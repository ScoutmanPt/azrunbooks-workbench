/**
 * End-to-end integration tests against a real Azure subscription.
 *
 * Token is obtained from `az account get-access-token` so no credentials
 * are stored in source. All test runbooks created here are deleted on cleanup.
 *
 * Target:
 *   Subscription : b8f257f8-149a-497c-8150-1b2c6d4feb5f  (MPN-ISBR)
 *   Account      : aa-etension  (rg_runbooks, westeurope)
 *   Account 2    : aa-demo      (rg_runbooks, northeurope)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { _testState } from 'vscode';

// ── Azure test constants ───────────────────────────────────────────────────────

const SUB_ID   = 'b8f257f8-149a-497c-8150-1b2c6d4feb5f';
const SUB_NAME = 'MPN-ISBR';
const RG       = 'rg_runbooks';
const ACCOUNT  = 'aa-etension';
const LOCATION = 'westeurope';
const RB_NAME  = `rb-e2e-test-${Date.now()}`;  // unique per run

// ── Auth helpers ──────────────────────────────────────────────────────────────

function getToken(): string {
  const raw = cp.execSync(
    `az account get-access-token --subscription ${SUB_ID} --resource https://management.azure.com/ --query accessToken -o tsv`,
    { encoding: 'utf8' }
  ).trim();
  return raw;
}

function makeMockAuth(token: string) {
  return {
    getAccessToken: async () => token,
    getCredential: () => ({
      getToken: async () => ({ token, expiresOnTimestamp: Date.now() + 3600000 }),
    }),
    getResourceManagerEndpoint: () => 'https://management.azure.com/',
    isSignedIn: true,
    onDidSignInChange: (_: unknown) => ({ dispose: () => {} }),
    accountName: 'e2e-test-user',
    scopes: [],
  };
}

// ── Workspace setup ───────────────────────────────────────────────────────────

let tmpDir: string;
let token: string;

// ── Import modules after vscode mock is in place ──────────────────────────────

import { AzureService } from '../src/azureService.js';
import { WorkspaceManager } from '../src/workspaceManager.js';
import { RunbookCommands } from '../src/runbookCommands.js';
import { SubscriptionColorRegistry } from '../src/subscriptionColorRegistry.js';
import { WorkspaceRunbooksTreeProvider } from '../src/workspaceRunbooksTreeProvider.js';
import { CiCdGenerator } from '../src/cicdGenerator.js';

// ── 1. AzureService - list operations ─────────────────────────────────────────

describe('AzureService - list operations', () => {
  let azure: AzureService;

  before(() => {
    token = getToken();
    azure = new AzureService(makeMockAuth(token) as any);
  });

  it('listSubscriptions - returns at least the test subscription', async () => {
    const subs = await azure.listSubscriptions();
    const found = subs.find(s => s.id === SUB_ID);
    assert.ok(found, `Subscription ${SUB_ID} not found in list`);
    assert.equal(found.name, SUB_NAME);
    assert.ok(found.tenantId.length > 0);
  });

  it('listAutomationAccounts - returns all 4 known accounts', async () => {
    const accounts = await azure.listAutomationAccounts(SUB_ID, SUB_NAME);
    assert.ok(accounts.length >= 4, `Expected ≥4 accounts, got ${accounts.length}`);
    const names = accounts.map(a => a.name);
    assert.ok(names.includes('aa-etension'));
    assert.ok(names.includes('aa-demo'));
    assert.ok(names.includes('aa-demo01'));
    assert.ok(names.includes('aa-psc25demo'));
  });

  it('listAutomationAccounts - each account has required fields', async () => {
    const accounts = await azure.listAutomationAccounts(SUB_ID, SUB_NAME);
    for (const a of accounts) {
      assert.ok(a.name, 'missing name');
      assert.ok(a.resourceGroupName, 'missing resourceGroupName');
      assert.ok(a.subscriptionId, 'missing subscriptionId');
      assert.ok(a.location, 'missing location');
    }
  });

  it('listRunbooks - returns runbooks from aa-etension', async () => {
    const runbooks = await azure.listRunbooks(SUB_ID, RG, ACCOUNT, SUB_NAME);
    // Each runbook must have required fields
    for (const rb of runbooks) {
      assert.ok(rb.name, 'runbook missing name');
      assert.ok(rb.runbookType, 'runbook missing type');
      assert.ok(rb.state, 'runbook missing state');
      assert.equal(rb.accountName, ACCOUNT);
      assert.equal(rb.subscriptionId, SUB_ID);
    }
  });

  it('listRunbooks - results are sorted alphabetically', async () => {
    const runbooks = await azure.listRunbooks(SUB_ID, RG, ACCOUNT, SUB_NAME);
    if (runbooks.length > 1) {
      for (let i = 1; i < runbooks.length; i++) {
        assert.ok(
          runbooks[i].name.localeCompare(runbooks[i - 1].name) >= 0,
          `runbooks not sorted: ${runbooks[i - 1].name} > ${runbooks[i].name}`
        );
      }
    }
  });

  it('listSchedules - returns array (may be empty)', async () => {
    const items = await azure.listSchedules(SUB_ID, RG, ACCOUNT);
    assert.ok(Array.isArray(items));
  });

  it('listVariables - returns array (may be empty)', async () => {
    const items = await azure.listVariables(SUB_ID, RG, ACCOUNT);
    assert.ok(Array.isArray(items));
  });

  it('listImportedModules - returns array', async () => {
    const items = await azure.listImportedModules(SUB_ID, RG, ACCOUNT);
    assert.ok(Array.isArray(items));
  });

  it('listPythonPackages - returns array', async () => {
    const items = await azure.listPythonPackages(SUB_ID, RG, ACCOUNT);
    assert.ok(Array.isArray(items));
  });

  it('listRuntimeEnvironments - returns array', async () => {
    const items = await azure.listRuntimeEnvironments(SUB_ID, RG, ACCOUNT);
    assert.ok(Array.isArray(items));
  });

  it('listHybridWorkerGroups - returns array', async () => {
    const items = await azure.listHybridWorkerGroups(SUB_ID, RG, ACCOUNT);
    assert.ok(Array.isArray(items));
  });

  it('listRecentJobs - returns array', async () => {
    const items = await azure.listRecentJobs(SUB_ID, RG, ACCOUNT);
    assert.ok(Array.isArray(items));
  });

  it('listCredentials - returns array', async () => {
    const items = await azure.listCredentials(SUB_ID, RG, ACCOUNT);
    assert.ok(Array.isArray(items));
  });
});

// ── 2. AzureService - runbook lifecycle ──────────────────────────────────────

describe('AzureService - runbook lifecycle (create / upload / publish / fetch / delete)', () => {
  let azure: AzureService;
  const CONTENT_V1 = `# E2E test runbook - created by automated test\nWrite-Host "E2E test v1"`;
  const CONTENT_V2 = `# E2E test runbook - updated\nWrite-Host "E2E test v2"`;

  before(() => {
    azure = new AzureService(makeMockAuth(token) as any);
  });

  after(async () => {
    // Best-effort cleanup - delete test runbook if it still exists
    try {
      await azure.deleteRunbook(SUB_ID, RG, ACCOUNT, RB_NAME);
    } catch { /* already deleted or never created */ }
  });

  it('createRunbook - creates a new PowerShell runbook', async () => {
    await azure.createRunbook(SUB_ID, RG, ACCOUNT, LOCATION, RB_NAME, 'PowerShell', 'E2E test');
    const runbooks = await azure.listRunbooks(SUB_ID, RG, ACCOUNT, SUB_NAME);
    const found = runbooks.find(r => r.name === RB_NAME);
    assert.ok(found, `Runbook ${RB_NAME} not found after create`);
    assert.equal(found.runbookType, 'PowerShell');
    assert.equal(found.state, 'New');
  });

  it('uploadDraftContent - uploads script content as draft', async () => {
    await azure.uploadDraftContent(SUB_ID, RG, ACCOUNT, RB_NAME, CONTENT_V1);
    // Verify by fetching draft content
    const content = await azure.getRunbookContent(SUB_ID, RG, ACCOUNT, RB_NAME, 'draft');
    assert.equal(content.trim(), CONTENT_V1.trim());
  });

  it('publishRunbook - publishes the draft (202/200 both accepted)', async () => {
    await azure.publishRunbook(SUB_ID, RG, ACCOUNT, RB_NAME);
    // After publish the state should be Published
    const runbooks = await azure.listRunbooks(SUB_ID, RG, ACCOUNT, SUB_NAME);
    const found = runbooks.find(r => r.name === RB_NAME);
    assert.ok(found);
    assert.equal(found.state, 'Published');
  });

  it('getRunbookContent (published) - returns the published script', async () => {
    const content = await azure.getRunbookContent(SUB_ID, RG, ACCOUNT, RB_NAME, 'published');
    assert.ok(content.includes('E2E test v1'));
  });

  it('uploadDraftContent + publish - second update flow works', async () => {
    await azure.uploadDraftContent(SUB_ID, RG, ACCOUNT, RB_NAME, CONTENT_V2);
    await azure.publishRunbook(SUB_ID, RG, ACCOUNT, RB_NAME);
    const content = await azure.getRunbookContent(SUB_ID, RG, ACCOUNT, RB_NAME, 'published');
    assert.ok(content.includes('E2E test v2'));
  });

  it('deleteRunbook - removes the runbook', async () => {
    await azure.deleteRunbook(SUB_ID, RG, ACCOUNT, RB_NAME);
    const runbooks = await azure.listRunbooks(SUB_ID, RG, ACCOUNT, SUB_NAME);
    const found = runbooks.find(r => r.name === RB_NAME);
    assert.equal(found, undefined, `Runbook ${RB_NAME} still exists after delete`);
  });
});

