// I/O for the evidence and skeleton scripts: reads a run folder and the reference files.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REFERENCE_FILES = ['checklist', 'platforms', 'upcoming', 'sources'];

async function readJson(file, label) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(error.code === 'ENOENT' ? `${label} not found: ${file}` : `${label} cannot be read (${error.code ?? error.message}): ${file}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON: ${file}`);
  }
}

/** Read daten/scan.json and daten/findings.json of a run folder. */
export async function loadRun(runDir) {
  const dataDir = path.join(path.resolve(runDir), 'daten');
  const scan = await readJson(path.join(dataDir, 'scan.json'), 'scan.json');
  const findings = await readJson(path.join(dataDir, 'findings.json'), 'findings.json');
  if (!Array.isArray(scan.pages) || !Array.isArray(findings.findings)) {
    throw new Error('scan.json or findings.json has an unexpected shape (pages / findings missing)');
  }
  return { dataDir, scan, findings };
}

/** Read the four reference files of this skill (checklist, platforms, upcoming, sources) as text. */
export async function loadReferences() {
  const entries = await Promise.all(REFERENCE_FILES.map(
    async (name) => [name, await readFile(path.join(ROOT, 'references', `${name}.md`), 'utf8')],
  ));
  return Object.fromEntries(entries);
}
