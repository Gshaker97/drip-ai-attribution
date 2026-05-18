/**
 * Detects whether a GHL message is the native "Missed Call Text Back" (MCTB).
 *
 * V2: More lenient on message type detection. Some GHL API responses use
 * messageType, some use type, and the numeric/string codes vary by endpoint.
 * We now rely primarily on direction + body match.
 */

const DEFAULT_TEMPLATE = 'Hi this is {{location.name}}, I saw that we just missed your call how can I help?';

function getRenderedTemplate() {
  const template = process.env.MCTB_TEMPLATE || DEFAULT_TEMPLATE;
  const locationName = process.env.LOCATION_NAME || 'Drip Plumbing';
  return template.replace('{{location.name}}', locationName);
}

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

  // Must be outbound (multiple field name variations)
  const direction = String(message.direction || message.messageDirection || '').toLowerCase();
  if (direction && direction !== 'outbound') return false;
  if (!direction) {
    // If direction is completely absent, check other clues
    // Outbound messages typically have userId or are not from contact
    // Skip strict check and fall through to body match
  }

  // Body must match template (try multiple field names)
  const body = message.body || message.message || message.text || message.content || '';
  if (!body) return false;

  const regex = getTemplateRegex();
  return regex.test(body);
}

/**
 * Returns true if the contact replied at least once AFTER the MCTB was sent.
 */
export function findFirstReply(messages, mctbSentAt) {
  const mctbTime = new Date(mctbSentAt).getTime();

  const inboundAfter = messages
    .filter(m => {
      const dir = String(m.direction || m.messageDirection || '').toLowerCase();
      if (dir !== 'inbound') return false;
      const t = new Date(m.dateAdded || m.createdAt || m.dateUpdated || 0).getTime();
      return t > mctbTime;
    })
    .sort((a, b) => {
      const ta = new Date(a.dateAdded || a.createdAt || a.dateUpdated || 0).getTime();
      const tb = new Date(b.dateAdded || b.createdAt || b.dateUpdated || 0).getTime();
      return ta - tb;
    });

  if (inboundAfter.length === 0) return { replied: false, firstReplyAt: null };

  const first = inboundAfter[0];
  return {
    replied: true,
    firstReplyAt: new Date(first.dateAdded || first.createdAt || first.dateUpdated),
  };
}
