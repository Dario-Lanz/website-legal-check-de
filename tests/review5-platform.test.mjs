// Blind real run (noavia.de on Framer, question 4 = U): the assumption must not promise click paths that do not exist.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveKiPrompt } from '../scripts/build-reports.mjs';
import { hasClickPaths } from '../scripts/lib/platform-docs.mjs';
import { texts } from '../scripts/lib/report/i18n.mjs';
import { translationTemplate } from '../scripts/translation.mjs';

test('click paths exist exactly for the systems with a section in references/platforms.md', () => {
  for (const name of ['WordPress', 'Shopify', 'Wix', 'Jimdo', 'Squarespace', 'Webflow', 'TYPO3', 'Shopware']) assert.equal(hasClickPaths(name), true, name);
  assert.equal(hasClickPaths('Framer'), false);
  assert.equal(hasClickPaths(null), false);
  assert.equal(hasClickPaths('Unbekannt'), false);
});

test('U with a detected system without click paths: no prompt, generic steps, in German and English', () => {
  const de = resolveKiPrompt('unknown', { platform: { name: 'Framer' } }, texts('de'));
  assert.equal(de.kiPrompt, false);
  assert.match(de.assumption.consequence, /keine geprüften Klickwege/);
  assert.match(de.assumption.consequence, /allgemein/);
  assert.doesNotMatch(de.assumption.consequence, /nutzen die Klickwege/);
  const en = resolveKiPrompt('unknown', { platform: { name: 'Framer' } }, texts('en'));
  assert.match(en.assumption.consequence, /no verified click paths/);
  const wix = resolveKiPrompt('unknown', { platform: { name: 'Wix' } }, texts('de'));
  assert.match(wix.assumption.consequence, /nutzen die Klickwege des erkannten Systems/);
});

test('the new text is part of the translation template', () => {
  assert.equal(typeof translationTemplate().aiUnknown.consequenceNoGeneric, 'string');
});
