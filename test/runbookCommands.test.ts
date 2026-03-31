import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { _testState } from 'vscode';
import { RunbookCommands } from '../src/runbookCommands.js';
import { WorkspaceManager } from '../src/workspaceManager.js';

describe('RunbookCommands.fetchAllRunbooks', () => {
  const originalInfo = vscode.window.showInformationMessage;
  const originalWarn = vscode.window.showWarningMessage;
  let tmpDir: string;
  let workspace: WorkspaceManager;
  let infoMessages: string[];
  let warningMessages: string[];

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-cmds-'));
    _testState.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    workspace = new WorkspaceManager();
    await workspace.initWorkspace('acct-1', 'rg-1', 'sub-1', 'Sub One', 'westeurope');
  });

  after(() => {
    vscode.window.showInformationMessage = originalInfo;
    vscode.window.showWarningMessage = originalWarn;
    _testState.workspaceFolders = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates empty local files for runbooks with no content and warns the user', async () => {
    infoMessages = [];
    warningMessages = [];
    vscode.window.showInformationMessage = async (message?: string) => {
      if (message) { infoMessages.push(message); }
      return undefined;
    };
    vscode.window.showWarningMessage = async (message?: string) => {
      if (message) { warningMessages.push(message); }
      return undefined;
    };

    const azure = {
      listRunbooks: async () => [
        {
          name: 'EmptyWorkflow',
          runbookType: 'PowerShellWorkflow',
          state: 'New',
          accountName: 'acct-1',
          resourceGroupName: 'rg-1',
          subscriptionId: 'sub-1',
          subscriptionName: 'Sub One',
        },
        {
          name: 'ReadyRunbook',
          runbookType: 'PowerShell',
          state: 'Published',
          accountName: 'acct-1',
          resourceGroupName: 'rg-1',
          subscriptionId: 'sub-1',
          subscriptionName: 'Sub One',
        },
      ],
      getRunbookContent: async (_sub: string, _rg: string, _acct: string, name: string) => {
        if (name === 'EmptyWorkflow') {
          throw new Error('No content stream returned for draft runbook.');
        }
        return 'Write-Host "ready"';
      },
    } as any;

    const outputLines: string[] = [];
    const commands = new RunbookCommands(
      azure,
      workspace,
      { appendLine: (line: string) => outputLines.push(line) } as any
    );

    await commands.fetchAllRunbooks({
      id: '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Automation/automationAccounts/acct-1',
      name: 'acct-1',
      resourceGroupName: 'rg-1',
      subscriptionId: 'sub-1',
      subscriptionName: 'Sub One',
      location: 'westeurope',
    });

    const emptyPath = workspace.readRunbookFile('acct-1', 'EmptyWorkflow', 'PowerShellWorkflow');
    const readyPath = workspace.readRunbookFile('acct-1', 'ReadyRunbook', 'PowerShell');

    assert.equal(emptyPath, '');
    assert.equal(readyPath, 'Write-Host "ready"');
    assert.ok(infoMessages.includes('Fetched 2 runbook(s) from "acct-1".'));
    assert.ok(warningMessages.some(m => m.includes('with no content') && m.includes('EmptyWorkflow')));
    assert.ok(outputLines.some(line => line.includes('[fetch-all-warning] EmptyWorkflow')));
  });

  it('creates the automation account folder even when Azure returns no runbooks', async () => {
    infoMessages = [];
    warningMessages = [];
    vscode.window.showInformationMessage = async (message?: string) => {
      if (message) { infoMessages.push(message); }
      return undefined;
    };
    vscode.window.showWarningMessage = async (message?: string) => {
      if (message) { warningMessages.push(message); }
      return undefined;
    };

    const azure = {
      listRunbooks: async () => [],
    } as any;

    const commands = new RunbookCommands(
      azure,
      workspace,
      { appendLine: () => undefined } as any
    );

    await commands.fetchAllRunbooks({
      id: '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Automation/automationAccounts/acct-1',
      name: 'acct-1',
      resourceGroupName: 'rg-1',
      subscriptionId: 'sub-1',
      subscriptionName: 'Sub One',
      location: 'westeurope',
    });

    assert.ok(fs.existsSync(workspace.accountDirForAccount('acct-1')));
    assert.ok(fs.statSync(workspace.accountDirForAccount('acct-1')).isDirectory());
    assert.ok(infoMessages.includes('No runbooks found in "acct-1".'));
  });

  it('preserves manual local-only runbooks during sync', async () => {
    infoMessages = [];
    warningMessages = [];
    vscode.window.showInformationMessage = async (message?: string) => {
      if (message) { infoMessages.push(message); }
      return undefined;
    };
    vscode.window.showWarningMessage = async (message?: string) => {
      if (message) { warningMessages.push(message); }
      return undefined;
    };

    await workspace.initWorkspace('acct-sync', 'rg-sync', 'sub-1', 'Sub One', 'westeurope');
    workspace.writeRunbookFile('acct-sync', 'ManualOnly', 'PowerShell', 'Write-Host "local only"');

    const azure = {
      listRunbooks: async () => [
        {
          name: 'AzureRunbook',
          runbookType: 'PowerShell72',
          state: 'Published',
          accountName: 'acct-sync',
          resourceGroupName: 'rg-sync',
          subscriptionId: 'sub-1',
          subscriptionName: 'Sub One',
        },
      ],
      getRunbookContent: async () => 'Write-Host "azure"',
    } as any;

    const outputLines: string[] = [];
    const commands = new RunbookCommands(
      azure,
      workspace,
      { appendLine: (line: string) => outputLines.push(line) } as any
    );

    await commands.syncRunbooks({
      id: '/subscriptions/sub-1/resourceGroups/rg-sync/providers/Microsoft.Automation/automationAccounts/acct-sync',
      name: 'acct-sync',
      resourceGroupName: 'rg-sync',
      subscriptionId: 'sub-1',
      subscriptionName: 'Sub One',
      location: 'westeurope',
    });

    assert.equal(workspace.readRunbookFile('acct-sync', 'ManualOnly', 'PowerShell'), 'Write-Host "local only"');
    assert.equal(workspace.readRunbookFile('acct-sync', 'AzureRunbook', 'PowerShell72'), 'Write-Host "azure"');
    assert.ok(infoMessages.some(message => message.includes('preserved 1 local-only runbook(s)')));
    assert.ok(warningMessages.some(message => message.includes('Preserved local-only runbook(s)') && message.includes('ManualOnly')));
    assert.ok(outputLines.some(line => line.includes('[sync-runbooks] Preserved local-only runbook: ManualOnly')));
  });

  it('replaces stale cached section items during Fetch All', async () => {
    infoMessages = [];
    warningMessages = [];
    vscode.window.showInformationMessage = async (message?: string) => {
      if (message) { infoMessages.push(message); }
      return undefined;
    };
    vscode.window.showWarningMessage = async (message?: string) => {
      if (message) { warningMessages.push(message); }
      return undefined;
    };

    workspace.writeSectionItemFile('acct-1', 'Schedules', 'OldDaily', { frequency: 'Daily' });

    const azure = {
      listRunbooks: async () => [],
      listSchedules: async () => [{ name: 'NewHourly', frequency: 'Hour', interval: 1, isEnabled: true }],
      listVariables: async () => [],
      listCredentials: async () => [],
      listConnections: async () => [],
      listCertificates: async () => [],
      listImportedModules: async () => [],
      listPythonPackages: async () => [],
      listRuntimeEnvironments: async () => [],
      listHybridWorkerGroups: async () => [],
      listRecentJobs: async () => [],
    } as any;

    const commands = new RunbookCommands(
      azure,
      workspace,
      { appendLine: () => undefined } as any
    );

    await commands.fetchAllForAccount({
      id: '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Automation/automationAccounts/acct-1',
      name: 'acct-1',
      resourceGroupName: 'rg-1',
      subscriptionId: 'sub-1',
      subscriptionName: 'Sub One',
      location: 'westeurope',
    });

    const schedules = workspace.listSectionItemFiles('acct-1', 'Schedules');
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0].name, 'NewHourly');
    assert.equal((schedules[0].data as any).frequency, 'Hour');
  });
});

