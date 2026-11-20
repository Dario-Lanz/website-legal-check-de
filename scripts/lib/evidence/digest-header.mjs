// Header part of the evidence digest: site, platform, scan notes, page list, consent runs.

import { hostOf, listLimited, oneLine, shortUrl } from './format.mjs';

const MAX_HOSTS = 25;

function platformLine(profile) {
  const p = profile?.platform;
  if (!p?.name) return 'not detected by the scanner (confidence: none)';
  const extras = p.extras?.length ? `; add-ons: ${p.extras.join(', ')}` : '';
  return `${p.name} (confidence ${p.confidence})${extras}; evidence: ${(p.evidence ?? []).join(' | ')}`;
}

function reuseLine(reuse) {
  if (!reuse) return 'none';
  return `from ${reuse.from} (scanned ${reuse.scannedAt}); ${reuse.unchangedPages?.length ?? 0} pages unchanged, ${reuse.changedPages?.length ?? 0} changed or failed`;
}

function pageLines(pages) {
  return pages.map((p) => `  #${p.index} ${p.url} [${p.pageType ?? '?'}] ${p.status ?? 'no status'}${p.finalUrl && p.finalUrl !== p.url ? ` -> ${p.finalUrl}` : ''}`);
}

/** Third-party hosts of a consent run as "host (service)" strings. */
function thirdPartyHosts(requests) {
  const seen = new Map();
  for (const r of requests ?? []) {
    if (!r.thirdParty) continue;
    const host = hostOf(r.url);
    if (!seen.has(host)) seen.set(host, r.service ?? null);
  }
  return [...seen].map(([host, service]) => (service ? `${host} (${service})` : host));
}

function consentRunLines(choice, run) {
  if (!run) return [`  ${choice}: no data`];
  if (!run.clicked) return [`  ${choice}: not clicked, reason: ${run.reason ?? 'unknown'}`];
  const cookies = (run.newCookies ?? []).map((c) => c.name);
  return [
    `  ${choice}: clicked "${oneLine(run.button).slice(0, 120)}", banner gone: ${run.bannerGone}`,
    `    visited: ${(run.visited ?? []).map(shortUrl).join(' ') || 'none'}`,
    `    third-party hosts after click: ${listLimited(thirdPartyHosts(run.requests), MAX_HOSTS) || 'none'}`,
    `    new cookies: ${listLimited(cookies, MAX_HOSTS) || 'none'}`,
  ];
}

/** Header block of the digest as an array of lines. */
export function headerLines(scan, profile) {
  const lines = [
    '=== SITE ===',
    `host: ${scan.host}  start URL: ${scan.startUrl}  scanned at: ${scan.scannedAt}  duration: ${scan.durationSeconds}s`,
    `platform: ${platformLine(profile)}`,
    `pages scanned: ${profile?.pagesScanned ?? scan.pages.length}; failed: ${(profile?.pagesFailed ?? []).length}; skipped: ${(profile?.pagesSkipped ?? []).length}; shop signals: ${profile?.shopSignals}`,
    `scan notes: ${scan.notes?.length ? scan.notes.join(' | ') : 'none'}`,
    `deep check: ${scan.deepCheck?.decision ?? 'n/a'}`,
    `reuse: ${reuseLine(scan.reuse)}`,
    'pages:',
    ...pageLines(scan.pages),
    '=== CONSENT RUNS ===',
    ...consentRunLines('reject', scan.consentRuns?.reject),
    ...consentRunLines('accept', scan.consentRuns?.accept),
  ];
  return lines;
}
