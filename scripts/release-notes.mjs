// Print the CHANGELOG.md section for one version, for the GitHub release notes.
//   node scripts/release-notes.mjs 2.0.0
// Fails (rather than publishing empty notes) if the section is missing or empty.
import {readFileSync} from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/release-notes.mjs <version>');
  process.exit(1);
}
const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/);
const start = lines.findIndex(line => line.startsWith(`## [${version}]`));
const end = lines.findIndex((line, index) => index > start && line.startsWith('## ['));
const body = start < 0 ? '' : lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
if (!body) {
  console.error(`CHANGELOG.md has no notes for ${version}.`);
  process.exit(1);
}
console.log(body);
