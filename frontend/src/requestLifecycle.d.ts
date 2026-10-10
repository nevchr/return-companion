export type RequestInterruptionKind = 'timeout' | 'cancelled' | 'superseded' | 'navigation';

export class RequestInterruptedError extends Error {
  readonly kind: RequestInterruptionKind;
  constructor(kind?: RequestInterruptionKind);
}

export interface RequestScope {
  readonly signal: AbortSignal;
  mutationStarted: boolean;
  isCurrent(): boolean;
  assertCurrent(): void;
}

export class RequestCoordinator {
  begin(): RequestScope;
  cancel(kind?: RequestInterruptionKind): void;
  finish(scope: RequestScope): boolean;
}

export function boundedRequest<T>(
  operation: (signal: AbortSignal) => PromiseLike<T> | T,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T>;

export function isRequestInterruption(error: unknown): error is RequestInterruptedError;