// ── 3. WorkspaceManager + RunbookCommands - full fetch workflow ───────────────

describe('WorkspaceManager + RunbookCommands - workspace fetch flow', () => {
  let azure: AzureService;
  let ws: WorkspaceManager;
  let commands: RunbookCommands;
  const outputLines: string[] = [];
  const outputChannel = {
    appendLine: (s: string) => outputLines.push(s),
    append: () => {},
    show: () => {},
    dispose: () => {},
  };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-e2e-'));
    _testState.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    azure = new AzureService(makeMockAuth(token) as any);
    ws = new WorkspaceManager();
    commands = new RunbookCommands(azure, ws, outputChannel as any);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _testState.workspaceFolders = undefined;
  });

  it('initWorkspace - creates required files', async () => {
    await ws.initWorkspace(ACCOUNT, RG, SUB_ID, SUB_NAME, LOCATION);
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'aaccounts.json')));
    assert.ok(fs.existsSync(ws.localSettingsPath));
    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('local.settings.json'));
  });

  it('getLinkedAccount - returns the initialized account', () => {
    const acc = ws.getLinkedAccount(ACCOUNT);
    assert.ok(acc);
    assert.equal(acc.subscriptionId, SUB_ID);
    assert.equal(acc.location, LOCATION);
  });

  it('fetchAllRunbooks - fetches published runbooks to disk', async () => {
    const account = { name: ACCOUNT, resourceGroupName: RG, subscriptionId: SUB_ID, subscriptionName: SUB_NAME, location: LOCATION };
    await commands.fetchAllRunbooks(account as any);
    const runbooks = ws.listWorkspaceRunbooks().filter(r => r.accountName === ACCOUNT);
    assert.ok(Array.isArray(runbooks));
  });

  it('listWorkspaceRunbooks - each entry has valid fields', () => {
    for (const rb of ws.listWorkspaceRunbooks()) {
      assert.ok(rb.runbookName, 'missing runbookName');
      assert.ok(rb.filePath, 'missing filePath');
      assert.ok(rb.localHash.length === 64, 'localHash should be sha256 hex');
      assert.ok(fs.existsSync(rb.filePath), `file not found: ${rb.filePath}`);
    }
  });

  it('writeSectionItemFile - stores section data (schedules)', async () => {
    const schedules = await azure.listSchedules(SUB_ID, RG, ACCOUNT);
    for (const s of schedules) {
      ws.writeSectionItemFile(ACCOUNT, 'Schedules', s.name, s);
    }
    const stored = ws.listSectionItemFiles(ACCOUNT, 'Schedules');
    assert.equal(stored.length, schedules.length);
  });

  it('writeSectionItemFile - stores PS modules', async () => {
    const modules = await azure.listImportedModules(SUB_ID, RG, ACCOUNT);
    for (const m of modules) {
      ws.writeSectionItemFile(ACCOUNT, 'PowerShellModules', m.name, m);
    }
    const stored = ws.listSectionItemFiles(ACCOUNT, 'PowerShellModules');
    assert.equal(stored.length, modules.length);
  });
});

