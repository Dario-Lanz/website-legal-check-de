// Orchestrates a scan: sample pages (decision 3a), then a short deep check (15a).
// The main browser context never interacts with consent dialogs, so everything recorded
// there happened before any consent; afterwards fresh contexts click reject and accept.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { canonicalPageUrl, isSameSite, isThirdParty, normalizeStartUrl, pageKey } from './url.mjs';
import { classifyVisitedPage, selectDeepCheckUrls } from './page-types.mjs';
import { sampleTargets } from './sample-targets.mjs';
import { discoverSitemapUrls } from './sitemap.mjs';
import { isPublicHost } from './public-host.mjs';
import { matchService } from './third-parties.mjs';
import { checkTransport } from './transport.mjs';
import { linkScreenshots, pageFingerprint } from './reuse.mjs';
import { visitPage } from './visit-page.mjs';
import { consentRunUrls, runConsentChoices } from './consent-runs.mjs';
import { closeQuietly } from './timeout.mjs';
import { blockInternalNavigations, isMainFrameNavigation } from './navigation-guard.mjs';

// serviceWorkers 'block': the scan sees the site as a first-time visitor, and no worker can answer requests the guard never sees.
const CONTEXT_OPTIONS = { bypassCSP: true, locale: 'de-DE', viewport: { width: 1366, height: 900 }, serviceWorkers: 'block' };

export const DEFAULTS = {
  maxNavPages: 40, maxExtraPages: 20, deepPerType: 3, deep: true,
  delayMs: 500, pageTimeoutMs: 45_000, settleMs: 2_500, maxTotalMs: 20 * 60_000,
};

/**
 * @param {{startUrl: string, outDir: string, launchArgs?: string[], log?: (msg: string) => void, allowInternalHosts?: boolean} & Partial<typeof DEFAULTS>} options
 *   allowInternalHosts is for tests that serve local hosts; by default the scanner follows redirects and landing hosts to public hosts only.
 * @returns {Promise<object>} the scan result (also written to outDir/scan.json)
 */
export async function scanSite(options) {
  const opts = { ...DEFAULTS, log: () => {}, launchArgs: [], allowInternalHosts: false, ...options };
  const start = normalizeStartUrl(opts.startUrl);
  const evidenceDir = path.join(opts.outDir, 'belege');
  await mkdir(evidenceDir, { recursive: true });

  const startedAt = Date.now();
  const transport = await checkTransport(start, { allowInternal: opts.allowInternalHosts });
  const browser = await chromium.launch({ args: opts.launchArgs });
  // `site` is the first-party base: the typed host until the start page shows where the site really lives.
  const state = { pages: [], requests: [], cookieFirstSeen: new Map(), visited: new Set(), scannedKeys: new Map(), blocked: new Set(), notes: [], site: start, startedAt, timedOut: false };
  const watchdog = startWatchdog(browser, state, opts, startedAt);
  try {
    await blockInternalNavigations(browser, {
      typedHost: start.hostname, allowInternal: opts.allowInternalHosts,
      onBlocked: (url) => blockedUrl(state, url),
    });
    return await runScan(browser, { start, transport, state, opts, evidenceDir, startedAt });
  } finally {
    clearTimeout(watchdog);
    await closeQuietly(browser);
  }
}

async function runScan(browser, { start, transport, state, opts, evidenceDir, startedAt }) {
  const context = await browser.newContext(CONTEXT_OPTIONS);
  context.on('request', (request) => recordRequest(state, request.url(), request.resourceType(), isMainFrameNavigation(request)));
  const deepCheck = await crawlSite(context, { start, state, opts, evidenceDir });
  const cookies = await readCookies(context, state);
  await closeQuietly(context);
  const consentRuns = await consentChoiceRuns(browser, state, opts);
  // The 'request' event can come before or after the guard's verdict: drop blocked URLs for good here.
  dropBlockedRequests(state, consentRuns);
  const result = buildResult({ start, transport, state, cookies, deepCheck, consentRuns, startedAt });
  await writeFile(path.join(opts.outDir, 'scan.json'), JSON.stringify(result, null, 2));
  return result;
}

