// Tests for the quarterly update check. No internet: fetch and git are injected or never reached.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  assertAllowedLawUrl, checkLaws, compareSemver, extractStand, isDue, parseGithubRepo,
  parseUpcomingDue, readStandFromStream, run,
} from '../scripts/lib/update-check.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'update-check.mjs');

const PAGE_HEAD = '<html><body><div class="jnheader"><h1>Gesetz</h1></div><div class="jnhtml">'
  + '<table class="standangaben" width="100%"><tr><td class="StandangabeStand">Stand:</td>'
  + '<td>Zuletzt ge&#228;ndert durch  Art. 3 G v. 10.3.2026 I Nr. 64</td></tr></table><br />';

function streamOf(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
}

test('due: no file, corrupt value, 2 months, exactly 3 months', () => {
  assert.equal(isDue(null, '2026-11-16'), true);
  assert.equal(isDue('not a date', '2026-11-16'), true);
  assert.equal(isDue('2026-09-16', '2026-11-16'), false);
  assert.equal(isDue('2026-08-17', '2026-11-16'), false);
  assert.equal(isDue('2026-08-16', '2026-11-16'), true);
  assert.equal(isDue('2026-02-28', '2026-05-31'), true, 'day clamped to month end');
  assert.equal(isDue('2025-11-16', '2026-02-16'), true, 'across the year boundary');
});

test('semver compare is numeric, not textual', () => {
  assert.equal(compareSemver('1.10.0', '1.9.9'), 1);
  assert.equal(compareSemver('1.16.1', '1.16.1'), 0);
  assert.equal(compareSemver('1.2.3', '1.2.4'), -1);
  assert.throws(() => compareSemver('abc', '1.0.0'));
});

test('repository URL: only the https://github.com/<owner>/<repo> form', () => {
  assert.deepEqual(parseGithubRepo('https://github.com/Dario-Lanz/website-legal-check-de'), { owner: 'Dario-Lanz', repo: 'website-legal-check-de' });
  assert.deepEqual(parseGithubRepo('https://github.com/a/b.git'), { owner: 'a', repo: 'b' });
  assert.equal(parseGithubRepo('https://evil.example/a/b'), null);
  assert.equal(parseGithubRepo('git@github.com:a/b.git'), null);
  assert.equal(parseGithubRepo('https://github.com/a/b/../../x'), null);
});

test('Stand is extracted, entities decoded and whitespace collapsed', () => {
  assert.equal(extractStand(PAGE_HEAD), 'Stand: Zuletzt geändert durch Art. 3 G v. 10.3.2026 I Nr. 64');
  assert.equal(extractStand('<html>no stand here</html>'), null);
});

test('stream stops as soon as the Stand table is complete', async () => {
  let pulled = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(encoder.encode(pulled === 1 ? PAGE_HEAD : 'x'.repeat(1000)));
    },
  });
  assert.match(await readStandFromStream(body), /^Stand: Zuletzt/);
  assert.ok(pulled <= 2, `read too much: ${pulled} chunks`);
});

test('stream is cut off at the size cap when no Stand line shows up', async () => {
  let pulled = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(encoder.encode('y'.repeat(1000)));
    },
  });
  await assert.rejects(readStandFromStream(body, 5000), /Stand line not found/);
  assert.ok(pulled <= 6, `endless stream not cut off: ${pulled} chunks`);
});

test('Stand split over chunk boundaries is still found', async () => {
  const half = Math.floor(PAGE_HEAD.length / 2);
  assert.match(await readStandFromStream(streamOf([PAGE_HEAD.slice(0, half), PAGE_HEAD.slice(half)])), /10\.3\.2026/);
});

test('non-allowed hosts and schemes are rejected', async () => {
  assert.doesNotThrow(() => assertAllowedLawUrl('https://www.gesetze-im-internet.de/bgb/BJNR001950896.html'));
  for (const bad of ['http://www.gesetze-im-internet.de/x.html', 'https://evil.example/x.html', 'https://www.gesetze-im-internet.de.evil.example/x',
    'https://user:pw@www.gesetze-im-internet.de/x', 'https://www.gesetze-im-internet.de:8443/x', 'file:///etc/passwd', 'nonsense']) {
    assert.throws(() => assertAllowedLawUrl(bad), undefined, bad);
  }
  let called = false;
  const { lawErrors } = await checkLaws([{ law: 'x', url: 'https://evil.example/', stand: 's' }], async () => { called = true; return 's'; });
  assert.equal(called, false, 'no request for a forbidden host');
  assert.equal(lawErrors[0].law, 'x');
});