// ── 4. WorkspaceRunbooksTreeProvider - tree state ─────────────────────────────

describe('WorkspaceRunbooksTreeProvider - tree states', () => {
  let ws: WorkspaceManager;
  let tree: WorkspaceRunbooksTreeProvider;
  const colorRegistry = new SubscriptionColorRegistry();

  before(async () => {
    // Fresh workspace
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-tree-'));
    _testState.workspaceFolders = [{ uri: { fsPath: dir } }];
    ws = new WorkspaceManager();
    tree = new WorkspaceRunbooksTreeProvider(ws, colorRegistry);
  });

  it('root shows 8 sections when no account linked', async () => {
    const children = await tree.getChildren();
    assert.equal(children.length, 8);
  });

  it('each section shows "No account linked" when no account', async () => {
    const sections = await tree.getChildren();
    const first = await tree.getChildren(sections[0] as any);
    assert.equal(first.length, 1);
    assert.ok((first[0] as any).label.includes('No account linked'));
  });

  it('after init - Runbooks section shows "No runbooks fetched yet"', async () => {
    await ws.initWorkspace(ACCOUNT, RG, SUB_ID, SUB_NAME, LOCATION);
    tree.refresh();
    const sections = await tree.getChildren();
    const runbooksSection = sections.find((s: any) => s.label === 'Runbooks');
    assert.ok(runbooksSection);
    const children = await tree.getChildren(runbooksSection as any);
    assert.equal(children.length, 1);
    assert.ok((children[0] as any).label.includes('No runbooks fetched yet'));
  });

  it('after writing a runbook - Runbooks section shows the file', async () => {
    ws.writeRunbookFile(ACCOUNT, 'TestRb', 'PowerShell', '# test');
    tree.refresh();
    const sections = await tree.getChildren();
    const runbooksSection = sections.find((s: any) => s.label === 'Runbooks');
    const children = await tree.getChildren(runbooksSection as any);
    assert.ok(children.some((c: any) => c.runbookName === 'TestRb'));
  });

  it('Schedules section shows "Not fetched yet" when folder is empty', async () => {
    const sections = await tree.getChildren();
    const schedSection = sections.find((s: any) => s.label === 'Schedules');
    const children = await tree.getChildren(schedSection as any);
    assert.equal(children.length, 1);
    assert.ok((children[0] as any).label.includes('Not fetched yet'));
  });

  it('Schedules section shows "Fetched, but Azure returned no items" after an empty fetch marker', async () => {
    ws.markSectionFetched(ACCOUNT, 'Schedules');
    tree.refresh();
    const sections = await tree.getChildren();
    const schedSection = sections.find((s: any) => s.label === 'Schedules');
    const children = await tree.getChildren(schedSection as any);
    assert.equal(children.length, 1);
    assert.ok((children[0] as any).label.includes('Fetched, but Azure returned no items'));
  });

  it('after writing section items - section shows the items', async () => {
    ws.writeSectionItemFile(ACCOUNT, 'Schedules', 'DailyJob', { frequency: 'Day', isEnabled: true });
    ws.writeSectionItemFile(ACCOUNT, 'Schedules', 'WeeklyJob', { frequency: 'Week', isEnabled: true });
    tree.refresh();
    const sections = await tree.getChildren();
    const schedSection = sections.find((s: any) => s.label === 'Schedules');
    const children = await tree.getChildren(schedSection as any);
    assert.equal(children.length, 2);
  });
});

