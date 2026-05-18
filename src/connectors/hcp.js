import axios from 'axios';
import pLimit from 'p-limit';

const HCP_API_BASE = process.env.HCP_API_BASE || 'https://api.housecallpro.com';
const limit = pLimit(3);

function client() {
  const key = process.env.HCP_API_KEY;
  if (!key) throw new Error('HCP_API_KEY is not set');

  return axios.create({
    baseURL: HCP_API_BASE,
    headers: {
      Authorization: `Token ${key}`,
      Accept: 'application/json',
    },
    timeout: 30000,
  });
}

async function withRetry(fn, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status === 429 || status >= 500) {
        const wait = Math.min(1000 * Math.pow(2, i), 10000);
        console.log(`HCP retry ${i + 1}/${retries} after ${wait}ms (status ${status})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * List all customers (paginated).
 * HCP uses page-based pagination with page_size up to 200.
 */
export async function listCustomers({ updatedSince } = {}) {
  const c = client();
  const all = [];
  let page = 1;
  const pageSize = 200;

  while (true) {
    const params = { page, page_size: pageSize };
    if (updatedSince) params.updated_after = updatedSince;

    const res = await limit(() => withRetry(() =>
      c.get('/customers', { params })
    ));

    const customers = res.data?.customers || res.data?.data || [];
    if (customers.length === 0) break;
    all.push(...customers);

    if (customers.length < pageSize) break;
    page++;
    if (page > 200) {
      console.warn('HCP customers: hit 200-page safety limit');
      break;
    }
  }

  return all;
}

/**
 * List jobs for a specific customer.
 */
export async function listJobsForCustomer(customerId) {
  const c = client();
  const all = [];
  let page = 1;
  const pageSize = 200;

  while (true) {
    const res = await limit(() => withRetry(() =>
      c.get('/jobs', {
        params: { customer_id: customerId, page, page_size: pageSize },
      })
    ));

    const jobs = res.data?.jobs || res.data?.data || [];
    if (jobs.length === 0) break;
    all.push(...jobs);

    if (jobs.length < pageSize) break;
    page++;
    if (page > 20) break;
  }

  return all;
}

/**
 * List all jobs in a date range (used for initial sync).
 */
export async function listJobs({ scheduledStartMin, scheduledStartMax } = {}) {
  const c = client();
  const all = [];
  let page = 1;
  const pageSize = 200;

  while (true) {
    const params = { page, page_size: pageSize };
    if (scheduledStartMin) params.scheduled_start_min = scheduledStartMin;
    if (scheduledStartMax) params.scheduled_start_max = scheduledStartMax;

    const res = await limit(() => withRetry(() =>
      c.get('/jobs', { params })
    ));

    const jobs = res.data?.jobs || res.data?.data || [];
    if (jobs.length === 0) break;
    all.push(...jobs);

    if (jobs.length < pageSize) break;
    page++;
    if (page > 200) break;
  }

  return all;
}
