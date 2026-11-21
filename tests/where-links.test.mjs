// Decisions 101a-104a: the finding location ("Fundstelle") is written out with full URLs of the checked site at build time.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PDFArray, PDFDocument, PDFName } from 'pdf-lib';
import { buildReports } from '../scripts/build-reports.mjs';
import { customTexts, translationTemplate } from '../scripts/translation.mjs';
import { texts } from '../scripts/lib/report/i18n.mjs';
import { buildModel } from '../scripts/lib/report/model.mjs';
import { renderKiPrompt } from '../scripts/lib/report/ki-prompt.mjs';
import { renderKurzbericht } from '../scripts/lib/report/kurzbericht.mjs';
import { renderLangfassung } from '../scripts/lib/report/langfassung.mjs';
import { expandWhere, siteBase, whereHtml } from '../scripts/lib/report/where-links.mjs';

const de = texts('de');
const en = texts('en');
const START = 'https://www.noavia.de/';

test('site values: host only, host with path, full URL', () => {
  assert.deepEqual(siteBase('www.noavia.de'), { origin: 'https://www.noavia.de', start: 'https://www.noavia.de/' });
  assert.deepEqual(siteBase('www.keeeper.com/de/'), { origin: 'https://www.keeeper.com', start: 'https://www.keeeper.com/de/' });
  assert.deepEqual(siteBase('wh.group/de'), { origin: 'https://wh.group', start: 'https://wh.group/de' });
  assert.deepEqual(siteBase('https://x.de/'), { origin: 'https://x.de', start: 'https://x.de/' });
  assert.equal(siteBase('not a site'), null);
});

test('site-relative paths become full URLs (examples from real reports)', () => {
  const k = 'www.keeeper.com/de/';
  assert.equal(expandWhere('/de/shop/, /de/sale/', k, de), 'https://www.keeeper.com/de/shop/, https://www.keeeper.com/de/sale/');
  assert.equal(expandWhere('Startseite /', 'www.noavia.de', de), 'Startseite https://www.noavia.de/');
  assert.equal(expandWhere('/rechtliches/datenschutz-cookies', 'www.noavia.de', de), 'https://www.noavia.de/rechtliches/datenschutz-cookies');
  assert.equal(
    expandWhere('/de/sale/, /de/kids/ (vor Einwilligung); /de/, /de/shop/ nach dem Ablehnen', k, de),
    'https://www.keeeper.com/de/sale/, https://www.keeeper.com/de/kids/ (vor Einwilligung); https://www.keeeper.com/de/, https://www.keeeper.com/de/shop/ nach dem Ablehnen',
  );
  assert.equal(expandWhere('Seite (dazu /cn/)', 'wh.group/de', de), 'Seite (dazu https://wh.group/cn/)');
  assert.equal(expandWhere('Kontakt: /kontakt/.', 'x.de', de), 'Kontakt: https://x.de/kontakt/.', 'trailing full stop stays outside');
});

test('full URLs stay unchanged, slashes inside words and bare slashes between words are no paths', () => {
  const text = 'Alle Seiten (Fußzeile); Anfrageformular auf https://www.stroemcraft.com/#contact';
  assert.equal(expandWhere(text, 'stroemcraft.com', de), text);
  assert.equal(expandWhere('https://www.stroemcraft.com/ und https://www.stroemcraft.com/impressum', 'stroemcraft.com', de), 'https://www.stroemcraft.com/ und https://www.stroemcraft.com/impressum');
  assert.equal(expandWhere('Cookie und/oder Banner, siehe …/flexodruckmaschinen/', 'x.de', de), 'Cookie und/oder Banner, siehe …/flexodruckmaschinen/ (geprüft u. a. https://x.de/)');
  assert.equal(expandWhere('A / B /kontakt', 'x.de', de), 'A / B https://x.de/kontakt');
});

