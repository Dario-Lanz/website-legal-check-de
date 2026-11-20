// Decide whether a fetched page counts as a reachable source: HTTP 2xx and not an error,
// block or challenge page.

const CHALLENGE = /just a moment|attention required|cf-browser-verification|awswafintegration|aws[- ]?waf|captcha|enable javascript and cookies|request rejected|checking your browser/i;
const ERROR_TITLE = /^(error\b|\d{3}\b)|\b(not found|nicht gefunden|forbidden|access denied|zugriff verweigert|page unavailable)\b/i;
const FALLBACK_STATUSES = new Set([202, 401, 403, 429, 503]);

/** Text of the <title> element, whitespace collapsed; empty if there is none. */
export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html ?? '');
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function decodeEntities(text) {
  return text
    .replace(/&#(\d{1,6});/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&(amp|lt|gt|quot|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' }[e]));
}

/** True when title or the start of the body looks like a bot-protection or challenge page. */
export function looksLikeChallenge(title, html) {
  return CHALLENGE.test(title ?? '') || CHALLENGE.test((html ?? '').slice(0, 6000));
}

/**
 * @param {{status: number, title: string, snippet: string, isHtml: boolean}} page
 * @returns {{reachable: boolean, reason: string}}
 */
export function judge({ status, title, snippet, isHtml }) {
  if (status < 200 || status >= 300) return { reachable: false, reason: `HTTP ${status}` };
  if (!isHtml) return { reachable: true, reason: 'non-HTML document' };
  if (looksLikeChallenge(title, snippet)) return { reachable: false, reason: 'challenge or block page' };
  if (ERROR_TITLE.test(title)) return { reachable: false, reason: 'error page' };
  return { reachable: true, reason: '' };
}

/** A plain-fetch result for which a real browser may do better (blocked, challenged). */
export function needsBrowser(result) {
  return FALLBACK_STATUSES.has(result.status) || (result.status >= 200 && result.status < 300 && looksLikeChallenge(result.title, result.snippet));
}