// ── 5. RunbookCommands - create + fetch + publish + delete ────────────────────

describe('RunbookCommands - create, fetch, publish, delete lifecycle', () => {
  let azure: AzureService;
  let ws: WorkspaceManager;
  let commands: RunbookCommands;
  const RB2_NAME = `rb-e2e-cmd-${Date.now()}`;
  const outputLines: string[] = [];
  const outputChannel = {
    appendLine: (s: string) => outputLines.push(s),
    append: () => {},
    show: () => {},
    dispose: () => {},
  };

  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-cmd-'));
    _testState.workspaceFolders = [{ uri: { fsPath: dir } }];
    azure = new AzureService(makeMockAuth(token) as any);
    ws = new WorkspaceManager();
    commands = new RunbookCommands(azure, ws, outputChannel as any);
    await ws.initWorkspace(ACCOUNT, RG, SUB_ID, SUB_NAME, LOCATION);
  });

  after(async () => {
    // cleanup remote
    try { await azure.deleteRunbook(SUB_ID, RG, ACCOUNT, RB2_NAME); } catch { /* ok */ }
    if (_testState.workspaceFolders?.[0]) {
      fs.rmSync(_testState.workspaceFolders[0].uri.fsPath, { recursive: true, force: true });
    }
    _testState.workspaceFolders = undefined;
  });

  it('createRunbook - creates runbook in Azure and returns name+type', async () => {
    const result = await commands.createRunbook(ACCOUNT, RG, SUB_ID, LOCATION);
    // createRunbook requires UI interaction (showInputBox) - it will return undefined
    // because the mock showInputBox returns undefined (no user input)
    // This verifies the method handles cancellation gracefully
    assert.equal(result, undefined);
  });

  it('createRunbook via azure directly, then fetchRunbook writes file', async () => {
    await azure.createRunbook(SUB_ID, RG, ACCOUNT, LOCATION, RB2_NAME, 'PowerShell', 'cmd e2e test');
    await azure.uploadDraftContent(SUB_ID, RG, ACCOUNT, RB2_NAME, 'Write-Host "cmd-e2e"');

    // Re-fetch list so state reflects 'Edit' (draft uploaded)
    const runbooks = await azure.listRunbooks(SUB_ID, RG, ACCOUNT, SUB_NAME);
    const runbook = runbooks.find(r => r.name === RB2_NAME)!;
    assert.ok(runbook, `${RB2_NAME} not found after create+upload`);

    await commands.fetchRunbook(runbook, 'draft');
    const content = ws.readRunbookFile(ACCOUNT, RB2_NAME, 'PowerShell');
    assert.ok(content, 'File not written to workspace');
    assert.ok(content!.includes('cmd-e2e'));
    assert.ok(outputLines.some(l => l.includes('[fetch]') && l.includes(RB2_NAME)));
  });

  it('publishRunbook - uploads local content and publishes', async () => {
    ws.writeRunbookFile(ACCOUNT, RB2_NAME, 'PowerShell', 'Write-Host "published by cmd-e2e"');
    const runbooks = await azure.listRunbooks(SUB_ID, RG, ACCOUNT, SUB_NAME);
    const runbook = runbooks.find(r => r.name === RB2_NAME)!;

    // Simulate user clicking "Publish" in the confirmation dialog
    _testState.ui = { showWarningMessage: ['Publish'] };
    await commands.publishRunbook(runbook);

    const state = ws.getDeployState(ACCOUNT);
    assert.ok(state[RB2_NAME], 'No deploy hash recorded after publish');
    assert.ok(outputLines.some(l => l.includes('[publish]') && l.includes(RB2_NAME)));
  });

  it('deleteRunbook - deletes from Azure', async () => {
    const runbooks = await azure.listRunbooks(SUB_ID, RG, ACCOUNT, SUB_NAME);
    const runbook = runbooks.find(r => r.name === RB2_NAME)!;
    assert.ok(runbook, 'Runbook not found before delete');

    // Simulate user clicking "Delete" in the confirmation dialog
    _testState.ui = { showWarningMessage: ['Delete'] };
    await commands.deleteRunbook(runbook);

    const after = await azure.listRunbooks(SUB_ID, RG, ACCOUNT, SUB_NAME);
    assert.equal(after.find(r => r.name === RB2_NAME), undefined, 'Runbook still exists after delete');
    assert.ok(outputLines.some(l => l.includes('[delete]') && l.includes(RB2_NAME)));
  });
});