test('no path and no URL: the start page is appended in the document language', () => {
  assert.equal(expandWhere('Alle Seiten', 'www.noavia.de', de), `Alle Seiten (geprüft u. a. ${START})`);
  assert.equal(expandWhere('39 von 43 Seiten', 'www.noavia.de', en), `39 von 43 Seiten (checked e.g. ${START})`);
  assert.equal(expandWhere('Startseite (Framer-Schrift)', 'wh.group/de', en), 'Startseite (Framer-Schrift) (checked e.g. https://wh.group/de)');
  assert.equal(expandWhere('/x/', 'x.de', en), 'https://x.de/x/', 'a path means no appended start page');
});

test('an unreadable site value leaves the text unchanged', () => {
  assert.equal(expandWhere('/x/', 'kein host', de), '/x/');
});

test('HTML: URLs are links, the rest is escaped, trailing punctuation stays outside the link', () => {
  const html = whereHtml('<b>/x</b> siehe https://x.de/a/b, und (https://x.de/c). Ende https://x.de/d.');
  assert.match(html, /^&lt;b&gt;\/x&lt;\/b&gt; siehe <a href="https:\/\/x\.de\/a\/b">https:\/\/x\.de\/a\/b<\/a>, und \(<a href="https:\/\/x\.de\/c">https:\/\/x\.de\/c<\/a>\)\./);
  assert.match(html, /<a href="https:\/\/x\.de\/d">https:\/\/x\.de\/d<\/a>\.$/);
  assert.equal(whereHtml('javascript:alert(1)'), 'javascript:alert(1)');
});

const finding = (where) => ({ prio: 1, kind: 'gap', title: 'T', what: 'W', where, law: 'L', fix: 'F', evidence: 'E', summary: 'S', plain: { where: 'pw', law: 'pl', evidence: 'pe' }, aiTask: 'task' });
const report = (site, ...wheres) => ({ site, date: '21.11.2026', pagesScanned: 3, checklistStatus: '07.11.2026', findings: wheres.map(finding) });

test('short report, long report and AI prompt carry the full URL; the stored data keep the relative path', () => {
  const data = report('www.noavia.de', '/rechtliches/impressum', 'Alle Seiten');
  const model = buildModel(data);
  assert.equal(data.findings[0].where, '/rechtliches/impressum', 'report.json is not changed');
  const url = 'https://www.noavia.de/rechtliches/impressum';
  for (const html of [renderKurzbericht(model), renderLangfassung(model, {})]) {
    assert.ok(html.includes(`<a href="${url}">${url}</a>`), 'clickable full URL');
    assert.ok(html.includes(`geprüft u. a. <a href="${START}">`.replace('u. a.', 'u. a.')), 'start page link for a location without path');
  }
  const prompt = renderKiPrompt(model);
  assert.ok(prompt.includes(`- ${de.prompt.where}: ${url}`));
  assert.ok(prompt.includes(`(geprüft u. a. ${START})`));
  assert.ok(!prompt.includes('<a '), 'plain text');
});

test('table cells break words only when they overflow; only URL text may break anywhere', () => {
  const html = renderKurzbericht(buildModel(report('x.de', '/a/very/long/path')));
  assert.match(html, /th, td \{[^}]*overflow-wrap: break-word/);
  assert.doesNotMatch(html, /th, td \{[^}]*overflow-wrap: anywhere/);
  assert.match(html, /td a \{[^}]*overflow-wrap: anywhere/);
  const long = renderLangfassung(buildModel(report('x.de', '/a')), {});
  assert.doesNotMatch(long, /th, td \{[^}]*overflow-wrap: anywhere/);
  assert.match(long, /th, td \{[^}]*overflow-wrap: break-word/);
});

test('translated document languages get the appended text from the translation template', () => {
  const tpl = translationTemplate();
  assert.equal(tpl.whereChecked, '(checked e.g. {url})');
  const mark = (v) => (typeof v === 'string' ? `«${v}»` : Array.isArray(v) ? v.map(mark) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mark(x)])) : v);
  const { _comment, ...rest } = tpl;
  const t = customTexts({ ...mark(rest), lang: 'fr', languageName: 'Français' });
  assert.equal(expandWhere('Toutes les pages', 'x.de', t), 'Toutes les pages «(checked e.g. https://x.de/)»');
  const incomplete = { ...mark(rest), lang: 'fr', languageName: 'Français' };
  delete incomplete.whereChecked;
  assert.throws(() => customTexts(incomplete), /whereChecked: missing/);
});

