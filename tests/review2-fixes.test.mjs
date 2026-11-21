// Regression tests for the second review round (opus-review-1): reuse figures, banner choice, timeouts,
// price signals, legal links on other domains, SSRF limits, mock-up isolation, VAT note, patterns.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { serveFixture } from './helpers.mjs';
import { collectPageFacts } from '../scripts/lib/collect-page.mjs';
import { runChecks } from '../scripts/lib/checks/index.mjs';
import { looksLikeShop, PATTERNS } from '../scripts/lib/checks/helpers.mjs';
import { checkImprintDetails } from '../scripts/lib/checks/legal-content.mjs';
import { checkLegalPages } from '../scripts/lib/checks/legal-pages.mjs';
import { checkShop } from '../scripts/lib/checks/shop.mjs';
import { matchService } from '../scripts/lib/third-parties.mjs';
import { isPublicHost } from '../scripts/lib/public-host.mjs';
import { scanSite } from '../scripts/lib/scanner.mjs';
import { discoverSitemapUrls, fetchText } from '../scripts/lib/sitemap.mjs';
import { checkTransport } from '../scripts/lib/transport.mjs';
import { prepareImages } from '../scripts/lib/report/images.mjs';

const withFigures = (...srcs) => [{ figures: srcs.map((src) => ({ src })) }];

/** Write a solid colour PNG using the browser. */
async function writePng(browser, file, color) {
  const p = await browser.newPage();
  try {
    await p.setContent(`<body style="margin:0;background:${color};width:200px;height:200px"></body>`);
    await p.screenshot({ path: file, clip: { x: 0, y: 0, width: 200, height: 200 } });
  } finally {
    await p.close();
  }
}

// Finding 1
test('long build: reuse figures of an earlier run beside this one are accepted, other paths are refused', async () => {
  const runs = await mkdtemp(path.join(tmpdir(), 'wlc-r2-'));
  const browser = await chromium.launch();
  try {
    const oldBelege = path.join(runs, 'old', 'daten', 'belege');
    const newDaten = path.join(runs, 'new', 'daten');
    await mkdir(oldBelege, { recursive: true });
    await mkdir(path.join(runs, 'other'), { recursive: true });
    await mkdir(newDaten, { recursive: true });
    await writePng(browser, path.join(oldBelege, 'a.png'), '#08f');
    await writeFile(path.join(runs, 'old', 'daten', 'secret.txt'), 'x');
    await writeFile(path.join(runs, 'other', 'secret.txt'), 'x');
    const ok = '../../old/daten/belege/a.png';
    const { figures } = await prepareImages(browser, newDaten, withFigures(ok));
    assert.match(figures.get(ok), /^data:image\/jpeg/);
    for (const bad of ['../../old/daten/secret.txt', '../../other/secret.txt', '../../old/daten/belege/../secret.txt', '../../../x/daten/belege/a.png']) {
      await assert.rejects(prepareImages(browser, newDaten, withFigures(bad)), /outside|belege|not found/i, bad);
    }
  } finally {
    await browser.close();
    await rm(runs, { recursive: true, force: true });
  }
});