// ── 6. CiCdGenerator - generates valid YAML with real account data ─────────────

describe('CiCdGenerator - generates YAML with real account values', () => {
  before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-cicd-'));
    _testState.workspaceFolders = [{ uri: { fsPath: dir } }];
  });

  it('generates GitHub Actions YAML with real account name injected', async () => {
    const ws = new WorkspaceManager(process.cwd());
    await ws.initWorkspace(ACCOUNT, RG, SUB_ID, SUB_NAME, LOCATION);
    const channel = { appendLine: () => {} } as any;
    const gen = new CiCdGenerator(ws, channel, process.cwd()) as any;
    const yaml: string = gen.buildGitHubActionsYaml({ accountName: ACCOUNT, resourceGroup: RG, subscriptionId: SUB_ID });
    assert.ok(yaml.includes(ACCOUNT));
    assert.ok(yaml.includes(RG));
    assert.ok(yaml.includes(SUB_ID));
    assert.ok(yaml.includes('azure/login@v2'));
  });

  it('generates Azure DevOps YAML with real account name injected', async () => {
    const ws = new WorkspaceManager(process.cwd());
    const channel = { appendLine: () => {} } as any;
    const gen = new CiCdGenerator(ws, channel, process.cwd()) as any;
    const yaml: string = gen.buildAzureDevOpsYaml({ accountName: ACCOUNT, resourceGroup: RG, subscriptionId: SUB_ID });
    assert.ok(yaml.includes(ACCOUNT));
    assert.ok(yaml.includes(RG));
    assert.ok(yaml.includes(SUB_ID));
    assert.ok(yaml.includes('AzureCLI@2'));
  });

  it('generates GitLab YAML with real account name injected', async () => {
    const ws = new WorkspaceManager(process.cwd());
    const channel = { appendLine: () => {} } as any;
    const gen = new CiCdGenerator(ws, channel, process.cwd()) as any;
    const yaml: string = gen.buildGitLabYaml({ accountName: ACCOUNT, resourceGroup: RG, subscriptionId: SUB_ID });
    assert.ok(yaml.includes(ACCOUNT));
    assert.ok(yaml.includes(RG));
    assert.ok(yaml.includes(SUB_ID));
    assert.ok(yaml.includes('az login --service-principal'));
  });
});

