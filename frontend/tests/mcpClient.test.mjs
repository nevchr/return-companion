import test from 'node:test';
import assert from 'node:assert/strict';
import { callMcpTool, resetMcpClientForTests } from '../src/mcpClient.js';
import { RequestCoordinator } from '../src/requestLifecycle.js';

const never = () => new Promise(() => {});
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const isTimeout = (error) => error.kind === 'timeout';
const isCancelled = (error) => error.kind === 'cancelled';

function fakeServer({ abortCall = false, sseCall = false } = {}) {
  const requests = [];
  const controller = new AbortController();
  const fetchImpl = async (_url, init) => {
    const message = JSON.parse(init.body);
    requests.push({ message, headers: init.headers, signal: init.signal });
    if (abortCall && message.method === 'tools/call') {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    }
    if (message.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
    else if (message.method === 'tools/list') result = { tools: [
      { name: 'get_sample_order' }, { name: 'check_return_options' },
      { name: 'prepare_return_proposal' }, { name: 'submit_simulated_return' },
    ] };
    else result = { structuredContent: { eligibility: { status: 'eligible' } }, isError: false };
    const payload = { jsonrpc: '2.0', id: message.id, result };
    if (sseCall && message.method === 'tools/call') {
      return new Response(`id: event-1\ndata: ${JSON.stringify(payload)}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return Response.json(payload);
  };
  return { requests, fetchImpl, controller };
}

test('browser MCP client initializes, discovers, then calls the selected tool over HTTP', async () => {
  resetMcpClientForTests();
  const { requests, fetchImpl } = fakeServer();
  const result = await callMcpTool('check_return_options', { order_id: 'NS-DEMO-1001' }, { fetchImpl });
  assert.deepEqual(requests.map(({ message }) => message.method), [
    'initialize', 'notifications/initialized', 'tools/list', 'tools/call',
  ]);
  assert.equal(requests[0].message.params.protocolVersion, '2025-11-25');
  assert.equal(requests[2].headers['MCP-Protocol-Version'], '2025-11-25');
  assert.equal(requests[3].message.params.name, 'check_return_options');
  assert.equal(result.data.eligibility.status, 'eligible');
  assert.equal(result.trace.transport, 'Streamable HTTP');
  assert.ok(requests.every(({ signal }) => signal instanceof AbortSignal));
  assert.ok(requests.every(({ signal }) => signal === requests[0].signal));
});

test('browser MCP client accepts a Streamable HTTP SSE response', async () => {
  resetMcpClientForTests();
  const { fetchImpl } = fakeServer({ sseCall: true });
  const result = await callMcpTool('get_sample_order', { order_id: 'NS-DEMO-1001' }, { fetchImpl });
  assert.equal(result.data.eligibility.status, 'eligible');
});

test('browser MCP client passes cancellation and gates local simulation write tools behind explicit controls', async () => {
  resetMcpClientForTests();
  const { requests, fetchImpl, controller } = fakeServer({ abortCall: true });
  await assert.rejects(callMcpTool('check_return_options', {}, { fetchImpl, signal: controller.signal }), isCancelled);
  assert.equal(requests.at(-1).message.method, 'notifications/cancelled');
  assert.equal(requests.at(-1).message.params.requestId, requests.at(-2).message.id);
  await assert.rejects(callMcpTool('submit_simulated_return', {}, { fetchImpl }), /explicit review controls/);
  await assert.rejects(callMcpTool('submit_simulated_return', {}, { fetchImpl, allowMutation: 'model approval' }), /explicit review controls/);
  await assert.rejects(callMcpTool('made_up_write', {}, { fetchImpl }), /not in the local synthetic allowlist/);
});

test('browser MCP client allows proposal preparation when invoked by its explicit reviewed flow', async () => {
  resetMcpClientForTests();
  const { requests, fetchImpl } = fakeServer();
  const result = await callMcpTool('prepare_return_proposal', { order_id: 'NS-DEMO-1001' }, { fetchImpl, allowMutation: true });
  assert.equal(requests.at(-1).message.params.name, 'prepare_return_proposal');
  assert.equal(result.trace.name, 'prepare_return_proposal');
});

test('hung initialization times out and a later call initializes independently', async () => {
  resetMcpClientForTests();
  const hung = fakeServer();
  const methods = [];
  const fetchImpl = (_url, init) => {
    const message = JSON.parse(init.body);
    methods.push(message.method);
    if (message.method === 'initialize') return never();
    return hung.fetchImpl(_url, init);
  };
  await assert.rejects(callMcpTool('get_sample_order', {}, { fetchImpl, timeoutMs: 25 }), isTimeout);
  assert.deepEqual(methods, ['initialize', 'notifications/cancelled']);
  const healthy = fakeServer();
  assert.equal((await callMcpTool('get_sample_order', {}, { fetchImpl: healthy.fetchImpl })).data.eligibility.status, 'eligible');
  assert.equal(healthy.requests[0].message.method, 'initialize');
});

test('an already cancelled action sends no request and does not mark a mutation started', async () => {
  const coordinator = new RequestCoordinator();
  const scope = coordinator.begin();
  coordinator.cancel();
  const server = fakeServer();
  let started = false;
  await assert.rejects(callMcpTool('submit_simulated_return', {}, {
    fetchImpl: server.fetchImpl, signal: scope.signal, allowMutation: true,
    onMutationStart: () => { started = true; },
  }), isCancelled);
  assert.deepEqual(server.requests, []);
  assert.equal(started, false);
});

test('initialization that ignores abort cannot dispatch a late mutation', async () => {
  const server = fakeServer();
  const controller = new AbortController();
  let releaseInitialization;
  let started = false;
  const fetchImpl = (_url, init) => {
    if (JSON.parse(init.body).method === 'initialize') {
      return new Promise((resolve) => {
        releaseInitialization = () => resolve(server.fetchImpl(_url, init));
      });
    }
    return server.fetchImpl(_url, init);
  };
  const request = callMcpTool('prepare_return_proposal', {}, {
    fetchImpl, signal: controller.signal, allowMutation: true,
    onMutationStart: () => { started = true; },
  });
  controller.abort();
  await assert.rejects(request, isCancelled);
  releaseInitialization();
  await nextTurn();
  assert.equal(started, false);
  assert.equal(server.requests.some(({ message }) => message.method === 'tools/call'), false);
  assert.equal(server.requests.some(({ message }) => message.method === 'notifications/initialized'), false);
});

test('late discovery after timeout cannot dispatch a write or invoke its callback', async () => {
  for (const phase of ['notifications/initialized', 'tools/list']) {
    const server = fakeServer();
    let release;
    let started = false;
    const fetchImpl = (_url, init) => {
      if (JSON.parse(init.body).method === phase) {
        return new Promise((resolve) => { release = () => resolve(server.fetchImpl(_url, init)); });
      }
      return server.fetchImpl(_url, init);
    };
    await assert.rejects(callMcpTool('submit_simulated_return', {}, {
      fetchImpl, timeoutMs: 25, allowMutation: true, onMutationStart: () => { started = true; },
    }), isTimeout);
    release();
    await nextTurn();
    assert.equal(started, false);
    assert.equal(server.requests.some(({ message }) => message.method === 'tools/call'), false);
  }
});

test('mutation callback runs after discovery immediately before each write dispatch', async () => {
  for (const name of ['prepare_return_proposal', 'submit_simulated_return']) {
    const server = fakeServer();
    const events = [];
    const fetchImpl = (_url, init) => {
      events.push(JSON.parse(init.body).method);
      return server.fetchImpl(_url, init);
    };
    await callMcpTool(name, {}, { fetchImpl, allowMutation: true, onMutationStart: () => events.push('mutation-start') });
    assert.deepEqual(events, ['initialize', 'notifications/initialized', 'tools/list', 'mutation-start', 'tools/call']);
  }
  const server = fakeServer();
  await callMcpTool('get_sample_order', {}, {
    fetchImpl: server.fetchImpl, onMutationStart: () => { throw new Error('read marked as mutation'); },
  });
});

test('a throwing or cancelling mutation callback prevents dispatch', async () => {
  for (const name of ['prepare_return_proposal', 'submit_simulated_return']) {
    const server = fakeServer();
    await assert.rejects(callMcpTool(name, {}, {
      fetchImpl: server.fetchImpl, allowMutation: true,
      onMutationStart: () => { throw new Error('Scope is stale.'); },
    }), /Scope is stale/);
    assert.equal(server.requests.some(({ message }) => message.method === 'tools/call'), false);
  }
  const server = fakeServer();
  const controller = new AbortController();
  await assert.rejects(callMcpTool('submit_simulated_return', {}, {
    fetchImpl: server.fetchImpl, signal: controller.signal, allowMutation: true,
    onMutationStart: () => controller.abort(),
  }), isCancelled);
  assert.equal(server.requests.some(({ message }) => message.method === 'tools/call'), false);
});

test('a hanging cancellation notification cannot delay rejection and is bounded itself', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = fakeServer();
  const controller = new AbortController();
  let cancellationSignal;
  const fetchImpl = (_url, init) => {
    const message = JSON.parse(init.body);
    if (message.method === 'tools/call') return never();
    if (message.method === 'notifications/cancelled') {
      cancellationSignal = init.signal;
      return never();
    }
    return server.fetchImpl(_url, init);
  };
  const request = callMcpTool('get_sample_order', {}, { fetchImpl, signal: controller.signal });
  await nextTurn();
  controller.abort();
  await assert.rejects(request, isCancelled);
  assert.ok(cancellationSignal);
  assert.equal(cancellationSignal.aborted, false);
  t.mock.timers.tick(1000);
  assert.equal(cancellationSignal.aborted, true);
});

test('a lost write response is never replayed automatically', async () => {
  for (const name of ['prepare_return_proposal', 'submit_simulated_return']) {
    const server = fakeServer();
    const writes = [];
    const fetchImpl = (_url, init) => {
      const message = JSON.parse(init.body);
      if (message.method === 'tools/call' && message.params.name === name) {
        writes.push(message);
        return Promise.reject(new TypeError('Response lost after dispatch.'));
      }
      return server.fetchImpl(_url, init);
    };
    await assert.rejects(callMcpTool(name, { idempotency_key: 'same-key' }, { fetchImpl, allowMutation: true }), /Response lost/);
    await callMcpTool('get_sample_order', {}, { fetchImpl });
    await nextTurn();
    assert.equal(writes.length, 1);
  }
});

test('the deadline includes response JSON parsing and stalled SSE reads', async () => {
  for (const phase of ['initialize', 'tools/list', 'tools/call']) {
    const server = fakeServer();
    const fetchImpl = (_url, init) => {
      if (JSON.parse(init.body).method === phase) {
        return Promise.resolve({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: never });
      }
      return server.fetchImpl(_url, init);
    };
    await assert.rejects(callMcpTool('get_sample_order', {}, { fetchImpl, timeoutMs: 25 }), isTimeout);
    assert.equal(server.requests.some(({ message }) => message.method === 'tools/call'), false);
  }
  const server = fakeServer();
  let readerCancelled = false;
  const fetchImpl = (_url, init) => {
    if (JSON.parse(init.body).method === 'tools/call') {
      return Promise.resolve({
        ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: { getReader: () => ({ read: never, cancel: () => { readerCancelled = true; return never(); } }) },
      });
    }
    return server.fetchImpl(_url, init);
  };
  await assert.rejects(callMcpTool('get_sample_order', {}, { fetchImpl, timeoutMs: 25 }), isTimeout);
  assert.equal(readerCancelled, true);
});

test('the default deadline bounds the complete MCP call to twenty seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = callMcpTool('get_sample_order', {}, { fetchImpl: never });
  let settled = false;
  const rejection = assert.rejects(request, isTimeout).then(() => { settled = true; });
  t.mock.timers.tick(19_999);
  await nextTurn();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejection;
});
