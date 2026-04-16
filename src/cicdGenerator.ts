import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { sanitizeName, type LinkedAccount, type WorkspaceManager } from './workspaceManager';
import type { AzureService } from './azureService';

type PipelinePlatform = 'github' | 'azdo' | 'gitlab';
type PipelineChoice = PipelinePlatform | 'both' | 'all';
type DeploymentScope = 'full' | 'infrastructure' | 'assets' | 'modulesRunbooks' | 'runbooks';

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
    private readonly azure: AzureService,
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
        { label: 'GitLab', value: 'gitlab' as PipelineChoice },
        { label: 'GitHub Actions + Azure DevOps', value: 'both' as PipelineChoice },
        { label: 'GitHub Actions + Azure DevOps + GitLab', value: 'all' as PipelineChoice },
      ],
      { title: 'Generate CI/CD Pipeline for' }
    );
    if (!choice) { return; }

    const scope = await vscode.window.showQuickPick(
      [
        { label: 'Full Automation Account', value: 'full' as DeploymentScope, description: 'Provision account (Bicep) + deploy modules, runbooks, and assets (PowerShell)' },
        { label: 'Automation Account Infrastructure', value: 'infrastructure' as DeploymentScope, description: 'Provision the Automation Account via Bicep only' },
        { label: 'Automation Account Assets', value: 'assets' as DeploymentScope, description: 'Variables, credentials, connections, and certificates' },
        { label: 'Modules + Runbooks', value: 'modulesRunbooks' as DeploymentScope, description: 'Import modules then upload and publish runbooks' },
        { label: 'Runbooks', value: 'runbooks' as DeploymentScope, description: 'Upload and publish runbook scripts only' },
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
    this.copyDeployAssets(rootPath, account.accountName);
    await this.exportSchedulesManifest(rootPath, account);
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

    const workspaceTemplate = path.join(this.workspace.pipelineTemplatesDir, 'yml', fileName);
    if (fs.existsSync(workspaceTemplate)) {
      return fs.readFileSync(workspaceTemplate, 'utf8');
    }

    if (this.extensionPath) {
      const builtInTemplate = path.join(this.extensionPath, 'resources', 'pipeline-templates', 'yml', fileName);
      if (fs.existsSync(builtInTemplate)) {
        return fs.readFileSync(builtInTemplate, 'utf8');
      }
    }

    throw new Error(`Pipeline template not found: ${fileName}`);
  }

  private ensurePipelineTemplates(): void {
    if (!this.extensionPath) { return; }
    // Only copy yml templates — used by readTemplate() and customisable by the user.
    for (const fileName of ['yml/github-actions.yml.template', 'yml/azure-devops.yml.template', 'yml/gitlab-ci.yml.template']) {
      const source = path.join(this.extensionPath, 'resources', 'pipeline-templates', fileName);
      const target = path.join(this.workspace.pipelineTemplatesDir, fileName);
      if (!fs.existsSync(source) || fs.existsSync(target)) { continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }

  private copyDeployAssets(rootPath: string, accountName: string): void {
    if (!this.extensionPath) { return; }
    const sourceDir = path.join(this.extensionPath, 'resources', 'pipeline-templates');
    const targetDir = path.join(rootPath, '.pipelines', accountName);

    const scripts = [
      'scripts/deploy-runbooks.ps1',
      'scripts/deploy-assets.ps1',
      'scripts/deploy-modules.ps1',
      'scripts/deploy-schedules.ps1',
      'scripts/deploy-infrastructure.ps1',
      'bicep/automation-account.bicep',
    ];
    for (const fileName of scripts) {
      const source = path.join(sourceDir, fileName);
      const target = path.join(targetDir, fileName);
      if (!fs.existsSync(source) || fs.existsSync(target)) { continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }

    // Manifest starters — only written once so the user can customise them.
    const manifests: Array<{ src: string; dst: string }> = [
      { src: 'modules.manifest.json.template',      dst: `modules.${accountName}.json` },
      { src: 'certificates.manifest.json.template', dst: `certificates.${accountName}.json` },
    ];
    for (const { src, dst } of manifests) {
      const source = path.join(sourceDir, src);
      const target = path.join(targetDir, dst);
      if (!fs.existsSync(source) || fs.existsSync(target)) { continue; }
      fs.copyFileSync(source, target);
    }

    this.outputChannel.appendLine(`[cicd] deploy assets → .pipelines/${accountName}/`);
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
    const accountPath   = `aaccounts/${account.accountName}`;
    const pipelineRoot  = `./.pipelines/${account.accountName}`;
    const runbookFilters = [
      `- '${accountPath}/*.ps1'`,
      `- '${accountPath}/*.py'`,
    ];
    const pipelineFilter = `- '.settings/mocks/pipelines/**'`;
    const assetsFilter   = `- 'local.settings.json'`;

    // ── Runbooks ──────────────────────────────────────────────────────────────
    const githubRunbookScript = [
      `& "${pipelineRoot}/scripts/deploy-runbooks.ps1" \``,
      `  -AccountName $accountName \``,
      `  -ResourceGroup $resourceGroup \``,
      `  -SubscriptionId $subscriptionId \``,
      `  -AccountPath "./aaccounts/$accountName"`,
    ];
    const azdoRunbookScript = [
      `& "${pipelineRoot}/scripts/deploy-runbooks.ps1" \``,
      `  -AccountName '$(automationAccountName)' \``,
      `  -ResourceGroup '$(resourceGroup)' \``,
      `  -SubscriptionId '$(subscriptionId)' \``,
      `  -AccountPath "./aaccounts/$(automationAccountName)"`,
    ];
    const gitlabRunbookScript = [
      `- pwsh -File "${pipelineRoot}/scripts/deploy-runbooks.ps1" -AccountName "$AUTOMATION_ACCOUNT_NAME" -ResourceGroup "$RESOURCE_GROUP" -SubscriptionId "$SUBSCRIPTION_ID" -AccountPath "./aaccounts/$AUTOMATION_ACCOUNT_NAME"`,
    ];

    // ── Modules ───────────────────────────────────────────────────────────────
    const githubModulesScript = [
      `& "${pipelineRoot}/scripts/deploy-modules.ps1" \``,
      `  -AccountName $accountName \``,
      `  -ResourceGroup $resourceGroup \``,
      `  -SubscriptionId $subscriptionId \``,
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
      `- pwsh -File "${pipelineRoot}/scripts/deploy-modules.ps1" -AccountName "$AUTOMATION_ACCOUNT_NAME" -ResourceGroup "$RESOURCE_GROUP" -SubscriptionId "$SUBSCRIPTION_ID" -PipelineRoot "${pipelineRoot}"`,
    ];

    // ── Assets ────────────────────────────────────────────────────────────────
    const githubAssetsScript = [
      `& "${pipelineRoot}/scripts/deploy-assets.ps1" \``,
      `  -AccountName $accountName \``,
      `  -ResourceGroup $resourceGroup \``,
      `  -SubscriptionId $subscriptionId \``,
      `  -LocalSettingsPath "./local.settings.json" \``,
      `  -PipelineRoot "${pipelineRoot}"`,
    ];
    const azdoAssetsScript = [
      `& "${pipelineRoot}/scripts/deploy-assets.ps1" \``,
      `  -AccountName '$(automationAccountName)' \``,
      `  -ResourceGroup '$(resourceGroup)' \``,
      `  -SubscriptionId '$(subscriptionId)' \``,
      `  -LocalSettingsPath "./local.settings.json" \``,
      `  -PipelineRoot "${pipelineRoot}"`,
    ];
    const gitlabAssetsScript = [
      `- pwsh -File "${pipelineRoot}/scripts/deploy-assets.ps1" -AccountName "$AUTOMATION_ACCOUNT_NAME" -ResourceGroup "$RESOURCE_GROUP" -SubscriptionId "$SUBSCRIPTION_ID" -LocalSettingsPath "./local.settings.json" -PipelineRoot "${pipelineRoot}"`,
    ];

    // ── Schedules ─────────────────────────────────────────────────────────────
    const githubSchedulesScript = [
      `& "${pipelineRoot}/scripts/deploy-schedules.ps1" \``,
      `  -AccountName $accountName \``,
      `  -ResourceGroup $resourceGroup \``,
      `  -SubscriptionId $subscriptionId \``,
      `  -PipelineRoot "${pipelineRoot}"`,
    ];
    const azdoSchedulesScript = [
      `& "${pipelineRoot}/scripts/deploy-schedules.ps1" \``,
      `  -AccountName '$(automationAccountName)' \``,
      `  -ResourceGroup '$(resourceGroup)' \``,
      `  -SubscriptionId '$(subscriptionId)' \``,
      `  -PipelineRoot "${pipelineRoot}"`,
    ];
    const gitlabSchedulesScript = [
      `- pwsh -File "${pipelineRoot}/scripts/deploy-schedules.ps1" -AccountName "$AUTOMATION_ACCOUNT_NAME" -ResourceGroup "$RESOURCE_GROUP" -SubscriptionId "$SUBSCRIPTION_ID" -PipelineRoot "${pipelineRoot}"`,
    ];

    // ── Infrastructure (Bicep) ────────────────────────────────────────────────
    const githubInfraScript = [
      `& "${pipelineRoot}/scripts/deploy-infrastructure.ps1" \``,
      `  -AccountName $accountName \``,
      `  -ResourceGroup $resourceGroup \``,
      `  -SubscriptionId $subscriptionId \``,
      `  -PipelineRoot "${pipelineRoot}"`,
    ];
    const azdoInfraScript = [
      `& "${pipelineRoot}/scripts/deploy-infrastructure.ps1" \``,
      `  -AccountName '$(automationAccountName)' \``,
      `  -ResourceGroup '$(resourceGroup)' \``,
      `  -SubscriptionId '$(subscriptionId)' \``,
      `  -PipelineRoot "${pipelineRoot}"`,
    ];
    const gitlabInfraScript = [
      `- pwsh -File "${pipelineRoot}/scripts/deploy-infrastructure.ps1" -AccountName "$AUTOMATION_ACCOUNT_NAME" -ResourceGroup "$RESOURCE_GROUP" -SubscriptionId "$SUBSCRIPTION_ID" -PipelineRoot "${pipelineRoot}"`,
    ];

    switch (scope) {
      case 'full':
        return {
          label: 'Full Automation Account',
          pathFilters: [...runbookFilters, pipelineFilter, assetsFilter],
          githubScript: [
            ...githubInfraScript,     '',
            ...githubModulesScript,   '',
            ...githubRunbookScript,   '',
            ...githubAssetsScript,    '',
            ...githubSchedulesScript,
          ],
          azdoScript: [
            ...azdoInfraScript,     '',
            ...azdoModulesScript,   '',
            ...azdoRunbookScript,   '',
            ...azdoAssetsScript,    '',
            ...azdoSchedulesScript,
          ],
          gitlabScript: [
            ...gitlabInfraScript,
            ...gitlabModulesScript,
            ...gitlabRunbookScript,
            ...gitlabAssetsScript,
            ...gitlabSchedulesScript,
          ],
        };

      case 'infrastructure':
        return {
          label: 'Automation Account Infrastructure',
          pathFilters: [pipelineFilter],
          githubScript: githubInfraScript,
          azdoScript: azdoInfraScript,
          gitlabScript: gitlabInfraScript,
        };

      case 'assets':
        return {
          label: 'Automation Account Assets',
          pathFilters: [assetsFilter, pipelineFilter],
          githubScript: [...githubAssetsScript, '', ...githubSchedulesScript],
          azdoScript:   [...azdoAssetsScript,   '', ...azdoSchedulesScript],
          gitlabScript: [...gitlabAssetsScript,     ...gitlabSchedulesScript],
        };

      case 'modulesRunbooks':
        return {
          label: 'Modules + Runbooks',
          pathFilters: [...runbookFilters, pipelineFilter],
          githubScript: [...githubModulesScript, '', ...githubRunbookScript],
          azdoScript:   [...azdoModulesScript,   '', ...azdoRunbookScript],
          gitlabScript: [...gitlabModulesScript,     ...gitlabRunbookScript],
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

  private async exportSchedulesManifest(rootPath: string, account: LinkedAccount): Promise<void> {
    const targetDir = path.join(rootPath, '.pipelines', account.accountName);
    const targetFile = path.join(targetDir, `schedules.${account.accountName}.json`);

    try {
      const [schedules, jobSchedules] = await Promise.all([
        this.azure.listSchedules(account.subscriptionId, account.resourceGroup, account.accountName),
        this.azure.listJobSchedules(account.subscriptionId, account.resourceGroup, account.accountName),
      ]);

      const manifest = {
        schedules: schedules.map(s => {
          const entry: Record<string, unknown> = {
            name: s.name,
            frequency: s.frequency,
            startTime: s.startTime,
            isEnabled: s.isEnabled,
            timeZone: s.timeZone ?? 'UTC',
          };
          if (s.interval)          { entry.interval          = s.interval; }
          if (s.expiryTime)        { entry.expiryTime        = s.expiryTime; }
          if (s.description)       { entry.description       = s.description; }
          if (s.advancedSchedule)  { entry.advancedSchedule  = s.advancedSchedule; }
          return entry;
        }),
        jobSchedules: jobSchedules.map(js => {
          const entry: Record<string, unknown> = {
            scheduleName: js.scheduleName,
            runbookName:  js.runbookName,
          };
          if (js.runOn)      { entry.runOn      = js.runOn; }
          if (js.parameters) { entry.parameters = js.parameters; }
          return entry;
        }),
      };

      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetFile, JSON.stringify(manifest, null, 2), 'utf8');
      this.outputChannel.appendLine(`[cicd] schedules exported → ${targetFile} (${schedules.length} schedules, ${jobSchedules.length} links)`);
    } catch (e) {
      this.outputChannel.appendLine(`[cicd] schedule export failed: ${e instanceof Error ? e.message : String(e)}`);
      void vscode.window.showWarningMessage(`Could not export schedules: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export type { DeploymentScope };
