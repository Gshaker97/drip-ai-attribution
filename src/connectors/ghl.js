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
    timeout: 45000,
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
      const isTimeout = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
      if (status === 429 || status >= 500 || isTimeout) {
        const wait = Math.min(1500 * Math.pow(2, i), 15000);
        console.log(`GHL retry ${i + 1}/${retries} after ${wait}ms (${status || err.code || 'timeout'})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Search conversations with proper date-based cursor pagination.
 * sort=desc + startAfterDate cursor = we always get newest first
 * and can stop cleanly once we pass the start of the window.
 */
export async function searchConversations({ locationId, startDate, endDate, limitN = 100, debug = false }) {
  const c = client();
  const all = [];
  const startMs = startDate ? new Date(startDate).getTime() : null;
  const endMs = endDate ? new Date(endDate).getTime() : null;

  let startAfter = null;
  let startAfterId = null;
  let pagesFetched = 0;
  const MAX_PAGES = 500;

  while (pagesFetched < MAX_PAGES) {
    const params = {
      locationId,
      limit: limitN,
      sort: 'desc',
      sortBy: 'last_message_date',
    };
    if (startAfter) params.startAfterDate = startAfter;
    if (startAfterId) params.startAfterId = startAfterId;

    const res = await limit(() => withRetry(() =>
      c.get('/conversations/search', { params })
    ));

    const conversations = res.data?.conversations || [];
    if (conversations.length === 0) break;
    pagesFetched++;

    if (debug && pagesFetched === 1) {
      console.log('     [debug] First conversation sample:', JSON.stringify(conversations[0], null, 2).substring(0, 800));
    }

    let pastWindow = false;
    for (const conv of conversations) {
      const lastMs = conv.lastMessageDate ? new Date(conv.lastMessageDate).getTime() : 0;
      if (endMs && lastMs > endMs) continue;
      if (startMs && lastMs && lastMs < startMs) {
        pastWindow = true;
        continue;
      }
      all.push(conv);
    }

    if (pastWindow) break;
    if (conversations.length < limitN) break;

    const last = conversations[conversations.length - 1];
    startAfter = last.lastMessageDate;
    startAfterId = last.id;

    if (pagesFetched % 10 === 0) {
      console.log(`     [progress] fetched ${pagesFetched} pages, ${all.length} convos in window`);
    }
  }

  if (pagesFetched >= MAX_PAGES) {
    console.warn(`     [warning] hit MAX_PAGES (${MAX_PAGES}). May not have all conversations.`);
  }

  return all;
}

/**
 * Get all messages in a conversation. Tolerant of different response shapes.
 */
export async function getMessages(conversationId, debug = false) {
  const c = client();
  const all = [];
  let lastMessageId = null;

  while (true) {
    const params = { limit: 100 };
    if (lastMessageId) params.lastMessageId = lastMessageId;

    const res = await limit(() => withRetry(() =>
      c.get(`/conversations/${conversationId}/messages`, { params })
    ));

    let messages = [];
    const d = res.data;
    if (Array.isArray(d?.messages?.messages)) messages = d.messages.messages;
    else if (Array.isArray(d?.messages)) messages = d.messages;
    else if (Array.isArray(d)) messages = d;

    if (debug && all.length === 0 && messages.length > 0) {
      console.log('     [debug] First message sample:', JSON.stringify(messages[0], null, 2));
      console.log('     [debug] Response keys:', Object.keys(d || {}));
    }

    if (messages.length === 0) break;
    all.push(...messages);

    if (messages.length < 100) break;
    lastMessageId = messages[messages.length - 1].id;
    if (all.length > 1000) break;
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
