// Review of v1.19.0 (items 2, 4 to 7, 12, 13): covered legal links as a hint, backdrop counted, order of the photos,
// content layers never hidden, failures recorded, digest, TDD-08.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright';
import { serveFixture } from './helpers.mjs';
import { visitPage } from '../scripts/lib/visit-page.mjs';
import { checkLegalPages } from '../scripts/lib/checks/legal-pages.mjs';
import { headerLines } from '../scripts/lib/evidence/digest-header.mjs';
import { candidateScreenshots } from '../scripts/lib/evidence/findings-view.mjs';

let site;
let browser;
let context;
let dir;
before(async () => {
  site = await serveFixture('banner-cover');
  browser = await chromium.launch({ args: site.launchArgs });
  context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'de-DE' });
  dir = await mkdtemp(path.join(tmpdir(), 'wlc-review4-'));
});
after(async () => {
  await browser.close();
  await site.close();
  await rm(dir, { recursive: true, force: true });
});

const visit = async (file, index) => {
  const page = await visitPage(context, `${site.base}/${file}`, { index, evidenceDir: dir, timeoutMs: 20_000, settleMs: 200 });
  return { ...page, pageType: 'other' };
};

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
const scanOf = (pages) => ({ startUrl: pages[0].url, pages, requests: [], cookies: [], transport: {} });

describe('item 2: a visible link covered by the dialog is a hint of its own', () => {
  test('IMP-01 and DSE-01 give a covered hint with the dialog photo, and no ok', async () => {
    const page = await visit('index.html', 1);
    for (const check of ['IMP-01', 'DSE-01']) {
      const results = checkLegalPages(scanOf([page])).filter((f) => f.check === check);
      assert.deepEqual(results.map((f) => f.status), ['hint'], check);
      assert.match(results[0].title, /covered by the consent dialog on 1 of 1 pages/);
      assert.deepEqual(results[0].pages, [page.finalUrl]);
      assert.deepEqual(results[0].evidence.screenshots, [page.screenshots.cookieabfrage]);
      assert.equal(results[0].evidence.bannerOverlap[0].covered, 1, 'only the links of this kind');
    }
  });

  test('a banner at the top covers nothing: IMP-01 is ok', async () => {
    const page = await visit('clear.html', 2);
    assert.deepEqual(checkLegalPages(scanOf([page])).filter((f) => f.check === 'IMP-01').map((f) => f.status), ['ok']);
  });
});

describe('item 4: the backdrop of a modal counts as covering', () => {
  test('a small centred dialog with a full-screen backdrop covers the footer links', async () => {
    const page = await visit('modal.html', 3);
    assert.equal(page.bannerOverlap.covered, 2);
    assert.equal(page.bannerOverlap.notInView, 0);
    assert.equal(isBlue(await pixel(page.screenshots.ansicht, 700, 700)), true, 'backdrop hidden in the page photo');
  });
});

describe('item 5: -cookieabfrage is taken before anything scrolls', () => {
  test('a dialog that changes colour on scroll is still in its original colour in the dialog photo', async () => {
    const page = await visit('scrolled.html', 4);
    assert.equal(isRed(await pixel(page.screenshots.cookieabfrage, 100, 50)), true);
  });
});

describe('item 6: real content layers are never hidden', () => {
  test('a full-screen layer with a canvas or a background image stays in the page photo', async () => {
    const page = await visit('layers.html', 5);
    const [r, g, b] = await pixel(page.screenshots.ansicht, 683, 300);
    assert.equal(isBlue([r, g, b]), false, 'layers still visible (not plain page blue)');
    assert.equal(isRed([r, g, b]), false, 'dialog itself hidden');
    assert.equal(page.overlay.hiddenElements, 1, 'only the banner element');
    assert.equal(page.overlay.restoredVisible, true);
  });
});

