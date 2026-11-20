// report-skeleton.mjs: mechanical prefill, and the existing validation still rejects it until filled.

import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { berlinDateTime } from '../scripts/lib/berlin-time.mjs';
import { loadReferences, loadRun } from '../scripts/lib/evidence/run-files.mjs';
import { renderKiPrompt } from '../scripts/lib/report/ki-prompt.mjs';
import { renderKurzbericht } from '../scripts/lib/report/kurzbericht.mjs';
import { renderLangfassung } from '../scripts/lib/report/langfassung.mjs';
import { buildModel } from '../scripts/lib/report/model.mjs';
import { buildSkeleton, siteName } from '../scripts/lib/skeleton.mjs';
import { writeSkeleton } from '../scripts/report-skeleton.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/run-sample');
const run = await loadRun(FIXTURE);
const refs = await loadReferences();
const skeleton = buildSkeleton(run, refs, 'de');

test('Berlin date and time cross midnight in summer time', () => {
  assert.deepEqual(berlinDateTime('2026-07-01T22:30:00.000Z'), { date: '02.07.2026', time: '00:30' });
  assert.deepEqual(berlinDateTime('2026-11-16T14:35:34.273Z'), { date: '16.11.2026', time: '15:35' });
  assert.equal(berlinDateTime('not a date'), null);
  for (const empty of [null, undefined, '']) assert.equal(berlinDateTime(empty), null, String(empty));
});

test('top-level fields are filled from scan, findings and checklist', () => {
  assert.equal(skeleton.language, 'de');
  assert.equal(skeleton.site, 'www.beispiel.de');
  assert.equal(skeleton.date, '02.07.2026');
  assert.equal(skeleton.time, '00:30');
  assert.equal(skeleton.pagesScanned, 3);
  assert.equal(skeleton.checklistStatus, '07.11.2026');
  assert.equal(skeleton.platform.name, 'WordPress');
  assert.deepEqual(skeleton.scanNotes, ['Time limit reached after 20 minutes.']);
  assert.deepEqual(skeleton.okChecks, [], 'okChecks are Claude\'s own wording');
});

test('site name keeps a path but drops a bare slash and the scheme', () => {
  assert.equal(siteName('https://www.xyz.de/'), 'www.xyz.de');
  assert.equal(siteName('https://www.keeeper.com/de/'), 'www.keeeper.com/de/');
});

test('one candidate per non-ok finding, with scanner status, hints, pages, figure candidates and sources', () => {
  assert.deepEqual(skeleton.findings.map((f) => f.check), ['TDD-01', 'TDD-01', 'PRC-01', 'ZZZ-99']);
  const [analytics, , prices, unknown] = skeleton.findings;
  assert.equal(analytics.scannerStatus, 'gap');
  assert.equal(prices.scannerStatus, 'hint');
  assert.equal(analytics.kind, undefined, 'kind is Claude\'s judgement');
  assert.deepEqual(analytics.pages, ['/', '/shop/']);
  assert.deepEqual(analytics.figureCandidates, ['belege/seite-01-cookieabfrage.jpg', 'belege/seite-01-ansicht.jpg', 'belege/seite-02-ansicht.jpg']);
  assert.equal(analytics.figures, undefined, 'figures are not prefilled');
  assert.equal(analytics.sources[0].url, 'https://www.gesetze-im-internet.de/ttdsg/__25.html');
  assert.deepEqual([analytics.sources[0].use, analytics.sources[0].retrieved], ['', '']);
  assert.deepEqual([unknown.sources, unknown.abmahnung, unknown.abmahnungHint], [[], undefined, undefined]);
});

test('abmahnung is prefilled only for an unqualified yes, otherwise the checklist line is a hint', () => {
  const [analytics, , prices] = skeleton.findings;
  assert.equal(analytics.abmahnung, undefined);
  assert.equal(analytics.abmahnungHint, 'uncertain.');
  assert.equal(prices.abmahnung, true, 'PRC-01: "yes."');
  assert.equal(prices.abmahnungHint, undefined);
  const qualified = (check) => buildSkeleton({ scan: run.scan, findings: { siteProfile: {}, findings: [{ check, status: 'gap', title: 'x', pages: [], evidence: {} }] } }, refs, 'de').findings[0];
  for (const check of ['IMP-02', 'TDD-02', 'WID-02']) {
    const f = qualified(check);
    assert.equal(f.abmahnung, undefined, `${check} is qualified`);
    assert.ok(f.abmahnungHint.length > 0, check);
  }
  assert.equal(qualified('IMP-01').abmahnung, true);
});

