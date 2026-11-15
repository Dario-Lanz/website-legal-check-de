// Scanner fixes of the v1.15.1 review: page timeouts, banner detection, redirects, first-party host,
// classification, sitemap limits, registrable domains, prices, reuse guards.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright';
import { collectPageFacts } from '../scripts/lib/collect-page.mjs';
import { classifyPage, classifyVisitedPage } from '../scripts/lib/page-types.mjs';
import { scanSite } from '../scripts/lib/scanner.mjs';
import { discoverSitemapUrls, fetchText } from '../scripts/lib/sitemap.mjs';
import { checkTransport } from '../scripts/lib/transport.mjs';
import { baseDomain, isThirdParty } from '../scripts/lib/url.mjs';
import { serveFixture } from './helpers.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scanner-fixes');
const FAST = { delayMs: 0, settleMs: 300 };

/** Local http server with a handler; returns base URL and close(). */
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

describe('page classification (finding 10)', () => {
  test('look-alike paths are no shop pages', () => {
    for (const p of ['/krankenkasse', '/sparkasse', '/kassensysteme', '/p/ueber-uns']) {
      assert.equal(classifyPage(`https://x.de${p}`), 'other', p);
    }
    assert.equal(classifyPage('https://x.de/kasse'), 'checkout');
    assert.equal(classifyPage('https://x.de/kasse.html'), 'checkout');
    assert.equal(classifyPage('https://x.de/zur-kasse/'), 'checkout');
  });

  test('the title identifies legal pages only, never the root and never against the path', () => {
    assert.equal(classifyVisitedPage('https://x.de/', 'Kanzlei für Datenschutz'), 'other');
    assert.equal(classifyVisitedPage('https://x.de/info/rechtliches', 'Datenschutzerklärung'), 'privacy');
    assert.equal(classifyVisitedPage('https://x.de/blog/neue-regeln', 'Neue Datenschutz-Regeln'), 'blog');
    assert.equal(classifyVisitedPage('https://x.de/seite', 'Tisch bestellen'), 'other');
    assert.equal(classifyVisitedPage('https://x.de/seite', 'Zur Kasse'), 'other');
  });
});

describe('registrable domain (finding 16)', () => {
  test('public suffixes and hosting platforms keep their customers apart', () => {
    assert.equal(baseDomain('foo.gov.uk'), 'foo.gov.uk');
    assert.equal(isThirdParty('https://bar.gov.uk/a.js', 'foo.gov.uk'), true);
    assert.equal(isThirdParty('https://other.github.io/a.js', 'me.github.io'), true);
    assert.equal(isThirdParty('https://a.myshopify.com/a.js', 'b.myshopify.com'), true);
    assert.equal(isThirdParty('https://cdn.me.github.io/a.js', 'me.github.io'), false);
    assert.equal(isThirdParty('https://cdn.xyz.de/a.js', 'www.xyz.de'), false);
  });
});

describe('http to https redirect (finding 7)', () => {
  const routes = {
    '/two-hop': { status: 301, location: (port) => `http://127.0.0.1:${port}/hop2` },
    '/hop2': { status: 301, location: () => 'https://example.invalid/' },
    '/forbidden': { status: 403 },
    '/plain': { status: 200 },
    '/loop': { status: 301, location: (port) => `http://127.0.0.1:${port}/loop` },
  };
  let server;
  before(async () => {
    server = await serve((req, res) => {
      const route = routes[req.url];
      const headers = route?.location ? { location: route.location(server.port) } : {};
      res.writeHead(route?.status ?? 404, headers).end('x');
    });
  });
  after(() => server.close());
  const transportOf = (p) => checkTransport(new URL(`http://127.0.0.1:${server.port}${p}`));

  test('a two-hop chain that ends on https is a redirect', async () => {
    assert.equal((await transportOf('/two-hop')).httpRedirectsToHttps, true);
  });

  test('an answer other than 2xx on port 80 is undecided, not a gap', async () => {
    assert.equal((await transportOf('/forbidden')).httpRedirectsToHttps, null);
    assert.equal((await transportOf('/loop')).httpRedirectsToHttps, null);
  });

  test('an http page that answers 2xx is a gap', async () => {
    assert.equal((await transportOf('/plain')).httpRedirectsToHttps, false);
  });
});

