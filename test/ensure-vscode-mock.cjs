const fs = require('fs');
const path = require('path');

function ensureVscodeMock() {
  const pkgDir = path.resolve(__dirname, '..', 'node_modules', 'vscode');
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  const indexPath = path.join(pkgDir, 'index.js');

  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    pkgJsonPath,
    JSON.stringify({
      name: 'vscode',
      version: '0.0.0-test',
      main: 'index.js',
    }, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    indexPath,
    "module.exports = require('../../test/mock-vscode.ts');\n",
    'utf8'
  );
}

module.exports = { ensureVscodeMock };
