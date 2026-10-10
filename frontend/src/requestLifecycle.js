const interruptionMessages = {
  timeout: 'The request took too long. Its outcome may need to be checked.',
  cancelled: 'The request was cancelled.',
  superseded: 'A newer action replaced this request.',
  navigation: 'Navigation interrupted this request.',
};

export class RequestInterruptedError extends Error {
  constructor(kind = 'cancelled') {
    super(interruptionMessages[kind] ?? interruptionMessages.cancelled);
    this.name = 'RequestInterruptedError';
    this.kind = kind;
  }
}

export function isRequestInterruption(error) {
  return error instanceof RequestInterruptedError;
}

function interruptionFor(signal) {
  return isRequestInterruption(signal.reason)
    ? signal.reason
    : new RequestInterruptedError('cancelled');
}

/** One active user action; per-request timeouts do not invalidate the action. */
export class RequestCoordinator {
  #current = null;

  begin() {
    this.cancel('superseded');
    const controller = new AbortController();
    const scope = {
      signal: controller.signal,
      mutationStarted: false,
      isCurrent: () => this.#current?.scope === scope && !controller.signal.aborted,
      assertCurrent: () => {
        if (!scope.isCurrent()) {
          throw controller.signal.aborted
            ? interruptionFor(controller.signal)
            : new RequestInterruptedError('superseded');
        }
      },
    };
    this.#current = { scope, controller };
    return scope;
  }

  cancel(kind = 'cancelled') {
    const current = this.#current;
    this.#current = null;
    current?.controller.abort(new RequestInterruptedError(kind));
  }

  finish(scope) {
    if (this.#current?.scope !== scope) return false;
    this.#current = null;
    return true;
  }
}

/** Bound the complete operation, including response body reads, without retries. */
export function boundedRequest(operation, { signal, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      reject(new RangeError('timeoutMs must be a finite, non-negative number.'));
      return;
    }
    if (signal?.aborted) {
      reject(interruptionFor(signal));
      return;
    }

    const controller = new AbortController();
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (success, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (success) resolve(value);
      else reject(value);
    };
    const interrupt = (error) => {
      if (settled) return;
      // Settle first so a transport's abort reaction cannot replace the reason.
      settle(false, error);
      controller.abort(error);
    };
    const onAbort = () => interrupt(interruptionFor(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => interrupt(new RequestInterruptedError('timeout')), timeoutMs);

    try {
      Promise.resolve(operation(controller.signal)).then(
        (value) => settle(true, value),
        (error) => settle(false, error),
      );
    } catch (error) {
      settle(false, error);
    }
  });
}
