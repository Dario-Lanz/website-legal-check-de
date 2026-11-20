// evidence.mjs: digest content and sub-modes, on a small fixture run (no network).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { buildDigest } from '../scripts/lib/evidence/digest.mjs';
import { checklistEntry, generalSection, parseSources, platformSection, upcomingSummary } from '../scripts/lib/evidence/markdown.mjs';
import { grepPages } from '../scripts/lib/evidence/grep.mjs';
import { describePage, describeRequests } from '../scripts/lib/evidence/queries.mjs';
import { loadReferences, loadRun } from '../scripts/lib/evidence/run-files.mjs';
import { runEvidence } from '../scripts/evidence.mjs';

const RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/run-sample');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/evidence.mjs');
const run = await loadRun(RUN);
const refs = await loadReferences();
const digest = buildDigest(run, refs);

test('digest header names site, platform, notes, pages and both consent runs', () => {
  assert.match(digest, /host: www\.beispiel\.de/);
  assert.match(digest, /platform: WordPress \(confidence high\); add-ons: WooCommerce/);
  assert.match(digest, /scan notes: Time limit reached after 20 minutes\./);
  assert.match(digest, /#2 https:\/\/www\.beispiel\.de\/shop \[shop\] 200 -> https:\/\/www\.beispiel\.de\/shop\//);
  assert.match(digest, /reject: clicked "Nur notwendige", banner gone: true/);
  assert.match(digest, /third-party hosts after click: www\.googletagmanager\.com \(Google Analytics\)/);
  assert.match(digest, /new cookies: _ga/);
  assert.match(digest, /accept: not clicked, reason: no matching button found/);
});

test('digest contains the four general checklist sections verbatim, once each', () => {
  for (const title of ['Priority rules', 'Scope assumptions', 'Manual checks', 'Wording rules (RDG)']) {
    const section = generalSection(refs.checklist, title);
    assert.ok(section.length > 100, title);
    assert.equal(digest.split(section).length - 1, 1, `${title} appears exactly once`);
  }
});

test('each checklist entry is printed once even if two findings share the ID', () => {
  const entry = checklistEntry(refs.checklist, 'TDD-01');
  assert.equal(digest.split(entry).length - 1, 1);
  assert.match(digest, /--- F2 TDD-01 \[gap\] Google Maps[\s\S]*?checklist entry: printed at F1/);
});

test('findings show evidence JSON, screenshots of their pages and Help-line sources', () => {
  assert.match(digest, /evidence: \{"service":"Google Analytics","category":"analytics","requests":\["https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-1"\]\}/);
  assert.match(digest, /screenshots: belege\/seite-01-cookieabfrage\.jpg, belege\/seite-01-ansicht\.jpg/);
  assert.match(digest, /SRC-01: § 25 TDDDG[^\n]*<https:\/\/www\.gesetze-im-internet\.de\/ttdsg\/__25\.html>/);
});

test('evidence-named screenshots come first; unknown IDs are reported; ok findings are one line at the end', () => {
  assert.match(digest, /--- F3 PRC-01 \[hint\][\s\S]*?screenshots: belege\/seite-02-ansicht\.jpg\n/);
  assert.match(digest, /--- F4 ZZZ-99[\s\S]*?no entry for ZZZ-99/);
  const tail = digest.slice(digest.indexOf('--- ok findings'));
  assert.match(tail, /^--- ok findings\nok IMP-01: Imprint link on every scanned page\n/);
  assert.ok(!digest.includes('### IMP-01'), 'ok finding gets no entry');
});

test('digest has the platform intro, the detected section and the upcoming summary table', () => {
  assert.match(digest, /=== PLATFORMS[\s\S]*?# Platforms[\s\S]*?## 1\. WordPress/);
  assert.equal(digest.includes(platformSection(refs.platforms, 'WordPress')), true);
  assert.ok(!digest.includes('## 2. Shopify'));
  assert.equal(digest.includes(upcomingSummary(refs.upcoming)), true);
});

test('an unknown platform prints no system section', () => {
  const unknown = buildDigest({ scan: run.scan, findings: { ...run.findings, siteProfile: { platform: { name: null } } } }, refs);
  assert.match(unknown, /no section for the detected system: none detected/);
});

test('grep finds matches case-insensitively, merges identical snippets and names the pages', async () => {
  const out = await grepPages(run.scan, 'WIDERRUF');
  assert.match(out, /^grep \/WIDERRUF\/i in 3 pages[^\n]*: 1 distinct matches/);
  assert.match(out, /\[bodyText\] #1 \(first: https:\/\/www\.beispiel\.de\/\): .*Widerruf und Rückgabe/);
});

test('grep searches the shared footer once (all pages listed) and also link texts and hrefs', async () => {
  const footer = await grepPages(run.scan, 'footer \\d');
  assert.equal(footer.split('\n').filter((l) => l.startsWith('[footerText]')).length, 3, 'footers differ per page here');
  const same = structuredClone(run.scan);
  same.pages.forEach((p) => { p.facts.footerText = 'Gemeinsame Fußzeile Kontakt'; });
  const merged = (await grepPages(same, 'Fußzeile')).split('\n').filter((l) => l.startsWith('[footerText]'));
  assert.equal(merged.length, 1);
  assert.match(merged[0], /#1, #2, #3 \(first:/);
  const links = structuredClone(run.scan);
  links.pages.forEach((p) => { p.facts.links = [{ href: 'https://www.beispiel.de/impressum', text: 'Impressum', region: 'footer', visible: true }]; });
  assert.match(await grepPages(links, 'beispiel\\.de/impressum'), /\[link\] #1, #2, #3 \(first: https:\/\/www\.beispiel\.de\/\): Impressum -> https:\/\/www\.beispiel\.de\/impressum$/);
});

test('grep can be restricted to one page', async () => {
  assert.match(await grepPages(run.scan, 'Shop', { page: 2 }), /in page #2 .*: 2 distinct/);
  assert.match(await grepPages(run.scan, 'Shop', { page: 3 }), /in page #3 .*: 0 distinct matches/);
  await assert.rejects(grepPages(run.scan, 'Shop', { page: 9 }), /no page with index 9/);
});

test('grep stops collecting at the cap and says "more than"', async () => {
  const many = structuredClone(run.scan);
  many.pages[0].facts.bodyText = Array.from({ length: 200 }, (_, i) => `x${i} ${'.'.repeat(400)}`).join(' ');
  many.pages[0].facts.links = Array.from({ length: 200 }, (_, i) => ({ href: `https://a.example/x${i}`, text: `x${i}`, region: 'main', visible: true }));
  const out = await grepPages(many, 'x\\d');
  assert.match(out, /more than 40 distinct matches, showing the first 40/);
  assert.equal(out.split('\n').length, 41);
});

test('grep rejects invalid, empty-matching and oversized patterns cleanly', async () => {
  await assert.rejects(grepPages(run.scan, '('), /invalid regular expression/);
  await assert.rejects(grepPages(run.scan, ''), /non-empty/);
  await assert.rejects(grepPages(run.scan, 'a'.repeat(201)), /too long/);
  for (const p of ['a*', '^', '(foo)?', '$']) await assert.rejects(grepPages(run.scan, p), /matches the empty string/, p);
});

test('grep ends a catastrophic pattern with a time limit instead of hanging', async () => {
  const slow = structuredClone(run.scan);
  slow.pages[0].facts.bodyText = `${'a'.repeat(40)}!`;
  const started = Date.now();
  await assert.rejects(grepPages(slow, '(a+)+$', { timeLimitMs: 300 }), /stopped after 0\.3 s/);
  assert.ok(Date.now() - started < 3000);
});

test('page shows banner, buttons, links and texts; unknown index is rejected', () => {
  const out = describePage(run.scan, 1);
  assert.match(out, /banner: selector #cookie[\s\S]*buttons: Alle akzeptieren \| Einstellungen/);
  assert.match(out, /\[footer\] Impressum -> https:\/\/www\.beispiel\.de\/impressum/);
  assert.match(out, /bodyText: Willkommen bei Beispiel/);
  assert.throws(() => describePage(run.scan, 9), /no page with index 9/);
});

test('requests are grouped by host with counts and page indexes; --host drills down to URLs', () => {
  const out = describeRequests(run.scan);
  assert.match(out, /www\.googletagmanager\.com {2}service: Google Analytics {2}category: analytics {2}requests: 2 {2}pages: #1, #2/);
  assert.ok(!out.includes('(first party)'));
  const drill = describeRequests(run.scan, 'GSTATIC');
  assert.match(drill, /fonts\.gstatic\.com[\s\S]*#2 \[script\] https:\/\/fonts\.gstatic\.com\/s\/x\.woff2/);
  assert.match(describeRequests(run.scan, 'nope'), /no requests to a host containing "nope"/);
});

test('markdown helpers read the real reference files', () => {
  assert.ok(parseSources(refs.sources).get('SRC-01').url.startsWith('https://www.gesetze-im-internet.de/'));
  assert.equal(checklistEntry(refs.checklist, 'NOPE-01'), null);
  assert.ok(checklistEntry(refs.checklist, 'IMP-01').endsWith('legal basis verified, scope interpretation UNVERIFIED.'));
});

test('runEvidence validates its input', async () => {
  await assert.rejects(runEvidence({}), /--run/);
  await assert.rejects(runEvidence({ run: RUN, host: 'x' }), /--host only works/);
  await assert.rejects(runEvidence({ run: RUN, page: 'abc' }), /page number/);
  await assert.rejects(runEvidence({ run: RUN, entry: 'foo' }), /invalid check ID/);
  await assert.rejects(runEvidence({ run: RUN, upcoming: 'UP-1' }), /invalid ID/);
  await assert.rejects(runEvidence({ run: '/nonexistent-run' }), /scan\.json not found/);
  await assert.rejects(runEvidence({ run: path.join(RUN, 'daten/scan.json') }), /scan\.json cannot be read \(ENOTDIR\)/, 'a read error other than "not found" keeps its cause');
  assert.match(await runEvidence({ run: RUN, entry: 'ZZZ-99' }), /no entry for ZZZ-99.*Known IDs: IMP-01/);
  const man = await runEvidence({ run: RUN, entry: 'MAN-06' });
  assert.match(man, /^\| ID \| Duty \|[\s\S]*\| MAN-06 \|[\s\S]*sources named in this entry:\n {2}SRC-\d+: .* <https:\/\/[^>]+>/);
  assert.match(await runEvidence({ run: RUN, upcoming: 'UP-02' }), /^## UP-02 /);
});

test('every SRC ID anywhere in an entry or the Manual checks section is resolved', async () => {
  const entry = await runEvidence({ run: RUN, entry: 'IMP-01' });
  assert.match(entry, /sources named in this entry:\n {2}SRC-16: .*\n {2}SRC-05: /);
  const ids = [...new Set(generalSection(refs.checklist, 'Manual checks').match(/SRC-\d{2,3}/g))];
  const block = digest.slice(digest.indexOf('sources named in this section:'), digest.indexOf('## Wording rules'));
  for (const id of ids) assert.ok(block.includes(`  ${id}: `), id);
  assert.ok(!block.includes('not found in sources.md'));
});

test('only meaningful option combinations are accepted', async () => {
  await assert.rejects(runEvidence({ run: RUN, grep: 'x', requests: true }), /unsupported combination: --grep --requests/);
  await assert.rejects(runEvidence({ run: RUN, page: '1', entry: 'TDD-01' }), /unsupported combination: --entry --page/);
  await assert.rejects(runEvidence({ run: RUN, host: 'x' }), /--host only works together with --requests/);
  await assert.rejects(runEvidence({ run: RUN, upcoming: 'UP-01', host: 'x' }), /unsupported combination/);
  assert.match(await runEvidence({ run: RUN, grep: 'Shop', page: '2' }), /in page #2/);
});

test('digest section order: header, general sections, platform, upcoming, findings', () => {
  const at = (marker) => digest.indexOf(marker);
  const order = ['=== SITE ===', '=== CONSENT RUNS ===', '=== CHECKLIST GENERAL SECTIONS', '=== PLATFORMS', '=== UPCOMING RULES', '=== FINDINGS'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every((i) => i >= 0));
});

test('CLI writes the digest to daten/evidence.txt and prints only path, size and line count', async () => {
  const exec = promisify(execFile);
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-'));
  try {
    await cp(RUN, dir, { recursive: true });
    const { stdout } = await exec('node', [CLI, '--run', dir], { timeout: 30_000 });
    const text = await readFile(path.join(dir, 'daten/evidence.txt'), 'utf8');
    assert.match(text, /=== FINDINGS \(4 candidates to verify, 1 ok\) ===/);
    assert.ok(stdout.length < 600, 'stdout stays short');
    assert.match(stdout, new RegExp(`evidence\\.txt: ${text.length - 1} characters, ${text.split('\n').length - 1} lines`));
    await assert.rejects(exec('node', [CLI, '--run', RUN, '--grep', '('], { timeout: 30_000 }), (e) => e.code === 1 && /invalid regular expression/.test(e.stderr));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('grep ignores zero-length matches such as \\b or lookaheads instead of listing noise', async () => {
  for (const p of ['\\b', '(?=e)']) {
    const lines = (await grepPages(run.scan, p)).split('\n');
    assert.match(lines[0], /: 0 distinct matches$/, p);
    assert.equal(lines.length, 1, p);
  }
});

test('grep names the pages whose matches were cut and shows all of them with --page', async () => {
  const many = structuredClone(run.scan);
  many.pages[0].facts.bodyText = Array.from({ length: 8 }, (_, i) => `Treffer${i} ${'x'.repeat(400)}`).join(' ');
  const all = await grepPages(many, 'Treffer\\d');
  assert.match(all.split('\n')[0], new RegExp(`more matches than shown on #${many.pages[0].index} \\(use --page`));
  const one = await grepPages(many, 'Treffer\\d', { page: many.pages[0].index });
  assert.match(one.split('\n')[0], /: 8 distinct matches$/);
});

test('grep reports exactly 40 matches as 40 and shows more than 40 matches of one page with --page', async () => {
  const fill = (count) => {
    const scan = structuredClone(run.scan);
    scan.pages[0].facts.bodyText = Array.from({ length: count }, (_, i) => `Wort${i} ${'x'.repeat(400)}`).join(' ');
    return scan;
  };
  const exact = await grepPages(fill(40), 'Wort\\d+', { page: run.scan.pages[0].index });
  assert.match(exact.split('\n')[0], /: 40 distinct matches$/);
  const many = await grepPages(fill(60), 'Wort\\d+', { page: run.scan.pages[0].index });
  assert.match(many.split('\n')[0], /: 60 distinct matches$/);
});

test('grep with --page says "more than 200" above its cap, and lists at most 10 cut pages', async () => {
  const scan = structuredClone(run.scan);
  scan.pages[0].facts.bodyText = Array.from({ length: 250 }, (_, i) => `Wort${i} ${'x'.repeat(400)}`).join(' ');
  const one = await grepPages(scan, 'Wort\\d+', { page: scan.pages[0].index });
  assert.match(one.split('\n')[0], /more than 200 distinct matches, showing the first 200$/);
  const wide = structuredClone(run.scan);
  wide.pages = Array.from({ length: 12 }, (_, i) => ({ ...structuredClone(run.scan.pages[0]), index: i + 1, url: `https://a.example/${i}`, facts: { bodyText: `Seite${i} ${'Treffer '.repeat(8)}`, footerText: '', links: [] } }));
  assert.match((await grepPages(wide, 'Treffer')).split('\n')[0], /#1, #2, #3, #4, #5, #6, #7, #8, #9, #10 and 2 more pages \(use --page/);
});
