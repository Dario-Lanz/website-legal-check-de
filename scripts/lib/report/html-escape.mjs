// HTML escaping and links for the reports (shared by the model and the location links).

const SAFE_URL = /^https?:\/\//i;

/** Escape text for HTML element content and attribute values, without typography (URLs, copyable text such as the AI prompt). */
export function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Escape text for HTML element content and attribute values, with German typography. */
export function esc(value) {
  return typography(escHtml(value));
}

/**
 * German typography per DIN 5008 (as summarised in references/formatting.md): protected
 * space after § and before %, narrow protected space inside abbreviations like „z. B.“.
 */
export function typography(text) {
  return text
    .replace(/(§§?) (?=\S)/g, '$1\u00A0')
    .replace(/(\d) %/g, '$1\u00A0%')
    .replace(/\b([A-Za-zÄÖÜäöü])\. ([A-Za-zÄÖÜäöü])\./g, '$1.\u202F$2.');
}

/** Separators between words; every other run of characters is one word. */
const WORD_SPLIT = /([\s,;()„“"]+)/u;
/** A technical word has ".", "/", "_" or ":" between word characters (hosts, files, paths, cookie names, 1.900). */
const TECHNICAL = /[\p{L}\p{N}][._/:][\p{L}\p{N}_]/u;

/**
 * Escape text for a table cell (decision 110a): like esc(), but technical words are wrapped in
 * <span class="tech"> so the report CSS never hyphenates them (`.tech { hyphens: manual }`).
 * Splitting first keeps the cost linear in the text length.
 */
export function escCell(value) {
  const parts = String(value ?? '').split(WORD_SPLIT);
  const out = parts.map((part, i) => (i % 2 === 0 && TECHNICAL.test(part) ? `<span class="tech">${escHtml(part)}</span>` : escHtml(part)));
  return typography(out.join(''));
}

/** Link only for http(s) URLs; anything else is shown as plain text. */
export function link(url, text) {
  return SAFE_URL.test(String(url ?? '')) ? `<a href="${escHtml(url)}">${esc(text ?? url)}</a>` : esc(text ?? url ?? '');
}