/** Sample the site (or re-check an earlier scan) and run the deep check; returns its summary. */
async function crawlSite(context, { start, state, opts, evidenceDir }) {
  if (opts.reuseFrom) {
    state.reuse = await reuseEarlierScan(context, state, opts, evidenceDir, start);
    return { skipped: true, decision: 'Earlier scan reused; pages of that scan re-checked.' };
  }
  const crawl = (url) => crawlPage(context, url, state, opts, evidenceDir);
  await crawl(start.toString());
  const firstPage = state.pages[0];
  // When the time limit ended the start page, the partial result is still written (with the note).
  if (firstPage?.error && !state.timedOut) throw new Error(startPageError(firstPage, state));
  adoptLandingHost(state, firstPage, opts);
  const startUrl = new URL(firstPage?.finalUrl ?? state.site.href);
  for (const url of sampleTargets(firstPage?.facts?.links ?? [], startUrl, opts)) await crawl(url);
  return opts.deep && !state.timedOut ? runDeepCheck(state, opts, crawl) : { skipped: true };
}

/** A navigation the guard refused: remember the URL (the 'request' event fires for it too) and note it. */
function blockedUrl(state, url) {
  state.blocked.add(url);
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch { /* keep the raw text */ }
  state.notes.push(`Navigation to ${host} blocked: not a public host.`);
}

/** Message for an unreachable start page; names the last blocked navigation when there was one. */
function startPageError(firstPage, state) {
  const blocked = state.notes.findLast((note) => /blocked: not a public host/.test(note));
  return `Start page not reachable: ${firstPage.error}${blocked ? ` (${blocked})` : ''}`;
}

/** Hard stop: closing the browser ends every pending call, including one stuck in a blocked page. */
function startWatchdog(browser, state, opts, startedAt) {
  const remaining = Math.max(0, opts.maxTotalMs - (Date.now() - startedAt));
  return setTimeout(() => {
    state.timedOut = true;
    state.notes.push('Time limit reached: the browser was closed, the scan is incomplete.');
    browser.close().catch(() => {});
  }, remaining);
}

async function readCookies(context, state) {
  try {
    return (await context.cookies()).map((c) => describeCookie(c, state.site, state.cookieFirstSeen));
  } catch (error) {
    if (!state.timedOut) throw error;
    return [];
  }
}

async function consentChoiceRuns(browser, state, opts) {
  const pageUrls = state.timedOut ? [] : consentRunUrls(state.pages);
  if (pageUrls.length === 0) return null;
  opts.log('Consent choices: reject and accept');
  try {
    return await runConsentChoices(browser, state.site, pageUrls, {
      contextOptions: CONTEXT_OPTIONS, timeoutMs: opts.pageTimeoutMs, settleMs: opts.settleMs, shouldStop: () => state.timedOut,
    });
  } catch (error) {
    if (!state.timedOut) throw error;
    return null; // the watchdog closed the browser during the runs; the note is already in state.notes
  }
}

/**
 * The typed host may only forward to the real site (firma.de -> firma-gmbh.de). When the start page
 * ends on another registrable domain, that domain is the first party; requests seen so far are re-judged.
 * Only public hosts are adopted (never localhost or private addresses).
 */
function adoptLandingHost(state, firstPage, opts) {
  let landing;
  try {
    landing = new URL(firstPage?.finalUrl);
  } catch {
    return;
  }
  if (!isThirdParty(landing.href, state.site.hostname)) return;
  if (!opts.allowInternalHosts && !isPublicHost(landing.hostname)) {
    state.notes.push(`Start page forwards to ${landing.hostname}, which is not a public host; it is not followed as the website.`);
    return;
  }
  state.notes.push(`Start page forwards to ${landing.hostname}; that domain is treated as the website instead of ${state.site.hostname}.`);
  state.site = landing;
  for (const request of state.requests) request.thirdParty = isThirdParty(request.url, landing.hostname);
}

