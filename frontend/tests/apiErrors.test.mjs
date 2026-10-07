import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApprovalRequest } from '../src/approvalRequest.js';
import { formatApiError } from '../src/apiErrors.js';

test('approval payload sends the enclosing offer ID and the selected option terms', () => {
  const payload = buildApprovalRequest({
    revision: 3,
    offer: { offer_id: 'offer-parent-123' },
  }, {
    option_id: 'defective_mail',
    terms_hash: 'terms-for-mail',
  });
  assert.deepEqual(payload, {
    offer_id: 'offer-parent-123',
    terms_hash: 'terms-for-mail',
    expected_revision: 3,
  });
});

test('formats a FastAPI conflict detail as readable text', () => {
  assert.equal(formatApiError({ detail: 'OFFER_CHANGED: review the current offer' }), 'OFFER_CHANGED: review the current offer');
});

test('formats structured validation errors with their field location', () => {
  assert.equal(formatApiError({ detail: [{ loc: ['body', 'expected_revision'], msg: 'Field required' }] }), 'expected_revision: Field required');
});

test('formats nested message envelopes and serializes unknown objects instead of coercing to [object Object]', () => {
  assert.equal(formatApiError({ error: { message: { message: 'Approval expired' } } }), 'Approval expired');
  assert.equal(formatApiError({ detail: { code: 'CONFLICT', retryable: false } }), '{"code":"CONFLICT","retryable":false}');
});
