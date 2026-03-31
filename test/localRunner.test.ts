import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _testState } from 'vscode';
import { LocalRunner } from '../src/localRunner.js';
import { WorkspaceManager } from '../src/workspaceManager.js';

describe('LocalRunner', () => {
  let tmpDir: string;
  let workspace: WorkspaceManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-localrunner-'));
    _testState.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    workspace = new WorkspaceManager('/home/scoutman/github/azrunbooks-workbench');
    await workspace.initWorkspace('acct-1', 'rg-1', 'sub-1', 'Sub One', 'westeurope');
    _testState.messages.error.length = 0;
    _testState.debug.startCalls.length = 0;
  });

  afterEach(() => {
    _testState.workspaceFolders = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('treats an empty local runbook file as valid local content', async () => {
    workspace.writeRunbookFile('acct-1', 'EmptyRunbook', 'PowerShell', '');

    const runner = new LocalRunner(
      workspace,
      { appendLine: () => undefined, append: () => undefined, show: () => undefined } as any,
      undefined,
      '/home/scoutman/github/azrunbooks-workbench'
    ) as any;

    let delegatedContent: string | undefined;
    runner.runPowerShell = async (_runbook: unknown, content: string) => {
      delegatedContent = content;
    };

    await runner.run({
      name: 'EmptyRunbook',
      runbookType: 'PowerShell',
      accountName: 'acct-1',
      resourceGroupName: 'rg-1',
      subscriptionId: 'sub-1',
      subscriptionName: 'Sub One',
      state: 'Draft',
    });

    assert.equal(delegatedContent, '');
    assert.equal(_testState.messages.error.length, 0);
  });

  it('renders PowerShell mock variables and connections with safe quoted values', () => {
    const runner = new LocalRunner(
      workspace,
      { appendLine: () => undefined, append: () => undefined, show: () => undefined } as any,
      undefined,
      '/home/scoutman/github/azrunbooks-workbench'
    ) as any;

    const settings = workspace.readLocalSettings('acct-1');
    workspace.setGlobalPnPAppId('2b0dacad-2cdd-4b87-a045-2ba1e8e09dc4');
    settings.Assets.Variables.TenantInfo = '{"TenantId":"cb12","ClientId":"your-client-id","Thumbprint":"your-thumbprint"}';
    settings.Assets.Variables.abc = 'def';
    settings.Assets.Connections.AzureConnection = {
      TenantId: 'cb12',
      ClientId: "app'client",
    };

    const mockPath = runner.writePowerShellMock('acct-1', 'QuotedRunbook', settings);
    const content = fs.readFileSync(mockPath, 'utf8');

    assert.match(
      content,
      /'abc' \{ return "def" \}/
    );
    assert.match(
      content,
      /'PnPAppId' \{ return "2b0dacad-2cdd-4b87-a045-2ba1e8e09dc4" \}/
    );
    assert.match(
      content,
      /'TenantInfo' \{ return "\{`"TenantId`":`"cb12`",`"ClientId`":`"your-client-id`",`"Thumbprint`":`"your-thumbprint`"\}" \}/
    );
    assert.match(
      content,
      /'AzureConnection' \{ return @\{'TenantId'='cb12'; 'ClientId'='app''client'\} \}/
    );
    assert.doesNotMatch(
      content,
      /PnP\.PowerShell\\Connect-PnPOnline/
    );
    assert.match(
      content,
      /function Connect-PnPOnline/
    );
  });

  it('forces a temporary integrated PowerShell debug console for each local debug run', async () => {
    workspace.writeRunbookFile('acct-1', 'DebugRunbook', 'PowerShell', 'Write-Output "hi"');

    const runner = new LocalRunner(
      workspace,
      { appendLine: () => undefined, append: () => undefined, show: () => undefined } as any,
      undefined,
      '/home/scoutman/github/azrunbooks-workbench'
    );

    await runner.debug({
      name: 'DebugRunbook',
      runbookType: 'PowerShell',
      accountName: 'acct-1',
      resourceGroupName: 'rg-1',
      subscriptionId: 'sub-1',
      subscriptionName: 'Sub One',
      state: 'Draft',
    });

    assert.equal(_testState.config['debugging.createTemporaryIntegratedConsole'], true);
    assert.equal(_testState.debug.startCalls.length, 1);
    const [, config] = _testState.debug.startCalls[0] as [unknown, { type: string; request: string; script: string }];
    assert.equal(config.type, 'PowerShell');
    assert.equal(config.request, 'launch');
    assert.ok(config.script.endsWith('_debug.ps1'));
  });
});