describe('RunbookCommands.startJob', () => {
  let tmpDir: string;
  let workspace: WorkspaceManager;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-startjob-'));
    _testState.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    workspace = new WorkspaceManager();
    await workspace.initWorkspace('acct-1', 'rg-1', 'sub-1', 'Sub One', 'westeurope');
  });

  after(() => {
    _testState.workspaceFolders = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts a production automation job with prompted parameters', async () => {
    _testState.ui.showInputBox = ['{"Param1":"value1"}'];
    _testState.messages.info.length = 0;

    let receivedParams: Record<string, string> | undefined;
    let receivedJobId: string | undefined;
    const outputLines: string[] = [];

    const azure = {
      startJob: async (
        _sub: string,
        _rg: string,
        _acct: string,
        _runbook: string,
        params: Record<string, string>
      ) => {
        receivedParams = params;
        return { jobId: 'job-123', status: 'Queued' };
      },
      getJobOutput: async (_sub: string, _rg: string, _acct: string, jobId: string) => {
        receivedJobId = jobId;
        return {
          summary: 'Completed',
          streams: [{ streamType: 'Output', value: 'done', time: new Date() }],
        };
      },
    } as any;

    const commands = new RunbookCommands(
      azure,
      workspace,
      {
        appendLine: (line: string) => outputLines.push(line),
        show: () => undefined,
      } as any
    );

    await commands.startJob({
      name: 'ProdRunbook',
      runbookType: 'PowerShell72',
      state: 'Published',
      accountName: 'acct-1',
      resourceGroupName: 'rg-1',
      subscriptionId: 'sub-1',
      subscriptionName: 'Sub One',
    });

    assert.deepEqual(receivedParams, { Param1: 'value1' });
    assert.equal(receivedJobId, 'job-123');
    assert.ok(_testState.messages.info.some(message => message.includes('Started automation job for "ProdRunbook" (job-123).')));
    assert.ok(outputLines.some(line => line.includes('[job] ProdRunbook → Queued (job-123)')));
    assert.ok(outputLines.some(line => line.includes('[Output ] done')));
    assert.ok(outputLines.some(line => line.includes('[job] Final status for job-123: Completed')));
  });
});

