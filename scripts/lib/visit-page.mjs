// Visit one page in the shared, never-consented browser context and record evidence.

import { createRequire } from 'node:module';
import { collectPageFacts } from './collect-page.mjs';
import { takeScreenshots } from './evidence-shots.mjs';
import { closeQuietly, withTimeout } from './timeout.mjs';

const require = createRequire(import.meta.url);
const AXE_SOURCE = require('axe-core').source;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const MAX_AXE_TARGETS = 3;

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} url
 * @param {{index: number, evidenceDir: string, timeoutMs: number, settleMs: number, light?: boolean}} options
 */
export async function visitPage(context, url, { index, evidenceDir, timeoutMs, settleMs, light = false }) {
  const label = `seite-${String(index).padStart(2, '0')}`;
  let page;
  try {
    page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    await page.waitForTimeout(settleMs);
    const facts = await withTimeout(page.evaluate(collectPageFacts), timeoutMs);
    const storage = await withTimeout(readStorage(page), timeoutMs);
    // light = quick re-check of an earlier scan: no screenshots, no accessibility test.
    const shots = light ? { screenshots: {}, bannerOverlap: null, overlay: null } : await takeScreenshots(page, facts, label, evidenceDir);
    const accessibility = markIfOverlayHidden(light ? null : await runAxe(page, timeoutMs), shots.overlay);
    return {
      index, url, finalUrl: page.url(), status: response?.status() ?? null,
      headers: pickHeaders(response?.headers() ?? {}),
      facts, storage, screenshots: shots.screenshots, bannerOverlap: shots.bannerOverlap, overlay: shots.overlay, accessibility,
    };
  } catch (error) {
    const message = error.message.split('\n')[0];
    if (/Download is starting/i.test(message)) return { index, url, skipped: 'download' };
    return { index, url, error: message };
  } finally {
    if (page) await closeQuietly(page, { runBeforeUnload: false });
  }
}

/** The accessibility result is possibly affected when the consent dialog could not be made visible again before the test. */
function markIfOverlayHidden(accessibility, overlay) {
  if (!accessibility || !overlay || overlay.restoredVisible === true) return accessibility;
  return { ...accessibility, possiblyAffected: 'The consent dialog was hidden for the page photos and may still have been hidden during this accessibility test.' };
}

function pickHeaders(headers) {
  const keep = ['strict-transport-security', 'content-security-policy', 'content-type'];
  return Object.fromEntries(keep.filter((k) => headers[k]).map((k) => [k, headers[k]]));
}

async function readStorage(page) {
  return page.evaluate(() => {
    const keys = (store) => {
      try {
        return Object.keys(store);
      } catch {
        return [];
      }
    };
    return { localStorage: keys(window.localStorage), sessionStorage: keys(window.sessionStorage) };
  });
}

async function runAxe(page, timeoutMs) {
  try {
    await withTimeout(page.addScriptTag({ content: AXE_SOURCE }), timeoutMs);
    const result = await withTimeout(page.evaluate(async (tags) => {
      const res = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
      return res.violations;
    }, AXE_TAGS), timeoutMs);
    return {
      violations: result.map((v) => ({
        id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, tags: v.tags.filter((t) => t.startsWith('wcag')),
        count: v.nodes.length, targets: v.nodes.slice(0, MAX_AXE_TARGETS).map((n) => n.target.join(' ')),
      })),
    };
  } catch (error) {
    return { error: error.message.split('\n')[0] };
  }
}
