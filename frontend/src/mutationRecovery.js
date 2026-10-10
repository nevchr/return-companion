const KEY = 'return-companion-pending-mutation-v1';
const KINDS = new Set(['proposal', 'submit', 'approve', 'offer', 'advance']);
const text = (value) => typeof value === 'string' && value.length > 0;
const key = (value) => text(value) && value.length >= 8 && value.length <= 100;

function validPending(value) {
  if (value?.version !== 1 || !KINDS.has(value.kind) || !text(value.orderId) || !value.args || typeof value.args !== 'object' || Array.isArray(value.args)) return false;
  const args = value.args;
  if (value.kind === 'proposal') return value.caseId === null && args.order_id === value.orderId && key(args.idempotency_key) && args.receipt_reviewed === true && typeof args.accessories_complete === 'boolean' && text(args.issue) && text(args.condition);
  if (!text(value.caseId)) return false;
  if (value.kind === 'submit') return args.case_id === value.caseId && text(args.approval_id) && key(args.idempotency_key);
  if (value.kind === 'approve') return text(args.offer_id) && text(args.terms_hash) && Number.isInteger(args.expected_revision) && args.expected_revision > 0;
  if (value.kind === 'offer') return text(value.beforeOfferId);
  return ['DROPPED_OFF', 'RECEIVED', 'REFUNDED'].includes(args.status);
}

export function readPendingMutation(storage) {
  try {
    storage ??= globalThis.sessionStorage;
    const raw = storage.getItem(KEY);
    if (raw == null) return null;
    const value = JSON.parse(raw);
    if (!validPending(value)) throw new Error('invalid journal');
    return value;
  } catch { throw new Error('Recovery storage is unreadable or contains an invalid pending action. New changes are blocked; retry reading recovery storage.'); }
}

export function savePendingMutation(value, storage) {
  try {
    storage ??= globalThis.sessionStorage;
    if (!validPending(value)) throw new Error('Invalid pending action');
    const existing = readPendingMutation(storage);
    if (existing && (existing.kind !== value.kind || existing.orderId !== value.orderId || existing.caseId !== value.caseId || JSON.stringify(existing.args) !== JSON.stringify(value.args) || existing.beforeOfferId !== value.beforeOfferId)) throw new Error('Unresolved action cannot be replaced');
    storage.setItem(KEY, JSON.stringify(value));
  }
  catch { throw new Error('Session recovery storage is unavailable. Enable session storage before changing a saved case.'); }
}

export function clearPendingMutation(storage) {
  (storage ?? globalThis.sessionStorage).removeItem(KEY);
}

export function pendingOutcomeIsRecorded(pending, record) {
  if (!pending || record?.order_id !== pending.orderId || record?.case_id !== pending.caseId) return false;
  const args = pending.args;
  if (pending.kind === 'submit') return Boolean(text(args.approval_id) && record.return && record.approval?.approval_id === args.approval_id);
  if (pending.kind === 'approve') return Boolean(record.approval && text(args.offer_id) && text(args.terms_hash) && Number.isInteger(args.expected_revision) && record.approval.offer_id === args.offer_id && record.approval.terms_hash === args.terms_hash && record.approval.case_revision === args.expected_revision);
  if (pending.kind === 'offer') return Boolean(record.offer?.offer_id && record.offer.offer_id !== pending.beforeOfferId);
  if (pending.kind === 'advance') {
    const states = ['AWAITING_DROPOFF', 'DROPPED_OFF', 'RECEIVED', 'REFUNDED'];
    return states.indexOf(args.status) > 0 && states.indexOf(record.state) >= states.indexOf(args.status);
  }
  return false; // An unknown proposal is retrieved only by explicit replay of its exact key.
}
