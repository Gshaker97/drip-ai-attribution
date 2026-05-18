import 'dotenv/config';
import { query, pool } from '../db/pool.js';
import * as ghl from '../connectors/ghl.js';
import * as hcp from '../connectors/hcp.js';
import { isMissedCallTextBack, findFirstReply } from '../lib/mctb.js';
import { normalizePhone } from '../lib/phone.js';
import { matchContactToHcp, classifyAttribution } from '../lib/matching.js';

const ATTRIBUTION_WINDOW_DAYS = parseInt(process.env.ATTRIBUTION_WINDOW_DAYS || '30', 10);
const INITIAL_PULL_DAYS = parseInt(process.env.INITIAL_PULL_DAYS || '30', 10);

/**
 * Run a full sync. Returns the sync run record.
 *
 * @param {object} opts
 * @param {string} opts.triggeredBy - 'manual' or 'cron'
 * @param {number} [opts.daysBack] - How many days back to pull
 */
export async function runSync({ triggeredBy = 'manual', daysBack } = {}) {
  const days = daysBack || INITIAL_PULL_DAYS;
  const endDate = new Date();
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const runRes = await query(
    `INSERT INTO sync_runs (triggered_by, status, date_range_start, date_range_end)
     VALUES ($1, 'running', $2, $3) RETURNING id`,
    [triggeredBy, startDate, endDate]
  );
  const runId = runRes.rows[0].id;

  console.log(`\n=== SYNC RUN ${runId} (${triggeredBy}) ===`);
  console.log(`Date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);

  try {
    // STEP 1: Sync HCP customers
    console.log('\n[1/4] Syncing HCP customers...');
    const customerCount = await syncHcpCustomers();
    console.log(`     ✓ ${customerCount} HCP customers cached`);

    // STEP 2: Sync HCP jobs in window + buffer
    console.log('\n[2/4] Syncing HCP jobs...');
    const jobCount = await syncHcpJobs({ startDate, endDate });
    console.log(`     ✓ ${jobCount} HCP jobs cached`);

    // STEP 3: Scan GHL conversations for MCTB events
    console.log('\n[3/4] Scanning GHL conversations for MCTB events...');
    const mctbCount = await scanGhlConversations({ startDate, endDate });
    console.log(`     ✓ ${mctbCount} MCTB events found`);

    // STEP 4: Compute attributions
    console.log('\n[4/4] Computing attributions...');
    const attrCount = await computeAttributions();
    console.log(`     ✓ ${attrCount} attributions computed`);

    await query(
      `UPDATE sync_runs SET status = 'success', finished_at = NOW(),
       mctb_events_found = $2, hcp_customers_synced = $3,
       hcp_jobs_synced = $4, attributions_created = $5
       WHERE id = $1`,
      [runId, mctbCount, customerCount, jobCount, attrCount]
    );

    console.log(`\n=== SYNC ${runId} COMPLETE ===\n`);
    return { runId, mctbCount, customerCount, jobCount, attrCount };

  } catch (err) {
    console.error('Sync failed:', err);
    await query(
      `UPDATE sync_runs SET status = 'failed', finished_at = NOW(), error_message = $2 WHERE id = $1`,
      [runId, err.message]
    );
    throw err;
  }
}

async function syncHcpCustomers() {
  const customers = await hcp.listCustomers();
  let count = 0;

  for (const cust of customers) {
    const phone = cust.home_number || cust.work_number || cust.phone || null;
    const mobile = cust.mobile_number || null;
    const phoneNorm = normalizePhone(phone);
    const mobileNorm = normalizePhone(mobile);

    await query(
      `INSERT INTO hcp_customers
        (hcp_customer_id, first_name, last_name, email, phone, phone_normalized,
         mobile_number, mobile_number_normalized, hcp_created_at, raw_data, cached_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (hcp_customer_id) DO UPDATE SET
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         phone_normalized = EXCLUDED.phone_normalized,
         mobile_number = EXCLUDED.mobile_number,
         mobile_number_normalized = EXCLUDED.mobile_number_normalized,
         raw_data = EXCLUDED.raw_data,
         cached_at = NOW()`,
      [
        cust.id,
        cust.first_name || null,
        cust.last_name || null,
        cust.email || null,
        phone,
        phoneNorm,
        mobile,
        mobileNorm,
        cust.created_at || null,
        JSON.stringify(cust),
      ]
    );
    count++;
  }

  return count;
}

async function syncHcpJobs({ startDate, endDate }) {
  // Pull jobs from start of window through end + 60 days (to catch attribution window)
  const bufferEnd = new Date(endDate.getTime() + 60 * 24 * 60 * 60 * 1000);
  const bufferStart = new Date(startDate.getTime() - 7 * 24 * 60 * 60 * 1000);

  const jobs = await hcp.listJobs({
    scheduledStartMin: bufferStart.toISOString(),
    scheduledStartMax: bufferEnd.toISOString(),
  });

  let count = 0;
  for (const job of jobs) {
    const customerId = job.customer?.id || job.customer_id;
    if (!customerId) continue;

    await query(
      `INSERT INTO hcp_jobs
        (hcp_job_id, hcp_customer_id, job_status, total_amount, outstanding_balance,
         scheduled_start, scheduled_end, completed_at, hcp_created_at, invoice_number, raw_data, cached_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (hcp_job_id) DO UPDATE SET
         job_status = EXCLUDED.job_status,
         total_amount = EXCLUDED.total_amount,
         outstanding_balance = EXCLUDED.outstanding_balance,
         scheduled_start = EXCLUDED.scheduled_start,
         scheduled_end = EXCLUDED.scheduled_end,
         completed_at = EXCLUDED.completed_at,
         invoice_number = EXCLUDED.invoice_number,
         raw_data = EXCLUDED.raw_data,
         cached_at = NOW()`,
      [
        job.id,
        customerId,
        job.work_status || job.status || null,
        parseAmount(job.total_amount),
        parseAmount(job.outstanding_balance),
        job.schedule?.scheduled_start || job.scheduled_start || null,
        job.schedule?.scheduled_end || job.scheduled_end || null,
        job.work_timestamps?.completed_at || job.completed_at || null,
        job.created_at || null,
        job.invoice_number || null,
        JSON.stringify(job),
      ]
    );
    count++;
  }

  return count;
}

function parseAmount(val) {
  if (val === null || val === undefined) return null;
  // HCP returns amounts in cents typically
  const n = Number(val);
  if (isNaN(n)) return null;
  // If looks like cents (no decimal, large number), convert
  return n > 10000 && Number.isInteger(n) ? n / 100 : n;
}

async function scanGhlConversations({ startDate, endDate }) {
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) throw new Error('GHL_LOCATION_ID is not set');

  const conversations = await ghl.searchConversations({
    locationId,
    startDate,
    endDate,
  });

  console.log(`     Found ${conversations.length} conversations to scan`);

  let mctbCount = 0;
  for (const conv of conversations) {
    try {
      const messages = await ghl.getMessages(conv.id);
      if (messages.length === 0) continue;

      // Find the MCTB message
      const mctbMessage = messages.find(isMissedCallTextBack);
      if (!mctbMessage) continue;

      const mctbSentAt = new Date(mctbMessage.dateAdded || mctbMessage.createdAt);
      const { replied, firstReplyAt } = findFirstReply(messages, mctbSentAt);

      // Get contact details
      const contactId = conv.contactId;
      let contact = null;
      try {
        contact = await ghl.getContact(contactId);
      } catch (e) {
        console.warn(`     Could not fetch contact ${contactId}: ${e.message}`);
      }

      const phone = contact?.phone || conv.phone || null;
      const phoneNorm = normalizePhone(phone);
      if (!phoneNorm) {
        console.warn(`     Skipping conversation ${conv.id} - no valid phone`);
        continue;
      }

      await query(
        `INSERT INTO mctb_events
          (ghl_conversation_id, ghl_contact_id, contact_name, contact_phone,
           contact_phone_normalized, contact_email, mctb_sent_at,
           lead_replied, first_reply_at, message_count, ghl_contact_created_at, raw_data, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
         ON CONFLICT (ghl_conversation_id) DO UPDATE SET
           lead_replied = EXCLUDED.lead_replied,
           first_reply_at = EXCLUDED.first_reply_at,
           message_count = EXCLUDED.message_count,
           updated_at = NOW()`,
        [
          conv.id,
          contactId,
          contact?.contactName || conv.fullName || null,
          phone,
          phoneNorm,
          contact?.email || conv.email || null,
          mctbSentAt,
          replied,
          firstReplyAt,
          messages.length,
          contact?.dateAdded || null,
          JSON.stringify({ conversation: conv, mctbMessage }),
        ]
      );
      mctbCount++;
    } catch (err) {
      console.warn(`     Error processing conversation ${conv.id}: ${err.message}`);
    }
  }

  return mctbCount;
}

async function computeAttributions() {
  // Get all MCTB events where lead replied (saved leads)
  const events = await query(
    `SELECT * FROM mctb_events WHERE lead_replied = TRUE`
  );

  let count = 0;
  for (const event of events.rows) {
    const match = await matchContactToHcp({
      phoneNormalized: event.contact_phone_normalized,
      email: event.contact_email,
    });

    if (!match) continue;

    const windowEnd = new Date(
      new Date(event.mctb_sent_at).getTime() + ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000
    );

    // Find jobs for this customer within the attribution window
    const jobsRes = await query(
      `SELECT * FROM hcp_jobs
       WHERE hcp_customer_id = $1
         AND hcp_created_at >= $2
         AND hcp_created_at <= $3
       ORDER BY hcp_created_at ASC`,
      [match.hcpCustomerId, event.mctb_sent_at, windowEnd]
    );

    if (jobsRes.rows.length === 0) continue;

    const firstJob = jobsRes.rows[0];
    const totalRevenue = jobsRes.rows.reduce(
      (sum, j) => sum + (parseFloat(j.total_amount) || 0),
      0
    );
    const isRecurring = jobsRes.rows.length > 1;

    const attrType = classifyAttribution({
      mctbSentAt: event.mctb_sent_at,
      hcpCustomerCreatedAt: match.hcpCreatedAt,
    });

    await query(
      `INSERT INTO attributions
        (mctb_event_id, hcp_customer_id, attribution_type, first_job_id,
         first_job_amount, first_job_date, is_recurring, total_jobs_in_window,
         total_revenue_in_window, match_method, match_confidence, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (mctb_event_id, hcp_customer_id) DO UPDATE SET
         attribution_type = EXCLUDED.attribution_type,
         first_job_id = EXCLUDED.first_job_id,
         first_job_amount = EXCLUDED.first_job_amount,
         first_job_date = EXCLUDED.first_job_date,
         is_recurring = EXCLUDED.is_recurring,
         total_jobs_in_window = EXCLUDED.total_jobs_in_window,
         total_revenue_in_window = EXCLUDED.total_revenue_in_window,
         computed_at = NOW()`,
      [
        event.id,
        match.hcpCustomerId,
        attrType,
        firstJob.hcp_job_id,
        parseFloat(firstJob.total_amount) || 0,
        firstJob.hcp_created_at,
        isRecurring,
        jobsRes.rows.length,
        totalRevenue,
        match.method,
        match.confidence,
      ]
    );
    count++;
  }

  return count;
}

// Allow running directly: node src/jobs/sync.js
if (import.meta.url === `file://${process.argv[1]}`) {
  runSync({ triggeredBy: 'cli' })
    .then(() => pool.end())
    .catch(err => {
      console.error(err);
      pool.end();
      process.exit(1);
    });
}
