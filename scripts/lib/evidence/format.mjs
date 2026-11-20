// Small text helpers shared by the evidence digest and its sub-modes.

/** Path and query of a URL for compact listings; the input itself if it does not parse. */
export function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return String(url);
  }
}

/** Host of a URL, or the input if it does not parse. */
export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url);
  }
}

/** Cut text to `max` characters and say so, so a reader knows something is missing. */
export function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)} […truncated, ${s.length - max} more characters]`;
}

/** Collapse whitespace so multi-line page text stays on one line. */
export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** "a, b, c" for up to `max` items, then "(+n more)". */
export function listLimited(items, max) {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}

/** "#1, #4 (first: <url>)" for a list of page indexes; urlOf maps index to URL. */
export function listedPages(indexes, urlOf) {
  const sorted = [...indexes].sort((a, b) => a - b);
  return `${listLimited(sorted.map((i) => `#${i}`), 12)} (first: ${urlOf.get(sorted[0]) ?? '?'})`;
}
