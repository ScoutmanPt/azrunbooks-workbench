import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceManager, type WorkspaceRunbookFile, type LinkedAccount } from './workspaceManager';
import { SubscriptionColorRegistry } from './subscriptionColorRegistry';
import type { AzureCloudName } from './cloudConfig';
import { portalUrlForAccount, portalUrlForRunbook } from './portalUrls';

const LINKED_TWIN_SCHEME = 'runbookWorkbench-linked';

export class LinkedTwinDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== LINKED_TWIN_SCHEME) { return undefined; }
    return {
      badge: '↔',
      tooltip: 'Published and Draft have identical content',
      color: new vscode.ThemeColor('charts.blue'),
    };
  }
}

// ── Section definitions ────────────────────────────────────────────────────────

export type WorkspaceSection =
  | 'runbooks'
  | 'recentJobs'
  | 'schedules'
  | 'powershellModules'
  | 'assets'
  | 'pythonPackages'
  | 'runtimeEnvironments'
  | 'hybridWorkerGroups';

const SECTION_ORDER: WorkspaceSection[] = [
  'runbooks', 'recentJobs', 'schedules', 'powershellModules',
  'assets', 'pythonPackages', 'runtimeEnvironments', 'hybridWorkerGroups',
];

const SECTION_META: Record<WorkspaceSection, { label: string; icon: string; color?: string }> = {
  runbooks:           { label: 'Runbooks',             icon: 'book' },
  recentJobs:         { label: 'Recent Jobs',          icon: 'history' },
  schedules:          { label: 'Schedules',            icon: 'clock' },
  powershellModules:  { label: 'Modules',      icon: 'terminal-powershell', color: 'charts.blue' },
  assets:             { label: 'Assets',               icon: 'symbol-variable' },
  pythonPackages:     { label: 'Python Packages',      icon: 'symbol-misc',         color: 'charts.yellow' },
  runtimeEnvironments:{ label: 'Execution Environments', icon: 'symbol-class',      color: 'charts.green' },
  hybridWorkerGroups: { label: 'Hybrid Worker Groups', icon: 'server' },
};

const SECTION_FOLDER: Record<WorkspaceSection, string> = {
  runbooks:           'Runbooks',
  recentJobs:         'RecentJobs',
  schedules:          'Schedules',
  powershellModules:  'PowerShellModules',
  assets:             'Assets',
  pythonPackages:     'PythonPackages',
  runtimeEnvironments:'RuntimeEnvironments',
  hybridWorkerGroups: 'HybridWorkerGroups',
};

const SECTION_CHILD_ICON: Record<WorkspaceSection, string> = {
  runbooks:           'book',
  recentJobs:         'play-circle',
  schedules:          'calendar',
  powershellModules:  'package',
  assets:             'symbol-variable',
  pythonPackages:     'package',
  runtimeEnvironments:'symbol-class',
  hybridWorkerGroups: 'server',
};

// ── Tree item types ────────────────────────────────────────────────────────────

type WorkspaceTreeItem =
  | WorkspaceAccountItem
  | WorkspaceSectionItem
  | WorkspaceRunbookItem
  | WorkspaceSectionChildItem;

// ── Provider ──────────────────────────────────────────────────────────────────

export class WorkspaceRunbooksTreeProvider implements vscode.TreeDataProvider<WorkspaceTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<WorkspaceTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly colorRegistry: SubscriptionColorRegistry,
    private readonly getCloudName: () => AzureCloudName = () => 'AzureCloud'
  ) {}

  refresh(): void { this._onDidChangeTreeData.fire(); }

  getTreeItem(element: WorkspaceTreeItem): vscode.TreeItem { return element; }

  async getChildren(element?: WorkspaceTreeItem): Promise<WorkspaceTreeItem[]> {
    // Root level
    if (!element) {
      const accounts = this.workspace.getLinkedAccounts();
      // Multiple accounts: group by account node
      if (accounts.length > 1) {
        return accounts.map(a =>
          new WorkspaceAccountItem(a, this.colorRegistry.getColor(a.subscriptionId), this.getCloudName)
        );
      }
      // 0 or 1 account: always show the workspace sections directly (accountName = '' when none linked)
      const accountName = accounts[0]?.accountName ?? '';
      return SECTION_ORDER.map(s => new WorkspaceSectionItem(accountName, s));
    }

    // Account node (only reached in multi-account mode)
    if (element instanceof WorkspaceAccountItem) {
      return SECTION_ORDER.map(s => new WorkspaceSectionItem(element.accountName, s));
    }

    // No account linked yet - show prompt inside every section
    if (element instanceof WorkspaceSectionItem && !element.accountName) {
      return [new WorkspaceEmptyItem('No account linked - initialize workspace first')];
    }

    // Runbooks section: read from disk
    if (element instanceof WorkspaceSectionItem && element.section === 'runbooks') {
      const runbooks = this.workspace.listWorkspaceRunbooks()
        .filter(r => r.accountName === element.accountName);
      if (runbooks.length === 0) {
        return [new WorkspaceEmptyItem('No runbooks fetched yet')];
      }
      return runbooks.map(r => new WorkspaceRunbookItem(
        r,
        this.workspace.getLinkedAccount(r.accountName),
        this.getCloudName
      ));
    }

    // Other sections: read JSON files from the section folder
    if (element instanceof WorkspaceSectionItem) {
      const folder = SECTION_FOLDER[element.section];
      const items = this.workspace.listSectionItemFiles(element.accountName, folder);
      if (items.length === 0) {
        return [new WorkspaceEmptyItem(
          this.workspace.hasSectionBeenFetched(element.accountName, folder)
            ? 'Fetched, but Azure returned no items'
            : 'Not fetched yet'
        )];
      }
      return items.map(item => new WorkspaceSectionChildItem(item.name, item.data, element.section));
    }

    return [];
  }
}

