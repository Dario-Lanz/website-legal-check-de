// Fix 7: evidence photos `-ansicht` and `-fusszeile` are taken with the detected consent overlay hidden
// (CSS only, no click); `-cookieabfrage` still shows the dialog; scan.json records whether the banner covered the footer legal links.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright';
import { serveFixture } from './helpers.mjs';
import { visitPage } from '../scripts/lib/visit-page.mjs';

let site;
let browser;
let context;
let dir;
before(async () => {
  site = await serveFixture('banner-cover');
  browser = await chromium.launch({ args: site.launchArgs });
  context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'de-DE' });
  dir = await mkdtemp(path.join(tmpdir(), 'wlc-cover-'));
});
after(async () => {
  await browser.close();
  await site.close();
  await rm(dir, { recursive: true, force: true });
});

const visit = (file, index) => visitPage(context, `${site.base}/${file}`, { index, evidenceDir: dir, timeoutMs: 20_000, settleMs: 200 });

/** Colour of one pixel of a saved JPEG, decoded by the browser itself. */
async function pixel(file, x, y) {
  const data = (await readFile(path.join(dir, path.basename(file)))).toString('base64');
  const page = await browser.newPage();
  try {
    await page.setContent(`<img id="i" src="data:image/jpeg;base64,${data}">`);
    return await page.evaluate(async ([px, py]) => {
      const img = document.getElementById('i');
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(Math.min(px, canvas.width - 1), Math.min(py, canvas.height - 1), 1, 1).data.slice(0, 3)];
    }, [x, y]);
  } finally {
    await page.close();
  }
}
const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
const isBlue = ([r, g, b]) => b > 200 && r < 60 && g < 60;

describe('bottom banner with backdrop over the footer links', () => {
  let result;
  before(async () => { result = await visit('index.html', 1); });

  test('-cookieabfrage still shows the dialog', async () => {
    assert.equal(isRed(await pixel(result.screenshots.cookieabfrage, 100, 100)), true);
  });

  test('-ansicht shows the page, without dialog and backdrop', async () => {
    assert.equal(isRed(await pixel(result.screenshots.ansicht, 683, 800)), false, 'dialog hidden');
    assert.equal(isBlue(await pixel(result.screenshots.ansicht, 700, 300)), true, 'backdrop hidden, page colour visible');
  });

  test('-fusszeile shows the footer, not the dialog', async () => {
    const [r, g] = await pixel(result.screenshots.fusszeile, 600, 20);
    assert.equal(isRed([r, g, 0]), false);
    assert.ok(g > 120 && r < 60, 'footer background (green) visible');
  });

  test('scan.json records that the banner covers the footer legal links', () => {
    const o = result.bannerOverlap;
    assert.equal(o.footerLegalLinks, 2);
    assert.equal(o.covered, 2);
    assert.deepEqual(o.links.map((l) => [l.text, l.covered]), [['Impressum', true], ['Datenschutz', true]]);
  });

  test('the page is visible again after the photos: banner and backdrop are not left hidden, no click happened', async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${site.base}/index.html`);
      assert.equal(await page.locator('#cookie-banner').isVisible(), true);
    } finally {
      await page.close();
    }
    assert.equal(result.facts.banner !== null, true);
    assert.equal(result.accessibility.error, undefined);
  });
});

test('a banner that does not reach the footer links is recorded as not covering them', async () => {
  const result = await visit('clear.html', 2);
  assert.deepEqual(result.bannerOverlap.links.map((l) => l.covered), [false, false]);
  assert.equal(result.bannerOverlap.covered, 0);
  assert.equal(isRed(await pixel(result.screenshots.ansicht, 683, 40)), false, 'hidden in the view photo');
  assert.equal(isRed(await pixel(result.screenshots.cookieabfrage, 100, 50)), true);
});

test('a page without a banner has no overlap record and its photos are unchanged in kind', async () => {
  const result = await visit('nobanner.html', 3);
  assert.equal(result.bannerOverlap, null);
  assert.ok(result.screenshots.ansicht && result.screenshots.fusszeile && !result.screenshots.cookieabfrage);
});
