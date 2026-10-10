export function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal; fetchImpl?: typeof fetch; allowMutation?: boolean; timeoutMs?: number; onMutationStart?: () => void },
): Promise<{
  data: Record<string, any>;
  trace: { transport: string; protocolVersion: string; method: string; name: string; arguments: Record<string, unknown> };
}>;

export function resetMcpClientForTests(): void;
