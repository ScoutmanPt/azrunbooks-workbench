import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  __fireDidCreateFiles,
  __fireDidDeleteFiles,
  __fireWillDeleteFiles,
  _testState,
} from 'vscode';
import { WorkspaceManager } from '../src/workspaceManager.js';
import { registerWorkspaceProtection } from '../src/workspaceProtection.js';

describe('workspaceProtection', () => {
  let tmpDir: string;
  let workspace: WorkspaceManager;
  let protection: vscode.Disposable & { runWithoutProtection<T>(action: () => Promise<T> | T): Promise<T> };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-protect-'));
    _testState.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    _testState.messages.warn.length = 0;
    workspace = new WorkspaceManager('/home/scoutman/github/azrunbooks-workbench');
    await workspace.initWorkspace('acct-1', 'rg-1', 'sub-1', 'Sub One', 'westeurope');
    protection = registerWorkspaceProtection(workspace);
  });

  afterEach(() => {
    protection.dispose();
    _testState.workspaceFolders = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores protected account folders after deletion attempts', () => {
    const accountDir = workspace.accountDirForAccount('acct-1');
    __fireWillDeleteFiles({ files: [vscode.Uri.file(accountDir)] });
    fs.rmSync(accountDir, { recursive: true, force: true });
    __fireDidDeleteFiles({ files: [vscode.Uri.file(accountDir)] });

    assert.ok(fs.existsSync(accountDir));
    assert.ok(_testState.messages.warn.some(message => message.includes('cannot be deleted')));
  });

  it('does not restore protected folders while protection is suspended', async () => {
    const accountDir = workspace.accountDirForAccount('acct-1');
    await protection.runWithoutProtection(async () => {
      __fireWillDeleteFiles({ files: [vscode.Uri.file(accountDir)] });
      fs.rmSync(accountDir, { recursive: true, force: true });
      __fireDidDeleteFiles({ files: [vscode.Uri.file(accountDir)] });
    });

    assert.equal(fs.existsSync(accountDir), false);
  });

  it('removes folders created inside an automation account folder', () => {
    const nestedDir = path.join(workspace.accountDirForAccount('acct-1'), 'NestedFolder');
    fs.mkdirSync(nestedDir, { recursive: true });

    __fireDidCreateFiles({ files: [vscode.Uri.file(nestedDir)] });

    assert.equal(fs.existsSync(nestedDir), false);
    assert.ok(_testState.messages.warn.some(message => message.includes('Folders cannot be created inside Automation Account folders')));
  });

  it('allows deleting .settings/tmp without restoring it', () => {
    const tmpArtifactsDir = workspace.tempArtifactsRootDir;
    fs.mkdirSync(tmpArtifactsDir, { recursive: true });
    fs.writeFileSync(path.join(tmpArtifactsDir, 'session.log'), 'temp', 'utf8');

    __fireWillDeleteFiles({ files: [vscode.Uri.file(tmpArtifactsDir)] });
    fs.rmSync(tmpArtifactsDir, { recursive: true, force: true });
    __fireDidDeleteFiles({ files: [vscode.Uri.file(tmpArtifactsDir)] });

    assert.equal(fs.existsSync(tmpArtifactsDir), false);
    assert.equal(_testState.messages.warn.some(message => message.includes('cannot be deleted')), false);
  });
});