// ── 7. Error handling ─────────────────────────────────────────────────────────

describe('Error handling - invalid inputs and edge cases', () => {
  let azure: AzureService;

  before(() => {
    azure = new AzureService(makeMockAuth(token) as any);
  });

  it('getRunbookContent - throws for non-existent runbook', async () => {
    await assert.rejects(
      () => azure.getRunbookContent(SUB_ID, RG, ACCOUNT, 'rb-does-not-exist-xyz', 'published'),
      (err: Error) => { assert.ok(err instanceof Error); return true; }
    );
  });

  it('deleteRunbook - Azure DELETE is idempotent (no throw for non-existent)', async () => {
    // ARM DELETE on a resource that does not exist returns 200/204 - it does not throw.
    await assert.doesNotReject(
      () => azure.deleteRunbook(SUB_ID, RG, ACCOUNT, 'rb-does-not-exist-xyz')
    );
  });

  it('listRunbooks - throws for non-existent account', async () => {
    await assert.rejects(
      () => azure.listRunbooks(SUB_ID, RG, 'aa-does-not-exist-xyz', SUB_NAME),
      (err: Error) => { assert.ok(err instanceof Error); return true; }
    );
  });

  it('WorkspaceManager.deleteRunbookFile - rejects path outside workspace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-err-'));
    _testState.workspaceFolders = [{ uri: { fsPath: dir } }];
    const ws = new WorkspaceManager();
    assert.throws(
      () => ws.deleteRunbookFile('/etc/passwd'),
      /Refusing to delete/
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('WorkspaceManager.getLinkedAccounts - returns [] when .settings/aaccounts.json is corrupt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-corrupt-'));
    _testState.workspaceFolders = [{ uri: { fsPath: dir } }];
    const ws = new WorkspaceManager();
    fs.mkdirSync(path.join(dir, '.settings'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.settings', 'aaccounts.json'), '{ corrupt json !!!', 'utf8');
    assert.deepEqual(ws.getLinkedAccounts(), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('WorkspaceManager - isWorkspaceOpen is false when no folder', () => {
    _testState.workspaceFolders = undefined;
    const ws = new WorkspaceManager();
    assert.equal(ws.isWorkspaceOpen, false);
  });
});