test('checkLaws reports changes and errors separately', async () => {
  const url = (n) => `https://www.gesetze-im-internet.de/${n}/BJNR1.html`;
  const entries = [{ law: 'a', url: url('a'), stand: 'same' }, { law: 'b', url: url('b'), stand: 'old' }, { law: 'c', url: url('c'), stand: 'x' }];
  const result = await checkLaws(entries, async (u) => {
    if (u === url('c')) throw new Error('timeout');
    return u === url('a') ? 'same' : 'new';
  });
  assert.deepEqual(result.lawChanges, [{ law: 'b', url: url('b'), expected: 'old', current: 'new' }]);
  assert.deepEqual(result.lawErrors, [{ law: 'c', error: 'timeout' }]);
});

const UPCOMING = `# Upcoming
Upcoming status: 2026-11-07. Maintained monthly.

| ID | Rule | Status (2026-11-07) | Next key date | Affects |
|---|---|---|---|---|
| UP-01 | Omnibus | PROPOSAL | none fixed | all |
| UP-05 | CCD | ADOPTED-NYA | **20.11.2026** | shops |
| UP-06 | PLD | ADOPTED-NYA | **09.12.2026** | sellers |
| UP-02 | AI Act | PARTLY | 02.12.2026 plain; **10.11.2026** and **01.01.2030** | chatbots |
| UP-09 | Repair | PARTLY | **07.11.2026** (equal to status date) | makers |
| — | Green Claims | WITHDRAWAL | **12.11.2026** | — |
`;

test('upcomingDue: bold dates after the status date and up to today', () => {
  assert.deepEqual(parseUpcomingDue(UPCOMING, '2026-11-16'), [{ id: 'UP-02', date: '2026-11-10' }]);
  assert.deepEqual(parseUpcomingDue(UPCOMING, '2026-12-09').map((d) => d.id), ['UP-05', 'UP-06', 'UP-02']);
  assert.deepEqual(parseUpcomingDue('no status line', '2026-12-09'), []);
});

test('run --status: not due returns due:false and touches no I/O beyond the state file', async () => {
  const io = new Proxy({ readLastCheck: async () => '2026-10-01' }, { get: (t, k) => t[k] ?? (() => { throw new Error(`unexpected I/O: ${String(k)}`); }) });
  assert.deepEqual(await run('--status', io, '2026-11-16'), { due: false, lastCheck: '2026-10-01' });
});

test('run --status: due combines version info and law check', async () => {
  const io = {
    installMethod: 'git',
    readLastCheck: async () => null,
    readInstalledVersion: async () => '1.16.1',
    readLatest: async () => ({ version: '1.17.0', commits: Array.from({ length: 12 }, (_, i) => `c${i}`) }),
    readLawData: async () => [],
    readUpcoming: async () => UPCOMING,
    fetchStand: async () => '',
  };
  const out = await run('--status', io, '2026-11-16');
  assert.equal(out.due, true);
  assert.equal(out.updateAvailable, true);
  assert.equal(out.whatsNew.length, 10);
  assert.deepEqual(out.lawChanges, []);
  assert.equal(out.upcomingDue.length, 1);
  io.readLatest = async () => { throw new Error('offline'); };
  assert.equal((await run('--status', io, '2026-11-16')).versionError, 'offline');
});

test('CLI: --status not due prints due:false without any network call; --mark-checked writes the file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'update-check-'));
  try {
    const marker = path.join(root, 'fetch-called');
    const preload = path.join(root, 'no-network.mjs');
    await writeFile(preload, `import { writeFileSync } from 'node:fs';\nglobalThis.fetch = () => { writeFileSync(${JSON.stringify(marker)}, '1'); throw new Error('network'); };\n`);
    await mkdir(path.join(root, 'local'));
    await writeFile(path.join(root, 'local', 'update-check.json'), JSON.stringify({ lastCheck: '2026-10-20' }));
    const { stdout } = await execFileAsync(process.execPath, ['--import', preload, SCRIPT, '--status', '--root', root, '--today', '2026-11-16'], { timeout: 20_000 });
    assert.deepEqual(JSON.parse(stdout), { due: false, lastCheck: '2026-10-20' });
    await assert.rejects(access(marker));

    await execFileAsync(process.execPath, [SCRIPT, '--mark-checked', '--root', root, '--today', '2026-11-17'], { timeout: 20_000 });
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'local', 'update-check.json'), 'utf8')), { lastCheck: '2026-11-17' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
