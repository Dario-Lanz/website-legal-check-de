// Browser navigations follow redirects on their own. A public page must not be able to lead the
// browser into the local network (SSRF): document requests to non-public hosts are aborted.
// The check runs inside the browser (CDP Fetch domain on ONE browser-level session): Chromium pauses
// every document request of every page and context, each redirect hop included, before it is sent,
// so what is checked is exactly what the browser requests. No request is repeated, no header is
// forwarded, no body is buffered.

import { isPublicHost } from './public-host.mjs';

/** True for the top-level page navigation (incl. its redirects), false for iframes and subresources. */
export function isMainFrameNavigation(request) {
  try {
    return request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    return false; // service-worker requests have no frame
  }
}

/** Schemes that do not leave the browser (no network request to a host). */
const LOCAL_SCHEMES = new Set(['about:', 'data:', 'blob:']);

/**
 * Judge one paused document request: let it go on or fail it. Errors (page or browser already
 * closed, e.g. by the watchdog) are swallowed: there is nothing left to protect.
 */
async function decide(cdp, event, allowed, onBlocked) {
  const { requestId, request } = event;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    url = null;
  }
  const ok = url !== null && (LOCAL_SCHEMES.has(url.protocol) || allowed(url));
  try {
    if (ok) return await cdp.send('Fetch.continueRequest', { requestId });
    await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
  } catch {
    // closed page or browser, or a request that is already gone
  }
  if (!ok) {
    try {
      onBlocked(request.url); // after the request is failed: a throwing callback must not let it through
    } catch {
      // a broken callback never changes the verdict
    }
  }
}

/**
 * Abort document requests of every page of the browser (also iframes, popups and every redirect hop)
 * to hosts that are not public, except the typed host. Subresources are not touched.
 * The interception sits on the browser, not on single pages: a popup (Playwright switches the popup
 * blocker off) is guarded from its very first request, which a per-page session cannot do because
 * the 'page' event arrives after the navigation has started. Call it once, right after launch; the
 * allowed set (typed host, public hosts) is the same for every context, the consent runs included
 * (they only visit the typed or the adopted public landing host).
 * Known limits: names that resolve to private addresses by DNS; speculation-rules prefetch to
 * internal hosts (blind, no content reaches the page). Service workers are blocked by the
 * caller's context options (serviceWorkers: 'block'), not by this module.
 * @param {import('playwright').Browser} browser
 * @param {{typedHost: string, allowInternal?: boolean, onBlocked?: (url: string) => void}} options
 *   allowInternal is for tests that serve local hosts
 */
export async function blockInternalNavigations(browser, { typedHost, allowInternal = false, onBlocked = () => {} }) {
  if (allowInternal) return;
  const allowed = (url) => /^https?:$/.test(url.protocol) && (url.hostname === typedHost || isPublicHost(url.hostname));
  const cdp = await browser.newBrowserCDPSession();
  cdp.on('Fetch.requestPaused', (event) => { void decide(cdp, event, allowed, onBlocked); });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request', resourceType: 'Document' }] });
}
