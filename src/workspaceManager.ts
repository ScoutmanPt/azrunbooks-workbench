import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface LocalSettings {
  accountName: string;
  IsEncrypted: boolean;
  Assets: {
    Variables: Record<string, string>;
    Credentials: Record<string, { Username: string; Password: string }>;
    Connections: Record<string, Record<string, string>>;
    Certificates: Record<string, Record<string, string>>;
  };
}

export interface LocalSettingsFile {
  PnPAppId: string;
  aaccounts: LocalSettings[];
}

export interface LinkedAccount {
  accountName: string;
  resourceGroup: string;
  subscriptionId: string;
  subscriptionName: string;
  location?: string;
  linkedAt?: string;
  runbooks?: Record<string, string | RunbookMetadata>;
  sync?: Record<string, string>;
}

export interface RunbookMetadata {
  runbookType: string;
  runtimeEnvironment?: string;
}

export interface WorkspaceRunbookFile {
  accountName: string;
  runbookName: string;
  filePath: string;
  runbookType: string;
  runtimeEnvironment?: string;
  localHash: string;
  subfolder?: string;       // 'Published' | 'Draft' | undefined (root)
  deployedHash?: string;
  linkedTwin?: boolean;     // true when Published + Draft exist with identical content
}

function defaultSettings(accountName: string): LocalSettings {
  return {
    accountName,
    IsEncrypted: false,
    Assets: { Variables: {}, Credentials: {}, Connections: {}, Certificates: {} },
  };
}

function defaultLocalSettingsFile(): LocalSettingsFile {
  return {
    PnPAppId: '',
    aaccounts: [],
  };
}

/**
 * WorkspaceManager handles all file I/O for the runbook project structure:
 *
 *   <root>/
 *     .settings/
 *       aaccounts.json        ← array of linked automation accounts
 *       mocks/                ← seeded mock templates for local run/debug
 *       tmp/
 *         <accountName>/
 *           generated/        ← rendered local mock files for local run/debug
 *       cache/
 *         workspace-cache/
 *         modules/
 *     aaccounts/
 *       <accountName>/          ← one folder per linked account (colored icon)
 *         MyRunbook.ps1
 *         MyPythonRunbook.py
 *         Published/            ← optional legacy/local variants still supported
 *         Draft/
 *     local.settings.json       ← global settings + per-account asset mocks
 */
export class WorkspaceManager {
  private readonly rootPath: string;
  private readonly extensionPath?: string;

  constructor(extensionPath?: string) {
    this.extensionPath = extensionPath;
    const config = vscode.workspace.getConfiguration('runbookWorkbench');
    const override = config.get<string>('workspacePath');
    if (override && override.trim()) {
      this.rootPath = override.trim();
    } else {
      const folders = vscode.workspace.workspaceFolders;
      this.rootPath = folders?.[0]?.uri.fsPath ?? '';
    }

    if (this.rootPath) {
      this.migrateLegacyAccountFile();
      this.migrateLegacyCacheDir();
      this.migrateLegacyMockTemplates();
      this.migrateLegacyGeneratedMocks();
      this.migrateLegacyRunbookFolders();
    }
  }

  get isWorkspaceOpen(): boolean {
    return Boolean(this.rootPath);
  }

  /** Root folder for all accounts: <workspace>/aaccounts/ */
  get accountsDir(): string {
    return path.join(this.rootPath, 'aaccounts');
  }

  /** The account's root folder: <workspace>/aaccounts/<accountName>/ */
  accountDirForAccount(accountName: string): string {
    return path.join(this.accountsDir, accountName);
  }

  /** Runbooks now live directly inside the account folder: <workspace>/aaccounts/<accountName>/ */
  runbooksDirForAccount(accountName: string): string {
    return this.accountDirForAccount(accountName);
  }

  private get workbenchDir(): string {
    return path.join(this.rootPath, '.rb-workb');
  }

  private get studioDir(): string {
    return path.join(this.settingsDir, 'cache');
  }

  private get settingsDir(): string {
    return path.join(this.rootPath, '.settings');
  }

  private get accountFilePath(): string {
    return path.join(this.settingsDir, 'aaccounts.json');
  }

  private get legacyAccountFilePaths(): string[] {
    return [
      path.join(this.workbenchDir, 'aaccounts.json'),
      path.join(this.rootPath, 'aaccounts.json'),
      path.join(this.accountsDir, '.settings', 'aaccounts.json'),
    ];
  }

