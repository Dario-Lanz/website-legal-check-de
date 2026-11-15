// Time limits for calls into a page that may never answer (e.g. a script stuck in a loop).

export const UNRESPONSIVE = 'page unresponsive';
/** Grace period for closing a page or context before the close is given up on. */
export const CLOSE_TIMEOUT_MS = 5_000;

/**
 * Reject when the promise does not settle within ms. The pending call itself keeps running;
 * closing its page or browser ends it.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [message]
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, message = UNRESPONSIVE) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Close a page or context without ever blocking or throwing (a blocked page may not answer). */
export async function closeQuietly(target, options) {
  try {
    await withTimeout(target.close(options), CLOSE_TIMEOUT_MS, 'close timed out');
  } catch {
    // already closed, browser gone or close timed out: nothing more to do
  }
}
