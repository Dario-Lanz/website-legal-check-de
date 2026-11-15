// Regression tests for the third review round (opus-review-2): earlier-run mock-up evidence,
// browser navigations into the local network, public-host gaps, reuse time limit, reject-run
// time limit, VAT note, profession plural, TMG wording, own-domain legal links.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { checkConsentChoice } from '../scripts/lib/checks/consent-choice.mjs';
import { legalLinkKind, PATTERNS } from '../scripts/lib/checks/helpers.mjs';
import { CHAMBER_PROFESSION, OUTDATED_TMG } from '../scripts/lib/checks/legal-content.mjs';
import { runConsentChoices } from '../scripts/lib/consent-runs.mjs';
import { blockInternalNavigations } from '../scripts/lib/navigation-guard.mjs';
import { isPublicHost } from '../scripts/lib/public-host.mjs';
import { mockupRequestAllowed } from '../scripts/lib/report/images.mjs';
import { scanSite } from '../scripts/lib/scanner.mjs';

const FAST = { deep: false, delayMs: 0, settleMs: 100 };
const PAGE = (body = '') => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>F</title></head><body><main><p>F</p></main><footer>${body}</footer></body></html>`;

/** Start a server; handler(req, res, host, server). */
async function serve(handler) {
  const server = createServer((req, res) => handler(req, res, (req.headers.host ?? '').split(':')[0], server));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}
const html = (res, body) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);

// R2-1
test('mock-up requests: evidence of an earlier run beside this one is allowed, other files and links out are not', async () => {
  const runs = await mkdtemp(path.join(tmpdir(), 'wlc-r3-'));
  try {
    const mine = path.join(runs, 'run2', 'daten');
    const earlier = path.join(runs, 'run1', 'daten');
    await mkdir(mine, { recursive: true });
    await mkdir(path.join(earlier, 'belege'), { recursive: true });
    await writeFile(path.join(earlier, 'belege', 'a.jpg'), 'x');
    await writeFile(path.join(earlier, 'scan.json'), '{}');
    await writeFile(path.join(runs, 'secret.png'), 'x');
    await symlink(path.join(runs, 'secret.png'), path.join(earlier, 'belege', 'link.png'));
    const base = await (await import('node:fs/promises')).realpath(mine);
    const url = (...p) => `file://${path.join(...p)}`;
    assert.equal(await mockupRequestAllowed(url(earlier, 'belege', 'a.jpg'), base), true);
    assert.equal(await mockupRequestAllowed(url(earlier, 'scan.json'), base), false, 'only belege/ of the earlier run');
    assert.equal(await mockupRequestAllowed(url(earlier, 'belege', 'link.png'), base), false, 'a link out of belege/ is refused');
    assert.equal(await mockupRequestAllowed(url(runs, 'secret.png'), base), false);
    assert.equal(await mockupRequestAllowed('https://example.com/a.png', base), false);
  } finally {
    await rm(runs, { recursive: true, force: true });
  }
});

