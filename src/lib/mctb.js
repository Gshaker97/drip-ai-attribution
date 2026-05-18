/**
 * Detects whether a GHL message is the native "Missed Call Text Back" (MCTB).
 *
 * GHL's native MCTB feature sends a templated SMS automatically when a call
 * goes unanswered. It is NOT triggered by a workflow or Conversation AI,
 * so we identify it purely by message content + direction + lack of user attribution.
 */

const DEFAULT_TEMPLATE = 'Hi this is {{location.name}}, I saw that we just missed your call how can I help?';

function getRenderedTemplate() {
  const template = process.env.MCTB_TEMPLATE || DEFAULT_TEMPLATE;
  const locationName = process.env.LOCATION_NAME || 'Drip Plumbing';
  return template.replace('{{location.name}}', locationName);
}

/**
 * Build a regex from the rendered template that's tolerant of:
 *  - GHL appending "Reply STOP to unsubscribe" compliance line
 *  - Minor whitespace/punctuation variations
 *  - Extra trailing whitespace
 */
function getTemplateRegex() {
  const rendered = getRenderedTemplate();
  // Escape regex special chars, then make whitespace flexible
  const escaped = rendered
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`^\\s*${escaped}`, 'i');
}

/**
 * Returns true if this message is the MCTB.
 *
 * @param {object} message - GHL message object
 * @returns {boolean}
 */
export function isMissedCallTextBack(message) {
  if (!message) return false;

  // Must be outbound SMS
  const direction = (message.direction || '').toLowerCase();
  if (direction !== 'outbound') return false;

  // GHL message types: TYPE_SMS = 1, or string 'SMS' depending on API surface
  const type = message.type ?? message.messageType;
  const isSms = type === 1 || type === 'SMS' || type === 'TYPE_SMS' || (typeof type === 'string' && type.toUpperCase().includes('SMS'));
  if (!isSms && type !== undefined) return false;

  // Body must match template
  const body = message.body || message.message || '';
  if (!body) return false;

  const regex = getTemplateRegex();
  return regex.test(body);
}

/**
 * Returns true if the contact replied at least once AFTER the MCTB was sent.
 *
 * @param {Array} messages - All messages in the conversation, in any order
 * @param {Date|string} mctbSentAt - When the MCTB was sent
 * @returns {{replied: boolean, firstReplyAt: Date|null}}
 */
export function findFirstReply(messages, mctbSentAt) {
  const mctbTime = new Date(mctbSentAt).getTime();

  const inboundAfter = messages
    .filter(m => {
      const dir = (m.direction || '').toLowerCase();
      if (dir !== 'inbound') return false;
      const t = new Date(m.dateAdded || m.createdAt || 0).getTime();
      return t > mctbTime;
    })
    .sort((a, b) => {
      const ta = new Date(a.dateAdded || a.createdAt || 0).getTime();
      const tb = new Date(b.dateAdded || b.createdAt || 0).getTime();
      return ta - tb;
    });

  if (inboundAfter.length === 0) return { replied: false, firstReplyAt: null };

  const first = inboundAfter[0];
  return {
    replied: true,
    firstReplyAt: new Date(first.dateAdded || first.createdAt),
  };
}
