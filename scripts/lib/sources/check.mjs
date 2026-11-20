// Check the sources of a report: only URLs listed in references/sources.md (or written in
// references/upcoming.md) are fetched, at most 4 at once, first plain, then (on block or
// challenge) with a headless browser.

import { berlinDateTime } from '../berlin-time.mjs';
import { createBrowserChecker, launchChromium } from './browser-fallback.mjs';
import { plainFetch } from './plain-fetch.mjs';
import { collectUrls, listedUrls, referenceUrls, setRetrieved } from './report-sources.mjs';
import { judge, needsBrowser } from './verdict.mjs';

export const CONCURRENCY = 4;
export const PER_URL_TIMEOUT_MS = 30_000;
export const OVERALL_LIMIT_MS = 4 * 60_000;

/** Run `worker` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function toRow(url, via, page) {
  const verdict = page.error ? { reachable: false, reason: page.error } : judge(page);
  return { url, via, status: page.status, reachable: verdict.reachable, reason: verdict.reason, title: page.title };
}

async function checkOne(url, deps, deadline) {
  const remaining = deadline - deps.now();
  if (remaining <= 0) return { url, via: '-', status: 0, reachable: false, reason: 'overall time limit reached', title: '' };
  const timeoutMs = Math.min(PER_URL_TIMEOUT_MS, remaining);
  const plain = await plainFetch(url, { fetchImpl: deps.fetchImpl, timeoutMs });
  if (!needsBrowser(plain)) return toRow(url, 'plain', plain);
  return toRow(url, 'browser', await deps.browser.check(url, timeoutMs));
}

/** One printable line per URL. */
export function formatRow(row) {
  const note = row.reason ? ` (${row.reason})` : '';
  return `${row.status || '---'}  reachable: ${row.reachable ? 'yes' : 'no'}  via ${row.via}  ${row.title ? `"${row.title}"` : '(no title)'}${note}  ${row.url}`;
}

/**
 * @param {object} report parsed report.json (changed in place when `write` is set)
 * @param {string} sourcesMd text of references/sources.md
 * @param {{write?: boolean, upcomingMd?: string, fetchImpl?: typeof fetch, browserFactory?: () => object, now?: () => number}} [options]
 * @returns {Promise<{rows: object[], unlisted: string[], updated: number}>}
 */
export async function checkSources(report, sourcesMd, options = {}) {
  const urls = collectUrls(report);
  const listed = new Set([...listedUrls(sourcesMd), ...referenceUrls(options.upcomingMd ?? '')]);
  const toFetch = urls.filter((u) => listed.has(u));
  const unlisted = urls.filter((u) => !listed.has(u));
  const now = options.now ?? Date.now;
  const browser = options.browserFactory?.() ?? createBrowserChecker(launchChromium);
  const deps = { fetchImpl: options.fetchImpl ?? fetch, browser, now };
  const deadline = now() + OVERALL_LIMIT_MS;
  try {
    const rows = await mapLimit(toFetch, CONCURRENCY, (url) => checkOne(url, deps, deadline));
    const urlsWhere = (reachable) => new Set(rows.filter((r) => r.reachable === reachable).map((r) => r.url));
    const updated = options.write ? setRetrieved(report, urlsWhere(true), urlsWhere(false), berlinDateTime(now()).date) : 0;
    return { rows, unlisted, updated };
  } finally {
    await browser.close();
  }
}
