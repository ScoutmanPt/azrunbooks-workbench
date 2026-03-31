import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _testState } from 'vscode';
import { IconThemeManager } from '../src/iconThemeManager.js';
import { SubscriptionColorRegistry } from '../src/subscriptionColorRegistry.js';
import { WorkspaceManager } from '../src/workspaceManager.js';

describe('IconThemeManager', () => {
  let tmpDir: string;
  let extensionDir: string;
  let workspace: WorkspaceManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-icon-theme-'));
    extensionDir = path.join(tmpDir, 'extension');
    fs.mkdirSync(path.join(extensionDir, 'resources'), { recursive: true });
    fs.copyFileSync(
      '/home/scoutman/github/azrunbooks-workbench/resources/runbook-workbench-icons.json',
      path.join(extensionDir, 'resources', 'runbook-workbench-icons.json')
    );

    _testState.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    _testState.config = {};
    workspace = new WorkspaceManager('/home/scoutman/github/azrunbooks-workbench');
    await workspace.initWorkspace('acct-1', 'rg-1', 'sub-1', 'Sub One', 'westeurope');
    workspace.writeRunbookFile('acct-1', 'CloudRunbook', 'PowerShell72', 'Write-Host "azure"');
  });

  afterEach(() => {
    _testState.workspaceFolders = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes account folder mappings and azure-backed runbook file mappings into the theme', () => {
    const manager = new IconThemeManager(extensionDir, workspace, new SubscriptionColorRegistry());
    manager.update();

    const theme = JSON.parse(fs.readFileSync(path.join(extensionDir, 'resources', 'runbook-workbench-icons.json'), 'utf8'));

    assert.equal(theme.folderNames['acct-1'], '_account_bright_blue');
    assert.equal(theme.folderNamesExpanded['acct-1'], '_account_bright_blue_open');
    assert.equal(theme.fileNames['CloudRunbook.ps1'], '_file_ps72_azure');
    assert.equal(theme.fileNames['aaccounts.json'], '_file_aaccounts');
  });

  it('applies the icon theme to workspace configuration', () => {
    const manager = new IconThemeManager(extensionDir, workspace, new SubscriptionColorRegistry());
    manager.update();

    assert.equal(_testState.config['workbench.iconTheme'], 'runbook-workbench-icons');
    assert.equal(_testState.config['explorer.decorations.colors'], false);
  });
});
