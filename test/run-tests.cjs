const { spawnSync } = require('child_process');
const path = require('path');
const { ensureVscodeMock } = require('./ensure-vscode-mock.cjs');

ensureVscodeMock();

const result = spawnSync(
  process.execPath,
  [
    path.resolve(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    '--tsconfig',
    path.resolve(__dirname, 'tsconfig.json'),
    '--test',
    path.resolve(__dirname, '*.test.ts'),
  ],
  { stdio: 'inherit' }
);

process.exit(result.status ?? 1);
