import { boundedRequest } from './requestLifecycle.js';

const PROTOCOL_VERSION = '2025-11-25';
const ALLOWED_TOOLS = new Set(['get_sample_order', 'check_return_options', 'prepare_return_proposal', 'submit_simulated_return']);
const SIMULATION_WRITE_TOOLS = new Set(['prepare_return_proposal', 'submit_simulated_return']);
let nextId = 1;

async function readSseResponse(response, expectedId, signal) {
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
  const cancelReader = () => {
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ }
  };
  signal?.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      pending += decoder.decode(value, { stream: !done });
      pending = pending.replaceAll('\r\n', '\n');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const message = takeMessage(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        if (message?.id === expectedId && (message.result || message.error)) {
          return message;
        }
      }
      if (done) break;
    }
    const finalMessage = takeMessage(pending);
    if (finalMessage?.id === expectedId && (finalMessage.result || finalMessage.error)) return finalMessage;
    throw new Error('Local MCP event stream ended before its JSON-RPC response.');
  } finally {
    signal?.removeEventListener('abort', cancelReader);
    cancelReader();
  }
}

function notifyCancellation(message, headers, fetchImpl) {
  const cancellation = {
    jsonrpc: '2.0', method: 'notifications/cancelled',
    params: { requestId: message.id, reason: 'Browser request cancelled.' },
  };
  // A server or transport that ignores cancellation must not delay the caller.
  void boundedRequest((signal) => {
    signal.throwIfAborted();
    return fetchImpl('/mcp', {
      method: 'POST', headers: { ...headers, 'MCP-Protocol-Version': PROTOCOL_VERSION },
      body: JSON.stringify(cancellation), signal,
    });
  }, { timeoutMs: 1000 }).catch(() => {});
}

async function post(message, { initialized = false, signal, fetchImpl = fetch, onMutationStart } = {}) {
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  if (initialized) headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;
  const body = JSON.stringify(message);
  signal?.throwIfAborted();
  onMutationStart?.();
  signal?.throwIfAborted();
  const onAbort = () => notifyCancellation(message, headers, fetchImpl);
  if (message.id !== undefined) signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl('/mcp', {
      method: 'POST', headers, body, signal,
    });
    signal?.throwIfAborted();
    if (response.status === 202 && message.id === undefined) return null;
    if (!response.ok) throw new Error(`Local MCP server returned HTTP ${response.status}.`);
    const contentType = response.headers.get('content-type') ?? '';
    let payload;
    if (contentType.includes('application/json')) payload = await response.json();
    else if (contentType.includes('text/event-stream')) payload = await readSseResponse(response, message.id, signal);
    else throw new Error(`Local MCP server returned unsupported content type: ${contentType || 'unknown'}.`);
    signal?.throwIfAborted();
    if (payload.error) throw new Error(payload.error.message ?? 'Local MCP request failed.');
    if (payload.jsonrpc !== '2.0' || payload.id !== message.id || !payload.result) {
      throw new Error('Local MCP server returned an invalid JSON-RPC response.');
    }
    return payload.result;
  } finally {
    if (message.id !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}

async function initialize(fetchImpl, signal) {
  const result = await post({
    jsonrpc: '2.0', id: nextId++, method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'return-companion-web-demo', title: 'Return Companion Web Demo', version: '0.5.0' },
    },
  }, { fetchImpl, signal });
  if (result.protocolVersion !== PROTOCOL_VERSION || !result.capabilities?.tools) {
    throw new Error('Local MCP server did not negotiate the expected tools protocol.');
  }
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { initialized: true, fetchImpl, signal });
  const listed = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }, { initialized: true, fetchImpl, signal });
  const names = new Set((listed.tools ?? []).map((tool) => tool.name));
  if ([...ALLOWED_TOOLS].some((name) => !names.has(name))) {
    throw new Error('Local MCP server is missing a required read-only tool.');
  }
}

export async function callMcpTool(name, args, { signal, fetchImpl = fetch, allowMutation = false, timeoutMs = 20_000, onMutationStart } = {}) {
  if (!ALLOWED_TOOLS.has(name)) throw new Error('Tool is not in the local synthetic allowlist.');
  if (SIMULATION_WRITE_TOOLS.has(name) && allowMutation !== true) throw new Error('Simulation write tools are available only from their explicit review controls.');
  return boundedRequest(async (childSignal) => {
    await initialize(fetchImpl, childSignal);
    childSignal.throwIfAborted();
    const result = await post({
      jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args },
    }, {
      initialized: true, signal: childSignal, fetchImpl,
      onMutationStart: SIMULATION_WRITE_TOOLS.has(name) ? onMutationStart : undefined,
    });
    if (result.isError) throw new Error(result.content?.[0]?.text ?? 'Local MCP tool failed.');
    let data = result.structuredContent;
    if (!data && result.content?.[0]?.text) {
      try { data = JSON.parse(result.content[0].text); } catch { /* checked below */ }
    }
    if (!data || typeof data !== 'object') throw new Error('Local MCP tool returned no structured facts.');
    return { data, trace: { transport: 'Streamable HTTP', protocolVersion: PROTOCOL_VERSION, method: 'tools/call', name, arguments: args } };
  }, { signal, timeoutMs });
}

export function resetMcpClientForTests() {
  nextId = 1;
}
