import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = resolve(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!match) {
  throw new Error(`Invalid package version "${pkg.version}". Expected numeric semver like 1.4.0.`);
}

const [, majorRaw, minorRaw, patchRaw] = match;
const major = Number(majorRaw);
const minor = Number(minorRaw);
const patch = Number(patchRaw);

pkg.version = `${major}.${minor + 1}.${patch}`;

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`Version bumped to ${pkg.version}`);
