// Evidence photos of one page. The consent dialog photo (-cookieabfrage) is taken first, before anything is scrolled
// or measured, and shows the dialog as the visitor sees it. Then it is measured whether the dialog (or its backdrop)
// covers the legal links of the footer (checklist IMP-01, DSE-01). The page photos (-ansicht, -fusszeile) are taken with
// the detected dialog and its backdrop hidden by CSS visibility, so prices and footer links are readable; the dialog is
// restored afterwards, before the accessibility test. Nothing is clicked, so requests and cookies stay as they were.
// Every failure of measuring, hiding or restoring is recorded in the result.

import path from 'node:path';
import { PATTERNS } from './checks/helpers.mjs';
import { LEGAL_TYPES } from './page-types.mjs';
import { overlayTool, restoreOverlay } from './overlay-tool.mjs';
import { withTimeout } from './timeout.mjs';

/** JPEG quality for evidence screenshots: readable, much smaller than PNG. */
const SCREENSHOT_QUALITY = 80;
const BANNER = '[data-wlc-banner="1"]';
const LEGAL_LINK_KINDS = LEGAL_TYPES.filter((kind) => PATTERNS[kind]);
const LEGAL_LINK_SOURCES = LEGAL_LINK_KINDS.map((kind) => PATTERNS[kind].source);
const EVALUATE_TIMEOUT_MS = 10_000;

const errorText = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 200);

/** Run one overlay operation on the banner with a time limit. */
const runOverlay = (banner, args) => withTimeout(banner.evaluate(overlayTool, args), EVALUATE_TIMEOUT_MS);

/** The dialog photo: the element itself, or, for a wrapper without own height, the box around its visible parts. */
async function saveDialog(page, banner, save) {
  const own = await banner.boundingBox().catch(() => null);
  if (own && own.width > 0 && own.height > 0) return save('cookieabfrage', banner);
  const clip = await runOverlay(banner, { op: 'box' }).catch(() => null);
  return clip ? save('cookieabfrage', page, { clip }) : undefined;
}

async function measure(banner, hasFooter) {
  if (!hasFooter) return { footerLegalLinks: 0, covered: 0, notInView: 0, links: [] };
  try {
    return await runOverlay(banner, { op: 'measure', sources: LEGAL_LINK_SOURCES, kinds: LEGAL_LINK_KINDS });
  } catch (error) {
    return { footerLegalLinks: 0, covered: 0, notInView: 0, links: [], error: `overlap not measurable: ${errorText(error)}` };
  }
}

async function hide(banner, overlay) {
  try {
    overlay.hiddenElements = await runOverlay(banner, { op: 'hide' });
  } catch (error) {
    overlay.error = `dialog could not be hidden for the page photos: ${errorText(error)}`;
  }
}

async function restore(page, overlay) {
  try {
    const result = await withTimeout(page.evaluate(restoreOverlay), EVALUATE_TIMEOUT_MS);
    overlay.restoredVisible = result.restoredVisible;
    if (!result.restoredVisible) overlay.restoreFailed = 'dialog still hidden after restoring';
  } catch (error) {
    overlay.restoredVisible = false;
    overlay.restoreFailed = errorText(error);
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {{banner: object|null, hasFooterElement: boolean}} facts
 * @param {string} label file name prefix, e.g. "seite-01"
 * @param {string} evidenceDir
 * @returns {Promise<{screenshots: Record<string, string>, bannerOverlap: object|null, overlay: object|null}>}
 *   bannerOverlap: per footer legal link whether the banner covered it (null: no banner on the page; `error` when not measurable);
 *   overlay: {hiddenElements, restoredVisible, error?, restoreFailed?} (null: no banner)
 */
export async function takeScreenshots(page, facts, label, evidenceDir) {
  const screenshots = {};
  const save = async (name, target, extra = {}) => {
    const file = `${label}-${name}.jpg`;
    try {
      await target.screenshot({ path: path.join(evidenceDir, file), type: 'jpeg', quality: SCREENSHOT_QUALITY, timeout: 10_000, ...extra });
      screenshots[name] = `belege/${file}`;
    } catch {
      // element not capturable (e.g. zero size); evidence is then the page screenshot
    }
  };
  const banner = facts.banner ? page.locator(BANNER).first() : null;
  const overlay = banner ? { hiddenElements: 0, restoredVisible: null } : null;
  let bannerOverlap = null;
  if (banner) {
    await saveDialog(page, banner, save);
    bannerOverlap = await measure(banner, facts.hasFooterElement);
    await hide(banner, overlay);
  }
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await save('ansicht', page);
    if (facts.hasFooterElement) await save('fusszeile', page.locator('footer, [role="contentinfo"]').last());
  } finally {
    if (banner) await restore(page, overlay);
  }
  return { screenshots, bannerOverlap, overlay };
}
