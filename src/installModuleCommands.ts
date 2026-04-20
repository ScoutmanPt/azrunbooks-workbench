import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LocalRunner } from './localRunner';

export async function executeInstallModuleForLocalDebug(
  item: unknown,
  runner: LocalRunner,
  outputChannel: vscode.OutputChannel,
  forceSource?: 'gallery' | 'local'
): Promise<void> {
  let sourceValue: 'gallery' | 'local';

  if (forceSource) {
    sourceValue = forceSource;
  } else {
    const source = await vscode.window.showQuickPick(
      [
        { label: '$(cloud-download) From PowerShell Gallery', value: 'gallery' as const },
        { label: '$(folder-opened) From local file or folder', value: 'local' as const },
      ],
      {
        title: 'Install Module for Local Debug',
        placeHolder: 'Choose module source',
        ignoreFocusOut: true,
      }
    );
    if (!source) { return; }
    sourceValue = source.value;
  }

  if (sourceValue === 'local') {
    await executeImportLocalModule(runner, outputChannel);
    return;
  }

  const defaultName = inferPowerShellModuleName(item);
  const moduleSearch = await vscode.window.showInputBox({
    title: 'Install Module for Local Debug',
    prompt: 'Search PowerShell Gallery for a module name to save into .settings/cache/modules',
    value: defaultName,
    ignoreFocusOut: true,
  });
  if (!moduleSearch?.trim()) { return; }

  let moduleName = moduleSearch.trim();
  try {
    const matches = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Loading modules matching "${moduleName}"...`,
      },
      async () => runner.searchPowerShellModules(moduleName)
    );
    if (matches.length) {
      const exactMatch = matches.some(match => match.localeCompare(moduleName, undefined, { sensitivity: 'base' }) === 0);
      const pickedModule = await vscode.window.showQuickPick(
        [
          ...(!exactMatch ? [{
            label: moduleName,
            value: moduleName,
            description: 'Use exactly what I typed',
          }] : []),
          ...matches.map(match => ({
            label: match,
            value: match,
            description: match.localeCompare(moduleName, undefined, { sensitivity: 'base' }) === 0
              ? 'Exact match'
              : undefined,
          })),
        ],
        {
          title: 'Install Module for Local Debug',
          placeHolder: 'Select a PowerShell Gallery module',
          ignoreFocusOut: true,
        }
      );
      if (!pickedModule) { return; }
      moduleName = pickedModule.value;
    } else {
      void vscode.window.showWarningMessage(
        `No module names were returned from PowerShell Gallery for "${moduleName}". The typed name will be used.`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(
      `Could not query the PowerShell Gallery for module names matching "${moduleName}": ${msg}. The typed name will be used.`
    );
    outputChannel.appendLine(`[local-modules] Module search failed for "${moduleName}": ${msg}`);
  }

  let requiredVersion: string | undefined;
  try {
    let versions = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Loading versions for "${moduleName}"...`,
      },
      async () => runner.listPowerShellModuleVersions(moduleName, false)
    );
    let includePrerelease = false;
    if (!versions.length) {
      versions = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Loading prerelease versions for "${moduleName}"...`,
        },
        async () => runner.listPowerShellModuleVersions(moduleName, true)
      );
      includePrerelease = true;
    }
    if (versions.length) {
      for (;;) {
        const pickedVersion = await vscode.window.showQuickPick(
          [
            { label: 'Latest available version', value: '' },
            ...(!includePrerelease ? [{
              label: 'Show prerelease versions',
              value: '__show_prerelease__',
              description: 'Nightly, preview, and other prerelease builds',
            }] : []),
            ...versions.map(version => ({
              label: version,
              value: version,
              description: version === versions[0]
                ? (includePrerelease ? 'Latest prerelease in PowerShell Gallery' : 'Latest stable in PowerShell Gallery')
                : undefined,
            })),
          ],
          {
            title: 'Install Module for Local Debug',
            placeHolder: includePrerelease
              ? 'Select a PowerShell Gallery version (including prerelease)'
              : 'Select a PowerShell Gallery version',
            ignoreFocusOut: true,
          }
        );
        if (!pickedVersion) { return; }
        if (pickedVersion.value === '__show_prerelease__') {
          versions = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Loading prerelease versions for "${moduleName}"...`,
            },
            async () => runner.listPowerShellModuleVersions(moduleName, true)
          );
          includePrerelease = true;
          continue;
        }
        requiredVersion = pickedVersion.value || undefined;
        break;
      }
    } else {
      requiredVersion = undefined;
      void vscode.window.showWarningMessage(
        `No versions were returned from PowerShell Gallery for "${moduleName}". The latest version will be used if available.`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(
      `Could not query the PowerShell Gallery for "${moduleName}": ${msg}`
    );
    const fallback = await vscode.window.showInputBox({
      title: 'Install Module for Local Debug',
      prompt: `Could not query PowerShell Gallery versions. Enter an optional exact version for ${moduleName} or leave blank for latest.`,
      ignoreFocusOut: true,
    });
    if (fallback === undefined) { return; }
    requiredVersion = fallback.trim() || undefined;
    outputChannel.appendLine(`[local-modules] Version lookup failed for "${moduleName}": ${msg}`);
  }

  // Resolve a concrete version before dependency check
  const resolvedVersion = requiredVersion?.trim()
    || (await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Resolving latest version of "${moduleName}"…` },
      async () => (await runner.listPowerShellModuleVersions(moduleName, false))[0]
    ));
  if (!resolvedVersion) {
    void vscode.window.showErrorMessage(`No installable versions found for "${moduleName}" on PowerShell Gallery.`);
    return;
  }

  // Detect transitive dependencies not already in cache
  let deps: Array<{ name: string; version: string }> = [];
  try {
    deps = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking dependencies for "${moduleName}"…` },
      async () => runner.resolveModuleDependencies(moduleName, resolvedVersion)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[local-modules] Dependency resolution failed for "${moduleName}@${resolvedVersion}": ${msg}`);
  }

  if (deps.length > 0) {
    const depList = deps.map(d => `• ${d.name} (${d.version})`).join('\n');
    const choice = await vscode.window.showWarningMessage(
      `"${moduleName}" has ${deps.length} uninstalled dependenc${deps.length === 1 ? 'y' : 'ies'} that will also be downloaded:\n\n${depList}`,
      { modal: true },
      'Install All'
    );
    if (choice !== 'Install All') { return; }
  }

  const total = deps.length + 1;
  const label = total > 1 ? `"${moduleName}" and ${deps.length} dependenc${deps.length === 1 ? 'y' : 'ies'}` : `"${moduleName}"`;

  void vscode.window.showInformationMessage(`Downloading ${label}…`);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading ${label}…` },
      async () => {
        await runner.installModuleWithDependencies(moduleName, resolvedVersion, deps);
      }
    );
    void vscode.window.showInformationMessage(`Downloaded ${label} — done.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Failed to download ${label}: ${msg}`);
  }
}

