/**
 * Reject with a labelled timeout error if `promise` doesn't settle within `ms`.
 *
 * IMPORTANT: this does NOT cancel `promise`. It races the promise against a timer, so when
 * the timeout wins the underlying work keeps running to completion — its result is just
 * ignored. Callers that hold a resource (a network connection, a built wallet, a
 * subscription) must release it on timeout themselves. For example, `buildSessionWallet`
 * attaches a handler to dispose the wallet if it arrives after the timeout, so a slow
 * operator build does not leak a watcher for every timed-out attempt.
 *
 * The timer is cleared once the race settles, so a fast success leaves nothing pending.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