// ── Tree items ────────────────────────────────────────────────────────────────

export class WorkspaceAccountItem extends vscode.TreeItem {
  public readonly accountName: string;

  constructor(account: LinkedAccount, color: string, getCloudName: () => AzureCloudName) {
    super(account.accountName, vscode.TreeItemCollapsibleState.Expanded);
    this.accountName = account.accountName;
    this.iconPath = new vscode.ThemeIcon('server-process', new vscode.ThemeColor(color));
    this.contextValue = 'workspaceAccount';
    this.description = account.subscriptionName;
    this.tooltip = [
      `${account.accountName} (${account.resourceGroup})`,
      `Portal: ${portalUrlForAccount({
        subscriptionId: account.subscriptionId,
        resourceGroupName: account.resourceGroup,
        name: account.accountName,
      }, getCloudName())}`,
    ].join('\n');
  }
}

export class WorkspaceSectionItem extends vscode.TreeItem {
  constructor(
    public readonly accountName: string,
    public readonly section: WorkspaceSection
  ) {
    const meta = SECTION_META[section];
    super(meta.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = meta.color
      ? new vscode.ThemeIcon(meta.icon, new vscode.ThemeColor(meta.color))
      : new vscode.ThemeIcon(meta.icon);
    this.contextValue = `workspaceSection_${section}`;
  }
}

export class WorkspaceEmptyItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'workspaceEmpty';
  }
}

export class WorkspaceSectionChildItem extends vscode.TreeItem {
  constructor(name: string, data: Record<string, unknown>, section: WorkspaceSection) {
    // For recent jobs, use runbook name as display label
    const label = section === 'recentJobs'
      ? String(data.runbookName ?? name)
      : name;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(SECTION_CHILD_ICON[section]);
    this.contextValue = `workspaceSectionChild_${section}`;
    // Build a meaningful description from the data
    const desc = [
      data.version, data.frequency, data.status, data.groupType,
      data._type, data.isEnabled === false ? 'disabled' : undefined,
    ].filter(v => v !== undefined && v !== null && v !== '').join(' · ');
    this.description = desc || undefined;
    this.tooltip = JSON.stringify(data, null, 2);
  }
}

export class WorkspaceRunbookItem extends vscode.TreeItem {
  public readonly accountName: string;
  public readonly runbookName: string;
  public readonly filePath: string;
  public readonly runbookType: string;
  public readonly localHash: string;
  public readonly subfolder?: string;
  public readonly deployedHash?: string;
  public readonly ahead: boolean;
  public readonly linkedTwin: boolean;

  constructor(
    runbook: WorkspaceRunbookFile,
    linkedAccount: LinkedAccount | undefined,
    getCloudName: () => AzureCloudName
  ) {
    super(runbook.runbookName, vscode.TreeItemCollapsibleState.None);
    this.accountName = runbook.accountName;
    this.runbookName = runbook.runbookName;
    this.filePath = runbook.filePath;
    this.runbookType = runbook.runbookType;
    this.localHash = runbook.localHash;
    this.subfolder = runbook.subfolder;
    this.deployedHash = runbook.deployedHash;
    this.ahead = Boolean(this.deployedHash) && this.deployedHash !== this.localHash;
    this.linkedTwin = runbook.linkedTwin ?? false;

    if (this.linkedTwin) {
      this.resourceUri = vscode.Uri.parse(
        `${LINKED_TWIN_SCHEME}://${runbook.accountName}/${runbook.subfolder ?? 'root'}/${runbook.runbookName}`
      );
    }

    this.description = runbook.runtimeEnvironment
      ? `Env ${runbook.runtimeEnvironment}`
      : this.ahead
        ? 'Classic · AHEAD'
        : `Classic ${path.extname(runbook.filePath)}`;
    this.contextValue = 'workspaceRunbook';
    this.command = {
      command: 'runbookWorkbench.openWorkspaceRunbook',
      title: 'Open Workspace Runbook',
      arguments: [this],
    };
    this.iconPath = this.ahead
      ? new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.red'))
      : new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    this.tooltip = [
      `Account: ${this.accountName}`,
      `${this.runbookType} ${path.extname(runbook.filePath)}`,
      runbook.runtimeEnvironment
        ? `Execution Environment: ${runbook.runtimeEnvironment}`
        : 'Execution Model: Classic',
      this.ahead ? 'Local changes not published' : 'Up to date with deployed hash',
      `Local: ${this.localHash.slice(0, 12)}`,
      this.deployedHash ? `Deployed: ${this.deployedHash.slice(0, 12)}` : 'Deployed: unknown',
      linkedAccount ? `Portal: ${portalUrlForRunbook({
        subscriptionId: linkedAccount.subscriptionId,
        resourceGroupName: linkedAccount.resourceGroup,
        name: linkedAccount.accountName,
        runbookName: runbook.runbookName,
      }, getCloudName())}` : 'Portal: unavailable',
    ].join('\n');
  }
}
