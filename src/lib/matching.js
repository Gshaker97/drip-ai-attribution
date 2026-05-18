import { query } from '../db/pool.js';
import { normalizePhone, normalizeEmail } from './phone.js';

/**
 * Match a GHL contact (by normalized phone, then email) to an HCP customer.
 * Returns { hcpCustomerId, method, confidence } or null.
 */
export async function matchContactToHcp({ phoneNormalized, email }) {
  // 1. Try phone match first (strongest signal)
  if (phoneNormalized) {
    const res = await query(
      `SELECT hcp_customer_id, first_name, last_name, hcp_created_at
       FROM hcp_customers
       WHERE phone_normalized = $1 OR mobile_number_normalized = $1
       LIMIT 1`,
      [phoneNormalized]
    );
    if (res.rows.length > 0) {
      return {
        hcpCustomerId: res.rows[0].hcp_customer_id,
        hcpCreatedAt: res.rows[0].hcp_created_at,
        method: 'phone',
        confidence: 'high',
      };
    }
  }

  // 2. Fallback to email
  const emailNorm = normalizeEmail(email);
  if (emailNorm) {
    const res = await query(
      `SELECT hcp_customer_id, first_name, last_name, hcp_created_at
       FROM hcp_customers
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [emailNorm]
    );
    if (res.rows.length > 0) {
      return {
        hcpCustomerId: res.rows[0].hcp_customer_id,
        hcpCreatedAt: res.rows[0].hcp_created_at,
        method: 'email',
        confidence: 'medium',
      };
    }
  }

  return null;
}

/**
 * Classify an attribution as 'new_acquisition' or 'reactivation'.
 *
 * Rules:
 *  - new_acquisition: HCP customer was created AFTER the MCTB was sent
 *    OR within 7 days before (some offices create the contact during the call)
 *  - reactivation: HCP customer existed before the MCTB was sent
 */
export function classifyAttribution({ mctbSentAt, hcpCustomerCreatedAt }) {
  if (!hcpCustomerCreatedAt) return 'new_acquisition'; // unknown, assume new

  const mctbTime = new Date(mctbSentAt).getTime();
  const hcpTime = new Date(hcpCustomerCreatedAt).getTime();

  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  // If HCP customer was created within 7 days BEFORE the MCTB, still count as new
  // (office may have created the lead during/after initial call attempt)
  if (hcpTime >= mctbTime - sevenDays) return 'new_acquisition';
  return 'reactivation';
}
