// Tests for the five additions: Google Maps embeds and consent tools, gzip sitemaps,
// server-side tagging hints, --max-minutes and the checklist word lists.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { test, describe } from 'node:test';
import { parseMaxMinutes } from '../scripts/lib/time-limit.mjs';
import { DEFAULTS } from '../scripts/lib/scanner.mjs';
import { buildModel } from '../scripts/lib/report/model.mjs';
import { renderLangfassung } from '../scripts/lib/report/langfassung.mjs';
import { serveFixture } from './helpers.mjs';
import { checkConsent } from '../scripts/lib/checks/consent.mjs';
import { discoverSitemapUrls, fetchText } from '../scripts/lib/sitemap.mjs';
import { matchService, serviceByName } from '../scripts/lib/third-parties.mjs';

describe('service list: Google Maps embeds and consent tools', () => {
  test('Google Maps iframe embeds are the service Google Maps', () => {
    for (const url of ['https://www.google.com/maps/embed?pb=!1m18', 'https://maps.google.com/maps?q=Berlin&output=embed', 'https://google.com/maps/embed?pb=x']) {
      assert.equal(matchService(url)?.name, 'Google Maps', url);
    }
  });

  test('a path on www.google.com does not make all of www.google.com Google Maps', () => {
    assert.equal(matchService('https://www.google.com/recaptcha/api.js')?.name, 'Google reCAPTCHA');
    assert.equal(matchService('https://www.google.com/search?q=x'), null);
    assert.equal(matchService('https://www.google.com/maps/api/js'), null);
  });

  test('CookieYes, iubenda and the Cookiebot host consent.cookiebot.eu are consent tools', () => {
    assert.equal(matchService('https://cdn-cookieyes.com/client_data/x/script.js')?.name, 'CookieYes');
    assert.equal(matchService('https://cdn.iubenda.com/cs/iubenda_cs.js')?.name, 'iubenda');
    assert.equal(matchService('https://consent.cookiebot.eu/uc.js')?.name, 'Cookiebot');
    for (const name of ['CookieYes', 'iubenda', 'Cookiebot']) assert.equal(serviceByName(name).category, 'consent');
  });
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

describe('gzip sitemaps', () => {
  const xml = (port) => `<urlset><url><loc>http://127.0.0.1:${port}/a</loc></url></urlset>`;

  test('a sitemap ending in .xml.gz is decompressed', async () => {
    const server = await serve((req, res) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(gzipSync(xml(server.port))));
    try {
      assert.equal(await fetchText(`http://127.0.0.1:${server.port}/sitemap.xml.gz`), xml(server.port));
    } finally {
      await server.close();
    }
  });

  test('a gzip content type is decompressed whatever the file name', async () => {
    for (const type of ['application/gzip', 'application/x-gzip']) {
      const server = await serve((req, res) => res.writeHead(200, { 'content-type': type }).end(gzipSync(xml(server.port))));
      try {
        assert.equal(await fetchText(`http://127.0.0.1:${server.port}/sitemap`), xml(server.port), type);
      } finally {
        await server.close();
      }
    }
  });

  test('a highly compressible oversize payload (zip bomb) is refused at the decompressed limit', { timeout: 30_000 }, async () => {
    const bomb = gzipSync(Buffer.alloc(60_000_000, 'a'));
    assert.ok(bomb.length < 1_000_000, 'the payload itself is small');
    const server = await serve((req, res) => res.writeHead(200, { 'content-type': 'application/gzip' }).end(bomb));
    try {
      assert.equal(await fetchText(`http://127.0.0.1:${server.port}/sitemap.xml.gz`), null);
    } finally {
      await server.close();
    }
  });

  test('a corrupt gzip file is unavailable, not an error', async () => {
    const server = await serve((req, res) => res.writeHead(200, { 'content-type': 'application/gzip' }).end('not gzip at all'));
    try {
      assert.equal(await fetchText(`http://127.0.0.1:${server.port}/sitemap.xml.gz`), null);
    } finally {
      await server.close();
    }
  });

  test('robots.txt may name a gzip sitemap; its URLs are collected', async () => {
    const server = await serve((req, res) => {
      if (req.url === '/robots.txt') res.writeHead(200).end(`Sitemap: http://127.0.0.1:${server.port}/sitemap.xml.gz\n`);
      else if (req.url === '/sitemap.xml.gz') res.writeHead(200, { 'content-type': 'application/gzip' }).end(gzipSync(xml(server.port)));
      else res.writeHead(404).end();
    });
    try {
      const found = await discoverSitemapUrls(new URL(`http://127.0.0.1:${server.port}/`));
      assert.deepEqual(found.urls, [`http://127.0.0.1:${server.port}/a`]);
    } finally {
      await server.close();
    }
  });
});

describe('server-side tagging (decision 77a)', () => {
  const page = { index: 1, url: 'https://x.de/', finalUrl: 'https://x.de/', facts: { banner: null, links: [], buttons: [], prices: [] } };
  const own = (url, extra = {}) => ({ url, page: 1, thirdParty: false, service: null, category: null, mainFrame: false, ...extra });
  const tddHints = (requests) => checkConsent({ pages: [page], cookies: [], requests }).filter((f) => f.check === 'TDD-01');

  test('known tracking paths on the own domain or a subdomain are a TDD-01 hint, never a gap', () => {
    const hints = tddHints([
      own('https://x.de/g/collect?v=2&tid=G-1'),
      own('https://metrics.x.de/gtag/js?id=G-1'),
      own('https://x.de/gtm.js?id=GTM-AB12'),
    ]);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].status, 'hint');
    assert.equal(hints[0].evidence.service, 'Google (serverseitig)');
    assert.deepEqual(hints[0].pages, ['https://x.de/']);
    assert.equal(hints[0].evidence.requests.length, 3);
  });

  test('the same paths on a third-party host, other own paths and page navigations are no hint', () => {
    assert.deepEqual(tddHints([
      own('https://other.com/gtm.js', { thirdParty: true }),
      own('https://x.de/collect-data.js'),
      own('https://x.de/gtm.json'),
      own('https://x.de/gtm.js', { mainFrame: true }),
    ]), []);
  });
});