async function links(file) {
  const doc = await PDFDocument.load(await readFile(file));
  const uris = [];
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (let i = 0; i < (annots?.size() ?? 0); i += 1) {
      const uri = annots.lookup(i).lookup(PDFName.of('A'))?.lookup?.(PDFName.of('URI'));
      if (uri) uris.push(uri.decodeText?.() ?? uri.asString());
    }
  }
  return uris;
}

test('both PDFs contain the clickable full URL of the location', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wlc-where-'));
  try {
    const file = path.join(dir, 'report.json');
    await writeFile(file, JSON.stringify(report('www.example.de', '/de/shop/, /de/sale/', 'Alle Seiten')));
    const result = await buildReports(file, '20261121_example', { short: true, long: true });
    for (const name of ['Kurzbericht', 'Langfassung']) {
      const uris = await links(result[name].pdf);
      for (const u of ['https://www.example.de/de/shop/', 'https://www.example.de/de/sale/', 'https://www.example.de/']) assert.ok(uris.includes(u), `${name}: ${u}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('N7: the short report table has fixed column widths that add up to the content width, "Wo" wider than "Nr."', () => {
  const html = renderKurzbericht(buildModel(report('x.de', '/a')));
  assert.match(html, /table \{[^}]*table-layout: fixed/);
  const widths = [...html.matchAll(/<col style="width: (\d+(?:\.\d+)?)%">/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, 5);
  assert.ok(Math.abs(widths.reduce((a, b) => a + b, 0) - 100) < 0.01, `sum ${widths}`);
  assert.ok(widths[2] >= 25 && widths[0] <= 8, `Wo ${widths[2]}%, Nr. ${widths[0]}%`);
});

test('table cells hyphenate long words by the document language; links are never hyphenated (decision 110a)', () => {
  const html = renderKurzbericht(buildModel(report('x.de', '/a')));
  assert.match(html, /<html lang="de"/);
  assert.match(html, /th, td \{[^}]*hyphens: auto/);
  assert.match(html, /td a \{[^}]*hyphens: manual/);
  const long = renderLangfassung(buildModel(report('x.de', '/a')), {});
  assert.match(long, /th, td \{[^}]*hyphens: auto/);
  assert.match(long, /\ba \{[^}]*hyphens: manual/);
});

test('technical tokens in table cells (hosts, files, paths, cookie names) are never hyphenated (decision 110a)', async () => {
  const { escCell } = await import('../scripts/lib/report/html-escape.mjs');
  const cell = escCell('Pixel (pixel.wp.com, connect.facebook.net/en_US/fbevents.js) setzt _fbp; z. B. <b> & 1.900 € inkl. Einwilligung');
  for (const token of ['pixel.wp.com', 'connect.facebook.net/en_US/fbevents.js', '1.900']) assert.ok(cell.includes(`<span class="tech">${token}</span>`), token);
  assert.ok(!cell.includes('<span class="tech">Einwilligung'));
  assert.ok(cell.includes('&lt;b&gt; &amp;'), 'escaped');
  assert.ok(cell.includes('z. B.'), 'typography kept');
  assert.doesNotMatch(escCell('<span class="tech">x.y</span>'), /<span class="tech">x/);
  const model = buildModel(report('x.de', '/a'));
  model.findings[0].what = 'lädt pixel.wp.com';
  assert.ok(renderKurzbericht(model).includes('<span class="tech">pixel.wp.com</span>'));
  assert.match(renderKurzbericht(model), /\.tech \{[^}]*hyphens: manual/);
  assert.match(renderLangfassung(model, {}), /\.tech \{[^}]*hyphens: manual/);
});

test('escCell stays fast on very long cells without spaces', async () => {
  const { escCell } = await import('../scripts/lib/report/html-escape.mjs');
  const started = Date.now();
  escCell('a'.repeat(200000));
  escCell(`${'a'.repeat(200000)}.b`);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});
