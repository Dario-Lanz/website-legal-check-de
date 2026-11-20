// Plain HTTPS fetch with a browser-like User-Agent: manual redirect handling (https only),
// timeout, size cap. Returns what the verdict needs; never throws for network errors.

import { isPublicHost } from '../public-host.mjs';
import { extractTitle } from './verdict.mjs';

export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 512 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Read at most `limit` bytes of a response body as text and cancel the rest. */
async function readCapped(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

/** Why a URL must not be fetched (not https, not a public host), or null if it may be. */
export function refusalReason(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `refused invalid URL: ${url}`;
  }
  if (parsed.protocol !== 'https:') return `refused non-https URL: ${url}`;
  return isPublicHost(parsed.hostname) ? null : `refused non-public host: ${parsed.hostname}`;
}

function failure(message) {
  return { status: 0, title: '', snippet: '', isHtml: false, error: message };
}

/**
 * @param {string} url https URL
 * @param {{fetchImpl?: typeof fetch, timeoutMs: number}} options
 * @returns {Promise<{status: number, title: string, snippet: string, isHtml: boolean, finalUrl?: string, error?: string}>}
 */
export async function plainFetch(url, { fetchImpl = fetch, timeoutMs }) {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const refusal = refusalReason(current);
      if (refusal) return failure(refusal);
      const response = await fetchImpl(current, { redirect: 'manual', signal, headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/pdf;q=0.9,*/*;q=0.5', 'accept-language': 'en,de;q=0.8' } });
      const location = response.headers.get('location');
      if (REDIRECT_STATUSES.has(response.status) && location) {
        current = new URL(location, current).href;
        continue;
      }
      const isHtml = /html/i.test(response.headers.get('content-type') ?? 'text/html');
      const snippet = isHtml ? await readCapped(response, MAX_BODY_BYTES) : '';
      if (!isHtml) await response.body?.cancel().catch(() => {});
      return { status: response.status, title: extractTitle(snippet), snippet, isHtml, finalUrl: current };
    }
    return failure('too many redirects');
  } catch (error) {
    return failure(error.name === 'TimeoutError' ? 'timeout' : `network error: ${error.cause?.code ?? error.message}`);
  }
}
