// Imprint, privacy policy, withdrawal, terms and accessibility statement: present and
// reachable from every scanned page.

import { matchService, policyMentions } from '../third-parties.mjs';
import { contentPages, finding, hasLink, isErrorStatus, legalLinkKind, looksLikeShop, okPages, pageOfType, PATTERNS, policyPage, shotsOf } from './helpers.mjs';

const url = (p) => p.finalUrl ?? p.url;

/** A legal link must be on every page, on the site itself and visible; report pages without it or with a doubtful one. */
function linkOnEveryPage(scan, check, pattern, label) {
  const pages = contentPages(scan);
  if (pages.length === 0) {
    return [finding(check, 'hint', `No page could be scanned, ${label} link not checkable`, [], { pagesFailed: scan.pages.length })];
  }
  const kinds = pages.map((p) => ({ page: p, kind: legalLinkKind(p, pattern) }));
  const missing = kinds.filter((k) => k.kind === null).map((k) => k.page);
  const doubtful = kinds.filter((k) => k.kind === 'hidden' || k.kind === 'otherDomain');
  const results = [];
  if (missing.length > 0) {
    const title = missing.length === pages.length
      ? `No ${label} link found on any scanned page`
      : `${label} link missing on ${missing.length} of ${pages.length} pages`;
    results.push(finding(check, 'gap', title, missing.map(url), {
      screenshots: missing.slice(0, 3).flatMap(shotsOf),
      footerText: missing[0].facts.footerText.slice(0, 400),
    }));
  }
  if (doubtful.length > 0) {
    results.push(finding(check, 'hint', `${label} link leads to another domain or is not visible on ${doubtful.length} of ${pages.length} pages, please check`, doubtful.map((k) => url(k.page)), {
      otherDomain: doubtful.filter((k) => k.kind === 'otherDomain').map((k) => url(k.page)),
      notVisible: doubtful.filter((k) => k.kind === 'hidden').map((k) => url(k.page)),
      screenshots: doubtful.slice(0, 3).flatMap((k) => shotsOf(k.page)),
    }));
  }
  return results.length > 0 ? results : [finding(check, 'ok', `${label} link on every scanned page`, [])];
}

/** The legal page itself answers with an HTTP error (404, 500 ...): the link leads nowhere. */
function legalPageErrors(scan, check, type, label) {
  const broken = okPages(scan).filter((p) => p.pageType === type && isErrorStatus(p));
  if (broken.length === 0) return [];
  return [finding(check, 'gap', `${label} page answers with an HTTP error`, broken.map(url),
    { status: broken.map((p) => p.status), screenshots: broken.slice(0, 3).flatMap(shotsOf) })];
}

/** The ok finding of a check is dropped when its legal page is broken. */
function withPageErrors(scan, check, type, label, linkFindings) {
  const errors = legalPageErrors(scan, check, type, label);
  return errors.length > 0 && linkFindings[0].status === 'ok' ? errors : [...linkFindings, ...errors];
}

/** Postal code and town; a four-digit number counts only with country prefix or outside year and copyright context. */
function hasPostalAddress(text) {
  if (/\b\d{5}\s+[A-ZÄÖÜ][\wäöüß-]+/.test(text) || /\b(A|CH)-\d{4}\b/.test(text)) return true;
  const fourDigits = /(.{0,12})\b(\d{4})\s+[A-ZÄÖÜ][\wäöüß-]+/g;
  for (const [, before, digits] of text.matchAll(fourDigits)) {
    if (!/©|\(c\)|copyright|seit|stand/i.test(before) && !/^(19|20)\d\d$/.test(digits)) return true;
  }
  return false;
}

export const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+|\[at\]|\(at\)|@/i;
export const VAT_ID_PATTERN = /umsatzsteuer|ust-?id|ust\.?-?idnr|\bvat\b/i;

/** Minimal content signals on the imprint page (§ 5 DDG): e-mail and postal address. */
function imprintContent(scan) {
  const page = pageOfType(scan, 'imprint');
  if (!page) return [];
  const text = page.facts.bodyText;
  const results = [];
  const hasEmail = EMAIL_PATTERN.test(text);
  const hasAddress = hasPostalAddress(text);
  if (!hasEmail) results.push(finding('IMP-02', 'gap', 'Imprint page shows no e-mail address', [url(page)], { screenshots: shotsOf(page) }));
  if (!hasAddress) results.push(finding('IMP-02', 'hint', 'Imprint page: no postal code and town recognised', [url(page)], { screenshots: shotsOf(page) }));
  if (!VAT_ID_PATTERN.test(text)) {
    results.push(finding('IMP-03', 'hint', 'Imprint page names no VAT ID (required only if one exists)', [url(page)]));
  }
  return results;
}

/** Third-party services seen in requests but not named in the privacy policy. */
function servicesMissingInPolicy(scan) {
  const policy = policyPage(scan);
  if (!policy) return [];
  // Before consent and after "accept" (decision 47b): everything that loads must be named.
  const services = new Map();
  const collect = (requests, when) => {
    for (const request of requests) {
      const service = request.thirdParty ? matchService(request.url) : null;
      if (service && service.category !== 'consent' && !services.has(service.name)) services.set(service.name, { service, when });
    }
  };
  collect(scan.requests, 'before consent');
  collect(scan.consentRuns?.accept?.requests ?? [], 'after accept');
  const missing = [...services.values()].filter(({ service }) => !policyMentions(service, policy.facts.bodyText));
  if (missing.length === 0) return [];
  return [finding('DSE-02', 'hint', 'Third-party services loaded but not named in the privacy policy',
    [url(policy)], {
      services: missing.map(({ service }) => service.name),
      loaded: Object.fromEntries(missing.map(({ service, when }) => [service.name, when])),
      providers: Object.fromEntries(missing.map(({ service }) => [service.name, service.provider ?? null])),
    })];
}

function shopLegalPages(scan) {
  if (!looksLikeShop(scan)) return [];
  const pages = okPages(scan);
  const any = (pattern) => pages.some((p) => hasLink(p, pattern));
  const results = [];
  if (!any(PATTERNS.withdrawal) && !pageOfType(scan, 'withdrawal')) {
    results.push(finding('WID-01', 'gap', 'Shop signals found, but no withdrawal policy (Widerrufsbelehrung) linked', []));
  }
  if (!any(PATTERNS.terms)) results.push(finding('AGB-01', 'hint', 'Shop signals found, but no terms (AGB) linked', []));
  if (!any(PATTERNS.accessibility)) {
    results.push(finding('BF-02', 'hint', 'No accessibility statement linked (BFSG; micro-enterprises providing services are exempt)', []));
  }
  return results;
}

export function checkLegalPages(scan) {
  return [
    ...withPageErrors(scan, 'IMP-01', 'imprint', 'Imprint (Impressum)', linkOnEveryPage(scan, 'IMP-01', PATTERNS.imprint, 'Imprint (Impressum)')),
    ...withPageErrors(scan, 'DSE-01', 'privacy', 'Privacy policy (Datenschutzerklärung)', linkOnEveryPage(scan, 'DSE-01', PATTERNS.privacy, 'Privacy policy (Datenschutzerklärung)')),
    ...imprintContent(scan),
    ...servicesMissingInPolicy(scan),
    ...shopLegalPages(scan),
  ];
}
