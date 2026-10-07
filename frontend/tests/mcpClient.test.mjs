import test from 'node:test';
import assert from 'node:assert/strict';
import { callMcpTool, resetMcpClientForTests } from '../src/mcpClient.js';

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
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
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
  await assert.rejects(callMcpTool('check_return_options', {}, { fetchImpl, signal: controller.signal }), /Aborted/);
  assert.equal(requests.at(-1).message.method, 'notifications/cancelled');
  assert.equal(requests.at(-1).message.params.requestId, requests.at(-2).message.id);
  await assert.rejects(callMcpTool('submit_simulated_return', {}, { fetchImpl }), /explicit review controls/);
  await assert.rejects(callMcpTool('made_up_write', {}, { fetchImpl }), /not in the local synthetic allowlist/);
});

test('browser MCP client allows proposal preparation when invoked by its explicit reviewed flow', async () => {
  resetMcpClientForTests();
  const { requests, fetchImpl } = fakeServer();
  const result = await callMcpTool('prepare_return_proposal', { order_id: 'NS-DEMO-1001' }, { fetchImpl, allowMutation: true });
  assert.equal(requests.at(-1).message.params.name, 'prepare_return_proposal');
  assert.equal(result.trace.name, 'prepare_return_proposal');
});
