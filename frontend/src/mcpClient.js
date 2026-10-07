const PROTOCOL_VERSION = '2025-11-25';
const ALLOWED_TOOLS = new Set(['get_sample_order', 'check_return_options', 'prepare_return_proposal', 'submit_simulated_return']);
const SIMULATION_WRITE_TOOLS = new Set(['prepare_return_proposal', 'submit_simulated_return']);
let nextId = 1;
let ready;

async function readSseResponse(response, expectedId) {
  if (!response.body) throw new Error('Local MCP server returned an empty event stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const takeMessage = (block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return null;
    try { return JSON.parse(data); } catch { throw new Error('Local MCP server sent invalid SSE JSON.'); }
  };
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    pending = pending.replaceAll('\r\n', '\n');
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) !== -1) {
      const message = takeMessage(pending.slice(0, boundary));
      pending = pending.slice(boundary + 2);
      if (message?.id === expectedId && (message.result || message.error)) {
        await reader.cancel().catch(() => {});
        return message;
      }
    }
    if (done) break;
  }
  const finalMessage = takeMessage(pending);
  if (finalMessage?.id === expectedId && (finalMessage.result || finalMessage.error)) return finalMessage;
  throw new Error('Local MCP event stream ended before its JSON-RPC response.');
}

async function post(message, { initialized = false, signal, fetchImpl = fetch } = {}) {
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  if (initialized) headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;
  let response;
  try {
    response = await fetchImpl('/mcp', {
      method: 'POST', headers, body: JSON.stringify(message), signal,
    });
  } catch (error) {
    if (message.id !== undefined && signal?.aborted) {
      const cancellation = {
        jsonrpc: '2.0', method: 'notifications/cancelled',
        params: { requestId: message.id, reason: 'Browser request cancelled.' },
      };
      await fetchImpl('/mcp', {
        method: 'POST', headers: { ...headers, 'MCP-Protocol-Version': PROTOCOL_VERSION },
        body: JSON.stringify(cancellation),
      }).catch(() => {});
    }
    throw error;
  }
  if (response.status === 202 && message.id === undefined) return null;
  if (!response.ok) throw new Error(`Local MCP server returned HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type') ?? '';
  let payload;
  if (contentType.includes('application/json')) payload = await response.json();
  else if (contentType.includes('text/event-stream')) payload = await readSseResponse(response, message.id);
  else throw new Error(`Local MCP server returned unsupported content type: ${contentType || 'unknown'}.`);
  if (payload.error) throw new Error(payload.error.message ?? 'Local MCP request failed.');
  if (payload.jsonrpc !== '2.0' || payload.id !== message.id || !payload.result) {
    throw new Error('Local MCP server returned an invalid JSON-RPC response.');
  }
  return payload.result;
}

async function initialize(fetchImpl) {
  const result = await post({
    jsonrpc: '2.0', id: nextId++, method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'return-companion-web-demo', title: 'Return Companion Web Demo', version: '0.5.0' },
    },
  }, { fetchImpl });
  if (result.protocolVersion !== PROTOCOL_VERSION || !result.capabilities?.tools) {
    throw new Error('Local MCP server did not negotiate the expected tools protocol.');
  }
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { initialized: true, fetchImpl });
  const listed = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }, { initialized: true, fetchImpl });
  const names = new Set((listed.tools ?? []).map((tool) => tool.name));
  if ([...ALLOWED_TOOLS].some((name) => !names.has(name))) {
    throw new Error('Local MCP server is missing a required read-only tool.');
  }
}

export async function callMcpTool(name, args, { signal, fetchImpl = fetch, allowMutation = false } = {}) {
  if (!ALLOWED_TOOLS.has(name)) throw new Error('Tool is not in the local synthetic allowlist.');
  if (SIMULATION_WRITE_TOOLS.has(name) && !allowMutation) throw new Error('Simulation write tools are available only from their explicit review controls.');
  if (!ready) {
    ready = initialize(fetchImpl).catch((error) => { ready = null; throw error; });
  }
  await ready;
  const result = await post({
    jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args },
  }, { initialized: true, signal, fetchImpl });
  if (result.isError) throw new Error(result.content?.[0]?.text ?? 'Local MCP tool failed.');
  let data = result.structuredContent;
  if (!data && result.content?.[0]?.text) {
    try { data = JSON.parse(result.content[0].text); } catch { /* checked below */ }
  }
  if (!data || typeof data !== 'object') throw new Error('Local MCP tool returned no structured facts.');
  return { data, trace: { transport: 'Streamable HTTP', protocolVersion: PROTOCOL_VERSION, method: 'tools/call', name, arguments: args } };
}

export function resetMcpClientForTests() {
  ready = null;
  nextId = 1;
}
