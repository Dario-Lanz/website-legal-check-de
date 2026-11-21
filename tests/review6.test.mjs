// User decisions 111a (ODR text, redirect duplicates, Cloudflare Web Analytics, grep windows) and 112a lives in the checklist.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkShop } from '../scripts/lib/checks/shop.mjs';
import { findMatches } from '../scripts/lib/evidence/grep-core.mjs';
import { grepPages } from '../scripts/lib/evidence/grep.mjs';
import { scanSite } from '../scripts/lib/scanner.mjs';
import { matchService, policyMentions, serviceByName } from '../scripts/lib/third-parties.mjs';
import { pageKey } from '../scripts/lib/url.mjs';
import { runChecks } from '../scripts/lib/checks/index.mjs';

const facts = (over = {}) => ({ title: '', links: [], buttons: [], forms: [], prices: [], banner: null, bodyText: '', footerText: '', ...over });
const page = (index, path, pageType, over = {}) => ({ index, url: `https://x.de${path}`, finalUrl: `https://x.de${path}`, status: 200, pageType, facts: facts(over) });
const shopScan = (pages) => ({ startUrl: 'https://x.de/', host: 'x.de', pages, requests: [], cookies: [], transport: {} });
const cart = page(9, '/warenkorb', 'cart');

test('ODR-01: the platform address as plain text is found, with page and snippet; links still work', () => {
  for (const text of ['Plattform: https://ec.europa.eu/consumers/odr/ der EU.', 'siehe ec.europa.eu/consumers/odr', 'HTTP://EC.EUROPA.EU/CONSUMERS/ODR/']) {
    const result = checkShop(shopScan([cart, page(1, '/agb', 'terms', { bodyText: `Streitbeilegung. ${text} Ende.` })])).filter((f) => f.check === 'ODR-01');
    assert.equal(result.length, 1, text);
    assert.equal(result[0].status, 'gap');
    assert.deepEqual(result[0].pages, ['https://x.de/agb']);
    assert.equal(result[0].evidence.textMentions[0].page, 'https://x.de/agb');
    assert.match(result[0].evidence.textMentions[0].snippet, /ec\.europa\.eu\/consumers\/odr/i);
  }
  const link = page(2, '/impressum', 'imprint', { links: [{ href: 'https://ec.europa.eu/consumers/odr', text: 'OS', region: 'footer', visible: true }] });
  const viaLink = checkShop(shopScan([cart, link])).filter((f) => f.check === 'ODR-01');
  assert.equal(viaLink.length, 1);
  assert.deepEqual(viaLink[0].pages, ['https://x.de/impressum']);
  assert.deepEqual(checkShop(shopScan([cart, page(3, '/a', 'other', { bodyText: 'Mehr auf ec.europa.eu/consumers/ und europa.eu' })])).filter((f) => f.check === 'ODR-01'), []);
});

test('Cloudflare Web Analytics is a known analytics service; provider data stay empty (no fetched source)', () => {
  for (const url of ['https://static.cloudflareinsights.com/beacon.min.js/v1', 'https://cloudflareinsights.com/cdn-cgi/rum']) {
    const service = matchService(url);
    assert.equal(service?.name, 'Cloudflare Web Analytics', url);
    assert.equal(service.category, 'analytics');
    assert.equal(service.provider, null);
  }
  const service = serviceByName('Cloudflare Web Analytics');
  assert.equal(policyMentions(service, 'Wir nutzen Cloudflare Insights.'), true);
  assert.equal(policyMentions(service, 'Wir nutzen Cloudflare Web Analytics.'), true);
  assert.equal(policyMentions(service, 'Wir nutzen Matomo.'), false);
  assert.equal(matchService('https://cdnjs.cloudflare.com/x.js').name, 'cdnjs (Cloudflare)', 'other Cloudflare services keep their entry');
});

test('Cloudflare Web Analytics before consent is a TDD-01 gap and a DSE-02 hint when the policy is silent', () => {
  const policy = page(2, '/datenschutz', 'privacy', { bodyText: 'Wir nutzen keine Dienste.' });
  const scan = { ...shopScan([page(1, '/', 'other'), policy]), requests: [{ page: 1, url: 'https://static.cloudflareinsights.com/beacon.min.js', thirdParty: true, resourceType: 'script', service: 'Cloudflare Web Analytics', category: 'analytics' }] };
  const findings = runChecks(scan).findings;
  assert.ok(findings.some((f) => f.check === 'TDD-01' && f.evidence.service === 'Cloudflare Web Analytics'));
  assert.ok(findings.some((f) => f.check === 'DSE-02' && f.evidence.services.includes('Cloudflare Web Analytics')));
});

test('grep: overlapping context windows of several matches in one text become one snippet with the match count', () => {
  const text = `${'x '.repeat(200)}Widerruf hier und Widerruf dort und Widerruf da${' y'.repeat(200)} ENDE ${'z '.repeat(300)} Widerruf weit weg`;
  const { snippets } = findMatches([{ field: 'bodyText', text, pages: [1] }], /widerruf/gi);
  assert.equal(snippets.length, 2, 'one merged passage and one far away');
  assert.equal(snippets[0].matches, 3);
  assert.equal(snippets[1].matches, 1);
  assert.equal((snippets[0].text.match(/Widerruf/g) ?? []).length, 3, 'the passage is printed once');
});

