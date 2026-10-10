import { boundedRequest } from './requestLifecycle.js';
import { formatApiError } from './apiErrors.js';

const configured = Number(import.meta.env?.VITE_REQUEST_TIMEOUT_MS);
const override = Number.isFinite(configured) && configured >= 500 && configured <= 120000 ? configured : null;
export const MCP_TIMEOUT_MS = override ?? 20000;

export class LocalApiError extends Error {
  constructor(message, status) { super(message); this.name = 'LocalApiError'; this.status = status; }
}

export function requestLocalApi(path, { method = 'GET', body, signal, fetchImpl = fetch, timeoutMs = override ?? (path === '/api/chat' ? 65000 : 10000) } = {}) {
  return boundedRequest(async (requestSignal) => {
    const response = await fetchImpl(path, {
      method, signal: requestSignal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let result;
    try { result = await response.json(); }
    catch (error) {
      requestSignal.throwIfAborted();
      if (response.ok) throw new Error('The local API returned an unreadable response. Check saved progress before another action.');
      result = {};
    }
    requestSignal.throwIfAborted();
    if (!response.ok) throw new LocalApiError(formatApiError(result) || `Request failed (${response.status}).`, response.status);
    return result?.data ?? result;
  }, { signal, timeoutMs });
}
