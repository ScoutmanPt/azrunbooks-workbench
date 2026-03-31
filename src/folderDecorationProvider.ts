import * as vscode from 'vscode';
import * as path from 'path';
import type { WorkspaceManager } from './workspaceManager';
import type { SubscriptionColorRegistry } from './subscriptionColorRegistry';

// ── Runtime badge map ─────────────────────────────────────────────────────────

const RUNTIME_DECORATIONS: Record<string, { badge: string; tooltip: string }> = {
  'Script':                      { badge: '51', tooltip: 'PowerShell 5.1' },
  'PowerShell':                  { badge: '51', tooltip: 'PowerShell 5.1' },
  'PowerShellWorkflow':          { badge: 'WF', tooltip: 'PowerShell Workflow 5.1' },
  'PowerShell7':                 { badge: '71', tooltip: 'PowerShell 7.1' },
  'PowerShell72':                { badge: '72', tooltip: 'PowerShell 7.2' },
  'Python2':                     { badge: 'P2', tooltip: 'Python 2' },
  'Python3':                     { badge: 'P3', tooltip: 'Python 3' },
  'Graph':                       { badge: 'GR', tooltip: 'Graphical PowerShell' },
  'GraphPowerShell':             { badge: 'GR', tooltip: 'Graphical PowerShell' },
  'GraphicalPowerShell':         { badge: 'GR', tooltip: 'Graphical PowerShell' },
  'GraphPowerShellWorkflow':     { badge: 'GW', tooltip: 'Graphical PowerShell Workflow' },
  'GraphicalPowerShellWorkflow': { badge: 'GW', tooltip: 'Graphical PowerShell Workflow' },
};

function runtimeDecoration(runbookType: string, runtimeEnvironment?: string): vscode.FileDecoration | undefined {
  const meta = RUNTIME_DECORATIONS[runbookType];
  if (!meta) { return undefined; }
  if (runtimeEnvironment) {
    return {
      badge: 'E',
      tooltip: `Execution Environment linked · ${runtimeEnvironment} · ${meta.tooltip}`,
      color: new vscode.ThemeColor('charts.green'),
    };
  }
  return {
    badge: meta.badge,
    tooltip: `${meta.tooltip} · Classic execution`,
  };
}

/**
 * Badges .ps1 and .py runbook files in the VS Code explorer.
 * Classic runbooks show the runtime version badge (e.g. "72" or "P3"),
 * while Execution-Environment-linked runbooks show a strong green "E" badge.
 * The Workspace tree is the authoritative place for the full environment name.
 */
export class RunbookRuntimeDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<undefined | vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  constructor(private readonly workspace: WorkspaceManager) {}

  /** Pass specific URIs to refresh only those files, or no argument to refresh all. */
  refresh(uris?: vscode.Uri[]): void {
    // Firing undefined tells VS Code to re-query ALL file decorations from this provider.
    // Firing [] is a no-op - always pass undefined when doing a full refresh.
    this._onDidChangeFileDecorations.fire(uris ?? undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') { return undefined; }
    if (!this.workspace.isWorkspaceOpen) { return undefined; }

    const fsPath = uri.fsPath;
    const ext = path.extname(fsPath).toLowerCase();
    if (ext !== '.ps1' && ext !== '.py') { return undefined; }

    const accountsDir = this.workspace.accountsDir;
    if (!fsPath.startsWith(accountsDir + path.sep)) { return undefined; }

    // First path segment after accountsDir is the account name
    const rel = path.relative(accountsDir, fsPath);
    const accountName = rel.split(path.sep)[0];
    const runbookName = path.basename(fsPath, ext);

    const meta = this.workspace.getRunbookMeta(accountName);
    const runbookMeta = meta[runbookName];
    return runbookMeta ? runtimeDecoration(runbookMeta.runbookType, runbookMeta.runtimeEnvironment) : undefined;
  }
}

/**
 * Adds stable file-explorer tooltips for linked automation account folders.
 * VS Code only shows decoration tooltips reliably when there is a visible
 * decoration target, so we use a subtle neutral badge while keeping the folder
 * label text at the default theme color.
 */
export class RunbookFolderDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<undefined | vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  /** Cached per-account dir → tooltip text; invalidated on refresh(). */
  private _tooltipCache: Map<string, string> | undefined;

  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly colorRegistry: SubscriptionColorRegistry
  ) {}

  /** Call this after workspace changes (init / unlink) to repaint. */
  refresh(uris?: vscode.Uri[]): void {
    this._tooltipCache = undefined;
    this._onDidChangeFileDecorations.fire(uris ?? undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') { return undefined; }
    if (!this.workspace.isWorkspaceOpen) { return undefined; }

    const accountsDir = this.workspace.accountsDir;
    const fsPath = uri.fsPath;

    // Must be inside the accounts/ directory
    if (!fsPath.startsWith(accountsDir + path.sep) && fsPath !== accountsDir) {
      return undefined;
    }

    // Build cache once per refresh cycle
    if (!this._tooltipCache) {
      this._tooltipCache = new Map();
      for (const account of this.workspace.getLinkedAccounts()) {
        const accountDir = this.workspace.accountDirForAccount(account.accountName);
        const accountTooltip =
          `${account.accountName} (${account.resourceGroup})${account.location ? ` | ${account.location}` : ''} | ${account.subscriptionName}`;

        this._tooltipCache.set(
          accountDir,
          accountTooltip
        );
      }
    }

    // Decorate only the account root folder.
    const tooltip = this._tooltipCache.get(fsPath);
    return tooltip ? { badge: 'i', tooltip } : undefined;
  }
}

type LocalStateDecoration = {
  readonly rootPath: string;
  readonly badge: string;
  readonly tooltip: string;
};

/**
 * Adds subtle badges to local-only generated/cache content that cannot receive
 * path-scoped custom SVG icons through the icon theme system.
 */
export class LocalStateDecorationProvider implements vscode.FileDecorationProvider {
  constructor(private readonly workspace: WorkspaceManager) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') { return undefined; }
    if (!this.workspace.isWorkspaceOpen) { return undefined; }

    const fsPath = uri.fsPath;
    const decorations: LocalStateDecoration[] = [
      {
        rootPath: this.workspace.workspaceCacheDir,
        badge: 'C',
        tooltip: 'Workspace cache',
      },
      {
        rootPath: this.workspace.localModulesDir,
        badge: 'M',
        tooltip: 'Local debug module sandbox',
      },
    ];

    for (const decoration of decorations) {
      if (fsPath === decoration.rootPath || fsPath.startsWith(decoration.rootPath + path.sep)) {
        return {
          badge: decoration.badge,
          color: new vscode.ThemeColor('disabledForeground'),
          tooltip: decoration.tooltip,
        };
      }
    }

    if (fsPath.includes(`${path.sep}tmp${path.sep}`) && fsPath.includes(`${path.sep}generated${path.sep}`)) {
      return {
        badge: 'G',
        color: new vscode.ThemeColor('disabledForeground'),
        tooltip: 'Generated mock content',
      };
    }

    // Badge the tmp root itself (exact match only — children get their own badges above)
    if (fsPath === this.workspace.tempArtifactsRootDir) {
      return {
        badge: 'T',
        color: new vscode.ThemeColor('disabledForeground'),
        tooltip: 'Temporary run/debug artifacts — safe to delete',
      };
    }

    return undefined;
  }
}
