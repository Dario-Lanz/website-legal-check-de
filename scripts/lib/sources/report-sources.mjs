// Sources inside report.json: collect their URLs, match them against references/sources.md
// and set the retrieval date.

/** All source objects of a report (findings and upcoming rules). */
function allSources(report) {
  return [...(report.findings ?? []), ...(report.upcoming ?? [])].flatMap((item) => item.sources ?? []);
}

/** Distinct source URLs of a report, in order of first use. */
export function collectUrls(report) {
  return [...new Set(allSources(report).map((s) => s.url).filter((u) => typeof u === 'string'))];
}

/** URLs listed in the tables of references/sources.md. */
export function listedUrls(sourcesMd) {
  return new Set([...sourcesMd.matchAll(/\|\s*(https?:\/\/[^\s|]+)\s*\|/g)].map((m) => m[1]));
}

/** Drop trailing punctuation and a closing bracket that has no opening partner inside the URL. */
function trimUrl(url) {
  let u = url.replace(/[.,;:!?'"]+$/, '');
  while (u.endsWith(')') && (u.match(/\(/g) ?? []).length < (u.match(/\)/g) ?? []).length) u = u.slice(0, -1).replace(/[.,;:!?'"]+$/, '');
  return u;
}

/** Every https URL written anywhere in a reference text (e.g. references/upcoming.md). */
export function referenceUrls(text) {
  return new Set([...text.matchAll(/https:\/\/[^\s|<>"'`\]]+/g)].map((m) => trimUrl(m[0])));
}

/**
 * Set `retrieved` to `date` on every source whose URL is in `reachable` and clear it on every
 * source whose URL is in `unreachable`, so a stale date never survives a failed check.
 * @returns {number} how many sources were changed
 */
export function setRetrieved(report, reachable, unreachable, date) {
  let count = 0;
  for (const source of allSources(report)) {
    if (reachable.has(source.url)) source.retrieved = date;
    else if (unreachable.has(source.url)) source.retrieved = '';
    else continue;
    count += 1;
  }
  return count;
}