  get localSettingsPath(): string {
    return path.join(this.rootPath, 'local.settings.json');
  }

  get runbookWorkbenchDir(): string {
    return this.workbenchDir;
  }

  get mocksDir(): string {
    return path.join(this.accountsDir, 'mocks');
  }

  get mockTemplatesDir(): string {
    return path.join(this.settingsDir, 'mocks');
  }

  get pipelineTemplatesDir(): string {
    return path.join(this.mockTemplatesDir, 'pipelines');
  }

  get tempArtifactsRootDir(): string {
    return path.join(this.settingsDir, 'tmp');
  }

  get localModulesDir(): string {
    return path.join(this.studioDir, 'modules');
  }

  get workspaceCacheDir(): string {
    return path.join(this.studioDir, 'workspace-cache');
  }

  ensureAccountFolder(accountName: string): string {
    const accountDir = this.accountDirForAccount(accountName);
    fs.mkdirSync(accountDir, { recursive: true });
    return accountDir;
  }

  tempArtifactsDirForAccount(accountName: string): string {
    return path.join(this.tempArtifactsRootDir, accountName);
  }

  generatedMocksDirForAccount(accountName: string): string {
    return path.join(this.tempArtifactsDirForAccount(accountName), 'generated');
  }

  mockGeneratedDir(accountName: string, runbookName: string): string {
    return path.join(this.generatedMocksDirForAccount(accountName), runbookName);
  }

  private migrateLegacyMockTemplates(): void {
    const legacyDirs = [
      path.join(this.accountsDir, '.mocks'),
      path.join(this.workbenchDir, 'mocks'),
      path.join(this.mocksDir, 'templates'),
      path.join(this.mocksDir, '.mocks'),
      path.join(this.accountsDir, '.settings', 'mocks'),
    ].filter(dir => fs.existsSync(dir) && fs.statSync(dir).isDirectory());

    if (!legacyDirs.length) { return; }

    fs.mkdirSync(this.mockTemplatesDir, { recursive: true });
    for (const legacyDir of legacyDirs) {
      for (const name of fs.readdirSync(legacyDir)) {
        const source = path.join(legacyDir, name);
        const target = path.join(this.mockTemplatesDir, name);
        if (!fs.existsSync(target)) {
          copyPathRecursive(source, target);
        }
      }
    }

    for (const legacyDir of legacyDirs) {
      try {
        fs.rmSync(legacyDir, { recursive: true, force: true });
      } catch {
        // Best effort only; leaving the old folder behind is less harmful than failing init.
      }
    }
  }

  private migrateLegacyGeneratedMocks(): void {
    const legacyDirs = [
      path.join(this.mocksDir, 'generated'),
      path.join(this.settingsDir, 'generated'),
      path.join(this.accountsDir, '.settings', 'generated'),
    ].filter(dir => fs.existsSync(dir) && fs.statSync(dir).isDirectory());

    for (const legacyDir of legacyDirs) {
      for (const accountName of fs.readdirSync(legacyDir)) {
        const source = path.join(legacyDir, accountName);
        const target = this.generatedMocksDirForAccount(accountName);
        if (!fs.existsSync(target)) {
          fs.mkdirSync(this.tempArtifactsDirForAccount(accountName), { recursive: true });
          copyPathRecursive(source, target);
        }
      }

      try {
        fs.rmSync(legacyDir, { recursive: true, force: true });
      } catch {
        // Best effort only; preserving the new path matters more than old cleanup.
      }
    }

    if (!fs.existsSync(this.accountsDir)) { return; }
    for (const entry of fs.readdirSync(this.accountsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) { continue; }
      const legacyDir = path.join(this.accountDirForAccount(entry.name), '.settings', 'generated');
      if (!fs.existsSync(legacyDir) || !fs.statSync(legacyDir).isDirectory()) { continue; }
      const target = this.generatedMocksDirForAccount(entry.name);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(this.tempArtifactsDirForAccount(entry.name), { recursive: true });
        copyPathRecursive(legacyDir, target);
      }
      try {
        fs.rmSync(legacyDir, { recursive: true, force: true });
      } catch {
        // Best effort only; preserving the new path matters more than old cleanup.
      }
    }

