// check-sources: URL matching, fetch strategy (plain, then browser), verdicts and --write.
// All network access is mocked; the real-network trial is a manual run.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCheck } from '../scripts/check-sources.mjs';
import { checkSources, formatRow, mapLimit } from '../scripts/lib/sources/check.mjs';
import { createBrowserChecker } from '../scripts/lib/sources/browser-fallback.mjs';
import { plainFetch } from '../scripts/lib/sources/plain-fetch.mjs';
import { collectUrls, listedUrls, referenceUrls, setRetrieved } from '../scripts/lib/sources/report-sources.mjs';
import { extractTitle, judge } from '../scripts/lib/sources/verdict.mjs';

const OK = 'https://www.gesetze-im-internet.de/ttdsg/__25.html';
const EURLEX = 'https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng';
const GONE = 'https://www.gesetze-im-internet.de/gone.html';
const SOURCES_MD = `| ID | Title | URL | Retrieved | Helps with |\n|---|---|---|---|---|\n| SRC-01 | a | ${OK} | 2026-11-07 | x |\n| SRC-04 | b | ${EURLEX} | 2026-11-07 | x |\n| SRC-99 | c | ${GONE} | 2026-11-07 | x |\n`;
const src = (url) => ({ title: 't', url, use: 'u', retrieved: '' });
const makeReport = () => ({ findings: [{ sources: [src(OK), src(EURLEX)] }, { sources: [src(OK), src('https://example.org/not-listed')] }], upcoming: [{ sources: [src(GONE)] }] });
const html = (title, body = '') => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const reply = (status, body = '', headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
const fakeBrowser = (result, calls = []) => () => ({ check: async (url) => { calls.push(url); return result(url); }, close: async () => { calls.push('closed'); } });
const NOW = () => Date.parse('2026-11-20T10:00:00Z');

test('URLs are collected once, in order, from findings and upcoming; only listed URLs count', () => {
  const report = makeReport();
  assert.deepEqual(collectUrls(report), [OK, EURLEX, 'https://example.org/not-listed', GONE]);
  assert.deepEqual([...listedUrls(SOURCES_MD)], [OK, EURLEX, GONE]);
});

test('plain fetch succeeds: title is read, entities decoded, unlisted URL is not fetched', async () => {
  const fetched = [];
  const fetchImpl = async (url) => { fetched.push(url); return reply(200, html('&#167; 25 TDDDG &amp; Co')); };
  const { rows, unlisted } = await checkSources(makeReport(), SOURCES_MD, { fetchImpl, browserFactory: fakeBrowser(() => assert.fail('no browser needed')), now: NOW });
  assert.deepEqual(unlisted, ['https://example.org/not-listed']);
  assert.ok(!fetched.includes('https://example.org/not-listed'));
  assert.equal(rows[0].title, '§ 25 TDDDG & Co');
  assert.ok(rows.every((r) => r.reachable && r.via === 'plain'));
});

test('403, 429 and challenge pages fall back to the browser; its result decides', async () => {
  const calls = [];
  const fetchImpl = async (url) => (url === OK ? reply(403, 'Forbidden') : url === EURLEX ? reply(200, html('Just a moment...')) : reply(404, 'nope'));
  const browser = fakeBrowser((url) => ({ status: 200, title: `Real ${url.slice(8, 12)}`, snippet: '', isHtml: true }), calls);
  const { rows } = await checkSources(makeReport(), SOURCES_MD, { fetchImpl, browserFactory: browser, now: NOW });
  assert.deepEqual(rows.map((r) => [r.via, r.reachable]), [['browser', true], ['browser', true], ['plain', false]]);
  assert.deepEqual(calls, [OK, EURLEX, 'closed'], '404 does not trigger the browser; browser is closed at the end');
});

test('browser result that is still a challenge or HTTP error counts as not reachable', async () => {
  const fetchImpl = async () => reply(429);
  const browser = fakeBrowser((url) => (url === OK ? { status: 200, title: 'Attention Required', snippet: '', isHtml: true } : { status: 0, title: '', snippet: '', isHtml: false, error: 'browser error: boom' }));
  const { rows } = await checkSources(makeReport(), SOURCES_MD, { fetchImpl, browserFactory: browser, now: NOW });
  assert.deepEqual(rows.map((r) => [r.reachable, r.reason]), [[false, 'challenge or block page'], [false, 'browser error: boom'], [false, 'browser error: boom']]);
});

test('the browser is closed even when a check throws', async () => {
  const calls = [];
  const browser = () => ({ check: async () => { throw new Error('crash'); }, close: async () => { calls.push('closed'); } });
  await assert.rejects(checkSources(makeReport(), SOURCES_MD, { fetchImpl: async () => reply(403), browserFactory: browser, now: NOW }), /crash/);
  assert.deepEqual(calls, ['closed']);
});

test('--write sets today on reachable sources, clears the date on unreachable ones, leaves unlisted ones alone', async () => {
  const report = makeReport();
  report.upcoming[0].sources[0].retrieved = '01.01.2026';
  report.findings[1].sources[1].retrieved = '02.02.2026';
  const fetchImpl = async (url) => (url === GONE ? reply(404) : reply(200, html('ok')));
  const { updated } = await checkSources(report, SOURCES_MD, { write: true, fetchImpl, browserFactory: fakeBrowser(() => assert.fail('unused')), now: NOW });
  assert.equal(updated, 4);
  assert.deepEqual(report.findings[0].sources.map((s) => s.retrieved), ['20.11.2026', '20.11.2026']);
  assert.equal(report.findings[1].sources[1].retrieved, '02.02.2026', 'not in sources.md: untouched');
  assert.equal(report.upcoming[0].sources[0].retrieved, '', 'unreachable: stale date cleared');
});

test('without --write the report stays unchanged', async () => {
  const report = makeReport();
  await checkSources(report, SOURCES_MD, { fetchImpl: async () => reply(200, html('ok')), browserFactory: fakeBrowser(() => assert.fail('unused')), now: NOW });
  assert.equal(setRetrieved(structuredClone(report), new Set(), new Set(), 'x'), 0);
  assert.ok(collectUrls(report).length && report.findings[0].sources.every((s) => s.retrieved === ''));
});

test('at most 4 requests run at once', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapLimit(Array.from({ length: 10 }, (_, i) => i), 4, async (i) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return i * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(results, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
});

test('plain fetch follows https redirects and refuses a downgrade to http', async () => {
  const hop = async (url) => (url === 'https://a.example/start' ? reply(301, '', { location: '/next' }) : reply(200, html('Done')));
  const done = await plainFetch('https://a.example/start', { fetchImpl: hop, timeoutMs: 1000 });
  assert.deepEqual([done.status, done.title, done.finalUrl], [200, 'Done', 'https://a.example/next']);
  const downgrade = await plainFetch('https://a.example/start', { fetchImpl: async () => reply(302, '', { location: 'http://a.example/x' }), timeoutMs: 1000 });
  assert.match(downgrade.error, /refused non-https/);
  assert.match((await plainFetch('http://a.example/', { fetchImpl: hop, timeoutMs: 1000 })).error, /refused non-https/);
  const loop = await plainFetch('https://a.example/', { fetchImpl: async () => reply(302, '', { location: '/' }), timeoutMs: 1000 });
  assert.match(loop.error, /too many redirects/);
});

test('plain fetch reports a timeout and network errors without throwing', async () => {
  const slow = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  assert.match((await plainFetch('https://a.example/', { fetchImpl: slow, timeoutMs: 20 })).error, /timeout/);
  const broken = await plainFetch('https://a.example/', { fetchImpl: async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); }, timeoutMs: 1000 });
  assert.match(broken.error, /ENOTFOUND/);
});

