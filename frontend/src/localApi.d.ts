export class LocalApiError extends Error { status: number; constructor(message: string, status: number); }
export const MCP_TIMEOUT_MS: number;
export function requestLocalApi(path: string, options?: { method?: string; body?: Record<string, unknown>; signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<Record<string, any>>;
