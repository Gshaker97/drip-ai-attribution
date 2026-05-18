import axios from 'axios';
import pLimit from 'p-limit';

const GHL_API_BASE = process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

// GHL rate limit: 100 req per 10s per location. We stay well below.
const limit = pLimit(5);

function client() {
  const token = process.env.GHL_PIT_TOKEN;
  if (!token) throw new Error('GHL_PIT_TOKEN is not set');

  return axios.create({
    baseURL: GHL_API_BASE,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
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
        console.log(`GHL retry ${i + 1}/${retries} after ${wait}ms (status ${status})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Search conversations in a date range.
 * GHL's /conversations/search endpoint supports date filtering.
 */
export async function searchConversations({ locationId, startDate, endDate, limitN = 100 }) {
  const c = client();
  const all = [];
  let page = 1;
  const startMs = startDate ? new Date(startDate).getTime() : null;
  const endMs = endDate ? new Date(endDate).getTime() : null;

  while (true) {
    const res = await limit(() => withRetry(() =>
      c.get('/conversations/search', {
        params: {
          locationId,
          limit: limitN,
          page,
          sort: 'desc',
          sortBy: 'last_message_date',
        },
      })
    ));

    const conversations = res.data?.conversations || [];
    if (conversations.length === 0) break;

    // Filter by date range (client-side, since GHL date filters are inconsistent)
    let outOfRange = false;
    for (const conv of conversations) {
      const lastMs = conv.lastMessageDate ? new Date(conv.lastMessageDate).getTime() : 0;
      if (startMs && lastMs && lastMs < startMs) {
        outOfRange = true;
        continue;
      }
      if (endMs && lastMs && lastMs > endMs) continue;
      all.push(conv);
    }

    if (conversations.length < limitN) break;
    if (outOfRange) break; // we've gone past the start date
    page++;
    if (page > 100) {
      console.warn('GHL search: hit 100-page safety limit');
      break;
    }
  }

  return all;
}

/**
 * Get all messages in a conversation.
 */
export async function getMessages(conversationId) {
  const c = client();
  const all = [];
  let lastMessageId = null;

  while (true) {
    const params = { limit: 100 };
    if (lastMessageId) params.lastMessageId = lastMessageId;

    const res = await limit(() => withRetry(() =>
      c.get(`/conversations/${conversationId}/messages`, { params })
    ));

    const messages = res.data?.messages?.messages || res.data?.messages || [];
    if (messages.length === 0) break;
    all.push(...messages);

    if (messages.length < 100) break;
    lastMessageId = messages[messages.length - 1].id;
    if (all.length > 1000) break; // safety
  }

  return all;
}

/**
 * Get a single contact by ID.
 */
export async function getContact(contactId) {
  const c = client();
  const res = await limit(() => withRetry(() =>
    c.get(`/contacts/${contactId}`)
  ));
  return res.data?.contact;
}