test('verdicts: HTTP errors, error titles and non-HTML documents', () => {
  assert.equal(judge({ status: 500, title: '', snippet: '', isHtml: true }).reachable, false);
  assert.equal(judge({ status: 200, title: '404 Not Found', snippet: '', isHtml: true }).reason, 'error page');
  assert.equal(judge({ status: 200, title: '', snippet: '', isHtml: false }).reachable, true);
  assert.equal(extractTitle(html(' A\n  B ')), 'A B');
  assert.match(formatRow({ status: 200, reachable: true, via: 'plain', title: 'T', reason: '', url: OK }), /^200 {2}reachable: yes {2}via plain {2}"T" {2}https/);
});

test('an overall time limit marks pending URLs instead of fetching them', async () => {
  let t = 0;
  const now = () => { t += 300_000; return t; };
  const { rows } = await checkSources(makeReport(), SOURCES_MD, { fetchImpl: async () => reply(200, html('ok')), browserFactory: fakeBrowser(() => assert.fail('unused')), now });
  assert.ok(rows.every((r) => r.reason === 'overall time limit reached' && !r.reachable));
});

test('runCheck reads report.json, prints one line per URL and writes the date with --write', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'check-sources-'));
  const file = path.join(dir, 'report.json');
  try {
    await writeFile(file, JSON.stringify({ findings: [{ sources: [src(OK)] }] }));
    const deps = { fetchImpl: async () => reply(200, html('Einzelnorm')), browserFactory: fakeBrowser(() => assert.fail('unused')), now: NOW };
    const dry = (await runCheck({ data: file }, deps)).text;
    assert.match(dry, /200 {2}reachable: yes {2}via plain {2}"Einzelnorm" {2}https:\/\/www\.gesetze-im-internet\.de\/ttdsg\/__25\.html\n1 fetched: 1 reachable, 0 not reachable; 0 not in sources\.md or upcoming\.md \(dry run/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).findings[0].sources[0].retrieved, '');
    const written = await runCheck({ data: file, write: true }, deps);
    assert.equal(written.ok, true);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).findings[0].sources[0].retrieved, '20.11.2026');
    const failing = await runCheck({ data: file, write: true }, { ...deps, fetchImpl: async () => reply(404) });
    assert.equal(failing.ok, false, 'exit code 1 when a source is unreachable');
    assert.match(failing.text, /PROBLEM: 1 source\(s\) not reachable or not in sources\.md or upcoming\.md\. Remove them[\s\S]*exit code 1/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).findings[0].sources[0].retrieved, '', 'date cleared');
    await writeFile(file, JSON.stringify({ findings: [{ sources: [src('https://example.org/x')] }] }));
    assert.equal((await runCheck({ data: file }, deps)).ok, false, 'not in sources.md is a problem too');
    await assert.rejects(runCheck({}), /--data/);
    await writeFile(file, '{"nope":1}');
    await assert.rejects(runCheck({ data: file }), /no "findings" array/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plain fetch refuses non-public hosts, also after a redirect', async () => {
  let calls = 0;
  const never = async () => { calls += 1; return reply(200, html('x')); };
  for (const url of ['https://127.0.0.1/', 'https://localhost/x', 'https://192.168.1.5/', 'https://[::1]/', 'https://printer.local/', 'https://fritz.box/']) {
    assert.match((await plainFetch(url, { fetchImpl: never, timeoutMs: 1000 })).error, /refused non-public host/, url);
  }
  assert.equal(calls, 0, 'nothing was requested');
  const redirect = async (url) => (url === 'https://a.example/' ? reply(302, '', { location: 'https://169.254.169.254/latest/meta-data' }) : reply(200, html('secret')));
  const result = await plainFetch('https://a.example/', { fetchImpl: redirect, timeoutMs: 1000 });
  assert.match(result.error, /refused non-public host: 169\.254\.169\.254/);
  assert.equal(result.status, 0);
});

