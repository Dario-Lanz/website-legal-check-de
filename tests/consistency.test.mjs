// Keeps code, checklist, sources, text drafts and templates in sync.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PATTERNS } from '../scripts/lib/checks/helpers.mjs';
import { TRACKER_COOKIE } from '../scripts/lib/checks/consent.mjs';
import { CHAMBER, CHAMBER_PROFESSION, OUTDATED_TMG, REGISTER, REPRESENTATIVE } from '../scripts/lib/checks/legal-content.mjs';
import { EMAIL_PATTERN, VAT_ID_PATTERN } from '../scripts/lib/checks/legal-pages.mjs';
import { CONSENT_WORDS } from '../scripts/lib/checks/script-tags.mjs';
import { CANCEL_BUTTON, DISPUTE_NOTICE, GREEN_CLAIM, isCompliantOrderLabel, MANUFACTURER, ORDER_BUTTON, SUBSCRIPTION, WITHDRAW_FUNCTION } from '../scripts/lib/checks/shop.mjs';
import { CHAT_TEXT, COMMENT_TEXT, NEWSLETTER } from '../scripts/lib/checks/site.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(ROOT, file), 'utf8');

async function checkIdsInCode() {
  const dir = path.join(ROOT, 'scripts/lib/checks');
  const ids = new Set();
  for (const file of await readdir(dir)) {
    const source = await readFile(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(/finding\('([A-Z]+-\d{2})'/g)) ids.add(match[1]);
    for (const match of source.matchAll(/linkOnEveryPage\(scan, '([A-Z]+-\d{2})'/g)) ids.add(match[1]);
  }
  return [...ids].sort();
}

test('every check ID used in code is described in the checklist', async () => {
  const checklist = await read('references/checklist.md');
  const missing = (await checkIdsInCode()).filter((id) => !checklist.includes(id));
  assert.deepEqual(missing, []);
});

test('every source ID cited in the checklist exists in sources.md', async () => {
  const checklist = await read('references/checklist.md');
  const sources = await read('references/sources.md');
  const cited = [...new Set([...checklist.matchAll(/SRC-\d{2,3}/g)].map((m) => m[0]))];
  assert.deepEqual(cited.filter((id) => !sources.includes(id)), []);
});

test('every text draft named in the checklist exists and carries the draft notice', async () => {
  const checklist = await read('references/checklist.md');
  const named = [...new Set([...checklist.matchAll(/([a-z-]+\.md)/g)].map((m) => m[1]))]
    .filter((name) => !['checklist.md', 'sources.md', 'mockup-components.md', 'pruefbericht.md', 'regelwerk.md', 'update.md', 'upcoming.md', 'report-json.md'].includes(name));
  const existing = await readdir(path.join(ROOT, 'templates/texte'));
  assert.deepEqual(named.filter((name) => !existing.includes(name)), []);
  for (const file of existing) {
    const text = await read(`templates/texte/${file}`);
    assert.ok(text.includes('Entwurf – keine Rechtsberatung, vor Veröffentlichung prüfen lassen'), `${file} lacks the draft notice`);
  }
});

test('report templates carry the legal-advice notice', async () => {
  assert.match(await read('templates/mockup.html'), /keine Rechtsberatung/i);
  const i18n = await read('scripts/lib/report/i18n.mjs');
  assert.match(i18n, /Keine Rechtsberatung/);
  assert.match(i18n, /Not legal advice/);
});

// Word lists in the checklist's "Scanner observation" use one marker: Words[key]: „a“, „b“.
// Each key belongs to one check and to the pattern of the code that recognises these words (decision 79a).
const matches = (pattern) => (word) => pattern.test(word);
const WORD_LISTS = {
  'imprint-link': ['IMP-01', matches(PATTERNS.imprint)],
  'imprint-email': ['IMP-02', matches(EMAIL_PATTERN)],
  'imprint-vat-id': ['IMP-03', matches(VAT_ID_PATTERN)],
  'imprint-representative': ['IMP-04', matches(REPRESENTATIVE)],
  'imprint-register': ['IMP-04', matches(REGISTER)],
  'imprint-profession': ['IMP-04', matches(CHAMBER_PROFESSION)],
  'imprint-chamber': ['IMP-04', matches(CHAMBER)],
  'imprint-tmg': ['IMP-04', matches(OUTDATED_TMG)],
  'privacy-link': ['DSE-01', matches(PATTERNS.privacy)],
  'privacy-page': ['DSE-02', matches(PATTERNS.privacy)],
  'tracker-cookie': ['TDD-03', matches(TRACKER_COOKIE)],
  'banner-accept': ['TDD-04', matches(PATTERNS.accept)],
  'banner-reject': ['TDD-04', matches(PATTERNS.reject)],
  'script-tag-consent': ['TDD-08', matches(CONSENT_WORDS)],
  'withdrawal-link': ['WID-01', matches(PATTERNS.withdrawal)],
  'withdraw-function': ['WID-02', matches(WITHDRAW_FUNCTION)],
  'terms-link': ['AGB-01', matches(PATTERNS.terms)],
  'order-button': ['BTN-01', matches(ORDER_BUTTON)],
  'order-button-accepted': ['BTN-01', isCompliantOrderLabel],
  'subscription': ['KUE-01', matches(SUBSCRIPTION)],
  'cancel-button': ['KUE-01', matches(CANCEL_BUTTON)],
  'vat-note': ['PRC-01', matches(PATTERNS.vatNote)],
  'net-note': ['PRC-01', matches(PATTERNS.netNote)],
  'shipping-note': ['PRC-02', matches(PATTERNS.shippingNote)],
  'dispute-notice': ['VSB-01', matches(DISPUTE_NOTICE)],
  'manufacturer': ['GPSR-01', matches(MANUFACTURER)],
  'newsletter': ['UWG-01', matches(NEWSLETTER)],
  'green-claim': ['UWG-02', matches(GREEN_CLAIM)],
  'accessibility-link': ['BF-02', matches(PATTERNS.accessibility)],
  'chat-text': ['AI-01', matches(CHAT_TEXT)],
  'comment-text': ['DSA-01', matches(COMMENT_TEXT)],
};
const MARKER = /Words\[([\w-]+)\]: ((?:„[^“]+“, )*„[^“]+“)/g;

/** The "Scanner observation" line of every check section, by check ID. */
function observations(checklist) {
  const sections = checklist.split(/^### /m).slice(1);
  return new Map(sections.map((section) => [section.slice(0, section.indexOf(' ')), section.match(/^- \*\*Scanner observation:\*\*(.*)$/m)?.[1] ?? '']));
}

test('every word list in the checklist is recognised by the code pattern of its check (decision 79a)', async () => {
  const lists = [];
  for (const [id, text] of observations(await read('references/checklist.md'))) {
    const found = [...text.matchAll(MARKER)];
    assert.equal((text.match(/Words\[/g) ?? []).length, found.length, `${id}: malformed Words[...] marker`);
    for (const [, key, items] of found) lists.push({ id, key, words: [...items.matchAll(/„([^“]+)“/g)].map((m) => m[1]) });
  }
  assert.deepEqual([...new Set(lists.map((l) => l.key))].sort(), Object.keys(WORD_LISTS).sort(), 'every marker key is mapped to code and every mapping is used');
  const unrecognised = [];
  for (const { id, key, words } of lists) {
    const [checkId, recognises] = WORD_LISTS[key];
    assert.equal(id, checkId, `${key} belongs to ${checkId}, found in ${id}`);
    for (const word of words) if (!recognises(word)) unrecognised.push(`${id} ${key}: „${word}“`);
  }
  assert.deepEqual(unrecognised, []);
});