describe('--max-minutes (decision 78a)', () => {
  test('valid values become the total time limit in milliseconds; the default stays 20 minutes', () => {
    assert.equal(DEFAULTS.maxTotalMs, 20 * 60_000);
    assert.equal(parseMaxMinutes('20'), 1_200_000);
    assert.equal(parseMaxMinutes('0.5'), 30_000);
    assert.equal(parseMaxMinutes('120'), 7_200_000);
    assert.equal(parseMaxMinutes(undefined), DEFAULTS.maxTotalMs);
  });

  test('anything but a positive number up to 120 is refused with a clear message', () => {
    for (const bad of ['0', '-5', 'abc', '', ' ', '1e3', '0x10', '121', 'Infinity', 'NaN', '5 min']) {
      assert.throws(() => parseMaxMinutes(bad), /--max-minutes must be a positive number of minutes, at most 120/, JSON.stringify(bad));
    }
  });

  test('the CLI refuses an invalid value before scanning anything', async () => {
    await assert.rejects(
      run('node', [path.join(ROOT, 'scripts/scan.mjs'), '--url', 'example.invalid', '--out', path.join(tmpdir(), 'wlc-never'), '--max-minutes', 'abc'], { timeout: 30_000 }),
      (error) => error.code === 2 && /--max-minutes must be a positive number/.test(error.stderr),
    );
  });

  test('the CLI stops at the limit, still writes scan.json and findings.json, and notes the abort', { timeout: 120_000 }, async () => {
    const site = await serveFixture('scanner-fixes');
    const out = await mkdtemp(path.join(tmpdir(), 'wlc-max-'));
    try {
      await run('node', [path.join(ROOT, 'scripts/scan.mjs'), '--url', site.base, '--out', out, '--max-minutes', '0.1', '--no-deep'], { timeout: 100_000 });
      const scan = JSON.parse(await readFile(path.join(out, 'daten', 'scan.json'), 'utf8'));
      assert.ok(scan.notes.some((n) => /Time limit/.test(n)), scan.notes.join('|'));
      assert.ok(scan.pages.length >= 1 && scan.pages.length < 6, `pages checked so far: ${scan.pages.length}`);
      JSON.parse(await readFile(path.join(out, 'daten', 'findings.json'), 'utf8'));
    } finally {
      await site.close();
      await rm(out, { recursive: true, force: true });
    }
  });

  test('scan notes in report.json reach the long report, and SKILL.md documents the flag and the hand-over of the notes', async () => {
    const note = 'Time limit reached: the browser was closed, the scan is incomplete.';
    const report = {
      site: 'example.de', date: '15.11.2026', pagesScanned: 1, checklistStatus: '15.11.2026', scanNotes: [note],
      findings: [{ prio: 1, kind: 'gap', title: 'T', what: 'W', where: 'X', law: '§ 25 TDDDG', fix: 'F', evidence: 'E', summary: 'S', plain: { where: 'pw', law: 'pl', evidence: 'pe' } }],
    };
    assert.ok(renderLangfassung(buildModel(report)).includes(note));
    const skill = await readFile(path.join(ROOT, 'SKILL.md'), 'utf8');
    assert.match(skill, /--max-minutes <n>/);
    assert.match(skill, /`scan\.json` → `notes`[^.]*`scanNotes`/);
  });
});
