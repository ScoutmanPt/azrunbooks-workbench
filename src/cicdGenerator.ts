import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { sanitizeName, type LinkedAccount, type WorkspaceManager } from './workspaceManager';
import type { AzureService } from './azureService';

// ── Minimal ZIP writer (DEFLATE, no external deps) ───────────────────────────
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
    t[i] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) { crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8); }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function collectZipEntries(dir: string, prefix = ''): Array<{ name: string; data: Buffer }> {
  const entries: Array<{ name: string; data: Buffer }> = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryName = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      entries.push(...collectZipEntries(path.join(dir, item.name), entryName));
    } else {
      entries.push({ name: entryName, data: fs.readFileSync(path.join(dir, item.name)) });
    }
  }
  return entries;
}

function writeZipArchive(sourceDir: string, destZip: string): void {
  const entries = collectZipEntries(sourceDir);
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.data, { level: 6 });
    const checksum = crc32(entry.data);

    const lh = Buffer.alloc(30 + nameBytes.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(checksum, 14); lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(entry.data.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26); lh.writeUInt16LE(0, 28);
    nameBytes.copy(lh, 30);
    localParts.push(lh, compressed);

    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(checksum, 16); cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBytes.copy(cd, 46);
    cdParts.push(cd);

    offset += lh.length + compressed.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(destZip, Buffer.concat([...localParts, cdBuf, eocd]));
}

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
    private readonly extensionPath?: string,
    private readonly version: string = 'unknown'
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
      ],
      { title: 'Generate CI/CD Pipeline for' }
    );
    if (!choice) { return; }

    const scope = await vscode.window.showQuickPick(
      [
        { label: 'Full Automation Account', value: 'full' as DeploymentScope, description: 'Provision account (Bicep) + deploy modules, runbooks, and assets (PowerShell)' },
      ],
      { title: 'Deployment Scope' }
    );
    if (!scope) { return; }

    const rootPath = (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) ?? '';
    if (!rootPath) {
      void vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }

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

  private pipelinesDir(rootPath: string, accountName: string): string {
    return path.join(rootPath, 'aaccounts', accountName, 'pipelines');
  }

  private pipelineFilePath(rootPath: string, accountName: string, platform: PipelinePlatform): string {
    switch (platform) {
      case 'github': return path.join(rootPath, '.github', 'workflows', this.githubWorkflowFileName(accountName));
      case 'azdo':   return path.join(rootPath, this.azureDevOpsFileName(accountName));
      case 'gitlab': return path.join(rootPath, this.gitLabFileName(accountName));
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

  private pipelineFileHeader(commentChar: string): string {
    const sep = `${commentChar} ${'='.repeat(63)}`;
    return [
      sep,
      `${commentChar} Azure Runbooks Workbench v${this.version} by @scoutmanpt`,
      `${commentChar} https://www.pdragon.co`,
      `${commentChar} Generated: ${new Date().toISOString().slice(0, 10)}`,
      sep,
      '',
    ].join('\n');
  }

  private renderPipeline(platform: PipelinePlatform, account: LinkedAccount, scope: DeploymentScope): string {
    const definition = this.scopeDefinition(account, scope);
    const template = this.readTemplate(platform);
    const rendered = template
      .replaceAll('{{DEPLOY_SCOPE_LABEL}}', definition.label)
      .replaceAll('{{ACCOUNT_NAME}}', account.accountName)
      .replaceAll('{{RESOURCE_GROUP}}', account.resourceGroup)
      .replaceAll('{{SUBSCRIPTION_ID}}', account.subscriptionId)
      .replace('{{PATH_FILTERS}}', this.renderIndentedLines(definition.pathFilters, this.pathIndent(platform)))
      .replace('{{DEPLOY_SCRIPT}}', this.renderIndentedLines(this.scriptLines(platform, definition), this.scriptIndent(platform)));
    return this.pipelineFileHeader('#') + rendered;
  }

  private readTemplate(platform: PipelinePlatform): string {
    const fileName = platform === 'github'
      ? 'github-actions.yml.template'
      : platform === 'azdo'
        ? 'azure-devops.yml.template'
        : 'gitlab-ci.yml.template';

    // Always use the built-in template so extension updates are reflected immediately.
    if (this.extensionPath) {
      const builtInTemplate = path.join(this.extensionPath, 'resources', 'pipeline-templates', 'yml', fileName);
      if (fs.existsSync(builtInTemplate)) {
        return fs.readFileSync(builtInTemplate, 'utf8');
      }
    }

    throw new Error(`Pipeline template not found: ${fileName}`);
  }

  private copyDeployAssets(rootPath: string, accountName: string): void {
    if (!this.extensionPath) { return; }
    const sourceDir = path.join(this.extensionPath, 'resources', 'pipeline-templates');
    const targetDir = this.pipelinesDir(rootPath, accountName);

    // Scripts → pipelines/scripts/
    const scriptsDir = path.join(targetDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scripts: Array<{ src: string }> = [
      { src: 'scripts/deploy.ps1' },
      { src: 'scripts/deploy-runbooks.ps1' },
      { src: 'scripts/deploy-assets.ps1' },
      { src: 'scripts/deploy-modules.ps1' },
      { src: 'scripts/deploy-schedules.ps1' },
      { src: 'scripts/deploy-infrastructure.ps1' },
    ];
    // Scripts are always overwritten so extension updates are picked up automatically.
    for (const { src } of scripts) {
      const source = path.join(sourceDir, src);
      const target = path.join(scriptsDir, path.basename(src));
      if (!fs.existsSync(source)) { continue; }
      const content = this.pipelineFileHeader('#') + fs.readFileSync(source, 'utf8');
      fs.writeFileSync(target, content, 'utf8');
    }

    // Bicep — also always overwritten (infrastructure template, not user data).
    const bicepsDir = path.join(targetDir, 'biceps');
    fs.mkdirSync(bicepsDir, { recursive: true });
    const bicepSrc = path.join(sourceDir, 'bicep/automation-account.bicep');
    const bicepTgt = path.join(bicepsDir, 'automation-account.bicep');
    if (fs.existsSync(bicepSrc)) {
      const content = this.pipelineFileHeader('//') + fs.readFileSync(bicepSrc, 'utf8');
      fs.writeFileSync(bicepTgt, content, 'utf8');
    }

    // jsons/ — certificates starter is write-once; modules manifest is regenerated with local modules.
    const jsonsDir = path.join(targetDir, 'jsons');
    fs.mkdirSync(jsonsDir, { recursive: true });

    const certSrc = path.join(sourceDir, 'certificates.manifest.json.template');
    const certTgt = path.join(jsonsDir, `certificates.${accountName}.json`);
    if (fs.existsSync(certSrc) && !fs.existsSync(certTgt)) {
      fs.copyFileSync(certSrc, certTgt);
    }

    this.bundleLocalModules(accountName, targetDir, jsonsDir, sourceDir);

    this.outputChannel.appendLine(`[cicd] deploy assets → aaccounts/${accountName}/pipelines/{scripts,biceps,jsons,modules}/`);
  }

  private bundleLocalModules(accountName: string, pipelinesDir: string, jsonsDir: string, sourceDir: string): void {
    const localModulesDir = this.workspace.localModulesDir;
    const modulesOutDir   = path.join(pipelinesDir, 'modules');
    const manifestPath    = path.join(jsonsDir, `modules.${accountName}.json`);

    // Collect local modules: .settings/cache/modules/<Name>/<Version>/
    const localEntries: Array<{ name: string; zipPath: string }> = [];
    if (fs.existsSync(localModulesDir)) {
      for (const modName of fs.readdirSync(localModulesDir)) {
        const modDir = path.join(localModulesDir, modName);
        if (!fs.statSync(modDir).isDirectory()) { continue; }

        // Pick latest version folder
        const versions = fs.readdirSync(modDir, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name)
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
        if (versions.length === 0) { continue; }

        const versionDir = path.join(modDir, versions[0]);
        fs.mkdirSync(modulesOutDir, { recursive: true });
        const zipPath = path.join(modulesOutDir, `${modName}.zip`);
        writeZipArchive(versionDir, zipPath);
        localEntries.push({ name: modName, zipPath: `aaccounts/${accountName}/pipelines/modules/${modName}.zip` });
        this.outputChannel.appendLine(`[cicd] local module zipped → pipelines/modules/${modName}.zip`);
      }
    }

    // Read or seed the modules manifest
    let manifest: { modules: Array<Record<string, unknown>> } = { modules: [] };
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as typeof manifest;
        if (!Array.isArray(manifest.modules)) { manifest.modules = []; }
      } catch { manifest = { modules: [] }; }
    } else {
      // Seed with the gallery starter from the template
      const templateSrc = path.join(sourceDir, 'modules.manifest.json.template');
      if (fs.existsSync(templateSrc)) {
        try {
          const tpl = JSON.parse(fs.readFileSync(templateSrc, 'utf8')) as typeof manifest;
          manifest.modules = (tpl.modules ?? []).filter((m: Record<string, unknown>) => m['uri']);
        } catch { /* use empty */ }
      }
    }

    // Remove stale localPath entries (regenerated from cache every time)
    manifest.modules = manifest.modules.filter((m: Record<string, unknown>) => !m['localPath']);

    // Add current local module entries
    for (const entry of localEntries) {
      manifest.modules.push({ name: entry.name, localPath: entry.zipPath });
    }

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
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
    const runbookFilters = [
      `- '${accountPath}/*.ps1'`,
      `- '${accountPath}/*.py'`,
    ];
    const pipelineFilter = `- '${accountPath}/pipelines/**'`;
    const assetsFilter   = `- 'local.settings.json'`;

    const deployScript = `./${accountPath}/pipelines/scripts/deploy.ps1`;

    const githubScript = [
      `& "${deployScript}" \``,
      `  -AccountName    $accountName \``,
      `  -ResourceGroup  $resourceGroup \``,
      `  -SubscriptionId $subscriptionId`,
    ];
    const azdoScript = [
      `& "${deployScript}" \``,
      `  -AccountName    $accountName \``,
      `  -ResourceGroup  $resourceGroup \``,
      `  -SubscriptionId $subscriptionId`,
    ];
    const gitlabScript = [
      `- pwsh -File "${deployScript}" -AccountName "$AUTOMATION_ACCOUNT_NAME" -ResourceGroup "$RESOURCE_GROUP" -SubscriptionId "$SUBSCRIPTION_ID"`,
    ];

    switch (scope) {
      case 'full':
      default:
        return {
          label: 'Full Automation Account',
          pathFilters: [...runbookFilters, pipelineFilter, assetsFilter],
          githubScript,
          azdoScript,
          gitlabScript,
        };
    }
  }

  private async exportSchedulesManifest(rootPath: string, account: LinkedAccount): Promise<void> {
    const targetDir = path.join(this.pipelinesDir(rootPath, account.accountName), 'jsons');
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