test('browser fallback refuses non-https and non-public URLs before launching a browser, and guards the browser when it launches', async () => {
  let launched = 0;
  const events = [];
  const cdp = { on() {}, send: async (m) => { events.push(m); } };
  const context = { route: async (match) => { events.push(`route http:${match(new URL('http://a.example/'))} https:${match(new URL('https://a.example/'))}`); }, newPage: async () => { throw new Error('stop here'); }, close: async () => {} };
  const fakeBrowser = { newBrowserCDPSession: async () => cdp, newContext: async (o) => { events.push(`context serviceWorkers=${o.serviceWorkers}`); return context; }, close: async () => {} };
  const checker = createBrowserChecker(async () => { launched += 1; return fakeBrowser; });
  for (const url of ['http://a.example/', 'https://127.0.0.1/', 'https://localhost:8080/']) {
    assert.match((await checker.check(url, 1000)).error, /refused/, url);
  }
  assert.equal(launched, 0);
  const result = await checker.check('https://a.example/', 1000);
  assert.equal(launched, 1);
  assert.match(result.error, /browser error: stop here/);
  assert.deepEqual(events, ['Fetch.enable', 'context serviceWorkers=block', 'route http:true https:false']);
  await checker.close();
});

test('browser fallback counts a page as unreachable when it ends on a non-https URL after redirects', async () => {
  const cdp = { on() {}, send: async () => {} };
  const page = { on() {}, goto: async () => null, url: () => 'http://a.example/plain', content: async () => '<title>Plain</title>', title: async () => 'Plain', mainFrame: () => null };
  const context = { route: async () => {}, newPage: async () => page, close: async () => {} };
  const browser = { newBrowserCDPSession: async () => cdp, newContext: async () => context, close: async () => {} };
  const result = await createBrowserChecker(async () => browser).check('https://a.example/', 1000);
  assert.equal(result.status, 0);
  assert.match(result.error, /not https: http:\/\/a\.example\/plain/);
});

