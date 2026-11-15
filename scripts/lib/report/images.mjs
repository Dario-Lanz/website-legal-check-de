// Images for the long report: evidence screenshots are shrunk to a readable JPEG and
// cropped to the visible area; mock-up pages are rendered to images. Everything is
// embedded as data URI, so no HTML or image files are left next to the PDFs (15a, 19a).

import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const IMAGE_WIDTH = 1000;
const JPEG_QUALITY = 0.7;
const VIEWPORT_RATIO = 900 / 1366; // height/width of the scanner viewport
/** Evidence screenshots live here, below the data folder. */
const FIGURE_DIR = 'belege';
const MOCKUP_VIEWPORT = { width: 1200, height: 800 };

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

/**
 * Shrink one image in the browser: width IMAGE_WIDTH at most, height cropped to the
 * viewport ratio when crop is set (full-page screenshots show only the visible part).
 * @param {import('playwright').Page} page
 * @param {Buffer} bytes
 * @param {string} mime
 * @param {boolean} crop
 * @returns {Promise<string>} JPEG data URI
 */
async function shrink(page, bytes, mime, crop) {
  const source = `data:${mime};base64,${bytes.toString('base64')}`;
  return page.evaluate(async ({ source, width, ratio, quality, crop }) => {
    const img = new Image();
    img.src = source;
    await img.decode();
    const scale = Math.min(1, width / img.naturalWidth);
    const w = Math.round(img.naturalWidth * scale);
    const fullH = Math.round(img.naturalHeight * scale);
    const h = crop ? Math.min(fullH, Math.round(w * ratio)) : fullH;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, Math.round(img.naturalHeight * scale));
    return canvas.toDataURL('image/jpeg', quality);
  }, { source, width: IMAGE_WIDTH, ratio: VIEWPORT_RATIO, quality: JPEG_QUALITY, crop });
}

/**
 * Resolve a path from report.json inside baseDir (report.json is written from untrusted site content).
 * @param {string} baseDir
 * @param {string} relative
 * @param {string} [mustBeIn] sub folder of baseDir the file must be in
 * @param {string} [extension] required file extension, e.g. ".html"
 * @returns {Promise<string>} real path of the file
 */
export async function resolveInside(baseDir, relative, mustBeIn = '', extension = '') {
  const root = path.resolve(baseDir, mustBeIn);
  const file = path.resolve(baseDir, relative);
  const inside = (p, r) => p === r || p.startsWith(r + path.sep);
  if (!inside(file, path.resolve(baseDir))) throw new Error(`Path outside the data folder: ${relative}`);
  if (!inside(file, root)) throw new Error(`Path must be in ${mustBeIn}/: ${relative}`);
  if (extension && path.extname(file).toLowerCase() !== extension) throw new Error(`File must be an ${extension} file: ${relative}`);
  try {
    // Symbolic links must not lead out of the folder either.
    const real = await realpath(file);
    if (!inside(real, await realpath(root))) throw new Error(`Path outside ${mustBeIn || 'the data folder'}: ${relative}`);
    return real;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`File not found: ${relative}`);
    throw error;
  }
}

/**
 * Is the real path a file in <runs folder>/<run>/daten/belege/ of an earlier run beside this one
 * (reuse mode, decision 32a)? Same rule as resolveFigure; real paths, so links cannot lead out.
 * @param {string} real real path of a file
 * @param {string} realBase real path of this run's data folder
 */
async function isEarlierRunEvidence(real, realBase) {
  const runsFolder = await realpath(path.resolve(realBase, '..', '..'));
  const parts = path.relative(runsFolder, real).split(path.sep);
  return parts.length === 4 && parts[0] !== '..' && parts[1] === 'daten' && parts[2] === FIGURE_DIR;
}