// Finding 7
test('mock-ups cannot embed local files outside the data folder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wlc-r2-'));
  const browser = await chromium.launch();
  try {
    const daten = path.join(dir, 'daten');
    await mkdir(daten, { recursive: true });
    await writePng(browser, path.join(dir, 'secret.png'), '#f00');
    await writePng(browser, path.join(daten, 'inside.png'), '#00f');
    const secretUrl = new URL(`file://${path.join(dir, 'secret.png')}`).href;
    const html = (src) => `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff"><img src="${src}" style="display:block;width:200px;height:200px">`;
    await writeFile(path.join(daten, 'leak.html'), html(secretUrl));
    await writeFile(path.join(daten, 'ok.html'), html('inside.png'));
    const centre = async (uri) => {
      const p = await browser.newPage();
      try {
        return await p.evaluate(async (src) => {
          const img = new Image(); img.src = src; await img.decode();
          const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
          const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
          return [...ctx.getImageData(50, 50, 1, 1).data];
        }, uri);
      } finally {
        await p.close();
      }
    };
    const { mockups } = await prepareImages(browser, daten, [{ figures: [], mockup: { file: 'ok.html' } }]);
    const [r1, , b1] = await centre(mockups.get('ok.html'));
    assert.ok(b1 > 200 && r1 < 80, `inside image shown, got r=${r1} b=${b1}`);
    const leak = await prepareImages(browser, daten, [{ figures: [], mockup: { file: 'leak.html' } }]);
    const [r2, , b2] = await centre(leak.mockups.get('leak.html'));
    assert.ok(!(r2 > 200 && b2 < 80), 'file outside the data folder was embedded');
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Finding 2
test('banner: the outermost box wins when the choices sit in a sibling of the message (BEM), the nested case stays tight', async () => {
  const site = await serveFixture('scanner-fixes');
  const browser = await chromium.launch({ args: site.launchArgs });
  try {
    const factsOf = async (file) => {
      const page = await browser.newPage();
      try {
        await page.goto(`${site.base}/${file}`);
        const facts = await page.evaluate(collectPageFacts);
        const marked = await page.locator('[data-wlc-banner="1"] >> text=Ablehnen').count();
        return { ...facts, marked };
      } finally {
        await page.close();
      }
    };
    const bem = await factsOf('bem-banner.html');
    assert.deepEqual(bem.banner.buttons, ['Alle akzeptieren', 'Ablehnen', 'Einstellungen']);
    assert.equal(bem.marked, 1, 'the marked element contains the reject link');
    assert.deepEqual((await factsOf('nested-banner.html')).banner.buttons, ['Alle ablehnen', 'Alle akzeptieren']);
    assert.equal((await factsOf('modernizr.html')).banner, null);
  } finally {
    await browser.close();
    await site.close();
  }
});

/** Tiny HTTP server for one test; close() also drops open connections. */
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

// Finding 3
test('the time limit hits during the consent runs: scan.json and the checks are still written', { timeout: 60_000 }, async () => {
  let browserVisits = 0;
  const server = await serve((req, res) => {
    if (!/Mozilla/.test(req.headers['user-agent'] ?? '')) return res.writeHead(404).end();
    if (req.url !== '/') return res.writeHead(404).end();
    browserVisits += 1;
    if (browserVisits > 1) return undefined; // the consent runs never get an answer
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Firma</title></head><body><main><p>Firma</p></main></body></html>');
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'wlc-r2-'));
  try {
    const scan = await scanSite({ startUrl: `http://127.0.0.1:${server.port}/`, outDir: dir, deep: false, allowInternalHosts: true, delayMs: 0, settleMs: 100, pageTimeoutMs: 120_000, maxTotalMs: 6_000 });
    assert.ok(scan.notes.some((n) => /Time limit/.test(n)), scan.notes.join('|'));
    assert.equal(JSON.parse(await readFile(path.join(dir, 'scan.json'), 'utf8')).pages.length, 1);
    assert.ok(runChecks(scan).findings.length > 0);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Finding 6
test('isPublicHost: localhost, private, loopback and link-local addresses and internal names are not public', () => {
  for (const host of ['localhost', 'foo.localhost', 'printer.local', 'db.internal', 'intranet', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1',
    '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '[::1]', '[::]', '[fd00::1]', '[fe80::1]', '[::ffff:7f00:1]', '[::ffff:c0a8:101]']) {
    assert.equal(isPublicHost(host), false, host);
  }
  for (const host of ['example.de', 'www.example.co.uk', '93.184.216.34', '172.32.0.1', '[2606:4700::1111]', 'xn--mller-kva.de']) {
    assert.equal(isPublicHost(host), true, host);
  }
});

test('a sitemap that redirects to another host or an internal address is not followed; own-host redirects are', async () => {
  const hits = [];
  const server = await serve((req, res) => {
    hits.push(`${(req.headers.host ?? '').split(':')[0]}${req.url}`);
    if (req.url === '/to-internal') return res.writeHead(302, { location: `http://localhost:${server.port}/secret.xml` }).end();
    if (req.url === '/to-own') return res.writeHead(302, { location: `http://127.0.0.1:${server.port}/own.xml` }).end();
    return res.writeHead(200).end('<urlset/>');
  });
  try {
    assert.equal(await fetchText(`http://127.0.0.1:${server.port}/to-internal`), null);
    assert.ok(!hits.includes('localhost/secret.xml'), hits.join(','));
    assert.equal(await fetchText(`http://127.0.0.1:${server.port}/to-own`), '<urlset/>');
    const found = await discoverSitemapUrls(new URL(`http://127.0.0.1:${server.port}/`));
    assert.deepEqual(found.urls, []);
  } finally {
    await server.close();
  }
});

test('the http-to-https check does not follow a redirect to an internal host', async () => {
  const server = await serve((req, res) => {
    if (req.url === '/') return res.writeHead(301, { location: `http://localhost:${server.port}/plain` }).end();
    return res.writeHead(200).end('x');
  });
  try {
    assert.equal((await checkTransport(new URL(`http://127.0.0.1:${server.port}/`))).httpRedirectsToHttps, null);
  } finally {
    await server.close();
  }
});

test('a start page that forwards to localhost does not make localhost the website', { timeout: 60_000 }, async () => {
  const server = await serve((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    if (host === '127.0.0.1') return res.writeHead(302, { location: `http://localhost:${server.port}/` }).end();
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="de"><head><meta charset="utf-8"><title>F</title></head><body><main><p>F</p></main><footer><a href="/impressum.html">Impressum</a></footer></body></html>');
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'wlc-r2-'));
  try {
    // Since review round 3 the browser itself no longer follows the redirect (see review3-fixes.test.mjs).
    await assert.rejects(scanSite({ startUrl: `http://127.0.0.1:${server.port}/`, outDir: dir, deep: false, delayMs: 0, settleMs: 100 }), /Start page not reachable.*localhost blocked: not a public host/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Finding 4
const facts = (over = {}) => ({ title: '', links: [], buttons: [], forms: [], prices: [], banner: null, bodyText: '', footerText: '', ...over });
const pageOf = (index, url, pageType, over = {}) => ({ index, url, finalUrl: url, status: 200, pageType, facts: facts(over), ...{} });

test('prices: share capital and fine amounts are no prices, a real price stays', async () => {
  const site = await serveFixture('review2-fixes');
  const browser = await chromium.launch({ args: site.launchArgs });
  try {
    const page = await browser.newPage();
    await page.goto(`${site.base}/amounts.html`);
    const texts = (await page.evaluate(collectPageFacts)).prices.map((p) => p.text);
    assert.deepEqual(texts, ['Kaffee 49 €']);
  } finally {
    await browser.close();
    await site.close();
  }
});

test('legal pages with amounts do not make a shop: no shop checks run for a non-shop GmbH', () => {
  const price = [{ text: '25.000 €', context: 'Stammkapital 25.000 €' }];
  const scan = { startUrl: 'https://x.de/', pages: [
    pageOf(1, 'https://x.de/', 'other'), pageOf(2, 'https://x.de/impressum', 'imprint', { prices: price }),
    pageOf(3, 'https://x.de/datenschutz', 'privacy', { prices: price }),
  ], requests: [], cookies: [], transport: {} };
  assert.equal(looksLikeShop(scan), false);
  assert.deepEqual(checkShop(scan).filter((f) => /^(PRC|WID|BTN|KUE)/.test(f.check)), []);
  scan.pages.push(pageOf(4, 'https://x.de/a', 'other', { prices: price }), pageOf(5, 'https://x.de/b', 'other', { prices: price }));
  assert.equal(looksLikeShop(scan), false, 'prices on ordinary pages alone are no shop evidence (user decision, fix 4)');
});

// Finding 5
test('IMP-01/DSE-01: a group imprint on another domain is a hint, vendor hosts do not count, a hidden link is a hint', () => {
  const link = (href, text, extra = {}) => ({ href, text, region: 'footer', visible: true, ...extra });
  const run = (check, links) => checkLegalPages({ startUrl: 'https://marke.de/', pages: [pageOf(1, 'https://marke.de/', 'other', { links })], requests: [], cookies: [], transport: {} })
    .filter((f) => f.check === check);
  const group = run('IMP-01', [link('https://konzern.de/impressum', 'Impressum')]);
  assert.deepEqual(group.map((f) => f.status), ['hint']);
  assert.deepEqual(group[0].evidence.otherDomain, ['https://marke.de/']);
  assert.deepEqual(run('DSE-01', [link('https://policies.google.com/privacy', 'Datenschutz')]).map((f) => f.status), ['gap']);
  assert.deepEqual(run('DSE-01', [link('https://www.facebook.com/privacy', 'Datenschutz')]).map((f) => f.status), ['gap']);
  const hidden = run('IMP-01', [link('https://marke.de/impressum', 'Impressum', { visible: false })]);
  assert.deepEqual(hidden.map((f) => f.status), ['hint']);
  assert.deepEqual(hidden[0].evidence.notVisible, ['https://marke.de/']);
  assert.deepEqual(run('IMP-01', [link('https://marke.de/impressum', 'Impressum')]).map((f) => f.status), ['ok']);
});

// Finding 8
test('VAT note: "MwSt. inkl. Versand" and "zzgl. MwSt. ... enthalten" are no inclusive-VAT note', () => {
  for (const text of ['Preise zzgl. MwSt. inkl. Versand', 'Preise zzgl. gesetzl. MwSt. enthalten', 'Alle Preise MwSt. inkl. Versandkosten']) {
    assert.equal(PATTERNS.vatNote.test(text), false, text);
  }
  for (const text of ['Preise inkl. MwSt.', 'Alle Preise MwSt. enthalten', 'Preise: MwSt. inklusive.', 'Alle Preise (MwSt. inkl.)']) {
    assert.equal(PATTERNS.vatNote.test(text), true, text);
  }
  const priced = pageOf(1, 'https://x.de/', 'product', { prices: [{ text: '9 €', context: '' }], bodyText: 'Preise zzgl. MwSt. inkl. Versand' });
  const noteOf = (page) => checkShop({ startUrl: 'https://x.de/', pages: [page], requests: [], cookies: [], transport: {} }).filter((f) => f.check === 'PRC-01').map((f) => f.status);
  assert.deepEqual(noteOf(priced), ['hint']);
});

// Finding 10
test('gtag/js: AW- and DC- ids are Google Ads, G- ids and the rest stay Google Analytics; the policy needs the right name', () => {
  const gtag = (id) => `https://www.googletagmanager.com/gtag/js?id=${id}`;
  assert.equal(matchService(gtag('AW-123'))?.name, 'Google Ads / DoubleClick');
  assert.equal(matchService(gtag('DC-9'))?.name, 'Google Ads / DoubleClick');
  assert.equal(matchService(gtag('G-ABC'))?.name, 'Google Analytics');
  assert.equal(matchService('https://www.googletagmanager.com/gtag/js')?.name, 'Google Analytics');
  const scanWith = (id, policyText) => ({
    startUrl: 'https://x.de/', cookies: [], transport: {}, consentRuns: null,
    requests: [{ page: 1, url: gtag(id), thirdParty: true, resourceType: 'script' }],
    pages: [pageOf(1, 'https://x.de/', 'other'), pageOf(2, 'https://x.de/datenschutz', 'privacy', { bodyText: policyText })],
  });
  const missing = (scan) => checkLegalPages(scan).filter((f) => f.check === 'DSE-02').flatMap((f) => f.evidence.services);
  assert.deepEqual(missing(scanWith('AW-123', 'Wir nutzen Google Ads.')), []);
  assert.deepEqual(missing(scanWith('G-ABC', 'Wir nutzen Google Ads.')), ['Google Analytics']);
  assert.deepEqual(missing(scanWith('AW-123', 'Wir nutzen Google Analytics.')), ['Google Ads / DoubleClick']);
});

// Finding 11
test('IMP-04: specialist doctors and interior architects need a chamber; "Informationsarchitektur" does not; "früher TMG" is no outdated reference', () => {
  const run = (text) => checkImprintDetails({ startUrl: 'https://x.de/', pages: [pageOf(1, 'https://x.de/impressum', 'imprint', { bodyText: text })], requests: [], cookies: [], transport: {} })
    .map((f) => f.evidence.missing ?? f.evidence.outdated);
  for (const word of ['Fachärztin für Innere Medizin', 'Facharzt für Chirurgie', 'Innenarchitekt Max Muster', 'Landschaftsarchitektin Eva Muster']) {
    assert.deepEqual(run(`Praxis ${word}`), ['chamber'], word);
  }
  assert.deepEqual(run('Beratung für Informationsarchitektur und Softwarearchitektur'), []);
  assert.deepEqual(run('Angaben gemäß § 5 DDG (früher TMG)'), []);
  assert.deepEqual(run('Angaben gemäß § 5 DDG (früher § 5 TMG)'), []);
  assert.deepEqual(run('Angaben gemäß § 5 TMG'), ['§ 5 TMG']);
});

test('a gzip sitemap that fetch already decompressed (Content-Encoding x-gzip) is used as text', async () => {
  const xml = '<urlset><url><loc>http://127.0.0.1/a</loc></url></urlset>';
  const server = await serve((req, res) => {
    if (req.url === '/plain.xml.gz') return res.writeHead(200, { 'content-type': 'application/gzip' }).end(xml);
    return res.writeHead(200, { 'content-type': 'application/xml', 'content-encoding': 'x-gzip' }).end(gzipSync(xml));
  });
  try {
    assert.equal(await fetchText(`http://127.0.0.1:${server.port}/sitemap.xml.gz`), xml);
    assert.equal(await fetchText(`http://127.0.0.1:${server.port}/plain.xml.gz`), xml, 'text that only claims gzip');
  } finally {
    await server.close();
  }
});
