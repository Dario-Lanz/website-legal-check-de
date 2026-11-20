// Sub-modes of evidence.mjs that replace ad-hoc queries into scan.json: --page, --requests
// (--grep lives in grep.mjs). Pure functions over the parsed scan; output is capped and says when cut.

import { clip, hostOf, listLimited, oneLine } from './format.mjs';

const MAX_LINKS = 150;
const MAX_TEXT_CHARS = 30000;
const MAX_URLS_PER_HOST = 15;

function bannerLines(banner) {
  if (!banner) return ['banner: none'];
  const buttons = (banner.buttons ?? []).map((b) => (typeof b === 'string' ? b : b.text));
  return [`banner: selector ${banner.selector}`, `  text: ${clip(oneLine(banner.text), 1500)}`, `  buttons: ${buttons.join(' | ') || 'none'}`];
}

function formLines(forms) {
  return (forms ?? []).map((f) => `  ${f.method?.toUpperCase()} ${f.action} email:${f.hasEmail} password:${f.hasPassword} textarea:${f.hasTextarea} file:${f.hasFile} text: ${clip(oneLine(f.text), 300)}`);
}

function linkLines(links) {
  const lines = (links ?? []).slice(0, MAX_LINKS).map((l) => `  [${l.region}${l.visible ? '' : ', hidden'}] ${oneLine(l.text) || '(no text)'} -> ${l.href}`);
  if ((links ?? []).length > MAX_LINKS) lines.push(`  (+${links.length - MAX_LINKS} more links not shown)`);
  return lines;
}

/** One page's facts in readable form. */
export function describePage(scan, index) {
  const page = scan.pages.find((p) => p.index === index);
  if (!page) throw new Error(`no page with index ${index} (valid: 1-${scan.pages.length})`);
  const f = page.facts ?? {};
  return [
    `#${page.index} ${page.url} [${page.pageType}] status ${page.status}${page.finalUrl !== page.url ? ` final: ${page.finalUrl}` : ''}`,
    `title: ${f.title}  lang: ${f.lang}  generator: ${f.generator ?? 'none'}`,
    `screenshots: ${Object.values(page.screenshots ?? {}).join(', ') || 'none'}`,
    ...bannerLines(f.banner),
    `buttons: ${(f.buttons ?? []).map((b) => `${oneLine(b.text)} [${b.region}${b.visible ? '' : ', hidden'}]`).join(' | ') || 'none'}`,
    `forms (${(f.forms ?? []).length}):`, ...formLines(f.forms),
    `prices: ${(f.prices ?? []).map((p) => oneLine(p.context ?? p.text)).join(' | ') || 'none'}`,
    `iframes: ${(f.iframes ?? []).map((i) => i.src.slice(0, 120)).join(' | ') || 'none'}`,
    `links (${(f.links ?? []).length}):`, ...linkLines(f.links),
    `footerText: ${oneLine(f.footerText)}`,
    `bodyText: ${clip(oneLine(f.bodyText), MAX_TEXT_CHARS)}`,
  ].join('\n');
}

function groupByHost(requests) {
  const groups = new Map();
  for (const r of requests) {
    const host = hostOf(r.url);
    const g = groups.get(host) ?? { host, service: r.service, category: r.category, thirdParty: r.thirdParty, count: 0, pages: new Set(), urls: [] };
    g.count += 1;
    g.pages.add(r.page);
    if (g.urls.length < MAX_URLS_PER_HOST && !g.urls.some((u) => u.url === r.url)) g.urls.push({ page: r.page, url: r.url, type: r.resourceType });
    groups.set(host, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function groupLines(g, withUrls) {
  const label = `${g.host}  service: ${g.service ?? '-'}  category: ${g.category ?? '-'}${g.thirdParty ? '' : '  (first party)'}`;
  const pages = listLimited([...g.pages].sort((a, b) => a - b).map((p) => `#${p}`), 20);
  const lines = [`${label}  requests: ${g.count}  pages: ${pages}`];
  if (withUrls) lines.push(...g.urls.map((u) => `    #${u.page} [${u.type}] ${u.url}`));
  return lines;
}

/** Third-party requests grouped by host; with `host`, requests of every host containing it, with URLs. */
export function describeRequests(scan, host) {
  const needle = host ? host.toLowerCase() : null;
  const pool = scan.requests.filter((r) => (needle ? hostOf(r.url).toLowerCase().includes(needle) : r.thirdParty));
  if (pool.length === 0) return needle ? `no requests to a host containing "${host}"` : 'no third-party requests';
  const groups = groupByHost(pool);
  const head = needle
    ? `requests to hosts containing "${host}": ${pool.length} requests, ${groups.length} hosts`
    : `third-party requests (before consent, main scan): ${pool.length} requests, ${groups.length} hosts`;
  return [head, ...groups.flatMap((g) => groupLines(g, Boolean(needle)))].join('\n');
}
