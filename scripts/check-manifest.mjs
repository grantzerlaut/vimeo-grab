// Sanity checks run in CI: version numbers agree, every file the manifest
// and HTML pages reference exists, and every relative import resolves.
import {readFileSync, existsSync, readdirSync, statSync} from 'node:fs';
import {join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ext = join(root, 'extension');
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = [];

if (manifest.version !== pkg.version) problems.push(`manifest version ${manifest.version} != package.json ${pkg.version}`);
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${manifest.version}]`)) problems.push(`CHANGELOG.md has no entry for ${manifest.version}`);

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
];
for (const file of referenced) if (!existsSync(join(ext, file))) problems.push(`manifest references missing ${file}`);

const walk = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
for (const file of walk(ext)) {
  const text = /\.(m?js|html)$/.test(file) ? readFileSync(file, 'utf8') : '';
  // Imports and HTML src/href resolve from the file itself; runtime.getURL from the extension root.
  const local = [
    ...text.matchAll(/(?:import|from)\s*['"](\.[^'"]+)['"]/g),
    ...text.matchAll(/(?:src|href)="(?!https?:|#|data:|chrome:)([^"]+)"/g),
  ].map(match => join(dirname(file), match[1]));
  const fromRoot = [...text.matchAll(/getURL\('([^']+)'\)/g)].map(match => join(ext, match[1]));
  for (const target of [...local, ...fromRoot]) {
    if (!existsSync(target.split('?')[0])) problems.push(`${relative(root, file)} references missing ${relative(ext, target)}`);
  }
}
// Invisible characters in source are almost always an accident.
for (const file of walk(ext).filter(path => /\.(m?js|html|css|json)$/.test(path))) {
  const text = readFileSync(file, 'utf8');
  if (/[\p{Cf}\u00A0]/u.test(text.replace(/\\u[0-9a-f]{4}/gi, ''))) problems.push(`${relative(root, file)} contains invisible characters`);
}

if (problems.length) {
  console.error(problems.map(problem => `✖ ${problem}`).join('\n'));
  process.exit(1);
}
console.log(`✔ manifest ${manifest.version} and ${referenced.length} referenced files check out`);
