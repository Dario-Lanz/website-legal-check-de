// HTTPS checks outside the browser: does http:// redirect to https://, is HSTS set.

import { redirectAllowed } from './public-host.mjs';

const TIMEOUT_MS = 15_000;
/** Redirect hops followed from http:// before the answer counts as undecided. */
const MAX_REDIRECTS = 5;
const USER_AGENT = 'website-legal-check-de (technical website check)';

async function probe(url) {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT },
    });
    await response.body?.cancel();
    return {
      status: response.status,
      location: response.headers.get('location'),
      hsts: response.headers.get('strict-transport-security'),
    };
  } catch (error) {
    return { error: error.cause?.code ?? error.name ?? 'fetch failed' };
  }
}

/**
 * Follow the redirects of the http:// address by hand.
 * @param {object} first answer of the first request
 * @param {string} firstUrl
 * @param {{allowInternal?: boolean}} options
 * @returns {Promise<boolean|null>} true: ends on https; false: ends on an http page that answers 2xx (no redirect to https); null: undecided (error, 3xx without target, 4xx/5xx, too many hops)
 */
async function followToHttps(first, firstUrl, options) {
  let answer = first;
  let current = firstUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (answer.error) return null;
    if (answer.status >= 200 && answer.status < 300) return false;
    if (answer.status < 300 || answer.status >= 400 || !answer.location) return null;
    let next;
    try {
      next = new URL(answer.location, current);
    } catch {
      return null;
    }
    if (next.protocol === 'https:') return true;
    if (next.protocol !== 'http:' || !redirectAllowed(next, new URL(firstUrl), options)) return null;
    current = next.toString();
    answer = await probe(current);
  }
  return null;
}

/**
 * @param {URL} start
 * @param {{allowInternal?: boolean}} [options] allowInternal: tests only; by default a redirect to a non-public host ends the check as undecided
 * @returns {Promise<{http: object, https: object, httpRedirectsToHttps: boolean|null}>}
 */
export async function checkTransport(start, options = {}) {
  const httpUrl = new URL(start);
  httpUrl.protocol = 'http:';
  const httpsUrl = new URL(start);
  httpsUrl.protocol = 'https:';
  const [http, https] = await Promise.all([probe(httpUrl.toString()), probe(httpsUrl.toString())]);
  return { http, https, httpRedirectsToHttps: await followToHttps(http, httpUrl.toString(), options) };
}
