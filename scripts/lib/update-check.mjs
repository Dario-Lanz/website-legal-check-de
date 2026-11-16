// Quarterly update check: pure helpers plus the orchestration with injected I/O.
// The real I/O (fetch, git, files) lives in update-check-io.mjs.

export const DUE_MONTHS = 3;
export const MAX_COMMITS = 10;
export const LAW_HOST = 'www.gesetze-im-internet.de';
export const MAX_LAW_BYTES = 300_000;
export const LAW_CONCURRENCY = 4;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const STAND_TABLE = /<table[^>]*class="standangaben"[\s\S]*?<\/table>/i;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', sect: '§' };

/** @param {Date} date local date as YYYY-MM-DD */
export function toIsoDate(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Parse YYYY-MM-DD strictly (real calendar date) or return null. */
export function parseIsoDate(text) {
  const m = ISO_DATE.exec(String(text ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return { y, mo, d };
}

/** The date `months` calendar months before the given date, day clamped to month length. */
export function subtractMonths(iso, months) {
  const { y, mo, d } = parseIsoDate(iso);
  const index = y * 12 + (mo - 1) - months;
  const ny = Math.floor(index / 12);
  const nm = index % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const p = (n) => String(n).padStart(2, '0');
  return `${ny}-${p(nm + 1)}-${p(Math.min(d, lastDay))}`;
}

/** Due when there is no usable lastCheck or it lies at least 3 calendar months before today. */
export function isDue(lastCheck, today) {
  if (!parseIsoDate(lastCheck)) return true;
  return lastCheck <= subtractMonths(today, DUE_MONTHS);
}

/** Numeric semver compare of major.minor.patch (pre-release suffix ignored). Returns -1, 0 or 1. */
export function compareSemver(a, b) {
  const parts = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
    if (!m) throw new Error(`invalid version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** owner/repo from package.json repository.url, only the https://github.com/<owner>/<repo> form. */
export function parseGithubRepo(url) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url ?? ''));
  return m ? { owner: m[1], repo: m[2] } : null;
}

function decodeEntities(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([A-Za-z]+));/gi, (all, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[name] ?? all;
  });
}

/** Normalised text of the "Stand:" table on a gesetze-im-internet.de page, or null. */
export function extractStand(html) {
  const table = STAND_TABLE.exec(html);
  if (!table) return null;
  const text = decodeEntities(table[0].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text || null;
}

/** Only https URLs on the official law site, without credentials or a port. */
export function assertAllowedLawUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`invalid URL: ${url}`); }
  if (u.protocol !== 'https:' || u.hostname !== LAW_HOST || u.username || u.password || u.port) {
    throw new Error(`URL not allowed (only https://${LAW_HOST}/): ${url}`);
  }
  return u;
}

/**
 * Read a byte stream until the Stand table is complete or maxBytes are read; cancels the stream.
 * @param {ReadableStream<Uint8Array>} body
 * @returns {Promise<string>} the normalised Stand text
 */
export async function readStandFromStream(body, maxBytes = MAX_LAW_BYTES) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      const stand = extractStand(text);
      if (stand) return stand;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`Stand line not found in the first ${Math.min(bytes, maxBytes)} bytes`);
}

/**
 * Compare today's Stand of each law with the stored one.
 * @param {{law:string,url:string,stand:string}[]} entries
 * @param {(url:string)=>Promise<string>} fetchStand returns the current Stand text
 */
export async function checkLaws(entries, fetchStand) {
  const lawChanges = [];
  const lawErrors = [];
  const checkOne = async ({ law, url, stand }) => {
    try {
      assertAllowedLawUrl(url);
      const current = await fetchStand(url);
      if (current !== stand) lawChanges.push({ law, url, expected: stand, current });
    } catch (error) {
      lawErrors.push({ law, error: error.cause?.code ? `${error.message} (${error.cause.code})` : error.message });
    }
  };
  for (let i = 0; i < entries.length; i += LAW_CONCURRENCY) {
    await Promise.all(entries.slice(i, i + LAW_CONCURRENCY).map(checkOne));
  }
  return { lawChanges, lawErrors };
}

/** Bold dates in the "Next key date" column that lie after the file's status date and up to today. */
export function parseUpcomingDue(markdown, today) {
  const status = /Upcoming status:\s*(\d{4}-\d{2}-\d{2})/.exec(markdown)?.[1];
  if (!status) return [];
  const rows = markdown.split('\n').filter((l) => l.trim().startsWith('|')).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const header = rows.find((r) => r.includes('Next key date'));
  if (!header) return [];
  const col = header.indexOf('Next key date');
  const due = [];
  for (const row of rows) {
    if (!/^UP-\d+$/.test(row[0])) continue;
    for (const m of (row[col] ?? '').matchAll(/\*\*(\d{2})\.(\d{2})\.(\d{4})\*\*/g)) {
      const date = `${m[3]}-${m[2]}-${m[1]}`;
      if (parseIsoDate(date) && date > status && date <= today) due.push({ id: row[0], date });
    }
  }
  return due;
}

/** Law quick check: stored Stand lines against the live pages, plus upcoming dates now reached. */
export async function runLaws(io, today) {
  const result = { lawChanges: [], lawErrors: [], upcomingDue: [] };
  try {
    const checked = await checkLaws(await io.readLawData(), io.fetchStand);
    result.lawChanges = checked.lawChanges;
    result.lawErrors = checked.lawErrors;
  } catch (error) {
    result.lawErrors.push({ law: '*', error: `law data unreadable: ${error.message}` });
  }
  try {
    result.upcomingDue = parseUpcomingDue(await io.readUpcoming(), today);
  } catch (error) {
    result.upcomingError = error.message;
  }
  return result;
}

/** Installed version against the latest on GitHub; failures go into versionError. */
export async function runVersion(io) {
  const info = { installedVersion: null, installMethod: io.installMethod };
  try {
    info.installedVersion = await io.readInstalledVersion();
    const latest = await io.readLatest();
    info.latestVersion = latest.version;
    info.updateAvailable = compareSemver(latest.version, info.installedVersion) > 0;
    info.whatsNew = (latest.commits ?? []).slice(0, MAX_COMMITS);
  } catch (error) {
    info.versionError = error.message;
  }
  return info;
}

/** @returns {Promise<object>} the JSON object for the given mode */
export async function run(mode, io, today) {
  if (mode === '--laws') return runLaws(io, today);
  if (mode === '--mark-checked') {
    await io.writeLastCheck(today);
    return { marked: today };
  }
  if (mode === '--status') {
    const lastCheck = await io.readLastCheck();
    if (!isDue(lastCheck, today)) return { due: false, lastCheck };
    return { due: true, lastCheck: lastCheck ?? null, ...(await runVersion(io)), ...(await runLaws(io, today)) };
  }
  throw new Error('usage: update-check.mjs --status | --laws | --mark-checked');
}
