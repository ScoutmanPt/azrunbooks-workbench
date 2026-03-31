import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { sanitizeName, type LinkedAccount, type WorkspaceManager } from './workspaceManager';

type PipelinePlatform = 'github' | 'azdo' | 'gitlab';
type PipelineChoice = PipelinePlatform | 'both' | 'all';
type DeploymentScope = 'full' | 'assets' | 'modulesRunbooks' | 'runbooks';

type CiCdGeneratorPrivate = {
  buildGitHubActionsYaml(account: LinkedAccount, scope?: DeploymentScope): string;
  buildAzureDevOpsYaml(account: LinkedAccount, scope?: DeploymentScope): string;
  buildGitLabYaml(account: LinkedAccount, scope?: DeploymentScope): string;
};

type ScopeDefinition = {
  readonly label: string;
  readonly pathFilters: string[];
  readonly githubScript: string[];
  readonly azdoScript: string[];
  readonly gitlabScript: string[];
};

export class CiCdGenerator {
  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly extensionPath?: string
  ) {}

  async generate(accountName?: string): Promise<void> {
    const account = this.workspace.getLinkedAccount(accountName);
    if (!account) {
      void vscode.window.showErrorMessage('No linked account. Run "Initialize Runbook Workspace" first.');
      return;
    }

    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(github) GitHub Actions', value: 'github' as PipelineChoice },
        { label: '$(azure-devops) Azure DevOps', value: 'azdo' as PipelineChoice },
        { label: '$(gitlab) GitLab', value: 'gitlab' as PipelineChoice },
        { label: 'GitHub Actions + Azure DevOps', value: 'both' as PipelineChoice },
        { label: 'GitHub Actions + Azure DevOps + GitLab', value: 'all' as PipelineChoice },
      ],
      { title: 'Generate CI/CD Pipeline for' }
    );
    if (!choice) { return; }

    const scope = await vscode.window.showQuickPick(
      [
        { label: 'Full Automation Account', value: 'full' as DeploymentScope, description: 'All assets + modules + runbooks' },
        { label: 'Automation Account Assets', value: 'assets' as DeploymentScope, description: 'Variables, connections, certificates, and related assets' },
        { label: 'Modules + Runbooks', value: 'modulesRunbooks' as DeploymentScope },
        { label: 'Runbooks', value: 'runbooks' as DeploymentScope },
      ],
      { title: 'Deployment Scope' }
    );
    if (!scope) { return; }

    const rootPath = (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) ?? '';
    if (!rootPath) {
      void vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }

    this.ensurePipelineTemplates();
    const selectedPlatforms = this.resolvePlatforms(choice.value);

    for (const platform of selectedPlatforms) {
      const filePath = this.pipelineFilePath(rootPath, account.accountName, platform);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, this.renderPipeline(platform, account, scope.value), 'utf8');
      this.outputChannel.appendLine(`[cicd] ${this.platformLabel(platform)} (${scope.label}) → ${filePath}`);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filePath));
    }
  }

  private resolvePlatforms(choice: PipelineChoice): PipelinePlatform[] {
    switch (choice) {
      case 'both':
        return ['github', 'azdo'];
      case 'all':
        return ['github', 'azdo', 'gitlab'];
      default:
        return [choice];
    }
  }

  private platformLabel(platform: PipelinePlatform): string {
    switch (platform) {
      case 'github': return 'GitHub Actions';
      case 'azdo': return 'Azure DevOps';
      case 'gitlab': return 'GitLab';
    }
  }

  private pipelineFilePath(rootPath: string, accountName: string, platform: PipelinePlatform): string {
    switch (platform) {
      case 'github':
        return path.join(rootPath, '.github', 'workflows', this.githubWorkflowFileName(accountName));
      case 'azdo':
        return path.join(rootPath, this.azureDevOpsFileName(accountName));
      case 'gitlab':
        return path.join(rootPath, this.gitLabFileName(accountName));
    }
  }

  private githubWorkflowFileName(accountName: string): string {
    return `deploy-runbooks-${sanitizeName(accountName)}.yml`;
  }

  private azureDevOpsFileName(accountName: string): string {
    return `azure-pipelines-${sanitizeName(accountName)}.yml`;
  }

  private gitLabFileName(accountName: string): string {
    return `.gitlab-ci-${sanitizeName(accountName)}.yml`;
  }

  private buildGitHubActionsYaml(account: LinkedAccount, scope: DeploymentScope = 'runbooks'): string {
    return this.renderPipeline('github', account, scope);
  }

  private buildAzureDevOpsYaml(account: LinkedAccount, scope: DeploymentScope = 'runbooks'): string {
    return this.renderPipeline('azdo', account, scope);
  }

  private buildGitLabYaml(account: LinkedAccount, scope: DeploymentScope = 'runbooks'): string {
    return this.renderPipeline('gitlab', account, scope);
  }

  private renderPipeline(platform: PipelinePlatform, account: LinkedAccount, scope: DeploymentScope): string {
    const definition = this.scopeDefinition(account, scope);
    const template = this.readTemplate(platform);
    return template
      .replaceAll('{{DEPLOY_SCOPE_LABEL}}', definition.label)
      .replaceAll('{{ACCOUNT_NAME}}', account.accountName)
      .replaceAll('{{RESOURCE_GROUP}}', account.resourceGroup)
      .replaceAll('{{SUBSCRIPTION_ID}}', account.subscriptionId)
      .replace('{{PATH_FILTERS}}', this.renderIndentedLines(definition.pathFilters, this.pathIndent(platform)))
      .replace('{{DEPLOY_SCRIPT}}', this.renderIndentedLines(this.scriptLines(platform, definition), this.scriptIndent(platform)));
  }

  private readTemplate(platform: PipelinePlatform): string {
    const fileName = platform === 'github'
      ? 'github-actions.yml.template'
      : platform === 'azdo'
        ? 'azure-devops.yml.template'
        : 'gitlab-ci.yml.template';

    const workspaceTemplate = path.join(this.workspace.pipelineTemplatesDir, fileName);
    if (fs.existsSync(workspaceTemplate)) {
      return fs.readFileSync(workspaceTemplate, 'utf8');
    }

    if (this.extensionPath) {
      const builtInTemplate = path.join(this.extensionPath, 'resources', 'pipeline-templates', fileName);
      if (fs.existsSync(builtInTemplate)) {
        return fs.readFileSync(builtInTemplate, 'utf8');
      }
    }

    throw new Error(`Pipeline template not found: ${fileName}`);
  }

  private ensurePipelineTemplates(): void {
    fs.mkdirSync(this.workspace.pipelineTemplatesDir, { recursive: true });
    if (!this.extensionPath) { return; }

    const files = [
      'github-actions.yml.template',
      'azure-devops.yml.template',
      'gitlab-ci.yml.template',
      'automation-assets.bicep',
      'automation-modules.bicep',
      'modules.manifest.json.template',
      'certificates.manifest.json.template',
      'scripts/deploy-runbooks.ps1',
      'scripts/deploy-assets.ps1',
      'scripts/deploy-modules.ps1',
      'scripts/deploy-runbooks.sh',
      'scripts/deploy-assets.py',
      'scripts/deploy-modules.py',
    ];
    for (const fileName of files) {
      const source = path.join(this.extensionPath, 'resources', 'pipeline-templates', fileName);
      const target = path.join(this.workspace.pipelineTemplatesDir, fileName);
      if (!fs.existsSync(source) || fs.existsSync(target)) { continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }

  private pathIndent(platform: PipelinePlatform): number {
    switch (platform) {
      case 'github': return 6;
      case 'azdo': return 6;
      case 'gitlab': return 6;
    }
  }

  private scriptIndent(platform: PipelinePlatform): number {
    switch (platform) {
      case 'github': return 10;
      case 'azdo': return 8;
      case 'gitlab': return 4;
    }
  }

  private renderIndentedLines(lines: string[], spaces: number): string {
    const indent = ' '.repeat(spaces);
    return lines.map(line => `${indent}${line}`).join('\n');
  }

  private scriptLines(platform: PipelinePlatform, definition: ScopeDefinition): string[] {
    switch (platform) {
      case 'github': return definition.githubScript;
      case 'azdo': return definition.azdoScript;
      case 'gitlab': return definition.gitlabScript;
    }
  }

  private scopeDefinition(account: LinkedAccount, scope: DeploymentScope): ScopeDefinition {
    const accountPath = `aaccounts/${account.accountName}`;
    const pipelineRoot = './.settings/mocks/pipelines';
    const runbookFilters = [
      `- '${accountPath}/*.ps1'`,
      `- '${accountPath}/*.py'`,
    ];
    const pipelineFilter = `- '.settings/mocks/pipelines/**'`;
    const assetsFilter = `- 'local.settings.json'`;

    const githubRunbookScript = [
      `& "${pipelineRoot}/scripts/deploy-runbooks.ps1" \\`,
      `  -AccountName $accountName \\`,
      `  -ResourceGroup $resourceGroup \\`,
      `  -SubscriptionId $subscriptionId \\`,
      `  -AccountPath "./${accountPath}"`,
    ];
    const azdoRunbookScript = [
      `& "${pipelineRoot}/scripts/deploy-runbooks.ps1" \``,
      `  -AccountName '$(automationAccountName)' \``,
      `  -ResourceGroup '$(resourceGroup)' \``,
      `  -SubscriptionId '$(subscriptionId)' \``,
      `  -AccountPath "./${accountPath}"`,
    ];
    const gitlabRunbookScript = [
      `- chmod +x "${pipelineRoot}/scripts/deploy-runbooks.sh"`,
      `- "${pipelineRoot}/scripts/deploy-runbooks.sh" "$AUTOMATION_ACCOUNT_NAME" "$RESOURCE_GROUP" "$SUBSCRIPTION_ID" "./${accountPath}"`,
    ];

    const githubModulesScript = [
      `& "${pipelineRoot}/scripts/deploy-modules.ps1" \\`,
      `  -AccountName $accountName \\`,
      `  -ResourceGroup $resourceGroup \\`,
      `  -SubscriptionId $subscriptionId \\`,
      `  -PipelineRoot "${pipelineRoot}"`,
    ];
    const azdoModulesScript = [
      `& "${pipelineRoot}/scripts/deploy-modules.ps1" \``,
      `  -AccountName '$(automationAccountName)' \``,
      `  -ResourceGroup '$(resourceGroup)' \``,
      `  -SubscriptionId '$(subscriptionId)' \``,
      `  -PipelineRoot "${pipelineRoot}"`,
    ];
    const gitlabModulesScript = [
      `- python3 "${pipelineRoot}/scripts/deploy-modules.py" "$AUTOMATION_ACCOUNT_NAME" "$RESOURCE_GROUP" "$SUBSCRIPTION_ID" "${pipelineRoot}"`,
    ];

    const githubAssetsScript = [
      `& "${pipelineRoot}/scripts/deploy-assets.ps1" \\`,
      `  -AccountName $accountName \\`,
      `  -ResourceGroup $resourceGroup \\`,
      `  -SubscriptionId $subscriptionId \\`,
      `  -PipelineRoot "${pipelineRoot}" \\`,
      `  -LocalSettingsPath "./local.settings.json"`,
    ];
    const azdoAssetsScript = [
      `& "${pipelineRoot}/scripts/deploy-assets.ps1" \``,
      `  -AccountName '$(automationAccountName)' \``,
      `  -ResourceGroup '$(resourceGroup)' \``,
      `  -SubscriptionId '$(subscriptionId)' \``,
      `  -PipelineRoot "${pipelineRoot}" \``,
      `  -LocalSettingsPath "./local.settings.json"`,
    ];
    const gitlabAssetsScript = [
      `- python3 "${pipelineRoot}/scripts/deploy-assets.py" "$AUTOMATION_ACCOUNT_NAME" "$RESOURCE_GROUP" "$SUBSCRIPTION_ID" "${pipelineRoot}" "./local.settings.json"`,
    ];

    switch (scope) {
      case 'full':
        return {
          label: 'Full Automation Account',
          pathFilters: [...runbookFilters, pipelineFilter, assetsFilter],
          githubScript: [...githubRunbookScript, '', ...githubModulesScript, '', ...githubAssetsScript],
          azdoScript: [...azdoRunbookScript, '', ...azdoModulesScript, '', ...azdoAssetsScript],
          gitlabScript: [...gitlabRunbookScript, ...gitlabModulesScript, ...gitlabAssetsScript],
        };
      case 'assets':
        return {
          label: 'Automation Account Assets',
          pathFilters: [assetsFilter, pipelineFilter],
          githubScript: githubAssetsScript,
          azdoScript: azdoAssetsScript,
          gitlabScript: gitlabAssetsScript,
        };
      case 'modulesRunbooks':
        return {
          label: 'Modules + Runbooks',
          pathFilters: [...runbookFilters, pipelineFilter],
          githubScript: [...githubRunbookScript, '', ...githubModulesScript],
          azdoScript: [...azdoRunbookScript, '', ...azdoModulesScript],
          gitlabScript: [...gitlabRunbookScript, ...gitlabModulesScript],
        };
      case 'runbooks':
      default:
        return {
          label: 'Runbooks',
          pathFilters: runbookFilters,
          githubScript: githubRunbookScript,
          azdoScript: azdoRunbookScript,
          gitlabScript: gitlabRunbookScript,
        };
    }
  }
}

export type { CiCdGeneratorPrivate, DeploymentScope };
