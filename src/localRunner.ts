import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceManager } from './workspaceManager';
import type { RunbookSummary } from './azureService';
import type { RunbookSessionsViewProvider } from './runbookSessionsViewProvider';

/**
 * LocalRunner executes runbooks locally with Asset Mocks injected.
 *
 * For PowerShell runbooks it:
 *   1. Generates an AutomationAssetsMock.psm1 in a temp dir with
 *      stubs that read from local.settings.json
 *   2. Spawns pwsh with the mock module imported before the runbook
 *
 * For Python runbooks it injects an automationstubs.py shim and runs
 * python with that shim on the PYTHONPATH.
 */
export class LocalRunner {
  private readonly debugTempDirsBySessionName = new Map<string, string>();
  private readonly templatePaths: Record<'assets' | 'pnp' | 'graph' | 'python', string>;

  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly sessionsView?: RunbookSessionsViewProvider,
    extensionPath?: string,
    private readonly extensionVersion?: string
  ) {
    this.templatePaths = {
      assets: path.join(extensionPath ?? '', 'resources', 'mock-templates', 'AutomationAssetsMock.psm1.template'),
      pnp: path.join(extensionPath ?? '', 'resources', 'mock-templates', 'PnPPowerShellMock.psm1.template'),
      graph: path.join(extensionPath ?? '', 'resources', 'mock-templates', 'MicrosoftGraphMock.psm1.template'),
      python: path.join(extensionPath ?? '', 'resources', 'mock-templates', 'automationstubs.py.template'),
    };
    vscode.debug.onDidTerminateDebugSession((session) => {
      const tmpDir = this.debugTempDirsBySessionName.get(session.name);
      if (!tmpDir) { return; }
      this.debugTempDirsBySessionName.delete(session.name);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  }

  async run(runbook: RunbookSummary): Promise<void> {
    const content = this.workspace.readRunbookFile(runbook.accountName, runbook.name, runbook.runbookType);
    if (content === undefined) {
      void vscode.window.showErrorMessage(`No local file for "${runbook.name}". Fetch it first.`);
      return;
    }

    const rbType = runbook.runbookType.toLowerCase();
    try {
      if (rbType.startsWith('python')) {
        await this.runPython(runbook, content);
      } else {
        await this.runPowerShell(runbook, content);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`[local-run-error] ${runbook.name}: ${msg}`);
      void vscode.window.showErrorMessage(`Local run of "${runbook.name}" failed: ${msg}`);
    }
  }

  async debug(runbook: RunbookSummary): Promise<void> {
    const filePath = this.workspace.findRunbookFilePath(runbook.accountName, runbook.name, runbook.runbookType);
    if (!filePath) {
      void vscode.window.showErrorMessage(`No local file for "${runbook.name}". Fetch it first.`);
      return;
    }

    const rbType = runbook.runbookType.toLowerCase();
    try {
      if (rbType.startsWith('python')) {
        await this.debugPython(runbook, filePath);
      } else {
        await this.debugPowerShell(runbook, filePath);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`[local-debug-error] ${runbook.name}: ${msg}`);
      void vscode.window.showErrorMessage(`Local debug of "${runbook.name}" failed: ${msg}`);
    }
  }

  async installPowerShellModule(moduleName: string, requiredVersion?: string): Promise<void> {
    fs.mkdirSync(this.workspace.localModulesDir, { recursive: true });
    const version = requiredVersion?.trim() || (await this.listPowerShellModuleVersions(moduleName, false))[0];
    if (!version) {
      throw new Error(`No installable versions were found in PowerShell Gallery for "${moduleName}".`);
    }
    await this._downloadModule(moduleName, version);
  }

  importLocalModuleFromPath(sourcePath: string, moduleName: string, version: string): void {
    fs.mkdirSync(this.workspace.localModulesDir, { recursive: true });
    const targetDir = path.join(this.workspace.localModulesDir, moduleName, version);

    this.outputChannel.appendLine(`[local-modules] Importing local module "${moduleName}" (${version}) from "${sourcePath}" to "${targetDir}"`);

    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });

    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      fs.cpSync(sourcePath, targetDir, { recursive: true });
    } else {
      // Single file: copy it using the canonical module name
      const ext = path.extname(sourcePath).toLowerCase();
      fs.copyFileSync(sourcePath, path.join(targetDir, `${moduleName}${ext}`));
    }

    // Ensure a .psd1 manifest exists so buildCachedModuleImports can find this module
    const psd1Path = path.join(targetDir, `${moduleName}.psd1`);
    if (!fs.existsSync(psd1Path)) {
      const psm1Exists = fs.existsSync(path.join(targetDir, `${moduleName}.psm1`));
      const rootModuleLine = psm1Exists ? `\n    RootModule = '${moduleName}.psm1'` : '';
      fs.writeFileSync(psd1Path, `@{\n    ModuleVersion = '${version}'${rootModuleLine}\n}\n`, 'utf8');
    }
  }

  /**
   * Resolves all transitive dependencies for a module version.
   * Returns a flat list of {name, version} pairs in install order (deps first),
   * excluding modules that are already in the local cache.
   */
  async resolveModuleDependencies(
    moduleName: string,
    version: string
  ): Promise<Array<{ name: string; version: string }>> {
    const alreadyCached = new Set(
      fs.existsSync(this.workspace.localModulesDir)
        ? fs.readdirSync(this.workspace.localModulesDir, { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => e.name.toLowerCase())
        : []
    );
    const queue: Array<{ name: string; version: string }> = [];
    const visited = new Set<string>();

    const resolve = async (name: string, ver: string) => {
      const key = `${name.toLowerCase()}@${ver}`;
      if (visited.has(key)) { return; }
      visited.add(key);

      const deps = await fetchModuleDependencies(name, ver);
      for (const dep of deps) {
        const depVer = dep.minVersion || (await this.listPowerShellModuleVersions(dep.name, false))[0] || '';
        if (depVer) { await resolve(dep.name, depVer); }
      }

      if (!alreadyCached.has(name.toLowerCase())) {
        queue.push({ name, version: ver });
      }
    };

    // Resolve deps only — not the module itself (caller handles that)
    const deps = await fetchModuleDependencies(moduleName, version);
    for (const dep of deps) {
      const depVer = dep.minVersion || (await this.listPowerShellModuleVersions(dep.name, false))[0] || '';
      if (depVer) { await resolve(dep.name, depVer); }
    }

    return queue;
  }

  private async _downloadModule(moduleName: string, version: string): Promise<void> {
    const packageUrl = `https://www.powershellgallery.com/api/v2/package/${encodeURIComponent(moduleName)}/${encodeURIComponent(version)}`;
    const targetDir = path.join(this.workspace.localModulesDir, moduleName, version);
    const tempDir = this.createSharedTempDir('psgallery-module-');
    const archivePath = path.join(tempDir, `${moduleName}.${version}.nupkg`);

    this.outputChannel.appendLine(`[local-modules] Downloading module "${moduleName}" (${version}) to ${targetDir}`);

    try {
      const response = await fetch(packageUrl, {
        headers: { Accept: 'application/octet-stream,application/zip,*/*' },
      });
      if (!response.ok) {
        throw new Error(`PowerShell Gallery package request failed: ${response.status} ${response.statusText}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(archivePath, buffer);
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(targetDir, { recursive: true });
      await unzipArchive(archivePath, targetDir);
      removeNuGetMetadata(targetDir);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async installModuleWithDependencies(
    moduleName: string,
    version: string,
    deps: Array<{ name: string; version: string }>
  ): Promise<void> {
    fs.mkdirSync(this.workspace.localModulesDir, { recursive: true });
    for (const dep of deps) {
      await this._downloadModule(dep.name, dep.version);
    }
    await this._downloadModule(moduleName, version);
  }

  async listPowerShellModuleVersions(moduleName: string, includePrerelease = false): Promise<string[]> {
    const url = new URL('https://www.powershellgallery.com/api/v2/FindPackagesById()');
    url.searchParams.set('id', `'${moduleName}'`);

    const xmlPages = await fetchPowerShellGalleryPages(url.toString());
    const versions = xmlPages.flatMap(xml => Array.from(xml.matchAll(/<d:Version[^>]*>([^<]+)<\/d:Version>/g)))
      .map(match => match[1]?.trim())
      .filter((value): value is string => Boolean(value));

    const filtered = includePrerelease
      ? versions
      : versions.filter(version => !/-/.test(version));

    const unique = Array.from(new Set(filtered));
    unique.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
    return unique;
  }

  async searchPowerShellModules(searchTerm: string): Promise<string[]> {
    const term = searchTerm.trim();
    if (!term) { return []; }

    const url = new URL('https://www.powershellgallery.com/api/v2/Search()');
    url.searchParams.set('searchTerm', `'${term}'`);
    url.searchParams.set('targetFramework', `''`);
    url.searchParams.set('includePrerelease', 'false');
    url.searchParams.set('$filter', 'IsLatestVersion');
    url.searchParams.set('$top', '30');

    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`PowerShell Gallery request failed: ${response.status} ${response.statusText}`);
    }

    const xml = await response.text();
    const ids = [
      ...Array.from(xml.matchAll(/<d:Id[^>]*>([^<]+)<\/d:Id>/g)),
      ...Array.from(xml.matchAll(/<title[^>]*type="text"[^>]*>([^<]+)<\/title>/g)),
    ]
      .map(match => match[1]?.trim())
      .filter((value): value is string => Boolean(value))
      .filter(value => !/^(Search|Packages)$/i.test(value));

    const unique = Array.from(new Set(ids));
    unique.sort((a, b) => {
      const aStarts = a.toLowerCase().startsWith(term.toLowerCase()) ? 0 : 1;
      const bStarts = b.toLowerCase().startsWith(term.toLowerCase()) ? 0 : 1;
      if (aStarts !== bStarts) { return aStarts - bStarts; }
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    return unique;
  }

  private async runPowerShell(runbook: RunbookSummary, content: string): Promise<void> {
    const pwsh = await findPwsh();
    if (!pwsh) {
      void vscode.window.showErrorMessage(
        'PowerShell (pwsh) not found. Install PowerShell 7+ to run runbooks locally.'
      );
      return;
    }

    const settings = this.workspace.readLocalSettings(runbook.accountName);
    const tmpDir = this.createWorkspaceTempDir(runbook.accountName, 'runbook-');

    try {
      const mockPath = this.writePowerShellMock(runbook.accountName, runbook.name, settings);

      // Write the runbook script
      const rbPath = path.join(tmpDir, `${runbook.name}.ps1`);
      fs.writeFileSync(rbPath, content, 'utf8');

      // Build the launcher script that imports the mock then dot-sources the runbook
      const cachedImports = buildCachedModuleImports(this.workspace.localModulesDir);
      const launcher = [
        `$env:PSModulePath = "${this.workspace.localModulesDir.replace(/\\/g, '/')}" + [IO.Path]::PathSeparator + $env:PSModulePath`,
        ...(cachedImports ? [cachedImports] : []),
        `Import-Module "${mockPath.replace(/\\/g, '/')}" -Force -ErrorAction Stop`,
        `. "${rbPath.replace(/\\/g, '/')}"`,
      ].join('\n');
      const launcherPath = path.join(tmpDir, '_launch.ps1');
      fs.writeFileSync(launcherPath, launcher, 'utf8');

      this.outputChannel.appendLine(`\n[local-run] Starting ${runbook.name} (PowerShell)`);
      this.outputChannel.appendLine(`[local-run] Mock module: ${mockPath}`);
      this.outputChannel.appendLine(`[local-run] Mock workspace folder: ${path.dirname(mockPath)}`);
      this._logCachedModules('[local-run]');
      this.outputChannel.appendLine('[local-run] Streaming output to the "Runbook Sessions" panel.');
      this.outputChannel.show(true);

      this.launchProcess(
        runbook.name,
        'PowerShell',
        pwsh,
        ['-NoLogo', '-NonInteractive', '-File', launcherPath],
        tmpDir,
        process.env
      );
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }
  }

  private async runPython(runbook: RunbookSummary, content: string): Promise<void> {
    const python = await findPython();
    if (!python) {
      void vscode.window.showErrorMessage('Python 3 not found. Install Python 3 to run Python runbooks locally.');
      return;
    }

    const settings = this.workspace.readLocalSettings(runbook.accountName);
    const tmpDir = this.createWorkspaceTempDir(runbook.accountName, 'runbook-');

    try {
      const stubsPath = this.writePythonMock(runbook.accountName, runbook.name, settings);

      // Write the runbook
      const rbPath = path.join(tmpDir, `${runbook.name}.py`);
      fs.writeFileSync(rbPath, content, 'utf8');

      this.outputChannel.appendLine(`\n[local-run] Starting ${runbook.name} (Python)`);
      this.outputChannel.appendLine(`[local-run] Mock module: ${stubsPath}`);
      this.outputChannel.appendLine(`[local-run] Mock workspace folder: ${path.dirname(stubsPath)}`);
      this.outputChannel.appendLine('[local-run] Streaming output to the "Runbook Sessions" panel.');
      this.outputChannel.show(true);

      const env = { ...process.env, PYTHONPATH: `${tmpDir}${path.delimiter}${process.env.PYTHONPATH ?? ''}` };
      this.launchProcess(runbook.name, 'Python', python, [rbPath], tmpDir, env);
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }
  }

  private async debugPowerShell(runbook: RunbookSummary, filePath: string): Promise<void> {
    const settings = this.workspace.readLocalSettings(runbook.accountName);
    const tmpDir = this.createWorkspaceTempDir(runbook.accountName, 'runbook-debug-');

    try {
      await vscode.workspace.getConfiguration('powershell').update(
        'debugging.createTemporaryIntegratedConsole',
        true,
        vscode.ConfigurationTarget.Workspace
      );

      const mockPath = this.writePowerShellMock(runbook.accountName, runbook.name, settings);

      const cachedImports = buildCachedModuleImports(this.workspace.localModulesDir);
      const launcher = [
        `$env:PSModulePath = "${this.workspace.localModulesDir.replace(/\\/g, '/')}" + [IO.Path]::PathSeparator + $env:PSModulePath`,
        ...(cachedImports ? [cachedImports] : []),
        `Import-Module "${mockPath.replace(/\\/g, '/')}" -Force -ErrorAction Stop`,
        `. "${filePath.replace(/\\/g, '/')}"`,
      ].join('\n');
      const launcherPath = path.join(tmpDir, '_debug.ps1');
      fs.writeFileSync(launcherPath, launcher, 'utf8');

      const sessionName = `Runbook Debug: ${runbook.name} (${Date.now()})`;
      const started = await vscode.debug.startDebugging(undefined, {
        name: sessionName,
        type: 'PowerShell',
        request: 'launch',
        script: launcherPath,
        cwd: path.dirname(filePath),
        env: process.env,
      } as vscode.DebugConfiguration);

      if (!started) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        void vscode.window.showErrorMessage(
          'Unable to start PowerShell debugging. Make sure the PowerShell extension is installed and enabled.'
        );
        return;
      }

      this.debugTempDirsBySessionName.set(sessionName, tmpDir);
      this._logCachedModules('[local-debug]');
      this.outputChannel.appendLine(`[local-debug] St.arted PowerShell debug session for ${runbook.name}`);
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }
  }

  private async debugPython(runbook: RunbookSummary, filePath: string): Promise<void> {
    const settings = this.workspace.readLocalSettings(runbook.accountName);
    const tmpDir = this.createWorkspaceTempDir(runbook.accountName, 'runbook-debug-');

    try {
      this.writePythonMock(runbook.accountName, runbook.name, settings);

      const sessionName = `Runbook Debug: ${runbook.name} (${Date.now()})`;
      const started = await vscode.debug.startDebugging(undefined, {
        name: sessionName,
        type: 'debugpy',
        request: 'launch',
        program: filePath,
        cwd: path.dirname(filePath),
        console: 'integratedTerminal',
        env: {
          ...process.env,
          PYTHONPATH: `${tmpDir}${path.delimiter}${process.env.PYTHONPATH ?? ''}`,
        },
      } as vscode.DebugConfiguration);

      if (!started) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        void vscode.window.showErrorMessage(
          'Unable to start Python debugging. Make sure the Python Debugger extension is installed and enabled.'
        );
        return;
      }

      this.debugTempDirsBySessionName.set(sessionName, tmpDir);
      this.outputChannel.appendLine(`[local-debug] Started Python debug session for ${runbook.name}`);
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }
  }

  private launchProcess(
    runbookName: string,
    runtime: string,
    command: string,
    args: string[],
    tmpDir: string,
    env?: NodeJS.ProcessEnv
  ): void {
    const sessionId = this.sessionsView?.startSession(runbookName, runtime);
    const child = cp.spawn(command, args, {
      cwd: tmpDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const writeChunk = (text: string, stream: 'stdout' | 'stderr' | 'meta'): void => {
      const clean = sanitizeConsoleText(text);
      if (!clean) { return; }
      if (stream === 'stderr') {
        this.outputChannel.append(clean);
      } else {
        this.outputChannel.append(clean);
      }
      if (sessionId) {
        this.sessionsView?.appendOutput(sessionId, clean, stream);
      }
    };

    child.stdout?.on('data', chunk => writeChunk(String(chunk), 'stdout'));
    child.stderr?.on('data', chunk => writeChunk(String(chunk), 'stderr'));
    child.on('error', err => {
      writeChunk(`\n[local-run-error] ${err.message}\n`, 'stderr');
      if (sessionId) {
        this.sessionsView?.completeSession(sessionId, false, `Failed to start: ${err.message}`);
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      void vscode.window.showErrorMessage(`Local run of "${runbookName}" failed: ${err.message}`);
    });
    child.on('close', code => {
      const success = code === 0;
      const summary = success
        ? `[local-run] ${runbookName} completed successfully.`
        : `[local-run] ${runbookName} exited with code ${code ?? 'unknown'}.`;
      writeChunk(`\n${summary}\n`, success ? 'meta' : 'stderr');
      if (sessionId) {
        this.sessionsView?.completeSession(sessionId, success, summary);
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  }

  private writePowerShellMock(
    accountName: string,
    runbookName: string,
    settings: ReturnType<WorkspaceManager['readLocalSettings']>
  ): string {
    this.ensureMockTemplates();
    const targetDir = this.workspace.mockGeneratedDir(accountName, runbookName);
    fs.mkdirSync(targetDir, { recursive: true });
    const templates = {
      assets: fs.readFileSync(path.join(this.workspace.mockTemplatesDir, 'AutomationAssetsMock.psm1.template'), 'utf8'),
      pnp: fs.readFileSync(path.join(this.workspace.mockTemplatesDir, 'PnPPowerShellMock.psm1.template'), 'utf8'),
      graph: fs.readFileSync(path.join(this.workspace.mockTemplatesDir, 'MicrosoftGraphMock.psm1.template'), 'utf8'),
    };
    const rendered = renderPowerShellMock(templates, settings, this.workspace.getGlobalPnPAppId(), this.extensionVersion);
    const targetPath = path.join(targetDir, 'AutomationAssetsMock.psm1');
    fs.writeFileSync(targetPath, rendered, 'utf8');
    return targetPath;
  }

  private writePythonMock(
    accountName: string,
    runbookName: string,
    settings: ReturnType<WorkspaceManager['readLocalSettings']>
  ): string {
    this.ensureMockTemplates();
    const targetDir = this.workspace.mockGeneratedDir(accountName, runbookName);
    fs.mkdirSync(targetDir, { recursive: true });
    const template = fs.readFileSync(path.join(this.workspace.mockTemplatesDir, 'automationstubs.py.template'), 'utf8');
    const rendered = renderPythonMock(template, settings, this.workspace.getGlobalPnPAppId(), this.extensionVersion);
    const targetPath = path.join(targetDir, 'automationstubs.py');
    fs.writeFileSync(targetPath, rendered, 'utf8');
    return targetPath;
  }

  private ensureMockTemplates(): void {
    // Keep older workspaces aligned with the current root .settings/mocks layout.
    const legacyDirs = [
      path.join(this.workspace.accountsDir, '.mocks'),
      path.join(this.workspace.runbookWorkbenchDir, 'mocks'),
      path.join(this.workspace.mocksDir, 'templates'),
      path.join(this.workspace.mocksDir, '.mocks'),
    ].filter(dir => fs.existsSync(dir));

    if (legacyDirs.length && !fs.existsSync(this.workspace.mockTemplatesDir)) {
      fs.mkdirSync(this.workspace.mockTemplatesDir, { recursive: true });
      for (const legacyDir of legacyDirs) {
        for (const name of fs.readdirSync(legacyDir)) {
          const source = path.join(legacyDir, name);
          const target = path.join(this.workspace.mockTemplatesDir, name);
          if (!fs.existsSync(target)) {
            fs.copyFileSync(source, target);
          }
        }
      }

      for (const legacyDir of legacyDirs) {
        try {
          fs.rmSync(legacyDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup issues; the new path is the important part.
        }
      }
    }

    fs.mkdirSync(this.workspace.mockTemplatesDir, { recursive: true });
    const copies: Array<{ source: string; target: string }> = [
      {
        source: this.templatePaths.assets,
        target: path.join(this.workspace.mockTemplatesDir, 'AutomationAssetsMock.psm1.template'),
      },
      {
        source: this.templatePaths.pnp,
        target: path.join(this.workspace.mockTemplatesDir, 'PnPPowerShellMock.psm1.template'),
      },
      {
        source: this.templatePaths.graph,
        target: path.join(this.workspace.mockTemplatesDir, 'MicrosoftGraphMock.psm1.template'),
      },
      {
        source: this.templatePaths.python,
        target: path.join(this.workspace.mockTemplatesDir, 'automationstubs.py.template'),
      },
    ];

    for (const copy of copies) {
      if (!copy.source || !fs.existsSync(copy.source)) {
        throw new Error(`Mock template not found: ${copy.source}`);
      }
      if (fs.existsSync(copy.target)) {
        const current = fs.readFileSync(copy.target, 'utf8');
        if (!templateNeedsRefresh(copy.target, current)) {
          continue;
        }
      }
      fs.copyFileSync(copy.source, copy.target);
    }
  }

  private createWorkspaceTempDir(accountName: string, prefix: string): string {
    const root = this.workspace.tempArtifactsDirForAccount(accountName);
    fs.mkdirSync(root, { recursive: true });
    return fs.mkdtempSync(path.join(root, prefix));
  }

  private createSharedTempDir(prefix: string): string {
    const root = this.workspace.tempArtifactsRootDir;
    fs.mkdirSync(root, { recursive: true });
    return fs.mkdtempSync(path.join(root, prefix));
  }

  private _logCachedModules(prefix: string): void {
    const dir = this.workspace.localModulesDir;
    if (!fs.existsSync(dir)) { return; }
    const names = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name);
    if (names.length === 0) {
      this.outputChannel.appendLine(`${prefix} No cached modules to import.`);
    } else {
      this.outputChannel.appendLine(`${prefix} Importing cached modules: ${names.join(', ')}`);
    }
  }
}

/**
 * Fetches the declared dependencies of a specific module version from PSGallery.
 * Dependencies are stored in the OData feed as a pipe-separated string:
 *   "Az.Accounts:[2.12.1]:|Az.Storage:[6.1.0]:"
 */
async function fetchModuleDependencies(
  moduleName: string,
  version: string
): Promise<Array<{ name: string; minVersion: string }>> {
  const url = `https://www.powershellgallery.com/api/v2/Packages(Id='${encodeURIComponent(moduleName)}',Version='${encodeURIComponent(version)}')`;
  const response = await fetch(url, {
    headers: { Accept: 'application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' },
  });
  if (!response.ok) { return []; }

  const xml = await response.text();
  const match = xml.match(/<d:Dependencies[^>]*>([^<]*)<\/d:Dependencies>/);
  const raw = match?.[1]?.trim();
  if (!raw) { return []; }

  return raw.split('|')
    .map(part => {
      const [name, minVer] = part.split(':');
      return { name: name?.trim() ?? '', minVersion: minVer?.replace(/[\[\]]/g, '').trim() ?? '' };
    })
    .filter(d => d.name.length > 0);
}

async function fetchPowerShellGalleryPages(initialUrl: string): Promise<string[]> {
  const pages: string[] = [];
  const seen = new Set<string>();
  let nextUrl: string | undefined = initialUrl;

  while (nextUrl && !seen.has(nextUrl)) {
    seen.add(nextUrl);

    const response = await fetch(nextUrl, {
      headers: {
        Accept: 'application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`PowerShell Gallery request failed: ${response.status} ${response.statusText}`);
    }

    const xml = await response.text();
    pages.push(xml);

    const nextMatch = xml.match(/<link[^>]+rel="next"[^>]+href="([^"]+)"/i);
    const rawNext = nextMatch?.[1]
      ?.replace(/&amp;/g, '&')
      ?.trim();
    nextUrl = rawNext || undefined;
  }

  return pages;
}

async function unzipArchive(archivePath: string, targetDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = cp.spawn('unzip', ['-qq', '-o', archivePath, '-d', targetDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', chunk => {
      stderr += sanitizeConsoleText(String(chunk));
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `unzip failed with exit code ${code ?? 'unknown'}.`));
    });
  });
}

function removeNuGetMetadata(targetDir: string): void {
  for (const entry of fs.readdirSync(targetDir)) {
    if (entry === '_rels' || entry === 'package' || entry === '[Content_Types].xml' || entry.endsWith('.nuspec')) {
      fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
    }
  }
}

// ── Asset mock generators ─────────────────────────────────────────────────────

function renderPowerShellMock(
  templates: { assets: string; pnp: string; graph: string },
  settings: ReturnType<WorkspaceManager['readLocalSettings']>,
  pnpAppId: string,
  version?: string
): string {
  const variableValues = {
    ...(pnpAppId ? { PnPAppId: pnpAppId } : {}),
    ...settings.Assets.Variables,
  };
  const varEntries = Object.entries(variableValues)
    .map(([k, v]) => `    '${psSingleQuote(k)}' { return "${psDoubleQuote(WorkspaceManager.resolveEnvToken(v))}" }`)
    .join('\n');

  const credEntries = Object.entries(settings.Assets.Credentials)
    .map(([k, c]) => {
      const user = WorkspaceManager.resolveEnvToken(c.Username);
      const pass = WorkspaceManager.resolveEnvToken(c.Password);
      return `    '${psSingleQuote(k)}' { return [PSCustomObject]@{ UserName='${psSingleQuote(user)}'; Password='${psSingleQuote(pass)}' } }`;
    })
    .join('\n');

  const connEntries = Object.entries(settings.Assets.Connections)
    .map(([k, c]) => {
      const hash = Object.entries(c)
        .map(([ck, cv]) => `'${psSingleQuote(ck)}'='${psSingleQuote(WorkspaceManager.resolveEnvToken(cv))}'`)
        .join('; ');
      return `    '${psSingleQuote(k)}' { return @{${hash}} }`;
    })
    .join('\n');

  const assets = templates.assets
    .replace('$ARW_VARIABLE_CASE', varEntries)
    .replace('$ARW_CREDENTIAL_CASE', credEntries)
    .replace('$ARW_CONNECTION_CASE', connEntries);

  return [
    `# AutomationAssetsMock.psm1 - Auto-generated by Azure Runbook Workbench${version ? ` v${version}` : ''} [@scoutmanpt]`,
    '# DO NOT COMMIT GENERATED FILES - they may contain resolved secrets',
    '',
    assets.trim(),
    '',
    templates.pnp.trim(),
    '',
    templates.graph.trim(),
    '',
    'Export-ModuleMember -Function Connect-PnPOnline, Get-PnPConnection, Disconnect-PnPOnline, Connect-MgGraph, Get-MgContext, Disconnect-MgGraph, Get-AutomationVariable, Get-AutomationCredential, Get-AutomationConnection',
    '',
  ].join('\n');
}

function renderPythonMock(
  template: string,
  settings: ReturnType<WorkspaceManager['readLocalSettings']>,
  pnpAppId: string,
  version?: string
): string {
  const vars = JSON.stringify(
    Object.fromEntries(
      Object.entries({
        ...(pnpAppId ? { PnPAppId: pnpAppId } : {}),
        ...settings.Assets.Variables,
      }).map(([k, v]) => [k, WorkspaceManager.resolveEnvToken(v)])
    ),
    null, 2
  );
  return template
    .replace('# automationstubs.py - Auto-generated by Azure Runbook Workbench [@scoutmanpt]',
      `# automationstubs.py - Auto-generated by Azure Runbook Workbench${version ? ` v${version}` : ''} [@scoutmanpt]`)
    .replace('{{VARIABLES_JSON}}', vars);
}

async function findPwsh(): Promise<string | undefined> {
  for (const candidate of ['pwsh', 'pwsh.exe', '/usr/bin/pwsh', '/usr/local/bin/pwsh']) {
    if (await commandExists(candidate)) { return candidate; }
  }
  return undefined;
}

async function findPython(): Promise<string | undefined> {
  for (const candidate of ['python3', 'python', 'python3.exe', 'python.exe']) {
    if (await commandExists(candidate)) { return candidate; }
  }
  return undefined;
}

function commandExists(cmd: string): Promise<boolean> {
  return new Promise(resolve => {
    const test = process.platform === 'win32'
      ? cp.spawn('where', [cmd])
      : cp.spawn('which', [cmd]);
    test.on('close', code => resolve(code === 0));
    test.on('error', () => resolve(false));
  });
}

function sanitizeConsoleText(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
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
  return false;
}

/**
 * Returns `Import-Module` lines for every module saved in the local cache.
 * Module directories follow the layout: <localModulesDir>/<ModuleName>/<Version>/
 * Since localModulesDir is already on $env:PSModulePath we import by name only.
 */
/**
 * Returns `Import-Module` lines for every module saved in the local cache.
 * Layout: <localModulesDir>/<ModuleName>/<Version>/<ModuleName>.psd1
 * Imports by the absolute path to the .psd1 manifest so PowerShell does not
 * have to do any name/path discovery.
 */
function buildCachedModuleImports(localModulesDir: string): string {
  if (!fs.existsSync(localModulesDir)) { return ''; }
  const imports: Array<{ moduleName: string; psd1: string }> = [];

  for (const entry of fs.readdirSync(localModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) { continue; }
    const moduleName = entry.name;
    const moduleRoot = path.join(localModulesDir, moduleName);

    // Pick the latest version subdirectory
    const versions = fs.readdirSync(moduleRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
    if (versions.length === 0) { continue; }

    const versionDir = path.join(moduleRoot, versions[0]);
    const psd1 = path.join(versionDir, `${moduleName}.psd1`).replace(/\\/g, '/');
    if (fs.existsSync(psd1.replace(/\//g, path.sep))) {
      imports.push({ moduleName, psd1 });
    }
  }

  if (imports.length === 0) { return ''; }
  return imports
    .map(({ moduleName, psd1 }) => [
      `try { Import-Module "${psd1}" -Force -ErrorAction Stop; Write-Host "[runbook-workbench] Imported module: ${moduleName}" }`,
      `catch { Write-Warning "[runbook-workbench] Failed to import module '${moduleName}': $_" }`,
    ].join('\n'))
    .join('\n');
}

function psSingleQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function psDoubleQuote(value: string): string {
  return value.replace(/`/g, '``').replace(/"/g, '`"');
}