describe('RunbookCommands Runtime Environment support', () => {
  let tmpDir: string;
  let workspace: WorkspaceManager;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-runtime-'));
    _testState.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    workspace = new WorkspaceManager();
    await workspace.initWorkspace('acct-1', 'rg-1', 'sub-1', 'Sub One', 'westeurope');
  });

  after(() => {
    _testState.workspaceFolders = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a runbook linked to a runtime environment', async () => {
    _testState.ui.showInputBox = ['Cleanup-OldVMs', 'Cleanup old VMs'];
    _testState.ui.showQuickPick = [
      { label: 'PowerShell 7.2', value: 'PowerShell72' },
      { label: 'PS72-Shared', value: 'PS72-Shared' },
    ];

    const createdCalls: unknown[] = [];
    const azure = {
      listRuntimeEnvironments: async () => [
        {
          name: 'PS72-Shared',
          language: 'PowerShell',
          version: '7.2',
          defaultPackages: { Az: '12.3.0' },
        },
      ],
      createRunbook: async (...args: unknown[]) => {
        createdCalls.push(args);
      },
    } as any;

    const commands = new RunbookCommands(
      azure,
      workspace,
      { appendLine: () => undefined } as any
    );

    const created = await commands.createRunbook('acct-1', 'rg-1', 'sub-1', 'westeurope');

    assert.deepEqual(created, {
      name: 'Cleanup-OldVMs',
      runbookType: 'PowerShell',
      runtimeEnvironment: 'PS72-Shared',
    });
    assert.equal(createdCalls.length, 1);
    assert.deepEqual(createdCalls[0], [
      'sub-1',
      'rg-1',
      'acct-1',
      'westeurope',
      'Cleanup-OldVMs',
      'PowerShell',
      'Cleanup old VMs',
      'PS72-Shared',
    ]);
    assert.deepEqual(workspace.getRunbookMeta('acct-1')['Cleanup-OldVMs'], {
      runbookType: 'PowerShell',
      runtimeEnvironment: 'PS72-Shared',
    });
  });

  it('updates an existing runbook runtime environment', async () => {
    _testState.ui.showQuickPick = [
      { label: 'PS72-Modern', value: 'PS72-Modern' },
    ];

    const updateCalls: unknown[] = [];
    const azure = {
      listRuntimeEnvironments: async () => [
        { name: 'PS72-Modern', language: 'PowerShell', version: '7.2' },
      ],
      updateRunbookRuntimeEnvironment: async (...args: unknown[]) => {
        updateCalls.push(args);
      },
    } as any;

    const commands = new RunbookCommands(
      azure,
      workspace,
      { appendLine: () => undefined } as any
    );

    await commands.changeRunbookRuntimeEnvironment({
      name: 'ExistingRunbook',
      runbookType: 'PowerShell72',
      runtimeEnvironment: 'PS72-Shared',
      state: 'Published',
      accountName: 'acct-1',
      resourceGroupName: 'rg-1',
      subscriptionId: 'sub-1',
      subscriptionName: 'Sub One',
    });

    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0], [
      'sub-1',
      'rg-1',
      'acct-1',
      'ExistingRunbook',
      'PowerShell72',
      'PS72-Modern',
    ]);
  });
});
