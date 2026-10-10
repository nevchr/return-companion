import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RequestCoordinator,
  RequestInterruptedError,
  boundedRequest,
  isRequestInterruption,
} from '../src/requestLifecycle.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const interrupted = (kind) => (error) => {
  assert.ok(isRequestInterruption(error));
  assert.equal(error.kind, kind);
  return true;
};

test('completed requests return values and remove timer and parent listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const parent = new AbortController();
  const remove = t.mock.method(parent.signal, 'removeEventListener');
  let childSignal;
  const result = await boundedRequest((signal) => {
    childSignal = signal;
    return Promise.resolve('complete');
  }, { signal: parent.signal, timeoutMs: 20 });
  assert.equal(result, 'complete');
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(remove.mock.callCount(), 1);
  t.mock.timers.tick(100);
  parent.abort();
  assert.equal(childSignal.aborted, false);
});

test('default timeout rejects ignored transport after 15 seconds and aborts child', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let childSignal;
  let attempts = 0;
  const request = boundedRequest((signal) => {
    attempts += 1;
    childSignal = signal;
    return new Promise(() => {});
  });
  const rejection = assert.rejects(request, interrupted('timeout'));
  t.mock.timers.tick(14999);
  assert.equal(childSignal.aborted, false);
  t.mock.timers.tick(1);
  await rejection;
  assert.equal(childSignal.aborted, true);
  assert.equal(childSignal.reason.kind, 'timeout');
  assert.equal(attempts, 1);
});

test('timeout covers a stalled response body after transport headers arrive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const body = deferred();
  let readBody = false;
  const request = boundedRequest(async () => {
    const response = await Promise.resolve({ json: () => body.promise });
    readBody = true;
    return response.json();
  }, { timeoutMs: 25 });
  const rejection = assert.rejects(request, interrupted('timeout'));
  await Promise.resolve();
  assert.equal(readBody, true);
  t.mock.timers.tick(25);
  await rejection;
  body.resolve({ arrived: 'late' });
  await Promise.resolve();
});

test('manual cancellation promptly rejects ignored transport and cleans timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const parent = new AbortController();
  const remove = t.mock.method(parent.signal, 'removeEventListener');
  let childSignal;
  const request = boundedRequest((signal) => {
    childSignal = signal;
    return new Promise(() => {});
  }, { signal: parent.signal, timeoutMs: 50 });
  const rejection = assert.rejects(request, interrupted('cancelled'));
  parent.abort();
  await rejection;
  assert.equal(clear.mock.callCount(), 1);
  const reason = childSignal.reason;
  t.mock.timers.tick(100);
  assert.equal(childSignal.reason, reason);
  assert.equal(remove.mock.callCount(), 1);
});

test('already cancelled parents never invoke the operation', async () => {
  const parent = new AbortController();
  parent.abort(new RequestInterruptedError('navigation'));
  let invoked = false;
  await assert.rejects(boundedRequest(() => {
    invoked = true;
  }, { signal: parent.signal }), interrupted('navigation'));
  assert.equal(invoked, false);
});

test('superseding a scope rejects its request and forbids stale work', async () => {
  const coordinator = new RequestCoordinator();
  const old = coordinator.begin();
  old.mutationStarted = true;
  const request = boundedRequest(() => new Promise(() => {}), { signal: old.signal });
  const rejection = assert.rejects(request, interrupted('superseded'));
  const current = coordinator.begin();
  await rejection;
  assert.equal(old.mutationStarted, true);
  assert.equal(old.isCurrent(), false);
  assert.throws(() => old.assertCurrent(), interrupted('superseded'));
  assert.equal(current.isCurrent(), true);
  current.assertCurrent();
  assert.equal(coordinator.finish(old), false);
  assert.equal(current.isCurrent(), true);
  assert.equal(coordinator.finish(current), true);
  assert.equal(current.isCurrent(), false);
  assert.equal(coordinator.finish(current), false);
});

test('late ignored transport cannot publish a superseded result or finish newer work', async () => {
  const coordinator = new RequestCoordinator();
  const old = coordinator.begin();
  const transport = deferred();
  let published = false;
  const request = boundedRequest(() => transport.promise, { signal: old.signal }).then((result) => {
    old.assertCurrent();
    published = result;
  }).finally(() => coordinator.finish(old));
  const rejection = assert.rejects(request, interrupted('superseded'));
  const current = coordinator.begin();
  await rejection;
  transport.resolve('stale result');
  await Promise.resolve();
  assert.equal(published, false);
  assert.equal(current.isCurrent(), true);
  coordinator.finish(current);
});

test('navigation invalidates the scope before notifying abort listeners', () => {
  const coordinator = new RequestCoordinator();
  const scope = coordinator.begin();
  let currentAtAbort;
  scope.signal.addEventListener('abort', () => { currentAtAbort = scope.isCurrent(); });
  coordinator.cancel('navigation');
  assert.equal(currentAtAbort, false);
  assert.equal(scope.signal.reason.kind, 'navigation');
  assert.throws(() => scope.assertCurrent(), interrupted('navigation'));
  coordinator.cancel();
});

test('request timeout preserves current action for outcome recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const coordinator = new RequestCoordinator();
  const scope = coordinator.begin();
  scope.mutationStarted = true;
  const request = boundedRequest(() => new Promise(() => {}), {
    signal: scope.signal, timeoutMs: 10,
  });
  const rejection = assert.rejects(request, interrupted('timeout'));
  t.mock.timers.tick(10);
  await rejection;
  assert.equal(scope.isCurrent(), true);
  assert.equal(scope.signal.aborted, false);
  assert.equal(scope.mutationStarted, true);
  coordinator.finish(scope);
});

test('transport failures and synchronous errors are preserved and clean timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failure = new Error('network failure');
  let childSignal;
  await assert.rejects(boundedRequest((signal) => {
    childSignal = signal;
    return Promise.reject(failure);
  }, { timeoutMs: 10 }), (error) => error === failure);
  await assert.rejects(boundedRequest(() => { throw failure; }, { timeoutMs: 10 }),
    (error) => error === failure);
  t.mock.timers.tick(20);
  assert.equal(childSignal.aborted, false);
  assert.equal(isRequestInterruption(failure), false);
  assert.equal(isRequestInterruption(null), false);
});

test('late rejection after timeout is handled without an unhandled rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = deferred();
  const lateErrors = [];
  const onUnhandled = (error) => lateErrors.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const request = boundedRequest(() => transport.promise, { timeoutMs: 10 });
    const rejection = assert.rejects(request, interrupted('timeout'));
    t.mock.timers.tick(10);
    await rejection;
    transport.reject(new Error('late transport failure'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(lateErrors, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('abort-aware transport rejection cannot replace an interruption reason', async () => {
  const parent = new AbortController();
  const request = boundedRequest((signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('transport abort')));
  }), { signal: parent.signal });
  const rejection = assert.rejects(request, interrupted('navigation'));
  parent.abort(new RequestInterruptedError('navigation'));
  await rejection;
});

test('invalid timeout values reject before starting transport', async () => {
  for (const timeoutMs of [-1, Infinity, NaN]) {
    await assert.rejects(boundedRequest(() => assert.fail('unexpected transport'), { timeoutMs }),
      RangeError);
  }
});
