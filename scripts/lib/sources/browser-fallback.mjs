// Fallback for sources that block plain requests (e.g. EUR-Lex): headless Chromium through
// the installed Playwright. One browser for all URLs, started on first use, closed by close().

import { blockInternalNavigations } from '../navigation-guard.mjs';
import { closeQuietly, withTimeout } from '../timeout.mjs';
import { extractTitle, looksLikeChallenge } from './verdict.mjs';
import { refusalReason, USER_AGENT } from './plain-fetch.mjs';

const CHALLENGE_WAIT_MS = 15_000;
const SNIPPET_CHARS = 6000;

const unreachable = (error) => ({ status: 0, title: '', snippet: '', isHtml: false, error });

async function readPage(page, response) {
  const html = await page.content();
  return { status: response?.status() ?? 0, title: extractTitle(html) || await page.title(), snippet: html.slice(0, SNIPPET_CHARS), isHtml: true };
}

/** Wait (bounded) until a challenge page has replaced itself with the real page. */
async function waitOutChallenge(page) {
  const gone = () => !/just a moment|attention required|checking your browser|captcha/i.test(document.title);
  await page.waitForFunction(gone, null, { timeout: CHALLENGE_WAIT_MS }).catch(() => {});
}

/** Start the browser and refuse document requests (also after redirects) to hosts that are not public; the check itself refuses non-https. */
async function startGuarded(launch, blocked) {
  const browser = await launch();
  await blockInternalNavigations(browser, { typedHost: '', onBlocked: (url) => blocked.push(url) });
  return browser;
}

/**
 * @param {() => Promise<object>} launch starts the browser (default: Playwright chromium)
 * @returns {{check: (url: string, timeoutMs: number) => Promise<object>, close: () => Promise<void>}}
 */
export function createBrowserChecker(launch) {
  let browserPromise = null;
  const blocked = [];
  const getBrowser = () => { browserPromise ??= startGuarded(launch, blocked); return browserPromise; };
  return {
    async check(url, timeoutMs) {
      const refusal = refusalReason(url);
      if (refusal) return { status: 0, title: '', snippet: '', isHtml: false, error: refusal };
      let context;
      try {
        context = await (await getBrowser()).newContext({ userAgent: USER_AGENT, locale: 'en-US', serviceWorkers: 'block' });
        await context.route((u) => u.protocol === 'http:', (route) => route.abort('blockedbyclient'));
        const page = await context.newPage();
        let last = null;
        page.on('response', (r) => { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) last = r; });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        let result = await readPage(page, last);
        if (looksLikeChallenge(result.title, result.snippet) || result.status === 202) {
          await waitOutChallenge(page);
          result = await readPage(page, last);
          if (!result.title) return unreachable('challenge not passed (empty page afterwards)');
        }
        const landed = page.url();
        return landed.startsWith('https://') ? result : unreachable(`not https: ${landed}`);
      } catch (error) {
        const note = blocked.length ? ` (blocked: ${blocked.join(', ')})` : '';
        return { status: 0, title: '', snippet: '', isHtml: false, error: `browser error: ${error.message.split('\n')[0]}${note}` };
      } finally {
        if (context) await closeQuietly(context);
      }
    },
    async close() {
      if (!browserPromise) return;
      const browser = await browserPromise.catch(() => null);
      if (browser) await withTimeout(browser.close(), 10_000, 'browser close timed out').catch(() => {});
    },
  };
}

/** Default launcher: Playwright's bundled Chromium (installed with the skill). */
export async function launchChromium() {
  const { chromium } = await import('playwright');
  return chromium.launch();
}