test('figure candidates follow the check: dialog shots for consent checks, footer shots for link checks', () => {
  const shots = (check, pages) => buildSkeleton({ scan: run.scan, findings: { siteProfile: {}, findings: [{ check, status: 'gap', title: 'x', pages, evidence: {} }] } }, refs, 'de').findings[0].figureCandidates;
  const page1 = ['https://www.beispiel.de/'];
  assert.deepEqual(shots('TDD-04', page1), ['belege/seite-01-cookieabfrage.jpg', 'belege/seite-01-ansicht.jpg']);
  assert.deepEqual(shots('IMP-01', page1), ['belege/seite-01-fusszeile.jpg', 'belege/seite-01-ansicht.jpg']);
  assert.deepEqual(shots('PRC-01', page1), ['belege/seite-01-ansicht.jpg'], 'no dialog or footer shots for other checks');
});

test('judgement fields are empty or missing', () => {
  for (const f of skeleton.findings) {
    for (const key of ['title', 'summary', 'what', 'where', 'law', 'fix', 'evidence']) assert.equal(f[key], '', key);
    for (const key of ['prio', 'kind', 'plain', 'steps', 'draft', 'mockup', 'aiTask', 'done', 'figures']) assert.equal(f[key], undefined, key);
  }
  for (const key of ['assumptions', 'manualChecks', 'dropped', 'upcoming']) assert.deepEqual(skeleton[key], []);
});

test('the existing validation rejects the skeleton until a finding is filled in', () => {
  assert.throws(() => buildModel(structuredClone(skeleton)), /missing "prio" in findings\[0\]/);
  const filled = structuredClone(skeleton);
  const plain = { where: 'w', law: 'l', evidence: 'e' };
  filled.findings = filled.findings.map((f) => ({ ...f, prio: 1, kind: 'gap', title: 'T', summary: 'S', plain, what: 'W', where: 'X', law: 'L', fix: 'F', evidence: 'E', sources: f.sources.map((s) => ({ ...s, use: 'u', retrieved: '20.11.2026' })) }));
  assert.equal(buildModel(filled).findings.length, 4);
  const emptyUse = structuredClone(filled);
  emptyUse.findings[0].sources[0].use = '';
  assert.throws(() => buildModel(emptyUse), /missing "use"/);
  const noDate = structuredClone(filled);
  noDate.findings[0].sources[0].retrieved = '';
  assert.throws(() => buildModel(noDate), /missing "retrieved"/);
});

test('the build ignores pages, scannerStatus, figureCandidates and abmahnungHint', () => {
  const filled = { ...structuredClone(skeleton), findings: [{ prio: 1, kind: 'gap', title: 'T', summary: 'S', plain: { where: 'w', law: 'l', evidence: 'e' }, what: 'W', where: 'X', law: 'L', fix: 'F', evidence: 'E', pages: ['/MARK-PAGES/'], scannerStatus: 'MARK-STATUS', figureCandidates: ['MARK-FIG.jpg'], abmahnungHint: 'MARK-HINT' }] };
  const model = buildModel(filled);
  const html = `${renderKurzbericht(model)}${renderLangfassung(model)}${renderKiPrompt(model)}`;
  for (const mark of ['MARK-PAGES', 'MARK-STATUS', 'MARK-FIG', 'MARK-HINT']) assert.ok(!html.includes(mark), mark);
  assert.equal(model.findings[0].abmahnung, false, 'a hint never turns the warning-letter flag on');
});

test('an unparsable scan time leaves date and time missing, and the validation says so', () => {
  const noTime = buildSkeleton({ scan: { ...run.scan, scannedAt: null }, findings: run.findings }, refs, 'de');
  assert.equal('date' in noTime || 'time' in noTime, false);
  assert.throws(() => buildModel({ ...noTime, findings: [] }), /missing "date"/);
});

test('language code must be two lowercase letters', () => {
  assert.throws(() => buildSkeleton(run, refs, 'DE'), /two-letter/);
  assert.throws(() => buildSkeleton(run, refs, undefined), /two-letter/);
});

test('writeSkeleton refuses to overwrite without --force', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'skeleton-'));
  try {
    await cp(FIXTURE, dir, { recursive: true });
    const first = await writeSkeleton({ run: dir, lang: 'de' });
    assert.equal(first.findings, 4);
    await writeFile(path.join(dir, 'daten/report.json'), '{"keep":"me"}');
    await assert.rejects(writeSkeleton({ run: dir, lang: 'de' }), /already exists; use --force/);
    assert.equal(await readFile(path.join(dir, 'daten/report.json'), 'utf8'), '{"keep":"me"}');
    await writeSkeleton({ run: dir, lang: 'en', force: true });
    assert.equal(JSON.parse(await readFile(path.join(dir, 'daten/report.json'), 'utf8')).language, 'en');
    await assert.rejects(writeSkeleton({ lang: 'de' }), /--run/);
    await assert.rejects(writeSkeleton({ run: dir }), /--lang/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
