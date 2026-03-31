/**
 * Unit tests for WorkspaceManager, sanitizeName, extensionForRunbookType,
 * runbookTypeForFilePath, and WorkspaceManager.resolveEnvToken.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { _testState } from 'vscode';
import {
  sanitizeName,
  extensionForRunbookType,
  runbookTypeForFilePath,
  WorkspaceManager,
} from '../src/workspaceManager.js';

// ── sanitizeName ──────────────────────────────────────────────────────────────

describe('sanitizeName', () => {
  it('replaces spaces with underscores', () =>
    assert.equal(sanitizeName('My Runbook'), 'My_Runbook'));

  it('replaces special characters', () =>
    assert.equal(sanitizeName('hello!world@#'), 'hello_world'));

  it('collapses consecutive underscores', () =>
    assert.equal(sanitizeName('a  b'), 'a_b'));

  it('strips leading and trailing underscores', () =>
    assert.equal(sanitizeName('_hello_'), 'hello'));

  it('leaves valid names unchanged', () =>
    assert.equal(sanitizeName('Clean-Name_1'), 'Clean-Name_1'));

  it('handles empty string', () =>
    assert.equal(sanitizeName(''), ''));
});

// ── extensionForRunbookType ───────────────────────────────────────────────────

describe('extensionForRunbookType', () => {
  it('returns .py for Python3', () =>
    assert.equal(extensionForRunbookType('Python3'), '.py'));

  it('returns .py for Python2 (case-insensitive)', () =>
    assert.equal(extensionForRunbookType('python2'), '.py'));

  it('returns .ps1 for PowerShell', () =>
    assert.equal(extensionForRunbookType('PowerShell'), '.ps1'));

  it('returns .ps1 for PowerShell72', () =>
    assert.equal(extensionForRunbookType('PowerShell72'), '.ps1'));

  it('defaults to .ps1 for unknown types', () =>
    assert.equal(extensionForRunbookType('Graphical'), '.ps1'));
});

// ── runbookTypeForFilePath ────────────────────────────────────────────────────

describe('runbookTypeForFilePath', () => {
  it('returns Python3 for .py', () =>
    assert.equal(runbookTypeForFilePath('/path/Runbook.py'), 'Python3'));

  it('returns PowerShell for .ps1', () =>
    assert.equal(runbookTypeForFilePath('/path/Runbook.ps1'), 'PowerShell'));

  it('is case-insensitive on extension', () =>
    assert.equal(runbookTypeForFilePath('/path/Runbook.PY'), 'Python3'));
});

// ── WorkspaceManager.resolveEnvToken ─────────────────────────────────────────

describe('WorkspaceManager.resolveEnvToken', () => {
  it('replaces ${env:VAR} with process.env value', () => {
    process.env['_RB_TEST_A'] = 'hello';
    assert.equal(WorkspaceManager.resolveEnvToken('_${env:_RB_TEST_A}_'), '_hello_');
    delete process.env['_RB_TEST_A'];
  });

  it('replaces missing env var with empty string', () => {
    delete process.env['_RB_MISSING_'];
    assert.equal(WorkspaceManager.resolveEnvToken('${env:_RB_MISSING_}'), '');
  });

  it('leaves plain strings unchanged', () =>
    assert.equal(WorkspaceManager.resolveEnvToken('plain value'), 'plain value'));

  it('replaces multiple tokens in one string', () => {
    process.env['_T1'] = 'foo';
    process.env['_T2'] = 'bar';
    assert.equal(WorkspaceManager.resolveEnvToken('${env:_T1}-${env:_T2}'), 'foo-bar');
    delete process.env['_T1'];
    delete process.env['_T2'];
  });
});

// ── WorkspaceManager file I/O ─────────────────────────────────────────────────

describe('WorkspaceManager (file I/O)', () => {
  let tmpDir: string;
  let ws: WorkspaceManager;
  const extensionPath = '/home/scoutman/github/azrunbooks-workbench';

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-test-'));
    _testState.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    ws = new WorkspaceManager(extensionPath);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _testState.workspaceFolders = undefined;
  });

  it('isWorkspaceOpen is true when folder is set', () =>
    assert.ok(ws.isWorkspaceOpen));

  it('getLinkedAccounts returns [] before any init', () =>
    assert.deepEqual(ws.getLinkedAccounts(), []));

  it('initWorkspace creates .settings/aaccounts.json', async () => {
    await ws.initWorkspace('acct-1', 'rg-1', 'sub-1', 'Sub One', 'eastus');
    const accounts = ws.getLinkedAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].accountName, 'acct-1');
    assert.equal(accounts[0].resourceGroup, 'rg-1');
    assert.equal(accounts[0].subscriptionId, 'sub-1');
    assert.equal(accounts[0].location, 'eastus');
  });

  it('initWorkspace creates local.settings.json', () =>
    assert.ok(fs.existsSync(ws.localSettingsPath)));

  it('initWorkspace creates the automation account folder even before any runbooks are fetched', () => {
    assert.ok(fs.existsSync(ws.accountDirForAccount('acct-1')));
    assert.ok(fs.statSync(ws.accountDirForAccount('acct-1')).isDirectory());
  });

  it('initWorkspace seeds mock templates', () => {
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'AutomationAssetsMock.psm1.template')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'PnPPowerShellMock.psm1.template')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'MicrosoftGraphMock.psm1.template')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'automationstubs.py.template')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'pipelines', 'automation-assets.bicep')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'pipelines', 'automation-modules.bicep')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'pipelines', 'modules.manifest.json.template')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'pipelines', 'certificates.manifest.json.template')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'pipelines', 'scripts', 'deploy-runbooks.ps1')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'pipelines', 'scripts', 'deploy-assets.ps1')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'pipelines', 'scripts', 'deploy-modules.ps1')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'pipelines', 'scripts', 'deploy-runbooks.sh')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'pipelines', 'scripts', 'deploy-assets.py')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'mocks', 'pipelines', 'scripts', 'deploy-modules.py')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.settings', 'cache', 'modules')));
    const assetTemplate = fs.readFileSync(path.join(tmpDir, '.settings', 'mocks', 'AutomationAssetsMock.psm1.template'), 'utf8');
    const pnpTemplate = fs.readFileSync(path.join(tmpDir, '.settings', 'mocks', 'PnPPowerShellMock.psm1.template'), 'utf8');
    const graphTemplate = fs.readFileSync(path.join(tmpDir, '.settings', 'mocks', 'MicrosoftGraphMock.psm1.template'), 'utf8');
    const pipelineTemplate = fs.readFileSync(path.join(tmpDir, '.settings', 'mocks', 'pipelines', 'automation-assets.bicep'), 'utf8');
    const runbookScript = fs.readFileSync(path.join(tmpDir, '.settings', 'mocks', 'pipelines', 'scripts', 'deploy-runbooks.ps1'), 'utf8');
    assert.ok(assetTemplate.includes('function Get-AutomationVariable'));
    assert.ok(!assetTemplate.includes('function Connect-PnPOnline'));
    assert.ok(pnpTemplate.includes('function Connect-PnPOnline'));
    assert.ok(pnpTemplate.includes('$ManagedIdentity'));
    assert.ok(graphTemplate.includes('function Connect-MgGraph'));
    assert.ok(graphTemplate.includes('function Get-MgContext'));
    assert.ok(pipelineTemplate.includes('Microsoft.Automation/automationAccounts/variables'));
    assert.ok(runbookScript.includes('az automation runbook replace-content'));
  });

  it('initWorkspace writes .gitignore entries', () => {
    const gi = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(gi.includes('local.settings.json'));
    assert.ok(gi.includes('.env'));
    assert.ok(gi.includes('.settings/cache/workspace-cache/'));
    assert.ok(gi.includes('.settings/tmp/'));
    assert.ok(gi.includes('.settings/cache/modules/'));
  });

  it('getLinkedAccount finds by name', () => {
    const a = ws.getLinkedAccount('acct-1');
    assert.ok(a);
    assert.equal(a.accountName, 'acct-1');
  });

  it('getLinkedAccount returns undefined for unknown name', () =>
    assert.equal(ws.getLinkedAccount('no-such'), undefined));

  it('initWorkspace is idempotent - re-init updates, no duplicates', async () => {
    await ws.initWorkspace('acct-1', 'rg-1', 'sub-1', 'Sub One', 'westus');
    assert.equal(ws.getLinkedAccounts().length, 1);
    assert.equal(ws.getLinkedAccount('acct-1')!.location, 'westus');
  });

  it('initWorkspace supports multiple accounts', async () => {
    await ws.initWorkspace('acct-2', 'rg-2', 'sub-2', 'Sub Two', 'westeurope');
    assert.equal(ws.getLinkedAccounts().length, 2);
  });

  it('writeRunbookFile creates .ps1 and returns its path', () => {
    const fp = ws.writeRunbookFile('acct-1', 'MyRb', 'PowerShell', '# ps1 content');
    assert.ok(fs.existsSync(fp));
    assert.ok(fp.endsWith('MyRb.ps1'));
  });

  it('writeRunbookFile creates .py for Python type', () => {
    const fp = ws.writeRunbookFile('acct-1', 'MyPyRb', 'Python3', 'print("hi")');
    assert.ok(fp.endsWith('MyPyRb.py'));
  });

  it('readRunbookFile reads back written content', () =>
    assert.equal(ws.readRunbookFile('acct-1', 'MyRb', 'PowerShell'), '# ps1 content'));

  it('readRunbookFile returns undefined for missing runbook', () =>
    assert.equal(ws.readRunbookFile('acct-1', 'NoSuch', 'PowerShell'), undefined));

  it('writeRunbookFile with subfolder places file under subfolder', () => {
    const fp = ws.writeRunbookFile('acct-1', 'DraftRb', 'PowerShell', '# draft', 'Draft');
    assert.ok(fp.includes(`${path.sep}Draft${path.sep}`));
  });

  it('readRunbookFile finds files in subfolders', () =>
    assert.ok(ws.readRunbookFile('acct-1', 'DraftRb', 'PowerShell')));

  it('listWorkspaceRunbooks returns all written runbooks for account', () => {
    const list = ws.listWorkspaceRunbooks().filter(r => r.accountName === 'acct-1');
    const names = list.map(r => r.runbookName);
    assert.ok(names.includes('MyRb'));
    assert.ok(names.includes('DraftRb'));
  });

  it('listWorkspaceRunbooks marks linked twins when Published+Draft hashes match', () => {
    const content = '# same content';
    ws.writeRunbookFile('acct-1', 'TwinRb', 'PowerShell', content, 'Published');
    ws.writeRunbookFile('acct-1', 'TwinRb', 'PowerShell', content, 'Draft');
    const list = ws.listWorkspaceRunbooks().filter(r => r.runbookName === 'TwinRb');
    assert.equal(list.length, 2);
    assert.ok(list.every(r => r.linkedTwin === true));
  });

  it('writeSectionItemFile creates JSON in section folder', () => {
    ws.writeSectionItemFile('acct-1', 'Schedules', 'DailyJob', { frequency: 'Daily' });
    const items = ws.listSectionItemFiles('acct-1', 'Schedules');
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'DailyJob');
    assert.equal((items[0].data as any).frequency, 'Daily');
    assert.ok(items[0].filePath.includes(`${path.sep}.settings${path.sep}cache${path.sep}workspace-cache${path.sep}acct-1${path.sep}Schedules${path.sep}`));
  });

  it('listSectionItemFiles returns [] for non-existent section folder', () =>
    assert.deepEqual(ws.listSectionItemFiles('acct-1', 'Assets'), []));

  it('markSectionFetched records fetched state for an empty section', () => {
    ws.markSectionFetched('acct-1', 'Assets');
    assert.equal(ws.hasSectionBeenFetched('acct-1', 'Assets'), true);
    assert.deepEqual(ws.listSectionItemFiles('acct-1', 'Assets'), []);
  });

  it('replaceSectionItemFiles removes stale JSON before writing fresh items', () => {
    ws.writeSectionItemFile('acct-1', 'RecentJobs', 'job-1', { status: 'Old' });
    ws.replaceSectionItemFiles('acct-1', 'RecentJobs', [
      { itemName: 'job-2', data: { status: 'New' } },
    ]);

    const items = ws.listSectionItemFiles('acct-1', 'RecentJobs');
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'job-2');
    assert.equal((items[0].data as any).status, 'New');
  });

  it('readLocalSettings returns defaults when account not found', () => {
    const s = ws.readLocalSettings('unknown');
    assert.equal(s.accountName, 'unknown');
    assert.deepEqual(s.Assets.Variables, {});
    assert.equal(ws.getGlobalPnPAppId(), '');
  });

  it('writeLocalSettings and readLocalSettings roundtrip', () => {
    const s = ws.readLocalSettings('acct-1');
    s.Assets.Variables['SomeVar'] = 'val123';
    ws.writeLocalSettings('acct-1', s);
    assert.equal(ws.readLocalSettings('acct-1').Assets.Variables['SomeVar'], 'val123');
  });

  it('stores local.settings.json as a root object with PnPAppId and aaccounts', () => {
    ws.setGlobalPnPAppId('2b0dacad-2cdd-4b87-a045-2ba1e8e09dc4');
    const raw = JSON.parse(fs.readFileSync(ws.localSettingsPath, 'utf8'));
    assert.equal(raw.PnPAppId, '2b0dacad-2cdd-4b87-a045-2ba1e8e09dc4');
    assert.ok(Array.isArray(raw.aaccounts));
    assert.ok(raw.aaccounts.some((account: { accountName: string }) => account.accountName === 'acct-1'));
  });

  it('recordDeploy and getDeployState roundtrip', () => {
    ws.recordDeploy('acct-1', 'MyRb', 'deadbeef');
    assert.equal(ws.getDeployState('acct-1')['MyRb'], 'deadbeef');
  });

  it('getDeployState returns {} for account with no deploys', () =>
    assert.deepEqual(ws.getDeployState('acct-never'), {}));

  it('deleteRunbookFile removes the file', () => {
    const fp = ws.writeRunbookFile('acct-1', 'ToDelete', 'PowerShell', '# temp');
    assert.ok(fs.existsSync(fp));
    ws.deleteRunbookFile(fp);
    assert.ok(!fs.existsSync(fp));
    assert.equal(ws.getRunbookMeta('acct-1')['ToDelete'], undefined);
  });

  it('deleteRunbookFile keeps the Automation Account folder when the last runbook is removed', () => {
    const fp = ws.writeRunbookFile('acct-1', 'OnlyRunbook', 'PowerShell', '# temp');
    const runbooksDir = ws.accountDirForAccount('acct-1');
    ws.deleteRunbookFile(fp);
    assert.ok(fs.existsSync(runbooksDir));
    assert.ok(fs.statSync(runbooksDir).isDirectory());
  });

  it('deleteRunbookFile keeps metadata while another local copy exists', () => {
    const published = ws.writeRunbookFile('acct-1', 'KeepMeta', 'PowerShell', '# pub', 'Published');
    ws.writeRunbookFile('acct-1', 'KeepMeta', 'PowerShell', '# draft', 'Draft');
    ws.deleteRunbookFile(published);
    assert.deepEqual(ws.getRunbookMeta('acct-1')['KeepMeta'], { runbookType: 'PowerShell' });
  });

  it('clearWorkspace removes ARW-managed local workspace content without recreating it', () => {
    ws.writeRunbookFile('acct-1', 'Gone', 'PowerShell', '# temp');
    ws.writeLocalSettings('acct-1', {
      accountName: 'acct-1',
      IsEncrypted: false,
      Assets: { Variables: { Demo: '1' }, Credentials: {}, Connections: {}, Certificates: {} },
    });
    const githubWorkflowDir = path.join(tmpDir, '.github', 'workflows');
    fs.mkdirSync(githubWorkflowDir, { recursive: true });
    fs.writeFileSync(path.join(githubWorkflowDir, 'deploy-runbooks-acct-1.yml'), 'name: deploy', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'azure-pipelines-acct-1.yml'), 'trigger: none', 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.gitlab-ci-acct-1.yml'), 'stages: []', 'utf8');
    fs.mkdirSync(path.join(tmpDir, '.rb-workb'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.rb-workb', 'legacy.txt'), 'legacy', 'utf8');

    ws.clearWorkspace();

    assert.ok(!fs.existsSync(ws.accountsDir));
    assert.ok(!fs.existsSync(ws.findRunbookFilePath('acct-1', 'Gone', 'PowerShell') ?? ''));
    assert.equal(ws.getLinkedAccounts().length, 0);
    assert.ok(!fs.existsSync(ws.localSettingsPath));
    assert.ok(!fs.existsSync(path.join(tmpDir, 'azure-pipelines-acct-1.yml')));
    assert.ok(!fs.existsSync(path.join(tmpDir, '.gitlab-ci-acct-1.yml')));
    assert.ok(!fs.existsSync(path.join(githubWorkflowDir, 'deploy-runbooks-acct-1.yml')));
    assert.ok(!fs.existsSync(path.join(tmpDir, '.github')));
    assert.ok(!fs.existsSync(path.join(tmpDir, '.rb-workb')));
  });

  it('deleteRunbookFile throws when path is outside workspace accounts dir', () =>
    assert.throws(
      () => ws.deleteRunbookFile('/etc/passwd'),
      /Refusing to delete file outside workspace/
    ));

  it('findRunbookFilePath finds the file written earlier', () => {
    ws.writeRunbookFile('acct-1', 'MyRb', 'PowerShell', '# code');
    const fp = ws.findRunbookFilePath('acct-1', 'MyRb', 'PowerShell');
    assert.ok(fp);
    assert.ok(fp.endsWith('MyRb.ps1'));
  });

  it('findRunbookFilePath returns undefined for non-existent runbook', () =>
    assert.equal(ws.findRunbookFilePath('acct-1', 'NoSuch', 'PowerShell'), undefined));
});

describe('WorkspaceManager legacy migration', () => {
  it('migrates nested legacy mock template folders without throwing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-legacy-'));
    _testState.workspaceFolders = [{ uri: { fsPath: tmpDir } }];

    const legacyScriptsDir = path.join(tmpDir, '.rb-workb', 'mocks', 'pipelines', 'scripts');
    fs.mkdirSync(legacyScriptsDir, { recursive: true });
    fs.writeFileSync(path.join(legacyScriptsDir, 'deploy-runbooks.ps1'), '# legacy helper', 'utf8');

    const ws = new WorkspaceManager();
    const migratedPath = path.join(tmpDir, '.settings', 'mocks', 'pipelines', 'scripts', 'deploy-runbooks.ps1');

    assert.ok(fs.existsSync(migratedPath));
    assert.equal(fs.readFileSync(migratedPath, 'utf8'), '# legacy helper');

    fs.rmSync(tmpDir, { recursive: true, force: true });
    _testState.workspaceFolders = undefined;
  });
});
