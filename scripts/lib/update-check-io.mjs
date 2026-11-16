// Real I/O for the update check: files, git and HTTPS. Every call has a time limit.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertAllowedLawUrl, parseGithubRepo, readStandFromStream } from './update-check.mjs';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 30_000;
const MAX_PACKAGE_JSON = 100_000;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' };

async function git(root, ...args) {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { timeout: TIMEOUT_MS, env: GIT_ENV, maxBuffer: 1_000_000 });
  return stdout;
}

async function fetchWithLimit(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response;
}

/** @param {string} root skill folder */
export function createIo(root) {
  const stateFile = path.join(root, 'local', 'update-check.json');
  const readJson = async (...parts) => JSON.parse(await readFile(path.join(root, ...parts), 'utf8'));
  const installMethod = existsSync(path.join(root, '.git')) ? 'git' : 'other';

  const readLatestGit = async () => {
    await git(root, 'fetch', '--quiet', 'origin', 'main');
    const pkg = JSON.parse(await git(root, 'show', 'origin/main:package.json'));
    const log = await git(root, 'log', '--format=%s', 'HEAD..origin/main');
    return { version: pkg.version, commits: log.split('\n').filter(Boolean) };
  };

  const readLatestRaw = async () => {
    const repo = parseGithubRepo((await readJson('package.json')).repository?.url);
    if (!repo) throw new Error('repository.url is not a https://github.com/<owner>/<repo> URL');
    const url = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/main/package.json`;
    const text = await (await fetchWithLimit(url)).text();
    if (text.length > MAX_PACKAGE_JSON) throw new Error('package.json from GitHub is too large');
    return { version: JSON.parse(text).version, commits: [] };
  };

  return {
    installMethod,
    readInstalledVersion: async () => (await readJson('package.json')).version,
    readLatest: installMethod === 'git' ? readLatestGit : readLatestRaw,
    readLawData: () => readJson('data', 'law-status.json'),
    readUpcoming: () => readFile(path.join(root, 'references', 'upcoming.md'), 'utf8'),
    async fetchStand(url) {
      assertAllowedLawUrl(url);
      const response = await fetchWithLimit(url);
      return readStandFromStream(response.body);
    },
    async readLastCheck() {
      try {
        return JSON.parse(await readFile(stateFile, 'utf8')).lastCheck ?? null;
      } catch {
        return null; // missing or corrupt file counts as "never checked"
      }
    },
    async writeLastCheck(date) {
      await mkdir(path.dirname(stateFile), { recursive: true });
      await writeFile(stateFile, `${JSON.stringify({ lastCheck: date })}\n`);
    },
  };
}