/**
 * May a request of a mock-up page go through? Only data: URLs, files below baseDir and evidence
 * screenshots of an earlier run (<runs folder>/<run>/daten/belege/); everything else (network, files
 * elsewhere on this machine) is blocked, so a mock-up cannot embed local files.
 * @param {string} requestUrl
 * @param {string} realBase real path of the data folder
 * @returns {Promise<boolean>}
 */
export async function mockupRequestAllowed(requestUrl, realBase) {
  const { protocol } = new URL(requestUrl);
  if (protocol === 'data:') return true;
  if (protocol !== 'file:') return false;
  try {
    const real = await realpath(fileURLToPath(requestUrl));
    return real === realBase || real.startsWith(realBase + path.sep) || await isEarlierRunEvidence(real, realBase);
  } catch {
    return false;
  }
}

/**
 * Resolve a figure path: below baseDir/belege/, or (reuse mode, decision 32a) the belege/ folder of
 * another run beside this one: <runs folder>/<run>/daten/belege/<file>, checked with realpath.
 * @param {string} baseDir the data folder of this run
 * @param {string} src figure path from report.json
 * @returns {Promise<string>} real path of the image
 */
export async function resolveFigure(baseDir, src) {
  try {
    return await resolveInside(baseDir, src, FIGURE_DIR);
  } catch (error) {
    const runsFolder = path.resolve(baseDir, '..', '..');
    const parts = path.relative(runsFolder, path.resolve(baseDir, src)).split(path.sep);
    const isEarlierBelege = parts.length === 4 && parts[0] !== '..' && parts[1] === 'daten' && parts[2] === FIGURE_DIR;
    if (!isEarlierBelege) throw error;
    const belegeDir = path.join(runsFolder, parts[0], 'daten', FIGURE_DIR);
    const real = await resolveInside(runsFolder, path.relative(runsFolder, path.resolve(baseDir, src)), path.relative(runsFolder, belegeDir));
    // A symbolic link in the earlier run must not lead out of the runs folder.
    if (!real.startsWith(`${await realpath(runsFolder)}${path.sep}`)) throw error;
    return real;
  }
}

/**
 * @param {import('playwright').Browser} browser
 * @param {string} baseDir folder that figure and mock-up paths are relative to
 * @param {{figures: {src: string}[], mockup?: {file: string}}[]} findings
 * @returns {Promise<{figures: Map<string, string>, mockups: Map<string, string>}>} path -> data URI
 */
export async function prepareImages(browser, baseDir, findings) {
  const page = await browser.newPage();
  const figures = new Map();
  const mockups = new Map();
  try {
    for (const src of new Set(findings.flatMap((f) => f.figures.map((fig) => fig.src)))) {
      const file = await resolveFigure(baseDir, src);
      const mime = MIME[path.extname(file).toLowerCase()];
      if (!mime) throw new Error(`Unsupported image type: ${src}`);
      figures.set(src, await shrink(page, await readFile(file), mime, true));
    }
    for (const f of findings.filter((x) => x.mockup?.file)) {
      const file = await resolveInside(baseDir, f.mockup.file, '', '.html').catch((error) => {
        throw new Error(error.message.startsWith('File not found') ? `Mock-up file not found: ${f.mockup.file}` : error.message);
      });
      // The mock-up templates need no JavaScript and no network: render with both switched off.
      const context = await browser.newContext({ viewport: MOCKUP_VIEWPORT, javaScriptEnabled: false });
      try {
        const realBase = await realpath(baseDir);
        await context.route(() => true, async (route) => {
          if (await mockupRequestAllowed(route.request().url(), realBase)) await route.continue();
          else await route.abort();
        });
        const view = await context.newPage();
        await view.goto(pathToFileURL(file).toString(), { waitUntil: 'load' });
        mockups.set(f.mockup.file, await shrink(page, await view.screenshot({ fullPage: true }), 'image/png', false));
      } finally {
        await context.close();
      }
    }
  } finally {
    await page.close();
  }
  return { figures, mockups };
}