const timeIsUp = (state, opts) => state.timedOut || Date.now() - state.startedAt >= opts.maxTotalMs;

/**
 * Re-check every page of an earlier scan without screenshots; take unchanged pages over
 * (data and screenshots), scan changed or previously failed pages fully again.
 */
async function reuseEarlierScan(context, state, opts, evidenceDir, start) {
  const oldDataDir = path.join(opts.reuseFrom, 'daten');
  const old = JSON.parse(await readFile(path.join(oldDataDir, 'scan.json'), 'utf8'));
  if (!old.host || !isSameSite(`https://${old.host}/`, start)) {
    throw new Error(`Earlier scan belongs to ${old.host ?? 'an unknown site'}, not to ${start.hostname}.`);
  }
  adoptLandingHost(state, old.pages?.[0], opts);
  const reuse = { from: path.basename(opts.reuseFrom), scannedAt: old.scannedAt, unchangedPages: [], changedPages: [] };
  for (const oldPage of old.pages ?? []) {
    if (timeIsUp(state, opts)) {
      state.notes.push(`Time limit reached, not re-checked: ${oldPage.url}`);
      continue;
    }
    await recheckPage(context, state, opts, evidenceDir, { old, oldDataDir, oldPage, reuse });
  }
  const firstPage = state.pages[0];
  if (!firstPage) throw new Error('Earlier scan: no page could be re-checked.');
  if (firstPage.error && !state.timedOut) throw new Error(startPageError(firstPage, state));
  return reuse;
}

async function recheckPage(context, state, opts, evidenceDir, { old, oldDataDir, oldPage, reuse }) {
  const visitOptions = (index) => ({ index, evidenceDir, timeoutMs: opts.pageTimeoutMs, settleMs: opts.settleMs });
  state.currentIndex = oldPage.index;
  state.visited.add(oldPage.url);
  opts.log(`[${oldPage.index}] ${oldPage.url} (re-check)`);
  const mark = state.requests.length;
  const quick = oldPage.error || oldPage.skipped ? null : await visitPage(context, oldPage.url, { ...visitOptions(oldPage.index), light: true });
  const same = quick && !quick.error
    && pageFingerprint(quick.facts, state.requests.slice(mark)) === pageFingerprint(oldPage.facts, old.requests.filter((r) => r.page === oldPage.index));
  if (same) {
    state.pages.push({ ...oldPage, screenshots: linkScreenshots(oldPage.screenshots, oldDataDir, path.dirname(evidenceDir)) });
    reuse.unchangedPages.push(oldPage.url);
  } else {
    state.requests.splice(mark);
    const full = await visitPage(context, oldPage.url, visitOptions(oldPage.index));
    full.pageType = classifyVisitedPage(full.finalUrl ?? oldPage.url, full.facts?.title);
    state.pages.push(full);
    reuse.changedPages.push(oldPage.url);
  }
  await noteNewCookies(context, state);
  await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
}

async function crawlPage(context, url, state, opts, evidenceDir) {
  const canonical = canonicalPageUrl(url, url);
  if (!canonical || state.visited.has(canonical) || state.scannedKeys.has(pageKey(canonical))) return;
  if (timeIsUp(state, opts)) {
    state.notes.push(`Time limit reached, skipped: ${canonical}`);
    return;
  }
  state.visited.add(canonical);
  state.currentIndex = state.pages.length + 1;
  opts.log(`[${state.currentIndex}] ${canonical}`);
  const result = await visitPage(context, canonical, {
    index: state.currentIndex, evidenceDir, timeoutMs: opts.pageTimeoutMs, settleMs: opts.settleMs,
  });
  result.pageType = classifyVisitedPage(result.finalUrl ?? canonical, result.facts?.title);
  if (result.finalUrl) state.visited.add(canonicalPageUrl(result.finalUrl, result.finalUrl));
  const finalKey = pageKey(result.finalUrl ?? canonical);
  const scannedIndex = finalKey !== pageKey(canonical) ? state.scannedKeys.get(finalKey) : undefined;
  if (scannedIndex !== undefined) {
    // /cart and /checkout both leading to /warenkorb: the page was scanned already, its second visit is dropped.
    // Cookies that only this visit set belong to the page that was kept, not to the next page that takes this index.
    state.requests = state.requests.filter((r) => r.page !== state.currentIndex);
  } else {
    state.scannedKeys.set(pageKey(canonical), state.currentIndex);
    state.scannedKeys.set(finalKey, state.currentIndex);
    state.pages.push(result);
  }
  await noteNewCookies(context, state, scannedIndex ?? state.currentIndex);
  await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
}