// R2-2
test('a redirect from the typed host into the local network is not followed by the browser', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wlc-r3-'));
  let internalHits = 0;
  const server = await serve((req, res, host, srv) => {
    if (host === 'localhost') {
      internalHits += 1;
      return html(res, PAGE());
    }
    // two hops: the chain ends in the local network
    if (req.url === '/') return res.writeHead(302, { location: '/hop' }).end();
    return res.writeHead(302, { location: `http://localhost:${srv.address().port}/` }).end();
  });
  try {
    await assert.rejects(scanSite({ startUrl: `http://127.0.0.1:${server.port}/`, outDir: dir, ...FAST }), /Start page not reachable/);
    assert.equal(internalHits, 0, 'the local host was never requested');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a linked page that redirects into the local network becomes an error page with a note; allowInternalHosts follows it', { timeout: 90_000 }, async () => {
  const server = await serve((req, res, host, srv) => {
    if (host === 'localhost') return html(res, PAGE('<p>INTERNAL</p>'));
    if (req.url === '/geheim') return res.writeHead(302, { location: `http://localhost:${srv.address().port}/` }).end();
    return html(res, PAGE('<a href="/geheim">Kontakt</a>'));
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'wlc-r3-'));
  try {
    const scan = await scanSite({ startUrl: `http://127.0.0.1:${server.port}/`, outDir: dir, ...FAST });
    const page = scan.pages.find((p) => p.url.endsWith('/geheim'));
    assert.ok(page?.error, 'the page is recorded as an error');
    assert.equal(page.facts, undefined, 'no content, no screenshot of the local page');
    assert.ok(scan.notes.some((n) => /localhost.*blocked/.test(n)), scan.notes.join('|'));
    const open = await scanSite({ startUrl: `http://127.0.0.1:${server.port}/`, outDir: dir, allowInternalHosts: true, ...FAST });
    assert.match(open.pages.find((p) => p.url.endsWith('/geheim')).finalUrl, /^http:\/\/localhost:/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('consent runs do not follow a redirect into the local network either', { timeout: 60_000 }, async () => {
  const server = await serve((req, res, host, srv) => res.writeHead(302, { location: `http://localhost:${srv.address().port}/` }).end());
  const browser = await chromium.launch();
  try {
    const start = new URL(`http://127.0.0.1:${server.port}/`);
    await blockInternalNavigations(browser, { typedHost: start.hostname });
    const result = await runConsentChoices(browser, start, [start.href], { contextOptions: {}, timeoutMs: 10_000, settleMs: 50 });
    assert.equal(result.reject.clicked, false);
    assert.match(result.reject.reason, /ERR_BLOCKED_BY_CLIENT/);
  } finally {
    await browser.close();
    await server.close();
  }
});

// R2-3
test('isPublicHost: fritz.box, .home, .corp, IPv4-compatible, NAT64, site-local and 6to4 with private IPv4 are not public', () => {
  for (const host of ['fritz.box', 'router.fritz.box', 'nas.home', 'srv.corp', 'x.lan', 'wiki.intranet', '[::7f00:1]', '[::c0a8:1]',
    '[64:ff9b::c0a8:1]', '[64:ff9b::7f00:1]', '[fec0::1]', '[2002:c0a8:1::1]', '[2002:a00:1::1]']) {
    assert.equal(isPublicHost(host), false, host);
  }
  for (const host of ['example.com', 'home.example.de', '[2606:4700::1111]', '[64:ff9b::808:808]', '[2002:808:808::1]']) {
    assert.equal(isPublicHost(host), true, host);
  }
});

// R2-4
test('reuse mode: the time limit during the start page does not end in "Start page not reachable"', { timeout: 90_000 }, async () => {
  let slow = false;
  const server = await serve((req, res) => {
    // only the browser is slowed down (the transport check is a fetch with sec-fetch-mode: cors) before it
    if (!slow || req.headers['sec-fetch-mode'] === 'cors') return html(res, PAGE());
    setTimeout(() => html(res, PAGE()), 10_000);
  });
  const parent = await mkdtemp(path.join(tmpdir(), 'wlc-r3-'));
  try {
    const startUrl = `http://127.0.0.1:${server.port}/`;
    await scanSite({ startUrl, outDir: path.join(parent, 'run1', 'daten'), ...FAST });
    slow = true;
    const scan = await scanSite({ startUrl, outDir: path.join(parent, 'run2', 'daten'), reuseFrom: path.join(parent, 'run1'), maxTotalMs: 3_000, ...FAST });
    assert.ok(scan.notes.some((n) => /Time limit reached/.test(n)), JSON.stringify([scan.notes, scan.pages.map((p) => p.error)]));
  } finally {
    await server.close();
    await rm(parent, { recursive: true, force: true });
  }
});

// R2-5
test('reject run cut short by the time limit says so and raises no "could not be clicked" hint', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch();
  try {
    let calls = 0;
    const start = new URL('http://127.0.0.1:9/');
    // false before the reject run, true once it failed: as if the watchdog had closed the browser meanwhile
    const shouldStop = () => (calls += 1) > 1;
    const result = await runConsentChoices(browser, start, [start.href], { contextOptions: {}, timeoutMs: 5_000, settleMs: 50, shouldStop });
    assert.equal(result.reject.reason, 'time limit reached');
  } finally {
    await browser.close();
  }
  const scan = (reason) => ({ pages: [{ url: 'https://x.de/', finalUrl: 'https://x.de/', status: 200, facts: { banner: { text: 'Cookies' }, links: [] } }],
    consentRuns: { reject: { choice: 'reject', clicked: false, reason } } });
  assert.deepEqual(checkConsentChoice(scan('time limit reached')), []);
  assert.equal(checkConsentChoice(scan('no matching button found')).length, 1, 'other reasons still give the hint');
});

// R2-6
test('VAT note: "Alle Preise enthalten die (gesetzliche) MwSt." counts', () => {
  for (const text of ['Alle Preise enthalten die MwSt.', 'Preise enthalten die gesetzliche MwSt.', 'Alle Preise enthalten Mehrwertsteuer', 'Preise enthalten die gesetzl. Umsatzsteuer']) {
    assert.match(text, PATTERNS.vatNote, text);
  }
  assert.doesNotMatch('Preise zzgl. MwSt.', PATTERNS.vatNote);
});

// R2-7
test('IMP-04 patterns: plural "Fachärztinnen"; "TMG wurde abgelöst" is no outdated reference; own-domain legal links beat the vendor filter', () => {
  assert.match('Wir sind Fachärztinnen für Innere Medizin', CHAMBER_PROFESSION);
  assert.match('Fachärzte', CHAMBER_PROFESSION);
  assert.doesNotMatch('Das Telemediengesetz (TMG) wurde abgelöst.', OUTDATED_TMG);
  assert.doesNotMatch('§ 5 TMG wurde durch das DDG ersetzt.', OUTDATED_TMG);
  assert.doesNotMatch('Das TMG ist außer Kraft; Telemediengesetz aufgehoben.', OUTDATED_TMG);
  assert.match('Angaben gemäß § 5 TMG', OUTDATED_TMG);
  assert.match('Das Telemediengesetz. Es wurde abgelöst.', OUTDATED_TMG, 'the next sentence does not count');
  const page = { url: 'https://policies.google.com/', facts: { links: [{ href: 'https://policies.google.com/privacy', text: 'Datenschutz', visible: true }] } };
  assert.equal(legalLinkKind(page, PATTERNS.privacy), 'ok', 'a link on the vendor domain itself is the own page there');
});

// Review round 4: the guard checks every redirect hop in the browser itself (CDP Fetch domain),
// instead of walking the redirects beforehand (which the browser could be answered differently on).
const mainFrameUrls = (scan) => scan.requests.filter((r) => r.mainFrame).map((r) => r.url);

test('guard: a server that answers the check differently from the browser (flip) never gets the browser into the local network', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wlc-r4-'));
  let flips = 0;
  let internalHits = 0;
  const server = await serve((req, res, host, srv) => {
    if (host === 'localhost') {
      internalHits += 1;
      return html(res, PAGE('<p>INTERNAL</p>'));
    }
    if (req.url === '/hop') return res.writeHead(302, { location: '/flip' }).end();
    // The first request of the browser is answered with a page, every later one with the redirect.
    if (/Chrome/.test(req.headers['user-agent'] ?? '')) flips += 1;
    if (flips <= 1) return html(res, PAGE());
    return res.writeHead(302, { location: `http://localhost:${srv.address().port}/` }).end();
  });
  try {
    // Whether the start page then loads is not the point: the browser asks /flip once, the local host is never asked.
    await scanSite({ startUrl: `http://127.0.0.1:${server.port}/hop`, outDir: dir, ...FAST }).catch(() => null);
    assert.equal(internalHits, 0, 'the local host was never requested');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Guarded context of a browser that maps *.example.com to the server; page.goto(url) is the one navigation. */
async function guardedGoto(server, startUrl, { blocked = [] } = {}) {
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP *.example.com 127.0.0.1:${server.port}`] });
  try {
    await blockInternalNavigations(browser, { typedHost: new URL(startUrl).hostname, onBlocked: (u) => blocked.push(u) });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(startUrl, { waitUntil: 'load', timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(1500);
    return page.url();
  } finally {
    await browser.close();
  }
}

test('guard: a cookie of host A is not sent to the redirect target host B', { timeout: 60_000 }, async () => {
  const seen = [];
  const server = await serve((req, res, host, srv) => {
    seen.push({ host, url: req.url, cookie: req.headers.cookie });
    const port = srv.address().port;
    if (host === 'a.example.com' && req.url === '/') return res.writeHead(302, { 'set-cookie': 'secret=A; Path=/', location: `http://b.example.com:${port}/final` }).end();
    return html(res, PAGE());
  });
  try {
    assert.equal(await guardedGoto(server, `http://a.example.com:${server.port}/`), `http://b.example.com:${server.port}/final`);
    const final = seen.filter((s) => s.host === 'b.example.com' && s.url === '/final');
    assert.equal(final.length, 1, 'the target was requested once');
    assert.equal(final[0].cookie, undefined, `no cookie of host A at host B (got ${final[0].cookie})`);
  } finally {
    await server.close();
  }
});

test('guard: POST then 303 ends in exactly one POST and one GET of the final page', { timeout: 60_000 }, async () => {
  const seen = [];
  const server = await serve((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/') return html(res, PAGE('<form method="post" action="/post"><input name="q" value="x"></form><script>document.forms[0].submit()</script>'));
    if (req.url === '/post') return res.writeHead(303, { location: '/final' }).end();
    return html(res, PAGE());
  });
  try {
    assert.match(await guardedGoto(server, `http://a.example.com:${server.port}/`), /\/final$/);
    assert.deepEqual(seen.filter((s) => s !== 'GET /favicon.ico'), ['GET /', 'POST /post', 'GET /final']);
  } finally {
    await server.close();
  }
});

test('guard: every redirect hop is a recorded request of the scan', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wlc-r4-'));
  const server = await serve((req, res) => {
    if (req.url === '/') return res.writeHead(302, { location: '/hop2' }).end();
    if (req.url === '/hop2') return res.writeHead(301, { location: '/final' }).end();
    return html(res, PAGE());
  });
  try {
    const scan = await scanSite({ startUrl: `http://127.0.0.1:${server.port}/`, outDir: dir, ...FAST });
    const urls = mainFrameUrls(scan).filter((u) => /\/(hop2|final)?$/.test(u));
    for (const p of ['/', '/hop2', '/final']) assert.equal(urls.filter((u) => u === `http://127.0.0.1:${server.port}${p}`).length, 1, `${p}: ${urls.join(' ')}`);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Review round 5: the guard sits on the browser, so popups, JS navigations, meta refresh and iframes
// can not reach the local network either. The internal host must never receive a request.
const SLOW = { deep: false, delayMs: 0, settleMs: 1200 };

/** Scan a site whose start page has `body`; `internal(port)` gives the local URL the page tries to reach. */
async function scanTrap(body, { extra } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wlc-r5-'));
  const internal = [];
  const server = await serve((req, res, host, srv) => {
    if (host === 'localhost') {
      internal.push(req.url);
      return html(res, PAGE('<p>INTERNAL</p>'));
    }
    if (req.url.startsWith('/r?to=')) return res.writeHead(302, { location: decodeURIComponent(req.url.slice(6)) }).end();
    if (extra?.(req, res)) return undefined;
    return html(res, PAGE(body(srv.address().port)));
  });
  try {
    const scan = await scanSite({ startUrl: `http://127.0.0.1:${server.port}/`, outDir: dir, ...SLOW }).catch((error) => ({ error, notes: [], requests: [] })); // the start page may end in an error: only the host matters
    return { scan, internal };
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const script = (code) => `<script>${code}</script>`;
const TRAPS = {
  'popup: window.open(internal)': (port) => script(`window.open('http://localhost:${port}/pop')`),
  'popup: window.open(about:blank) then location = internal': (port) => script(`const w = window.open('about:blank'); w.location = 'http://localhost:${port}/pop'`),
  'popup: window.open(redirect to internal)': (port) => script(`window.open('/r?to=' + encodeURIComponent('http://localhost:${port}/pop'))`),
  'JS location into the local network': (port) => script(`setTimeout(() => { location.href = 'http://localhost:${port}/pop' }, 50)`),
  'meta refresh into the local network': (port) => `<meta http-equiv="refresh" content="0;url=http://localhost:${port}/pop">`,
  'iframe to an internal host': (port) => `<iframe src="http://localhost:${port}/pop"></iframe>`,
};
for (const [name, body] of Object.entries(TRAPS)) {
  test(`guard: ${name} never reaches the internal host`, { timeout: 90_000 }, async () => {
    const { internal } = await scanTrap(body);
    assert.deepEqual(internal, [], 'the local host was never requested');
  });
}

test('guard: a blocked URL is noted but not recorded as a request of the scan', { timeout: 90_000 }, async () => {
  const { scan } = await scanTrap((port) => `<iframe src="http://localhost:${port}/pop"></iframe>`);
  assert.ok(scan.notes.some((n) => /localhost.*blocked/.test(n)), scan.notes.join('|'));
  assert.deepEqual(scan.requests.filter((r) => /localhost/.test(r.url)), [], 'blocked URL is not in scan.requests');
});

test('guard: a throwing onBlocked callback still lets the request fail', { timeout: 60_000 }, async () => {
  const server = await serve((req, res, host) => html(res, host === 'localhost' ? PAGE('<p>INTERNAL</p>') : PAGE()));
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP *.example.com 127.0.0.1:${server.port}`] });
  try {
    await blockInternalNavigations(browser, { typedHost: 'a.example.com', onBlocked: () => { throw new Error('boom'); } });
    const page = await browser.newPage();
    await page.goto(`http://a.example.com:${server.port}/`, { waitUntil: 'load', timeout: 15_000 });
    const error = await page.goto(`http://localhost:${server.port}/`, { timeout: 15_000 }).then(() => null, (e) => e);
    assert.match(String(error), /ERR_BLOCKED_BY_CLIENT/);
  } finally {
    await browser.close();
    await server.close();
  }
});

// Service workers are blocked during the scan: the scan sees the site as a first-time visitor and a worker can not answer requests behind the guard.
test('service workers: a page can not register one (main scan and consent runs)', { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wlc-r5-'));
  const reports = [];
  const server = await serve((req, res) => {
    if (req.url.startsWith('/report')) {
      reports.push(req.url.slice(8));
      return res.writeHead(204).end();
    }
    if (req.url === '/sw.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end('self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim())); self.addEventListener("fetch", () => {});');
    // The worker claims its clients at once; the page reports whether it ended up controlled.
    const probe = `(async () => {
      try {
        await navigator.serviceWorker.register('/sw.js');
        await Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(resolve, 600))]);
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error) { /* refused: not controlled either */ }
      await fetch('/report?' + (navigator.serviceWorker.controller ? 'controlled' : 'free'));
    })()`;
    return html(res, PAGE(`<div id="cookie-banner">Cookies <button>Alle akzeptieren</button> <button>Ablehnen</button></div><script>${probe}</script>`));
  });
  try {
    await scanSite({ startUrl: `http://127.0.0.1:${server.port}/`, outDir: dir, ...FAST, settleMs: 800 });
    assert.ok(reports.length > 0, 'the page probed');
    assert.deepEqual([...new Set(reports)], ['free'], `no page was controlled by a worker (got ${reports.join(',')})`);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('blocked navigations are dropped from the consent runs too, not only from the main scan', async () => {
  const { dropBlockedRequests } = await import('../scripts/lib/scanner.mjs');
  const bad = 'http://localhost/x';
  const state = { blocked: new Set([bad]), requests: [{ url: bad }, { url: 'https://a.de/' }] };
  const runs = { reject: { requests: [{ url: bad }, { url: 'https://a.de/r' }] }, accept: { clicked: false } };
  dropBlockedRequests(state, runs);
  assert.deepEqual(state.requests.map((r) => r.url), ['https://a.de/']);
  assert.deepEqual(runs.reject.requests.map((r) => r.url), ['https://a.de/r']);
  dropBlockedRequests(state, null);
});