    for (const entry of fs.readdirSync(this.accountsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) { continue; }
      const legacyTempDir = path.join(this.accountDirForAccount(entry.name), 'tmp');
      if (!fs.existsSync(legacyTempDir) || !fs.statSync(legacyTempDir).isDirectory()) { continue; }
      const target = this.tempArtifactsDirForAccount(entry.name);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        copyPathRecursive(legacyTempDir, target);
      }
      try {
        fs.rmSync(legacyTempDir, { recursive: true, force: true });
      } catch {
        // Best effort only; preserving the new path matters more than old cleanup.
      }
    }

    const legacyTempDir = path.join(this.mocksDir, 'tmp');
    if (fs.existsSync(legacyTempDir) && fs.statSync(legacyTempDir).isDirectory()) {
      try {
        fs.rmSync(legacyTempDir, { recursive: true, force: true });
      } catch {
        // Temporary scratch content is disposable; ignore cleanup failures.
      }
    }
  }

  private migrateLegacyAccountFile(): void {
    if (fs.existsSync(this.accountFilePath)) { return; }

    for (const legacyPath of this.legacyAccountFilePaths) {
      if (!fs.existsSync(legacyPath)) { continue; }
      fs.mkdirSync(this.settingsDir, { recursive: true });
      fs.copyFileSync(legacyPath, this.accountFilePath);
      try {
        fs.rmSync(legacyPath, { force: true });
      } catch {
        // Best effort only; preserving the new canonical file is the priority.
      }
      return;
    }
  }

  private migrateLegacyCacheDir(): void {
    const legacyDirs = [
      path.join(this.workbenchDir, 'cache'),
      path.join(this.accountsDir, '.settings', 'cache'),
    ];

    for (const legacyDir of legacyDirs) {
      if (!fs.existsSync(legacyDir) || !fs.statSync(legacyDir).isDirectory()) { continue; }
      if (!fs.existsSync(this.studioDir)) {
        fs.mkdirSync(this.settingsDir, { recursive: true });
        fs.cpSync(legacyDir, this.studioDir, { recursive: true });
      }
      try {
        fs.rmSync(legacyDir, { recursive: true, force: true });
      } catch {
        // Best effort only; the migrated cache is the important part.
      }
    }
  }

  private migrateLegacyRunbookFolders(): void {
    if (!fs.existsSync(this.accountsDir)) { return; }

    for (const name of fs.readdirSync(this.accountsDir)) {
      if (name === '.settings' || name === 'mocks') { continue; }
      const accountDir = this.accountDirForAccount(name);
      const legacyRunbooksDir = path.join(accountDir, 'Runbooks');
      if (!fs.existsSync(legacyRunbooksDir)) { continue; }
      if (!fs.statSync(legacyRunbooksDir).isDirectory()) { continue; }

      for (const child of fs.readdirSync(legacyRunbooksDir)) {
        const source = path.join(legacyRunbooksDir, child);
        const target = path.join(accountDir, child);
        if (fs.existsSync(target)) { continue; }
        fs.renameSync(source, target);
      }

      try {
        fs.rmSync(legacyRunbooksDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup only. The migrated content is the important part.
      }
    }
  }

  private seedMockTemplates(): void {
    if (!this.extensionPath) { return; }

    const copies: Array<{ source: string; target: string }> = [
      {
        source: path.join(this.extensionPath, 'resources', 'mock-templates', 'AutomationAssetsMock.psm1.template'),
        target: path.join(this.mockTemplatesDir, 'AutomationAssetsMock.psm1.template'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'mock-templates', 'PnPPowerShellMock.psm1.template'),
        target: path.join(this.mockTemplatesDir, 'PnPPowerShellMock.psm1.template'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'mock-templates', 'MicrosoftGraphMock.psm1.template'),
        target: path.join(this.mockTemplatesDir, 'MicrosoftGraphMock.psm1.template'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'mock-templates', 'automationstubs.py.template'),
        target: path.join(this.mockTemplatesDir, 'automationstubs.py.template'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'pipeline-templates', 'github-actions.yml.template'),
        target: path.join(this.pipelineTemplatesDir, 'github-actions.yml.template'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'pipeline-templates', 'azure-devops.yml.template'),
        target: path.join(this.pipelineTemplatesDir, 'azure-devops.yml.template'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'pipeline-templates', 'gitlab-ci.yml.template'),
        target: path.join(this.pipelineTemplatesDir, 'gitlab-ci.yml.template'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'pipeline-templates', 'automation-assets.bicep'),
        target: path.join(this.pipelineTemplatesDir, 'automation-assets.bicep'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'pipeline-templates', 'automation-modules.bicep'),
        target: path.join(this.pipelineTemplatesDir, 'automation-modules.bicep'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'pipeline-templates', 'modules.manifest.json.template'),
        target: path.join(this.pipelineTemplatesDir, 'modules.manifest.json.template'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'pipeline-templates', 'certificates.manifest.json.template'),
        target: path.join(this.pipelineTemplatesDir, 'certificates.manifest.json.template'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'pipeline-templates', 'scripts', 'deploy-runbooks.ps1'),
        target: path.join(this.pipelineTemplatesDir, 'scripts', 'deploy-runbooks.ps1'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'pipeline-templates', 'scripts', 'deploy-assets.ps1'),
        target: path.join(this.pipelineTemplatesDir, 'scripts', 'deploy-assets.ps1'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'pipeline-templates', 'scripts', 'deploy-modules.ps1'),
        target: path.join(this.pipelineTemplatesDir, 'scripts', 'deploy-modules.ps1'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'pipeline-templates', 'scripts', 'deploy-runbooks.sh'),
        target: path.join(this.pipelineTemplatesDir, 'scripts', 'deploy-runbooks.sh'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'pipeline-templates', 'scripts', 'deploy-assets.py'),
        target: path.join(this.pipelineTemplatesDir, 'scripts', 'deploy-assets.py'),
      },
      {
        source: path.join(this.extensionPath, 'resources', 'pipeline-templates', 'scripts', 'deploy-modules.py'),
        target: path.join(this.pipelineTemplatesDir, 'scripts', 'deploy-modules.py'),
      },
    ];

    for (const copy of copies) {
      if (!fs.existsSync(copy.source)) { continue; }
      fs.mkdirSync(path.dirname(copy.target), { recursive: true });
      if (fs.existsSync(copy.target)) {
        const current = fs.readFileSync(copy.target, 'utf8');
        if (!templateNeedsRefresh(copy.target, current)) {
          continue;
        }
      }
      fs.copyFileSync(copy.source, copy.target);
    }
  }

  /**
   * Initialises (or re-links) an account in this workspace.
   * Appends to the accounts array - does not overwrite existing accounts.
   */
  async initWorkspace(accountName: string, resourceGroup: string, subscriptionId: string, subscriptionName: string, location?: string): Promise<void> {
    if (!this.rootPath) {
      throw new Error('No VS Code workspace folder is open.');
    }

    fs.mkdirSync(this.settingsDir, { recursive: true });
    fs.mkdirSync(this.studioDir, { recursive: true });

    // Upsert into accounts array
    const accounts = this.getLinkedAccounts().filter(a => a.accountName !== accountName);
    const existing = this.getLinkedAccount(accountName);
    accounts.push({
      accountName,
      resourceGroup,
      subscriptionId,
      subscriptionName,
      location,
      linkedAt: new Date().toISOString(),
      runbooks: existing?.runbooks ?? {},
      sync: existing?.sync ?? {},
    });
    this.writeLinkedAccounts(accounts);

    // Upsert into local.settings.json account entries
    const localSettingsFile = this.readLocalSettingsFile();
    const allSettings = localSettingsFile.aaccounts.filter(s => s.accountName !== accountName);
    allSettings.push(defaultSettings(accountName));
    this.writeLocalSettingsFile({ ...localSettingsFile, aaccounts: allSettings });

    // .gitignore - ensure local.settings.json isn't committed
    const gitignorePath = path.join(this.rootPath, '.gitignore');
    let gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    for (const entry of [
      'local.settings.json',
      '.env',
      '.settings/cache/workspace-cache/',
      '.settings/tmp/',
      '.settings/cache/modules/',
      // Explicitly un-ignore pipeline module zips so they are committed to the repo.
      '!aaccounts/**/pipelines/modules/',
      '!aaccounts/**/pipelines/modules/*.zip',
    ]) {
      if (!gitignore.includes(entry)) { gitignore += `\n${entry}`; }
    }
    fs.writeFileSync(gitignorePath, gitignore.trimStart(), 'utf8');

    fs.mkdirSync(this.mockTemplatesDir, { recursive: true });
    fs.mkdirSync(this.localModulesDir, { recursive: true });
    this.ensureAccountFolder(accountName);
    this.seedMockTemplates();
  }

  // ── Runbook runtime metadata ─────────────────────────────────────────────────

  /** Returns normalized runbook metadata for an account. */
  getRunbookMeta(accountName: string): Record<string, RunbookMetadata> {
    const stored = this.getLinkedAccount(accountName)?.runbooks ?? {};
    return Object.fromEntries(
      Object.entries(stored).map(([runbookName, value]) => [
        runbookName,
        typeof value === 'string' ? { runbookType: value } : value,
      ])
    );
  }

  /** Persists runbook metadata so explorer decorations and tree labels can show execution details. */
  setRunbookMeta(accountName: string, runbookName: string, runbookType: string, runtimeEnvironment?: string): void {
    const accounts = this.getLinkedAccounts();
    const account = accounts.find(item => item.accountName === accountName);
    if (!account) { return; }
    account.runbooks ??= {};
    account.runbooks[runbookName] = runtimeEnvironment
      ? { runbookType, runtimeEnvironment }
      : { runbookType };
    this.writeLinkedAccounts(accounts);
  }

  removeRunbookMeta(accountName: string, runbookName: string): void {
    const accounts = this.getLinkedAccounts();
    const account = accounts.find(item => item.accountName === accountName);
    if (!account?.runbooks?.[runbookName]) { return; }
    delete account.runbooks[runbookName];
    this.writeLinkedAccounts(accounts);
  }

  // ── Account registry ────────────────────────────────────────────────────────

  getLinkedAccounts(): LinkedAccount[] {
    if (!fs.existsSync(this.accountFilePath)) { return []; }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.accountFilePath, 'utf8'));
      return Array.isArray(parsed) ? parsed as LinkedAccount[] : [parsed as LinkedAccount];
    } catch (err) {
      console.error('[runbookWorkbench] Failed to parse aaccounts.json:', err);
      return [];
    }
  }

  private writeLinkedAccounts(accounts: LinkedAccount[]): void {
    fs.writeFileSync(this.accountFilePath, JSON.stringify(accounts, null, 2), 'utf8');
  }

  /** Returns a specific account by name, or the first account if no name given. */
  getLinkedAccount(accountName?: string): LinkedAccount | undefined {
    const accounts = this.getLinkedAccounts();
    if (!accountName) { return accounts[0]; }
    return accounts.find(a => a.accountName === accountName);
  }

  // ── Local settings (per account) ─────────────────────────────────────────────

  private readLocalSettingsFile(): LocalSettingsFile {
    if (!fs.existsSync(this.localSettingsPath)) { return defaultLocalSettingsFile(); }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.localSettingsPath, 'utf8'));
      if (Array.isArray(parsed)) {
        return {
          ...defaultLocalSettingsFile(),
          aaccounts: parsed as LocalSettings[],
        };
      }
      if (parsed && typeof parsed === 'object') {
        const root = parsed as Partial<LocalSettingsFile> & Partial<LocalSettings>;
        if (Array.isArray(root.aaccounts)) {
          return {
            PnPAppId: typeof root.PnPAppId === 'string' ? root.PnPAppId : '',
            aaccounts: root.aaccounts,
          };
        }
        if (typeof root.accountName === 'string') {
          return {
            ...defaultLocalSettingsFile(),
            aaccounts: [root as LocalSettings],
          };
        }
      }
      return defaultLocalSettingsFile();
    } catch (err) {
      console.error('[runbookWorkbench] Failed to parse local.settings.json:', err);
      return defaultLocalSettingsFile();
    }
  }

  private writeLocalSettingsFile(file: LocalSettingsFile): void {
    fs.writeFileSync(this.localSettingsPath, JSON.stringify(file, null, 2), 'utf8');
  }

  getGlobalPnPAppId(): string {
    return this.readLocalSettingsFile().PnPAppId ?? '';
  }

  setGlobalPnPAppId(pnpAppId: string): void {
    const current = this.readLocalSettingsFile();
    this.writeLocalSettingsFile({ ...current, PnPAppId: pnpAppId });
  }

  readLocalSettings(accountName: string): LocalSettings {
    return this.readLocalSettingsFile().aaccounts.find(s => s.accountName === accountName)
      ?? defaultSettings(accountName);
  }

  writeLocalSettings(accountName: string, settings: LocalSettings): void {
    const current = this.readLocalSettingsFile();
    const all = current.aaccounts.filter(s => s.accountName !== accountName);
    all.push({ ...settings, accountName });
    this.writeLocalSettingsFile({ ...current, aaccounts: all });
  }

  // ── Runbook files (per account) ───────────────────────────────────────────────

  writeRunbookFile(
    accountName: string,
    runbookName: string,
    runbookType: string,
    content: string,
    subfolder?: string,
    runtimeEnvironment?: string
  ): string {
    const base = this.ensureAccountFolder(accountName);
    const dir = subfolder ? path.join(base, subfolder) : base;
    fs.mkdirSync(dir, { recursive: true });
    const ext = extensionForRunbookType(runbookType);
    const filePath = path.join(dir, `${runbookName}${ext}`);
    fs.writeFileSync(filePath, content, 'utf8');
    this.setRunbookMeta(accountName, runbookName, runbookType, runtimeEnvironment);
    return filePath;
  }

  readRunbookFile(accountName: string, runbookName: string, runbookType: string): string | undefined {
    const ext = extensionForRunbookType(runbookType);
    const base = this.runbooksDirForAccount(accountName);
    for (const dir of [base, path.join(base, 'Published'), path.join(base, 'Draft')]) {
      const filePath = path.join(dir, `${runbookName}${ext}`);
      if (fs.existsSync(filePath)) { return fs.readFileSync(filePath, 'utf8'); }
    }
    return undefined;
  }

  listWorkspaceRunbooks(): WorkspaceRunbookFile[] {
    if (!this.rootPath) { return []; }

    const result: WorkspaceRunbookFile[] = [];

    for (const linked of this.getLinkedAccounts()) {
      const runbooksDir = this.runbooksDirForAccount(linked.accountName);
      if (!fs.existsSync(runbooksDir)) { continue; }

      const deployState = this.getDeployState(linked.accountName);
      const runbookMeta = this.getRunbookMeta(linked.accountName);

      // Scan Published / Draft subfolders (and root for backwards compat)
      this.scanRunbookDir(runbooksDir, linked.accountName, undefined, deployState, runbookMeta, result);
      for (const sub of fs.readdirSync(runbooksDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) { continue; }
        this.scanRunbookDir(path.join(runbooksDir, sub.name), linked.accountName, sub.name, deployState, runbookMeta, result);
      }
    }

    // Mark linked twins: Published + Draft with identical content hash
    const byKey = new Map<string, WorkspaceRunbookFile[]>();
    for (const f of result) {
      const key = `${f.accountName}|${f.runbookName}`;
      const group = byKey.get(key) ?? [];
      group.push(f);
      byKey.set(key, group);
    }
    for (const group of byKey.values()) {
      const pub = group.find(f => f.subfolder === 'Published');
      const draft = group.find(f => f.subfolder === 'Draft');
      if (pub && draft && pub.localHash === draft.localHash) {
        pub.linkedTwin = true;
        draft.linkedTwin = true;
      }
    }

    return result;
  }

  findRunbookFilePath(accountName: string, runbookName: string, runbookType: string): string | undefined {
    const ext = extensionForRunbookType(runbookType);
    const base = this.runbooksDirForAccount(accountName);
    for (const dir of [base, path.join(base, 'Published'), path.join(base, 'Draft')]) {
      const p = path.join(dir, `${runbookName}${ext}`);
      if (fs.existsSync(p)) { return p; }
    }
    return undefined;
  }

  private scanRunbookDir(
    dir: string,
    accountName: string,
    subfolder: string | undefined,
    deployState: Record<string, string>,
    runbookMeta: Record<string, RunbookMetadata>,
    result: WorkspaceRunbookFile[]
  ): void {
    const files = fs.readdirSync(dir)
      .filter(f => ['.ps1', '.py'].includes(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));

    for (const file of files) {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const runbookName = path.basename(file, path.extname(file));
      const localHash = crypto.createHash('sha256').update(content).digest('hex');
      // Prefer the stored runtime (e.g. 'PowerShell72') over the file-extension fallback
      const metadata = runbookMeta[runbookName];
      const runbookType = metadata?.runbookType ?? runbookTypeForFilePath(filePath);
      const deployKey = subfolder ? `${subfolder}/${runbookName}` : runbookName;
      result.push({
        accountName,
        runbookName,
        filePath,
        runbookType,
        runtimeEnvironment: metadata?.runtimeEnvironment,
        localHash,
        subfolder,
        deployedHash: deployState[deployKey],
      });
    }
  }

  deleteRunbookFile(filePath: string): void {
    const normalized = filePath.replace(/\\/g, '/');
    const accountsDirNormalized = this.accountsDir.replace(/\\/g, '/');
    if (!normalized.startsWith(accountsDirNormalized + '/')) {
      throw new Error(`Refusing to delete file outside workspace accounts directory: ${filePath}`);
    }

    const accountName = this.extractAccountNameFromRunbookPath(filePath);
    const runbookName = path.basename(filePath, path.extname(filePath));
    fs.unlinkSync(filePath);

    if (accountName) {
      fs.mkdirSync(this.accountDirForAccount(accountName), { recursive: true });
    }

    if (accountName && !this.hasAnyRunbookFile(accountName, runbookName)) {
      this.removeRunbookMeta(accountName, runbookName);
    }
  }

  clearWorkspace(): void {
    if (!this.isWorkspaceOpen) { return; }

    fs.rmSync(this.accountsDir, { recursive: true, force: true });
    fs.rmSync(this.settingsDir, { recursive: true, force: true });
    fs.rmSync(this.localSettingsPath, { force: true });
    fs.rmSync(this.workbenchDir, { recursive: true, force: true });
    this.removeGeneratedPipelineFiles();
  }

  private removeGeneratedPipelineFiles(): void {
    const rootEntries = [
      { dir: this.rootPath, pattern: /^azure-pipelines-.*\.yml$/i },
      { dir: this.rootPath, pattern: /^\.gitlab-ci-.*\.yml$/i },
      { dir: path.join(this.rootPath, '.github', 'workflows'), pattern: /^deploy-runbooks-.*\.yml$/i },
    ];

    for (const entry of rootEntries) {
      if (!fs.existsSync(entry.dir) || !fs.statSync(entry.dir).isDirectory()) { continue; }
      for (const name of fs.readdirSync(entry.dir)) {
        if (!entry.pattern.test(name)) { continue; }
        fs.rmSync(path.join(entry.dir, name), { force: true });
      }
    }

    const workflowsDir = path.join(this.rootPath, '.github', 'workflows');
    if (fs.existsSync(workflowsDir) && fs.statSync(workflowsDir).isDirectory() && fs.readdirSync(workflowsDir).length === 0) {
      fs.rmSync(workflowsDir, { recursive: true, force: true });
    }

    const githubDir = path.join(this.rootPath, '.github');
    if (fs.existsSync(githubDir) && fs.statSync(githubDir).isDirectory() && fs.readdirSync(githubDir).length === 0) {
      fs.rmSync(githubDir, { recursive: true, force: true });
    }
  }

  private hasAnyRunbookFile(accountName: string, runbookName: string): boolean {
    const base = this.runbooksDirForAccount(accountName);
    for (const dir of [base, path.join(base, 'Published'), path.join(base, 'Draft')]) {
      for (const ext of ['.ps1', '.py']) {
        if (fs.existsSync(path.join(dir, `${runbookName}${ext}`))) {
          return true;
        }
      }
    }
    return false;
  }

  private extractAccountNameFromRunbookPath(filePath: string): string | undefined {
    const normalized = filePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const idx = parts.findIndex(p => p === 'aaccounts');
    if (idx === -1 || idx + 1 >= parts.length) { return undefined; }
    return parts[idx + 1];
  }

  // ── Generic section file I/O ──────────────────────────────────────────────────

  sectionDirForAccount(accountName: string, folderName: string): string {
    return path.join(this.workspaceCacheDir, accountName, folderName);
  }

  private sectionFetchedMarkerPath(accountName: string, folderName: string): string {
    return path.join(this.sectionDirForAccount(accountName, folderName), '.fetched');
  }

  markSectionFetched(accountName: string, folderName: string): void {
    const dir = this.sectionDirForAccount(accountName, folderName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.sectionFetchedMarkerPath(accountName, folderName), new Date().toISOString(), 'utf8');
  }

  replaceSectionItemFiles(accountName: string, folderName: string, items: Array<{ itemName: string; data: object }>): void {
    const dir = this.sectionDirForAccount(accountName, folderName);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.sectionFetchedMarkerPath(accountName, folderName), new Date().toISOString(), 'utf8');
    for (const item of items) {
      const filePath = path.join(dir, `${sanitizeName(item.itemName || '_')}.json`);
      fs.writeFileSync(filePath, JSON.stringify(item.data, null, 2), 'utf8');
    }
  }

  hasSectionBeenFetched(accountName: string, folderName: string): boolean {
    const currentDir = this.sectionDirForAccount(accountName, folderName);
    if (fs.existsSync(this.sectionFetchedMarkerPath(accountName, folderName))) {
      return true;
    }
    const legacyDir = path.join(this.studioDir, 'sections', accountName, folderName);
    return fs.existsSync(legacyDir);
  }

  writeSectionItemFile(accountName: string, folderName: string, itemName: string, data: object): void {
    const dir = this.sectionDirForAccount(accountName, folderName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.sectionFetchedMarkerPath(accountName, folderName), new Date().toISOString(), 'utf8');
    const filePath = path.join(dir, `${sanitizeName(itemName || '_')}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  listSectionItemFiles(accountName: string, folderName: string): Array<{ name: string; filePath: string; data: Record<string, unknown> }> {
    const dir = this.resolveSectionDirForRead(accountName, folderName);
    if (!dir) { return []; }
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => {
        const filePath = path.join(dir, f);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
          return { name: path.basename(f, '.json'), filePath, data };
        } catch {
          return { name: path.basename(f, '.json'), filePath, data: {} };
        }
      });
  }

  private resolveSectionDirForRead(accountName: string, folderName: string): string | undefined {
    const currentDir = this.sectionDirForAccount(accountName, folderName);
    if (fs.existsSync(currentDir)) {
      return currentDir;
    }

    const legacyDir = path.join(this.studioDir, 'sections', accountName, folderName);
    return fs.existsSync(legacyDir) ? legacyDir : undefined;
  }

  // ── Deploy state (per account) ────────────────────────────────────────────────

  getDeployState(accountName: string): Record<string, string> {
    return this.getLinkedAccount(accountName)?.sync ?? {};
  }

  recordDeploy(accountName: string, runbookName: string, contentHash: string): void {
    const accounts = this.getLinkedAccounts();
    const account = accounts.find(item => item.accountName === accountName);
    if (!account) { return; }
    account.sync ??= {};
    account.sync[runbookName] = contentHash;
    this.writeLinkedAccounts(accounts);
  }

  /**
   * Resolves ${env:VAR_NAME} tokens in a local settings value.
   */
  static resolveEnvToken(value: string): string {
    return value.replace(/\$\{env:([^}]+)\}/g, (_, varName: string) => {
      return process.env[varName] ?? '';
    });
  }
}

function templateNeedsRefresh(filePath: string, content: string): boolean {
  if (filePath.endsWith('AutomationAssetsMock.psm1.template')) {
    return content.includes('function Connect-PnPOnline') || content.includes('function Connect-MgGraph');
  }
  if (filePath.endsWith('PnPPowerShellMock.psm1.template')) {
    // Needs refresh if it still has the old static mock-object pattern
    return content.includes("ConnectionType = 'PnP.ManagedIdentity.Mock'");
  }
  if (filePath.endsWith('MicrosoftGraphMock.psm1.template')) {
    return !content.includes('function Connect-MgGraph');
  }
  if (filePath.endsWith('github-actions.yml.template') || filePath.endsWith('azure-devops.yml.template') || filePath.endsWith('gitlab-ci.yml.template')) {
    return !content.includes('{{DEPLOY_SCOPE_LABEL}}') || !content.includes('{{DEPLOY_SCRIPT}}');
  }
  if (filePath.endsWith('automation-assets.bicep')) {
    return !content.includes('Microsoft.Automation/automationAccounts/variables') || !content.includes('Microsoft.Automation/automationAccounts/connections');
  }
  if (filePath.endsWith('automation-modules.bicep')) {
    return !content.includes('Microsoft.Automation/automationAccounts/modules');
  }
  if (filePath.endsWith('modules.manifest.json.template')) {
    return !content.includes('"modules"');
  }
  if (filePath.endsWith('certificates.manifest.json.template')) {
    return !content.includes('"certificates"');
  }
  if (filePath.endsWith('deploy-runbooks.ps1')) {
    return !content.includes('az automation runbook replace-content');
  }
  if (filePath.endsWith('deploy-assets.ps1')) {
    return !content.includes('automation-assets.bicep');
  }
  if (filePath.endsWith('deploy-modules.ps1')) {
    return !content.includes('automation-modules.bicep');
  }
  if (filePath.endsWith('deploy-runbooks.sh')) {
    return !content.includes('az automation runbook replace-content');
  }
  if (filePath.endsWith('deploy-assets.py')) {
    return !content.includes('automation-assets.bicep');
  }
  if (filePath.endsWith('deploy-modules.py')) {
    return !content.includes('automation-modules.bicep');
  }
  return false;
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

export function extensionForRunbookType(runbookType: string): string {
  const t = runbookType.toLowerCase();
  if (t.startsWith('python')) { return '.py'; }
  return '.ps1';
}

export function runbookTypeForFilePath(filePath: string): string {
  return path.extname(filePath).toLowerCase() === '.py' ? 'Python3' : 'PowerShell';
}

function copyPathRecursive(source: string, target: string): void {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      copyPathRecursive(path.join(source, name), path.join(target, name));
    }
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
