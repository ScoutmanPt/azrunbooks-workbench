/**
 * Unit tests for CiCdGenerator YAML output.
 * Tests the generated YAML structure for both GitHub Actions and Azure DevOps.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { _testState } from 'vscode';
import { CiCdGenerator, type DeploymentScope } from '../src/cicdGenerator.js';
import { WorkspaceManager } from '../src/workspaceManager.js';

const ACCOUNT = {
  accountName: 'my-automation',
  resourceGroup: 'rg-prod',
  subscriptionId: 'sub-abc-123',
};

// ── Access private YAML builders via class cast ───────────────────────────────

type CiCdGeneratorPrivate = CiCdGenerator & {
  buildGitHubActionsYaml(account: typeof ACCOUNT, scope?: DeploymentScope): string;
  buildAzureDevOpsYaml(account: typeof ACCOUNT, scope?: DeploymentScope): string;
  buildGitLabYaml(account: typeof ACCOUNT, scope?: DeploymentScope): string;
};

function makeGenerator(): CiCdGeneratorPrivate {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-cicd-'));
  _testState.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
  const ws = new WorkspaceManager();
  const channel = { appendLine: () => {} } as any;
  return new CiCdGenerator(ws, channel, process.cwd()) as CiCdGeneratorPrivate;
}

describe('CiCdGenerator - GitHub Actions YAML', () => {
  const gen = makeGenerator();
  const yaml = gen.buildGitHubActionsYaml(ACCOUNT);

  it('contains the workflow name', () =>
    assert.ok(yaml.includes('name: Deploy Runbooks')));

  it('triggers on push to main branch', () =>
    assert.ok(yaml.includes('branches: [main]')));

  it('watches account runbook paths', () =>
    assert.ok(yaml.includes(`- 'aaccounts/${ACCOUNT.accountName}/*.ps1'`)));

  it('requests id-token write permission (OIDC)', () =>
    assert.ok(yaml.includes('id-token: write')));

  it('uses azure/login@v2', () =>
    assert.ok(yaml.includes('uses: azure/login@v2')));

  it('injects automation account name', () =>
    assert.ok(yaml.includes(`"${ACCOUNT.accountName}"`)));

  it('injects resource group', () =>
    assert.ok(yaml.includes(`"${ACCOUNT.resourceGroup}"`)));

  it('injects subscription id', () =>
    assert.ok(yaml.includes(`"${ACCOUNT.subscriptionId}"`)));

  it('uses pwsh shell', () =>
    assert.ok(yaml.includes('shell: pwsh')));

  it('calls the runbook deployment helper script', () =>
    assert.ok(yaml.includes('deploy-runbooks.ps1')));

  it('passes the account runbook path to the helper script', () =>
    assert.ok(yaml.includes(`-AccountPath "./aaccounts/${ACCOUNT.accountName}"`)));
});

describe('CiCdGenerator - Azure DevOps YAML', () => {
  const gen = makeGenerator();
  const yaml = gen.buildAzureDevOpsYaml(ACCOUNT);

  it('has trigger on main branch', () =>
    assert.ok(yaml.includes('- main')));

  it('watches account runbook paths', () =>
    assert.ok(yaml.includes(`- 'aaccounts/${ACCOUNT.accountName}/*.ps1'`)));

  it('uses ubuntu-latest pool', () =>
    assert.ok(yaml.includes('vmImage: ubuntu-latest')));

  it('declares automationAccountName variable', () =>
    assert.ok(yaml.includes(`automationAccountName: '${ACCOUNT.accountName}'`)));

  it('declares resourceGroup variable', () =>
    assert.ok(yaml.includes(`resourceGroup:         '${ACCOUNT.resourceGroup}'`)));

  it('declares subscriptionId variable', () =>
    assert.ok(yaml.includes(`subscriptionId:        '${ACCOUNT.subscriptionId}'`)));

  it('uses AzureCLI@2 task', () =>
    assert.ok(yaml.includes('task: AzureCLI@2')));

  it('uses pscore script type', () =>
    assert.ok(yaml.includes('scriptType: pscore')));

  it('calls the runbook deployment helper script', () =>
    assert.ok(yaml.includes('deploy-runbooks.ps1')));

  it('passes the account runbook path to the helper script', () =>
    assert.ok(yaml.includes(`-AccountPath "./aaccounts/${ACCOUNT.accountName}"`)));
});

describe('CiCdGenerator - GitLab YAML', () => {
  const gen = makeGenerator();
  const yaml = gen.buildGitLabYaml(ACCOUNT);

  it('declares the deploy stage', () =>
    assert.ok(yaml.includes('stages:')));

  it('includes gitlab changes rules for account runbooks', () =>
    assert.ok(yaml.includes(`- 'aaccounts/${ACCOUNT.accountName}/*.ps1'`)));

  it('injects automation account variables', () =>
    assert.ok(yaml.includes(`AUTOMATION_ACCOUNT_NAME: "${ACCOUNT.accountName}"`)));

  it('uses azure cli login', () =>
    assert.ok(yaml.includes('az login --service-principal')));
});

describe('CiCdGenerator - scope variants', () => {
  const gen = makeGenerator();

  it('full scope includes runbooks plus Bicep-backed modules and assets deployment', () => {
    const yaml = gen.buildGitHubActionsYaml(ACCOUNT, 'full');
    assert.ok(yaml.includes('deploy-runbooks.ps1'));
    assert.ok(yaml.includes('deploy-modules.ps1'));
    assert.ok(yaml.includes('deploy-assets.ps1'));
    assert.ok(yaml.includes(".settings/mocks/pipelines"));
    assert.ok(yaml.includes(`- 'local.settings.json'`));
  });

  it('assets scope excludes runbook deployment and uses the assets Bicep template', () => {
    const yaml = gen.buildAzureDevOpsYaml(ACCOUNT, 'assets');
    assert.ok(!yaml.includes('deploy-runbooks.ps1'));
    assert.ok(yaml.includes('deploy-assets.ps1'));
  });

  it('modules + runbooks scope deploys modules with the module Bicep template', () => {
    const yaml = gen.buildGitLabYaml(ACCOUNT, 'modulesRunbooks');
    assert.ok(yaml.includes('deploy-modules.py'));
    assert.ok(yaml.includes('deploy-runbooks.sh'));
    assert.ok(!yaml.includes('deploy-assets.py'));
  });
});

describe('CiCdGenerator template seeding', () => {
  it('creates parent directories for nested helper scripts', () => {
    const gen = makeGenerator() as any;
    const workspace = (gen as any).workspace as WorkspaceManager;

    fs.rmSync(workspace.pipelineTemplatesDir, { recursive: true, force: true });
    gen.ensurePipelineTemplates();

    assert.ok(fs.existsSync(path.join(workspace.pipelineTemplatesDir, 'scripts', 'deploy-runbooks.ps1')));
    assert.ok(fs.existsSync(path.join(workspace.pipelineTemplatesDir, 'scripts', 'deploy-assets.py')));
  });
});