function recordRequest(state, url, resourceType, mainFrame = false) {
  if (!/^https?:/i.test(url) || state.blocked.has(url)) return; // blocked requests are noted, not recorded (see also runScan)
  const service = matchService(url);
  state.requests.push({
    page: state.currentIndex ?? 1, url: url.slice(0, 500), resourceType, mainFrame,
    thirdParty: isThirdParty(url, state.site.hostname), service: service?.name ?? null, category: service?.category ?? null,
  });
}

async function noteNewCookies(context, state, index = state.currentIndex) {
  let cookies;
  try {
    cookies = await context.cookies();
  } catch (error) {
    if (state.timedOut) return; // the watchdog closed the browser
    throw error;
  }
  for (const cookie of cookies) {
    const key = `${cookie.name}@${cookie.domain}`;
    if (!state.cookieFirstSeen.has(key)) state.cookieFirstSeen.set(key, index);
  }
}

function describeCookie(cookie, start, firstSeen) {
  const host = cookie.domain.replace(/^\./, '');
  return {
    name: cookie.name, domain: cookie.domain, path: cookie.path,
    expires: cookie.expires > 0 ? new Date(cookie.expires * 1000).toISOString() : 'session',
    httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite,
    thirdParty: isThirdParty(`https://${host}/`, start.hostname),
    firstSeenOnPage: firstSeen.get(`${cookie.name}@${cookie.domain}`) ?? null,
  };
}

async function runDeepCheck(state, opts, crawl) {
  const sitemap = await discoverSitemapUrls(state.site, { allowInternal: opts.allowInternalHosts });
  const linked = state.pages.flatMap((p) => p.facts?.links ?? [])
    .filter((l) => isSameSite(l.href, state.site))
    .map((l) => ({ url: canonicalPageUrl(l.href, l.href), text: l.text })).filter((c) => c.url);
  const candidates = [...linked, ...sitemap.urls.map((u) => ({ url: canonicalPageUrl(u, u) })).filter((c) => c.url)];
  const coveredTypes = new Set(state.pages.filter((p) => !p.error).map((p) => p.pageType));
  const added = selectDeepCheckUrls(candidates, coveredTypes, state.visited, opts.deepPerType);
  for (const { url } of added) await crawl(url);
  return {
    sitemapSources: sitemap.source, sitemapUrlCount: sitemap.urls.length,
    coveredTypesBefore: [...coveredTypes], added,
    decision: added.length > 0 ? 'Sample missed page types; extra pages scanned.' : 'Sample covers all relevant page types; no deeper scan needed.',
  };
}

function buildResult({ start, transport, state, cookies, deepCheck, consentRuns, startedAt }) {
  return {
    tool: 'website-legal-check-de', scannedAt: new Date(startedAt).toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    startUrl: start.toString(), host: start.hostname, consentGiven: false,
    transport, deepCheck, reuse: state.reuse ?? null, notes: state.notes, cookies,
    requests: state.requests, pages: state.pages, consentRuns,
  };
}

/** Remove navigations the guard blocked from the main scan and from both consent runs. */
export function dropBlockedRequests(state, consentRuns) {
  const keep = (requests) => requests.filter((r) => !state.blocked.has(r.url));
  state.requests = keep(state.requests);
  for (const run of [consentRuns?.reject, consentRuns?.accept]) {
    if (Array.isArray(run?.requests)) run.requests = keep(run.requests);
  }
}
