// Read the site's sitemap(s) to see which page types exist beyond the crawled sample.

import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { redirectAllowed } from './public-host.mjs';
import { baseDomain, isSameSite } from './url.mjs';

const gunzipAsync = promisify(gunzip);

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 5_000_000;
const MAX_URLS = 5_000;
const MAX_CHILD_SITEMAPS = 10;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'website-legal-check-de (technical website check)';

const GZIP_TYPE = /^application\/(x-)?gzip\b/i;

/** gzip sitemaps: the file name ends in .xml.gz or the server says gzip (a Content-Encoding is already undone by fetch). */
function isGzipSitemap(url, response) {
  return /\.xml\.gz$/i.test(new URL(url).pathname) || GZIP_TYPE.test(response.headers.get('content-type') ?? '');
}

/** Decompress with a hard limit on the DECOMPRESSED size (zip bombs); null when invalid or over the limit. */
async function gunzipCapped(compressed) {
  try {
    return await gunzipAsync(compressed, { maxOutputLength: MAX_BYTES });
  } catch {
    return null;
  }
}

/**
 * GET with manual redirects: every hop must stay on the registrable domain of the first URL and be public
 * (a sitemap must not lead the checker into the local network).
 * @returns {Promise<Response|null>}
 */
async function fetchFollowing(url, allowInternal) {
  const origin = new URL(url);
  let current = origin;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'user-agent': USER_AGENT }, redirect: 'manual',
    });
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) return null;
    current = new URL(location, current);
    if (!redirectAllowed(current, origin, { allowInternal, sameDomain: true })) return null;
  }
  return null;
}

/**
 * Fetch a text resource with timeout and size limit (the same limit applies to the decompressed size of a gzip file).
 * @param {string} url
 * @param {{allowInternal?: boolean}} [options] allowInternal: tests only; by default redirects to non-public hosts are refused
 * @returns {Promise<string|null>} body or null when unavailable
 */
export async function fetchText(url, { allowInternal = false } = {}) {
  try {
    const response = await fetchFollowing(url, allowInternal);
    if (!response?.ok) return null;
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) return null;
    const bytes = await readCapped(response);
    return decodeSitemap(url, response, bytes);
  } catch {
    return null;
  }
}

/** Plain text, or the unpacked gzip file; a body that only claims gzip but is already text (fetch undid x-gzip) is used as it is. */
async function decodeSitemap(url, response, bytes) {
  if (!isGzipSitemap(url, response)) return bytes.toString('utf8');
  const unpacked = await gunzipCapped(bytes);
  if (unpacked) return unpacked.toString('utf8');
  const text = bytes.toString('utf8');
  return text.trimStart().startsWith('<') ? text : null;
}

/** Read the body (raw bytes) chunk by chunk and stop at MAX_BYTES, so an endless or huge answer cannot fill memory. */
async function readCapped(response) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= MAX_BYTES) break; // leaving the loop cancels the rest of the download
  }
  return Buffer.concat(chunks).subarray(0, MAX_BYTES);
}

/**
 * Extract <loc> entries from sitemap XML.
 * @param {string} xml
 * @returns {{isIndex: boolean, locs: string[]}}
 */
export function parseSitemap(xml) {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)]
    .map((match) => match[1].replace(/&amp;/g, '&'));
  return { isIndex, locs };
}

/**
 * Sitemap URLs named in robots.txt.
 * @param {string} robots
 * @returns {string[]}
 */
export function sitemapsFromRobots(robots) {
  return [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((match) => match[1]);
}

/**
 * Collect page URLs from robots.txt sitemaps or /sitemap.xml (one index level deep).
 * @param {URL} start
 * @param {{allowInternal?: boolean}} [options] passed to fetchText
 * @returns {Promise<{source: string[], urls: string[]}>}
 */
export async function discoverSitemapUrls(start, options = {}) {
  const robots = await fetchText(new URL('/robots.txt', start).toString(), options);
  const roots = robots ? sitemapsFromRobots(robots).map((u) => resolveUrl(u, start)).filter((u) => u && sameDomainSitemap(u, start)) : [];
  if (roots.length === 0) roots.push(new URL('/sitemap.xml', start).toString());

  const urls = new Set();
  const source = [];
  for (const root of roots.slice(0, MAX_CHILD_SITEMAPS)) {
    await collectFromSitemap(root, start, urls, source, 0, options);
    if (urls.size >= MAX_URLS) break;
  }
  return { source, urls: [...urls].slice(0, MAX_URLS) };
}

/** A robots.txt may name any URL; only http(s) sitemaps of the checked site's own domain are fetched, and redirects of a sitemap must stay on that domain and on public hosts. */
function sameDomainSitemap(candidate, start) {
  const url = new URL(candidate);
  return /^https?:$/.test(url.protocol) && baseDomain(url.hostname) === baseDomain(start.hostname);
}

function resolveUrl(candidate, base) {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return null;
  }
}

async function collectFromSitemap(sitemapUrl, start, urls, source, depth, options) {
  if (!isSameSite(sitemapUrl, start) && depth > 0) return;
  const xml = await fetchText(sitemapUrl, options);
  if (!xml) return;
  source.push(sitemapUrl);
  const { isIndex, locs } = parseSitemap(xml);
  if (isIndex && depth === 0) {
    for (const child of locs.slice(0, MAX_CHILD_SITEMAPS)) {
      await collectFromSitemap(child, start, urls, source, depth + 1, options);
      if (urls.size >= MAX_URLS) return;
    }
    return;
  }
  for (const loc of locs) {
    if (urls.size >= MAX_URLS) return;
    if (isSameSite(loc, start)) urls.add(loc);
  }
}