test('grep output names the merged match count and the header counts snippets', async () => {
  const body = `Start. Widerruf A und Widerruf B und Widerruf C. ${'füll '.repeat(200)} Widerruf Ende`;
  const out = await grepPages({ pages: [{ index: 1, url: 'https://x.de/', facts: { bodyText: body, footerText: '', links: [] } }] }, 'widerruf');
  assert.match(out, /: 2 distinct matches/);
  assert.match(out, /\(3 matches\)/);
  assert.equal(out.split('\n').filter((l) => l.startsWith('[bodyText]')).length, 2);
});

test('page keys: double slashes collapse, www and the bare host are one origin, nothing else changes', () => {
  assert.equal(pageKey('https://www.keeeper.com/de//kitchen'), pageKey('https://keeeper.com/de/kitchen/'));
  assert.notEqual(pageKey('https://x.com/a'), pageKey('https://y.com/a'));
  assert.notEqual(pageKey('http://x.com/a'), pageKey('https://x.com/a'), 'scheme stays part of the key');
  assert.notEqual(pageKey('https://x.com/a?page_id=1'), pageKey('https://x.com/a?page_id=2'));
});

test('redirect duplicates: /cart and /checkout redirecting to /warenkorb are scanned once', async () => {
  const body = (title, extra = '') => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${extra}</body></html>`;
  const routes = {
    '/': body('Start', '<nav><a href="/cart">Cart</a> <a href="/checkout">Checkout</a> <a href="/warenkorb">Warenkorb</a> <a href="/info">Info</a></nav>'),
    '/warenkorb': body('Warenkorb'), '/info': body('Info'),
  };
  const server = createServer((req, res) => {
    if (req.url === '/cart' || req.url === '/checkout') { res.writeHead(302, { location: '/warenkorb' }).end(); return; }
    const html = routes[req.url];
    if (html) res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html); else res.writeHead(404).end('nf');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(path.join(tmpdir(), 'wlc-redir-'));
  try {
    const scan = await scanSite({ startUrl: `http://127.0.0.1:${server.address().port}/`, outDir: dir, deep: false, allowInternalHosts: true, delayMs: 0, settleMs: 200 });
    const finals = scan.pages.map((p) => new URL(p.finalUrl ?? p.url).pathname);
    assert.equal(finals.filter((p) => p === '/warenkorb').length, 1, finals.join(' '));
    assert.deepEqual(scan.pages.map((p) => p.index), scan.pages.map((_, i) => i + 1), 'page indexes stay consecutive');
    assert.ok(scan.requests.every((r) => scan.pages.some((p) => p.index === r.page)), 'no request of a dropped duplicate stays');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('last review: cookies first seen on a dropped redirect visit are attributed to the page that was scanned, not to the next page', async () => {
  const page = (title, extra = '') => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${extra}</body></html>`;
  const server = createServer((req, res) => {
    if (req.url === '/checkout') { res.writeHead(302, { location: '/warenkorb', 'set-cookie': 'late=1; Path=/' }).end(); return; }
    const html = { '/': page('Start', '<nav><a href="/warenkorb">W</a> <a href="/checkout">C</a> <a href="/info">I</a></nav>'), '/warenkorb': page('Warenkorb'), '/info': page('Info') }[req.url];
    if (html) res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html); else res.writeHead(404).end('nf');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(path.join(tmpdir(), 'wlc-cookie-'));
  try {
    const scan = await scanSite({ startUrl: `http://127.0.0.1:${server.address().port}/`, outDir: dir, deep: false, allowInternalHosts: true, delayMs: 0, settleMs: 200 });
    const warenkorb = scan.pages.find((p) => new URL(p.finalUrl ?? p.url).pathname === '/warenkorb');
    const late = scan.cookies.find((c) => c.name === 'late');
    assert.ok(late && warenkorb);
    assert.equal(late.firstSeenOnPage, warenkorb.index);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('ODR-01: a mention next to "eingestellt" or "shut down" is marked as possibly explanatory (not suppressed)', () => {
  const run = (text) => checkShop(shopScan([cart, page(1, '/agb', 'terms', { bodyText: text })])).find((f) => f.check === 'ODR-01');
  assert.equal(run('Die Plattform https://ec.europa.eu/consumers/odr wurde am 20.07.2025 eingestellt.').evidence.textMentions[0].possiblyExplanatory, true);
  assert.equal(run('The platform ec.europa.eu/consumers/odr was shut down.').evidence.textMentions[0].possiblyExplanatory, true);
  assert.equal(run('Streitbeilegung über https://ec.europa.eu/consumers/odr/ möglich.').evidence.textMentions[0].possiblyExplanatory, false);
});

test('Cloudflare Web Analytics keeps only its specific keywords: a CDN mention is no mention of the analytics', () => {
  const service = serviceByName('Cloudflare Web Analytics');
  assert.equal(policyMentions(service, 'Unser Hosting nutzt das Cloudflare CDN.'), false);
  assert.deepEqual(service.keywords, ['cloudflare web analytics', 'cloudflare insights']);
});