test('URLs written in references/upcoming.md count as listed, including balanced parentheses', async () => {
  const upcomingMd = '- OEIL 2025/0360(COD): https://oeil.europarl.europa.eu/oeil/en/procedure-file?reference=2025/0360(COD)\n- see (https://example.org/not-listed).';
  assert.deepEqual([...referenceUrls(upcomingMd)], ['https://oeil.europarl.europa.eu/oeil/en/procedure-file?reference=2025/0360(COD)', 'https://example.org/not-listed']);
  const { unlisted } = await checkSources(makeReport(), SOURCES_MD, { upcomingMd, fetchImpl: async () => reply(200, html('ok')), browserFactory: fakeBrowser(() => assert.fail('unused')), now: NOW });
  assert.deepEqual(unlisted, []);
});

test('browser fallback counts a challenge page that leaves an empty or non-https page as unreachable', async () => {
  const cdp = { on() {}, send: async () => {} };
  const make = (afterUrl, afterHtml = '<html><head></head><body></body></html>') => {
    let n = 0;
    const page = { on() {}, goto: async () => null, url: () => (n > 1 ? afterUrl : 'https://a.example/'), content: async () => { n += 1; return n === 1 ? '<title>Just a moment...</title>' : afterHtml; }, title: async () => '', waitForFunction: async () => {}, mainFrame: () => null };
    const context = { route: async () => {}, newPage: async () => page, close: async () => {} };
    return { newBrowserCDPSession: async () => cdp, newContext: async () => context, close: async () => {} };
  };
  const empty = await createBrowserChecker(async () => make('https://a.example/')).check('https://a.example/', 1000);
  assert.match(empty.error, /challenge not passed/);
  const plain = await createBrowserChecker(async () => make('http://a.example/', '<title>Real page</title>')).check('https://a.example/', 1000);
  assert.match(plain.error, /not https: http:\/\/a\.example\//);
});
