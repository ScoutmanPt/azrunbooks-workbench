import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { _testState } from 'vscode';
import {
  LocalStateDecorationProvider,
  RunbookFolderDecorationProvider,
  RunbookRuntimeDecorationProvider,
} from '../src/folderDecorationProvider.js';
import { SubscriptionColorRegistry } from '../src/subscriptionColorRegistry.js';
import { WorkspaceManager } from '../src/workspaceManager.js';

describe('folderDecorationProvider', () => {
  let tmpDir: string;
  let workspace: WorkspaceManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-decor-'));
    _testState.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    workspace = new WorkspaceManager('/home/scoutman/github/azrunbooks-workbench');
    await workspace.initWorkspace('acct-1', 'rg-1', 'sub-1', 'Sub One', 'westeurope');
  });

  it('adds runtime badges based on persisted runbook metadata', () => {
    workspace.writeRunbookFile('acct-1', 'MyRunbook', 'PowerShell72', 'Write-Host "hi"');
    const provider = new RunbookRuntimeDecorationProvider(workspace);

    const decoration = provider.provideFileDecoration(vscode.Uri.file(path.join(workspace.accountDirForAccount('acct-1'), 'MyRunbook.ps1')));

    assert.ok(decoration);
    assert.equal(decoration?.badge, '72');
    assert.equal(decoration?.tooltip, 'PowerShell 7.2');
  });

  it('adds account folder tooltip with account, resource group, location, and subscription', () => {
    const provider = new RunbookFolderDecorationProvider(workspace, new SubscriptionColorRegistry());

    const decoration = provider.provideFileDecoration(vscode.Uri.file(workspace.accountDirForAccount('acct-1')));

    assert.ok(decoration);
    assert.equal(decoration?.badge, 'i');
    assert.equal(decoration?.tooltip, 'acct-1 (rg-1) | westeurope | Sub One');
  });

  it('adds disabled cache/module/generated badges for local state paths', () => {
    const provider = new LocalStateDecorationProvider(workspace);
    fs.mkdirSync(path.join(workspace.workspaceCacheDir, 'acct-1', 'Schedules'), { recursive: true });
    fs.mkdirSync(path.join(workspace.localModulesDir, 'Az.Accounts'), { recursive: true });
    fs.mkdirSync(path.join(workspace.generatedMocksDirForAccount('acct-1'), 'rb1'), { recursive: true });

    const cacheDecoration = provider.provideFileDecoration(vscode.Uri.file(path.join(workspace.workspaceCacheDir, 'acct-1')));
    const moduleDecoration = provider.provideFileDecoration(vscode.Uri.file(path.join(workspace.localModulesDir, 'Az.Accounts')));
    const generatedDecoration = provider.provideFileDecoration(vscode.Uri.file(path.join(workspace.generatedMocksDirForAccount('acct-1'), 'rb1')));

    assert.equal(cacheDecoration?.badge, 'C');
    assert.equal(moduleDecoration?.badge, 'M');
    assert.equal(generatedDecoration?.badge, 'G');
  });
});