describe('sitemap limits (finding 15)', () => {
  test('an endless answer without content-length is cut at the byte limit', { timeout: 30_000 }, async () => {
    const server = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' });
      const timer = setInterval(() => res.write('x'.repeat(1_000_000)), 1);
      res.on('close', () => clearInterval(timer));
    });
    try {
      const text = await fetchText(`http://127.0.0.1:${server.port}/sitemap.xml`);
      assert.ok(text !== null && text.length <= 5_000_000);
    } finally {
      await server.close();
    }
  });

  test('robots.txt sitemaps on foreign hosts are not fetched', async () => {
    const hits = [];
    const server = await serve((req, res) => {
      hits.push(`${(req.headers.host ?? '').split(':')[0]}${req.url}`);
      const port = server.port;
      if (req.url === '/robots.txt') {
        res.writeHead(200).end(`Sitemap: http://localhost:${port}/internal.xml\nSitemap: http://127.0.0.1:${port}/own.xml\n`);
      } else if (req.url === '/own.xml') {
        res.writeHead(200).end(`<urlset><url><loc>http://127.0.0.1:${port}/a</loc></url></urlset>`);
      } else {
        res.writeHead(200).end('<urlset><url><loc>http://localhost/secret</loc></url></urlset>');
      }
    });
    try {
      const found = await discoverSitemapUrls(new URL(`http://127.0.0.1:${server.port}/`));
      assert.deepEqual(found.source, [`http://127.0.0.1:${server.port}/own.xml`]);
      assert.ok(!hits.includes('localhost/internal.xml'), hits.join(','));
    } finally {
      await server.close();
    }
  });
});

describe('in-page collection (findings 2 and 17)', () => {
  let site;
  let browser;
  before(async () => {
    site = await serveFixture(FIXTURE);
    browser = await chromium.launch({ args: site.launchArgs });
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });
  async function factsOf(file) {
    const page = await browser.newPage();
    try {
      await page.goto(`${site.base}/${file}`);
      return await page.evaluate(collectPageFacts);
    } finally {
      await page.close();
    }
  }

  test('a "cookies" class on <html> (Modernizr) is no consent dialog', async () => {
    assert.equal((await factsOf('modernizr.html')).banner, null);
  });

  test('a real banner is still found, with the message and not only its button row', async () => {
    const { banner } = await factsOf('nested-banner.html');
    assert.ok(banner, 'banner found');
    assert.deepEqual(banner.buttons, ['Alle ablehnen', 'Alle akzeptieren']);
    assert.match(banner.text, /Wir verwenden Cookies/);
  });

  test('whole-euro prices are detected, years are not', async () => {
    const texts = (await factsOf('prices.html')).prices.map((p) => p.text);
    assert.deepEqual(texts, ['Kaffee 49 €', 'Tee ab 99 EUR', 'Maschine 1.200 €']);
    assert.deepEqual((await factsOf('prices-none.html')).prices, []);
  });
});