function inferPowerShellModuleName(item: unknown): string {
  if (item instanceof vscode.Uri && path.extname(item.fsPath).toLowerCase() === '.ps1') {
    try {
      const content = fs.readFileSync(item.fsPath, 'utf8');
      const match = content.match(/^\s*#requires\s+-Modules?\s+([A-Za-z0-9_.-]+)/mi)
        ?? content.match(/^\s*Import-Module\s+([A-Za-z0-9_.-]+)/mi)
        ?? content.match(/^\s*using\s+module\s+([A-Za-z0-9_.-]+)/mi);
      return match?.[1] ?? '';
    } catch {
      return '';
    }
  }
  return '';
}

async function executeImportLocalModule(
  runner: LocalRunner,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    title: 'Select a PowerShell module file or folder',
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    filters: { 'PowerShell Module': ['psd1', 'psm1'], 'All Files': ['*'] },
    openLabel: 'Import Module',
  });
  if (!uris?.length) { return; }
  const selectedPath = uris[0].fsPath;

  let moduleName = '';
  let detectedVersion: string | undefined;

  const stat = fs.statSync(selectedPath);
  if (stat.isDirectory()) {
    moduleName = path.basename(selectedPath);
    const psd1File = fs.readdirSync(selectedPath).find(f => f.toLowerCase().endsWith('.psd1'));
    if (psd1File) {
      const nameWithoutExt = path.basename(psd1File, path.extname(psd1File));
      if (nameWithoutExt) { moduleName = nameWithoutExt; }
      detectedVersion = extractVersionFromPsd1(fs.readFileSync(path.join(selectedPath, psd1File), 'utf8'));
    }
  } else {
    const ext = path.extname(selectedPath).toLowerCase();
    moduleName = path.basename(selectedPath, ext);
    if (ext === '.psd1') {
      detectedVersion = extractVersionFromPsd1(fs.readFileSync(selectedPath, 'utf8'));
    }
  }

  const confirmedName = await vscode.window.showInputBox({
    title: 'Import Local Module',
    prompt: 'Module name (used as the sandbox folder name)',
    value: moduleName,
    ignoreFocusOut: true,
  });
  if (!confirmedName?.trim()) { return; }

  const confirmedVersion = await vscode.window.showInputBox({
    title: 'Import Local Module',
    prompt: 'Module version',
    value: detectedVersion ?? '1.0.0',
    ignoreFocusOut: true,
  });
  if (!confirmedVersion?.trim()) { return; }

  const finalName = confirmedName.trim();
  const finalVersion = confirmedVersion.trim();

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Importing "${finalName}" into local sandbox…` },
      async () => runner.importLocalModuleFromPath(selectedPath, finalName, finalVersion)
    );
    void vscode.window.showInformationMessage(
      `Imported "${finalName}" (${finalVersion}) into .settings/cache/modules.`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[local-modules] Import of local module "${finalName}" failed: ${msg}`);
    void vscode.window.showErrorMessage(`Failed to import module "${finalName}": ${msg}`);
  }
}

function extractVersionFromPsd1(content: string): string | undefined {
  return content.match(/ModuleVersion\s*=\s*['"]([^'"]+)['"]/)?.[1];
}
