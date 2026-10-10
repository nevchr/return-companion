import test from 'node:test';
import assert from 'node:assert/strict';
import { requestLocalApi, LocalApiError } from '../src/localApi.js';
import { savePendingMutation, readPendingMutation, clearPendingMutation, pendingOutcomeIsRecorded } from '../src/mutationRecovery.js';

test('REST timeout covers a stalled response body and sends no retry', async () => {
  let calls = 0;
  await assert.rejects(requestLocalApi('/api/cases/case_demo/approve', {
    method: 'POST', body: { terms_hash: 'exact' }, timeoutMs: 10,
    fetchImpl: async () => { calls++; return { ok: true, json: () => new Promise(() => {}) }; },
  }), (error) => error.kind === 'timeout');
  assert.equal(calls, 1);
});

test('REST cancellation ignores a delayed success and never repeats a POST', async () => {
  const controller = new AbortController();
  let finish;
  let calls = 0;
  const pending = requestLocalApi('/api/chat', { signal: controller.signal, method: 'POST', body: {}, timeoutMs: 1000,
    fetchImpl: () => { calls++; return new Promise((resolve) => { finish = resolve; }); },
  });
  controller.abort();
  await assert.rejects(pending);
  finish(Response.json({ tool_calls: [{ name: 'submit_simulated_return' }] }));
  assert.equal(calls, 1);
});

test('REST errors distinguish received rejection from unknown transport outcome', async () => {
  await assert.rejects(requestLocalApi('/api/cases/test/approve', { fetchImpl: async () => Response.json({ detail: 'APPROVAL_REQUIRED' }, { status: 409 }) }), (error) => error instanceof LocalApiError && error.status === 409);
  await assert.rejects(requestLocalApi('/api/demo', { fetchImpl: async () => new Response('broken') }), /unreadable response/);
});

test('pending journal survives reload and preserves an exact proposal key', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const pending = { version: 1, kind: 'proposal', orderId: 'NS-DEMO-1001', caseId: null, args: { order_id: 'NS-DEMO-1001', idempotency_key: 'same-key', receipt_reviewed: true, accessories_complete: true, issue: 'defective', condition: 'opened' } };
  savePendingMutation(pending, storage);
  assert.deepEqual(readPendingMutation(storage), pending);
  clearPendingMutation(storage);
  assert.equal(readPendingMutation(storage), null);
  assert.throws(() => savePendingMutation(pending, { setItem() { throw new Error('blocked'); } }), /storage is unavailable/);
});

test('reconciliation requires the exact case, purchase and approval facts', () => {
  const pending = { kind: 'submit', caseId: 'case_one', orderId: 'NS-DEMO-1001', args: { approval_id: 'approval_one' } };
  const record = { case_id: 'case_one', order_id: 'NS-DEMO-1001', approval: { approval_id: 'approval_one' }, return: { simulation: true } };
  assert.equal(pendingOutcomeIsRecorded(pending, record), true);
  assert.equal(pendingOutcomeIsRecorded(pending, { ...record, case_id: 'case_two' }), false);
  assert.equal(pendingOutcomeIsRecorded(pending, { ...record, order_id: 'NS-DEMO-1003' }), false);
  assert.equal(pendingOutcomeIsRecorded(pending, { ...record, approval: { approval_id: 'other' } }), false);
  assert.equal(pendingOutcomeIsRecorded(pending, { ...record, return: null }), false);
  assert.equal(pendingOutcomeIsRecorded({ ...pending, kind: 'proposal' }, record), false);
});

test('reconciliation matches exact approval terms, offer replacement and lifecycle progression', () => {
  const base = { orderId: 'NS-DEMO-1001', caseId: 'case_one', args: {} };
  const record = { order_id: base.orderId, case_id: base.caseId, state: 'DROPPED_OFF', offer: { offer_id: 'offer_new' }, approval: { offer_id: 'offer_new', terms_hash: 'hash_exact', case_revision: 2 } };
  const approval = { ...base, kind: 'approve', args: { offer_id: 'offer_new', terms_hash: 'hash_exact', expected_revision: 2 } };
  assert.equal(pendingOutcomeIsRecorded(approval, record), true);
  assert.equal(pendingOutcomeIsRecorded({ ...approval, args: { ...approval.args, expected_revision: 1 } }, record), false);
  assert.equal(pendingOutcomeIsRecorded({ ...approval, args: { ...approval.args, terms_hash: 'other' } }, record), false);
  assert.equal(pendingOutcomeIsRecorded({ ...base, kind: 'offer', beforeOfferId: 'offer_old' }, record), true);
  assert.equal(pendingOutcomeIsRecorded({ ...base, kind: 'offer', beforeOfferId: 'offer_new' }, record), false);
  assert.equal(pendingOutcomeIsRecorded({ ...base, kind: 'advance', args: { status: 'DROPPED_OFF' } }, record), true);
  assert.equal(pendingOutcomeIsRecorded({ ...base, kind: 'advance', args: { status: 'RECEIVED' } }, record), false);
  assert.equal(pendingOutcomeIsRecorded({ ...base, kind: 'advance', args: { status: 'invalid' } }, record), false);
});

test('blocked default storage getters fail closed before mutation dispatch', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('blocked getter'); } });
  try {
    assert.throws(() => readPendingMutation(), /Recovery storage is unreadable/);
    assert.throws(() => savePendingMutation({ version: 1, kind: 'proposal', args: {} }), /storage is unavailable/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else delete globalThis.sessionStorage;
  }
});

test('malformed or unreadable stored actions cannot be overwritten by a fresh mutation', () => {
  let raw = '{malformed';
  let writes = 0;
  const storage = { getItem: () => raw, setItem: () => { writes++; } };
  const pending = { version: 1, kind: 'proposal', orderId: 'NS-DEMO-1001', caseId: null, args: { order_id: 'NS-DEMO-1001', idempotency_key: 'same-key', receipt_reviewed: true, accessories_complete: true, issue: 'defective', condition: 'opened' } };
  assert.throws(() => readPendingMutation(storage), /invalid pending action/);
  assert.throws(() => savePendingMutation(pending, storage), /storage is unavailable/);
  raw = JSON.stringify({ version: 1, kind: 'approve', orderId: 'NS-DEMO-1001', caseId: 'case_one', args: {} });
  assert.throws(() => readPendingMutation(storage), /invalid pending action/);
  assert.throws(() => savePendingMutation(pending, storage), /storage is unavailable/);
  assert.equal(pendingOutcomeIsRecorded(JSON.parse(raw), { order_id: 'NS-DEMO-1001', case_id: 'case_one', approval: null }), false);
  assert.throws(() => savePendingMutation(pending, { getItem() { throw new Error('read denied'); }, setItem() { writes++; } }), /storage is unavailable/);
  assert.equal(writes, 0);
});