describe('blocked page, classification and first party in a real scan (findings 1, 8, 10)', () => {
  let site;
  let outDir;
  before(async () => {
    site = await serveFixture(FIXTURE);
    outDir = await mkdtemp(path.join(tmpdir(), 'wlc-fix-'));
  });
  after(async () => {
    await site.close();
    await rm(outDir, { recursive: true, force: true });
  });

  test('a page that blocks its main thread is recorded as unresponsive, the scan finishes', { timeout: 90_000 }, async () => {
    const scan = await scanSite({ startUrl: site.base, outDir, launchArgs: site.launchArgs, pageTimeoutMs: 3_000, ...FAST });
    const hang = scan.pages.find((p) => p.url.endsWith('/hang.html'));
    assert.equal(hang.error, 'page unresponsive');
    assert.ok(scan.pages.some((p) => p.url.endsWith('/impressum.html') && !p.error), 'pages after the blocked one are scanned');
    assert.ok(scan.consentRuns, 'consent runs happened');
  });

  test('the title of the start page and look-alike URLs do not make shop or privacy pages', async () => {
    const scan = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(outDir, 'scan.json'), 'utf8'));
    const typeOf = (suffix) => scan.pages.find((p) => p.url.endsWith(suffix) || p.url === `${site.base}${suffix}`)?.pageType;
    assert.equal(scan.pages[0].pageType, 'other');
    assert.equal(typeOf('/krankenkasse.html'), 'other');
    assert.equal(typeOf('/p/ueber-uns.html'), 'other');
    assert.equal(typeOf('/impressum.html'), 'imprint');
  });

  test('the watchdog closes the browser at maxTotalMs and the scan still returns', { timeout: 90_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wlc-fix-'));
    const began = Date.now();
    try {
      const scan = await scanSite({ startUrl: site.base, outDir: dir, launchArgs: site.launchArgs, pageTimeoutMs: 120_000, maxTotalMs: 6_000, ...FAST });
      assert.ok(Date.now() - began < 40_000, 'returned long before the page timeout');
      assert.ok(scan.notes.some((n) => /Time limit/.test(n)), scan.notes.join('|'));
      assert.ok(scan.pages.find((p) => p.url.endsWith('/hang.html'))?.error);
      assert.equal(scan.consentRuns, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('first party follows the start page (finding 8)', () => {
  test('typed host forwards to another domain: its requests and links are first party', { timeout: 60_000 }, async () => {
    const page = (links) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Firma</title><script src="/own.js"></script></head>`
      + `<body><main><p>Firma</p></main><footer>${links}</footer></body></html>`;
    const server = await serve((req, res) => {
      const host = (req.headers.host ?? '').split(':')[0];
      if (host === '127.0.0.1') return res.writeHead(302, { location: `http://localhost:${server.port}/` }).end();
      if (req.url === '/own.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end('1');
      if (req.url === '/impressum.html') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(''));
      if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('<a href="/impressum.html">Impressum</a>'));
      return res.writeHead(404).end();
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'wlc-fix-'));
    try {
      const scan = await scanSite({ startUrl: `http://127.0.0.1:${server.port}/`, outDir: dir, deep: false, allowInternalHosts: true, ...FAST });
      assert.ok(scan.pages.length >= 2, 'internal link of the landing host was followed');
      assert.ok(scan.requests.filter((r) => r.url.endsWith('/own.js')).every((r) => r.thirdParty === false));
      assert.ok(scan.notes.some((n) => /localhost/.test(n)));
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('reuse mode guards (finding 21)', () => {
  async function oldRun(parent, host, pages) {
    const dir = path.join(parent, 'old');
    await mkdir(path.join(dir, 'daten'), { recursive: true });
    await writeFile(path.join(dir, 'daten', 'scan.json'), JSON.stringify({ host, scannedAt: '2026-11-01T10:00:00.000Z', pages, requests: [] }));
    return dir;
  }

  test('an earlier scan of another host is refused', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wlc-fix-'));
    try {
      const reuseFrom = await oldRun(parent, 'other.example', [{ index: 1, url: 'https://other.example/', error: 'x' }]);
      await assert.rejects(scanSite({ startUrl: 'http://127.0.0.1:9/', outDir: path.join(parent, 'out'), reuseFrom, ...FAST }), /other\.example/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('maxTotalMs also limits re-checking; the start page failing is an error', { timeout: 90_000 }, async () => {
    const site = await serveFixture(FIXTURE);
    const parent = await mkdtemp(path.join(tmpdir(), 'wlc-fix-'));
    try {
      const pages = Array.from({ length: 12 }, (_, i) => ({ index: i + 1, url: `${site.base}/impressum.html?n=${i}`, error: 'old' }));
      const reuseFrom = await oldRun(parent, '127.0.0.1', pages);
      const scan = await scanSite({ startUrl: site.base, outDir: path.join(parent, 'out'), launchArgs: site.launchArgs, reuseFrom, maxTotalMs: 2_500, ...FAST });
      assert.ok(scan.pages.length < 12, `only some pages re-checked (${scan.pages.length})`);
      assert.ok(scan.notes.some((n) => /Time limit/.test(n)));

      const dead = await oldRun(await mkdtemp(path.join(tmpdir(), "wlc-dead-")), '127.0.0.1', [{ index: 1, url: "http://127.0.0.1:1/", error: 'old' }]);
      await assert.rejects(scanSite({ startUrl: site.base, outDir: path.join(parent, 'out2'), launchArgs: site.launchArgs, reuseFrom: dead, ...FAST }), /Start page not reachable|no page/);
    } finally {
      await site.close();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