describe('item 7 and 13: failures are recorded, the dialog is visible again before the accessibility test', () => {
  test('normal page: restored and visible again, recorded in the scan data', async () => {
    const page = await visit('index.html', 6);
    assert.deepEqual([page.overlay.hiddenElements, page.overlay.restoredVisible], [2, true]);
    assert.equal(page.accessibility.possiblyAffected, undefined);
  });

  test('measuring fails: error recorded in bannerOverlap and shown in the finding evidence', async () => {
    const page = await visit('measure-fails.html', 7);
    assert.match(page.bannerOverlap.error, /overlap not measurable: .*boom/);
    const [gap] = checkLegalPages(scanOf([{ ...page, facts: { ...page.facts, links: [] } }])).filter((f) => f.check === 'IMP-01');
    assert.equal(gap.status, 'gap');
    assert.match(gap.evidence.bannerOverlap[0].error, /not measurable/);
  });

  test('restoring fails: recorded, and the accessibility result is marked as possibly affected', async () => {
    const page = await visit('restore-fails.html', 8);
    assert.equal(page.overlay.restoredVisible, false);
    assert.match(page.overlay.restoreFailed, /still hidden/);
    assert.match(page.accessibility.possiblyAffected, /may still have been hidden/);
  });
});

describe('digest and photo candidates', () => {
  test('the digest shows the overlap per page; reused pages without the field are unknown', () => {
    const base = { url: 'https://x.de/', status: 200, pageType: 'other' };
    const scan = { host: 'x.de', startUrl: 'https://x.de/', scannedAt: 't', durationSeconds: 1, notes: [], pages: [
      { ...base, index: 1, bannerOverlap: { footerLegalLinks: 3, covered: 2, notInView: 1, links: [] } },
      { ...base, index: 2, bannerOverlap: null },
      { ...base, index: 3 },
      { ...base, index: 4, bannerOverlap: { footerLegalLinks: 0, covered: 0, notInView: 0, links: [], error: 'overlap not measurable: boom' } },
    ] };
    const text = headerLines(scan, {}).join('\n');
    assert.match(text, /#1 .*banner overlap: 2 of 3 legal links covered, 1 not in view/);
    assert.match(text, /#2 .*banner overlap: no dialog/);
    assert.match(text, /#3 .*banner overlap: unknown \(page taken over from an earlier scan\)/);
    assert.match(text, /#4 .*banner overlap: not measurable \(overlap not measurable: boom\)/);
  });

  test('TDD-08 (script tags) gets no dialog photo; other TDD checks do', () => {
    const scan = { pages: [{ url: 'https://x.de/', finalUrl: 'https://x.de/', screenshots: { ansicht: 'belege/a.jpg', cookieabfrage: 'belege/c.jpg' } }] };
    const pick = (check) => candidateScreenshots({ check, pages: ['https://x.de/'], evidence: {} }, scan);
    assert.deepEqual(pick('TDD-08'), ['belege/a.jpg']);
    assert.deepEqual(pick('TDD-04'), ['belege/c.jpg']);
  });
});

describe('N4 and N5', () => {
  test('N4: a backdrop darkened by opacity (dark opaque background) is counted and hidden', async () => {
    const page = await visit('opacity.html', 9);
    assert.equal(page.bannerOverlap.covered, 2);
    assert.equal(page.overlay.hiddenElements, 2);
    assert.equal(isBlue(await pixel(page.screenshots.ansicht, 700, 700)), true);
  });

  test('N5: a dialog that removed itself needs no restore: no wait, no failure, no accessibility mark', async () => {
    const started = Date.now();
    const page = await visit('self-removing.html', 10);
    assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
    assert.equal(page.overlay.restoredVisible, true);
    assert.equal(page.overlay.restoreFailed, undefined);
    assert.equal(page.accessibility.possiblyAffected, undefined);
  });
});

describe('real run 21.11.: Borlabs-like dialog (outer fixed wrapper, inner box, cookie text block, buttons outside the block), smooth scrolling', () => {
  let page;
  before(async () => { page = await visit('borlabs.html', 11); });

  test('the dialog photo is the whole dialog including the buttons', async () => {
    assert.equal(isRed(await pixel(page.screenshots.cookieabfrage, 450, 560)), true, 'accept button inside the crop');
  });

  test('the page photos show the page: whole dialog and backdrop hidden, no white hole', async () => {
    const [r, g, b] = await pixel(page.screenshots.ansicht, 683, 300);
    assert.equal(isBlue([r, g, b]), true, `view photo centre ${[r, g, b]}`);
    assert.equal(isBlue(await pixel(page.screenshots.ansicht, 100, 100)), true, 'backdrop hidden');
    const footer = await pixel(page.screenshots.fusszeile, 100, 50);
    assert.ok(footer[1] > 120 && footer[0] < 60 && footer[2] < 60, `footer photo centre ${footer} is footer green, not the dialog`);
  });

  test('the overlap is measured with each link scrolled into view: covered, none left "not in view"', () => {
    assert.equal(page.bannerOverlap.footerLegalLinks, 2);
    assert.equal(page.bannerOverlap.notInView, 0);
    assert.equal(page.bannerOverlap.covered, 2);
    assert.equal(page.overlay.restoredVisible, true);
  });
});

const imageHeight = async (file) => {
  const data = (await readFile(path.join(dir, path.basename(file)))).toString('base64');
  const p = await browser.newPage();
  try {
    await p.setContent(`<img id="i" src="data:image/jpeg;base64,${data}">`);
    return await p.evaluate(async () => { const img = document.getElementById('i'); await img.decode(); return img.naturalHeight; });
  } finally {
    await p.close();
  }
};
const isYellow = ([r, g, b]) => r > 200 && g > 200 && b < 60;

describe('R1: only the dialog is taken, never a page wrapper or a header that holds the menu', () => {
  test('div-only page inside an absolute wrapper: the cookie bar alone is photographed and hidden', async () => {
    const page = await visit('div-page.html', 12);
    assert.ok(page.facts.banner, 'banner detected');
    assert.ok(await imageHeight(page.screenshots.cookieabfrage) < 300, 'dialog photo is the bar, not the page');
    assert.equal(isYellow(await pixel(page.screenshots.ansicht, 900, 15)), true, 'menu still visible');
    assert.equal(isBlue(await pixel(page.screenshots.ansicht, 700, 300)), true, 'page content still visible');
    assert.equal(isRed(await pixel(page.screenshots.ansicht, 100, 850)), false, 'bar hidden');
    assert.equal(page.overlay.hiddenElements, 1);
  });

  test('sticky header with cookie bar and menu: the menu stays', async () => {
    const page = await visit('sticky-header.html', 13);
    assert.ok(page.facts.banner);
    assert.equal(isYellow(await pixel(page.screenshots.ansicht, 900, 100)), true, 'menu visible in the page photo');
    assert.equal(isRed(await pixel(page.screenshots.ansicht, 900, 40)), false, 'cookie bar hidden');
  });

  test('an unnamed fixed wrapper around the dialog is taken because the text matches (buttons outside the text block)', async () => {
    const page = await visit('unnamed-dialog.html', 14);
    assert.equal(isRed(await pixel(page.screenshots.cookieabfrage, 450, 360)), true, 'buttons in the dialog photo');
    assert.equal(isBlue(await pixel(page.screenshots.ansicht, 100, 100)), true, 'backdrop hidden');
  });

  test('a wrapper that is 0 px high (children positioned) is detected, photographed and hidden', async () => {
    const page = await visit('borlabs-zero.html', 15);
    assert.ok(page.facts.banner, 'banner detected');
    assert.ok(page.screenshots.cookieabfrage, 'dialog photo exists although the wrapper has no height');
    assert.equal(isRed(await pixel(page.screenshots.cookieabfrage, 450, 460)), true, 'buttons in the photo');
    assert.equal(isBlue(await pixel(page.screenshots.ansicht, 100, 100)), true);
    assert.equal(isBlue(await pixel(page.screenshots.ansicht, 683, 300)), true);
    assert.equal(page.bannerOverlap.covered, 1, 'the backdrop covers the footer link');
  });
});

describe('R4: the measurement leaves inner scroll containers where it found them', () => {
  test('scrollTop of a scrolled container is restored', async () => {
    const { takeScreenshots } = await import('../scripts/lib/evidence-shots.mjs');
    const { collectPageFacts } = await import('../scripts/lib/collect-page.mjs');
    const p = await context.newPage();
    try {
      await p.goto(`${site.base}/inner-scroll.html`);
      const facts = await p.evaluate(collectPageFacts);
      await takeScreenshots(p, facts, 'seite-99', dir);
      assert.equal(await p.evaluate(() => document.getElementById('scroller').scrollTop), 0);
    } finally {
      await p.close();
    }
  });
});

describe('last review: a collapsed settings block is no banner', () => {
  test('a max-height: 0 block with cookie text and buttons in the footer is not detected; the 0 px Borlabs-like wrapper still is', async () => {
    const collapsed = await visit('hidden-settings.html', 16);
    assert.equal(collapsed.facts.banner, null);
    assert.equal(collapsed.bannerOverlap, null);
    const zero = await visit('borlabs-zero.html', 17);
    assert.ok(zero.facts.banner, 'positioned children of a 0 px wrapper still count');
  });
});
