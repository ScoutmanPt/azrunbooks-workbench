import * as vscode from 'vscode';
import type { AzureService, AzureSubscription, AzureAutomationAccount, RunbookSummary, RuntimeEnvironmentSummary } from './azureService';
import type { AuthManager } from './authManager';
import { SubscriptionColorRegistry } from './subscriptionColorRegistry';
import { portalUrlForAccount, portalUrlForRunbook } from './portalUrls';

// ── Tree item kinds ───────────────────────────────────────────────────────────

export class SignInItem extends vscode.TreeItem {
  constructor() {
    super('Sign in to Azure…', vscode.TreeItemCollapsibleState.None);
    this.command = { command: 'runbookWorkbench.signIn', title: 'Sign in' };
    this.iconPath = new vscode.ThemeIcon('person');
    this.contextValue = 'signIn';
  }
}

export class SubscriptionItem extends vscode.TreeItem {
  constructor(public readonly subscription: AzureSubscription, color: string) {
    super(subscription.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = subscription.id;
    this.iconPath = new vscode.ThemeIcon('azure', new vscode.ThemeColor(color));
    this.contextValue = 'subscription';
    this.tooltip = `Tenant: ${subscription.tenantId}`;
  }
}

export class AutomationAccountItem extends vscode.TreeItem {
  constructor(public readonly account: AzureAutomationAccount, color: string, portalUrl: string) {
    super(account.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = account.resourceGroupName;
    this.iconPath = new vscode.ThemeIcon('server-process', new vscode.ThemeColor(color));
    this.contextValue = 'automationAccount';
    this.tooltip = [
      `${account.name} (${account.resourceGroupName}) | ${account.location}`,
      `Portal: ${portalUrl}`,
    ].join('\n');
  }
}

export type AccountSectionKind =
  | 'assets'
  | 'hybridWorkerGroups'
  | 'powershellModules'
  | 'pythonPackages'
  | 'recentJobs'
  | 'runtimeEnvironments'
  | 'runbooks'
  | 'schedules';

const SECTION_META: Record<AccountSectionKind, { label: string; icon: string; color?: string }> = {
  assets:             { label: 'Assets',               icon: 'symbol-variable' },
  hybridWorkerGroups: { label: 'Hybrid Worker Groups', icon: 'server' },
  powershellModules:  { label: 'Modules',      icon: 'terminal-powershell', color: 'charts.blue' },
  pythonPackages:     { label: 'Python Packages',      icon: 'symbol-misc',         color: 'charts.yellow' },
  recentJobs:         { label: 'Recent Jobs',          icon: 'history' },
  runtimeEnvironments:{ label: 'Execution Environments', icon: 'symbol-class',      color: 'charts.green' },
  runbooks:           { label: 'Runbooks',             icon: 'book' },
  schedules:          { label: 'Schedules',            icon: 'clock' },
};

export class AccountSectionItem extends vscode.TreeItem {
  constructor(
    public readonly account: AzureAutomationAccount,
    public readonly kind: AccountSectionKind,
    public readonly subscriptionColor: string
  ) {
    const meta = SECTION_META[kind];
    super(meta.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = meta.color
      ? new vscode.ThemeIcon(meta.icon, new vscode.ThemeColor(meta.color))
      : new vscode.ThemeIcon(meta.icon);
    this.contextValue = `accountSection_${kind}`;
  }
}

export class RunbookItem extends vscode.TreeItem {
  constructor(public readonly runbook: RunbookSummary, portalUrl: string) {
    super(runbook.name, vscode.TreeItemCollapsibleState.None);
    this.description = runbook.runtimeEnvironment
      ? `Env ${runbook.runtimeEnvironment}`
      : `Classic ${RunbookItem.shortType(runbook.runbookType)}`;
    this.iconPath = RunbookItem.iconForType(runbook.runbookType);
    this.contextValue = 'runbook';
    this.tooltip = [
      `Type: ${runbook.runbookType}`,
      runbook.runtimeEnvironment
        ? `Execution Environment: ${runbook.runtimeEnvironment}`
        : `Execution Model: Classic (${RunbookItem.friendlyType(runbook.runbookType)})`,
      `State: ${runbook.state}`,
      `Portal: ${portalUrl}`,
      runbook.description ? `\n${runbook.description}` : '',
    ].join('  ');
  }

  private static iconForType(runbookType: string): vscode.ThemeIcon {
    const t = runbookType.toLowerCase();
    if (t.startsWith('python')) {
      return new vscode.ThemeIcon('symbol-misc', new vscode.ThemeColor('charts.yellow'));
    }
    if (t.includes('graphpowershellworkflow') || t.includes('graphicalpowershellworkflow')) {
      return new vscode.ThemeIcon('type-hierarchy-sub', new vscode.ThemeColor('charts.red'));
    }
    if (t.startsWith('graph') || t.includes('graphical')) {
      return new vscode.ThemeIcon('type-hierarchy', new vscode.ThemeColor('charts.purple'));
    }
    if (t.includes('workflow')) {
      return new vscode.ThemeIcon('git-merge', new vscode.ThemeColor('charts.orange'));
    }
    if (t === 'powershell72' || t === 'powershell7') {
      return new vscode.ThemeIcon('terminal-powershell', new vscode.ThemeColor('terminal.ansiCyan'));
    }
    // PowerShell 5.1 / Script
    return new vscode.ThemeIcon('terminal-powershell', new vscode.ThemeColor('charts.blue'));
  }

  private static shortType(runbookType: string): string {
    const t = runbookType.toLowerCase();
    if (t === 'powershell72') { return 'PS 7.2'; }
    if (t === 'powershell7') { return 'PS 7.x'; }
    if (t === 'powershell') { return 'PS 5.1'; }
    if (t === 'python3') { return 'Py 3'; }
    if (t === 'python2') { return 'Py 2'; }
    return runbookType;
  }

  private static friendlyType(runbookType: string): string {
    const t = runbookType.toLowerCase();
    if (t === 'powershell72') { return 'PowerShell 7.2'; }
    if (t === 'powershell7') { return 'PowerShell 7.x'; }
    if (t === 'powershell') { return 'PowerShell 5.1'; }
    if (t === 'python3') { return 'Python 3'; }
    if (t === 'python2') { return 'Python 2'; }
    return runbookType;
  }
}

export class LoadingItem extends vscode.TreeItem {
  constructor(label = 'Loading…') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('loading~spin');
  }
}

export class ErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    this.tooltip = message;
  }
}

export class AccountSectionChildItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string | undefined,
    tooltip: string,
    iconId: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.tooltip = tooltip;
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = 'accountSectionChild';
  }
}

export class RuntimeEnvironmentItem extends vscode.TreeItem {
  constructor(
    public readonly account: AzureAutomationAccount,
    public readonly runtimeEnvironment: RuntimeEnvironmentSummary
  ) {
    super(runtimeEnvironment.name, vscode.TreeItemCollapsibleState.None);
    this.description = [runtimeEnvironment.language, runtimeEnvironment.version].filter(Boolean).join(' ')
      || runtimeEnvironment.provisioningState;
    this.tooltip = [
      runtimeEnvironment.description ? `Description: ${runtimeEnvironment.description}` : '',
      runtimeEnvironment.language ? `Language: ${runtimeEnvironment.language}` : '',
      runtimeEnvironment.version ? `Version: ${runtimeEnvironment.version}` : '',
      runtimeEnvironment.provisioningState ? `Provisioning State: ${runtimeEnvironment.provisioningState}` : '',
      runtimeEnvironment.defaultPackages && Object.keys(runtimeEnvironment.defaultPackages).length > 0
        ? `Packages: ${Object.entries(runtimeEnvironment.defaultPackages).map(([name, version]) => `${name}@${version}`).join(', ')}`
        : '',
    ].filter(Boolean).join('\n');
    this.iconPath = new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('charts.green'));
    this.contextValue = 'runtimeEnvironment';
  }
}

// ── Tree data provider ────────────────────────────────────────────────────────

type AccountTreeItem =
  | SignInItem
  | SubscriptionItem
  | AutomationAccountItem
  | AccountSectionItem
  | AccountSectionChildItem
  | RuntimeEnvironmentItem
  | RunbookItem
  | LoadingItem
  | ErrorItem;

export class AccountsTreeProvider
  implements vscode.TreeDataProvider<AccountTreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<AccountTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly auth: AuthManager,
    private readonly azure: AzureService,
    private readonly colorRegistry: SubscriptionColorRegistry
  ) {
    // Refresh tree when sign-in state changes
    auth.onDidSignInChange(() => this._onDidChangeTreeData.fire());
  }

  private colorForSubscription(subscriptionId: string): string {
    return this.colorRegistry.getColor(subscriptionId);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AccountTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AccountTreeItem): Promise<AccountTreeItem[]> {
    // Root level - show sign-in prompt or subscriptions
    if (!element) {
      if (!this.auth.isSignedIn) {
        if (!this.auth.shouldAttemptSilentSignIn) {
          return [new SignInItem()];
        }
        const signed = await this.auth.signIn(true /* silent */);
        if (!signed) {
          return [new SignInItem()];
        }
      }
      return this.loadSubscriptions();
    }

    if (element instanceof SubscriptionItem) {
      return this.loadAutomationAccounts(element.subscription);
    }

    if (element instanceof AutomationAccountItem) {
      const kinds: AccountSectionKind[] = [
        'runbooks', 'recentJobs', 'schedules', 'powershellModules',
        'pythonPackages', 'runtimeEnvironments', 'assets', 'hybridWorkerGroups',
      ];
      const color = this.colorForSubscription(element.account.subscriptionId);
      return kinds.map(k => new AccountSectionItem(element.account, k, color));
    }

    if (element instanceof AccountSectionItem) {
      if (element.kind === 'runbooks') {
        return this.loadRunbooks(element.account);
      }
      return this.loadSectionChildren(element.account, element.kind);
    }

    return [];
  }

  private async loadSubscriptions(): Promise<AccountTreeItem[]> {
    try {
      const subs = await this.azure.listSubscriptions();
      if (subs.length === 0) {
        return [new ErrorItem('No subscriptions found for this account.')];
      }
      return subs.map(s => new SubscriptionItem(s, this.colorForSubscription(s.id)));
    } catch (err) {
      return [new ErrorItem(`Failed to load subscriptions: ${String(err)}`)];
    }
  }

  private async loadAutomationAccounts(subscription: AzureSubscription): Promise<AccountTreeItem[]> {
    try {
      const color = this.colorForSubscription(subscription.id);
      const accounts = await this.azure.listAutomationAccounts(subscription.id, subscription.name);
      if (accounts.length === 0) {
        return [new ErrorItem('No Automation Accounts in this subscription.')];
      }
      const cloudName = this.auth.getCloudName();
      return accounts.map(a => new AutomationAccountItem(a, color, portalUrlForAccount({
        subscriptionId: a.subscriptionId,
        resourceGroupName: a.resourceGroupName,
        name: a.name,
      }, cloudName)));
    } catch (err) {
      return [new ErrorItem(`Failed to load accounts: ${String(err)}`)];
    }
  }

  private async loadRunbooks(account: AzureAutomationAccount): Promise<AccountTreeItem[]> {
    try {
      const runbooks = await this.azure.listRunbooks(
        account.subscriptionId,
        account.resourceGroupName,
        account.name,
        account.subscriptionName
      );
      if (runbooks.length === 0) {
        return [new ErrorItem('No runbooks in this account.')];
      }
      const cloudName = this.auth.getCloudName();
      return runbooks.map(r => new RunbookItem(r, portalUrlForRunbook({
        subscriptionId: r.subscriptionId,
        resourceGroupName: r.resourceGroupName,
        name: r.accountName,
        runbookName: r.name,
      }, cloudName)));
    } catch (err) {
      return [new ErrorItem(`Failed to load runbooks: ${String(err)}`)];
    }
  }

  private async loadSectionChildren(
    account: AzureAutomationAccount,
    kind: Exclude<AccountSectionKind, 'runbooks'>
  ): Promise<AccountTreeItem[]> {
    try {
      switch (kind) {
        case 'recentJobs': {
          const jobs = await this.azure.listRecentJobs(account.subscriptionId, account.resourceGroupName, account.name);
          if (jobs.length === 0) { return [new ErrorItem('No recent jobs in this account.')]; }
          return jobs.map(job => new AccountSectionChildItem(
            job.runbookName || job.jobId,
            job.status,
            [
              `Job ID: ${job.jobId}`,
              job.runbookName ? `Runbook: ${job.runbookName}` : '',
              job.status ? `Status: ${job.status}` : '',
              job.startTime ? `Started: ${job.startTime}` : '',
              job.endTime ? `Ended: ${job.endTime}` : '',
            ].filter(Boolean).join('\n'),
            'play-circle'
          ));
        }
        case 'schedules': {
          const schedules = await this.azure.listSchedules(account.subscriptionId, account.resourceGroupName, account.name);
          if (schedules.length === 0) { return [new ErrorItem('No schedules in this account.')]; }
          return schedules.map(schedule => new AccountSectionChildItem(
            schedule.name,
            schedule.frequency,
            [
              `Frequency: ${schedule.frequency}`,
              `Interval: ${String(schedule.interval ?? '')}`,
              schedule.nextRun ? `Next Run: ${schedule.nextRun}` : '',
              `Enabled: ${schedule.isEnabled ? 'Yes' : 'No'}`,
            ].filter(Boolean).join('\n'),
            'calendar'
          ));
        }
        case 'powershellModules': {
          const modules = await this.azure.listImportedModules(account.subscriptionId, account.resourceGroupName, account.name);
          if (modules.length === 0) { return [new ErrorItem('No PowerShell modules in this account.')]; }
          return modules.map(mod => new AccountSectionChildItem(
            mod.name,
            mod.version,
            `Provisioning State: ${mod.provisioningState}`,
            'package'
          ));
        }
        case 'pythonPackages': {
          const packages = await this.azure.listPythonPackages(account.subscriptionId, account.resourceGroupName, account.name);
          if (packages.length === 0) { return [new ErrorItem('No Python packages in this account.')]; }
          return packages.map(pkg => new AccountSectionChildItem(
            pkg.name,
            `Py${pkg.pythonVersion} · ${pkg.version}`,
            `Provisioning State: ${pkg.provisioningState}`,
            'package'
          ));
        }
        case 'runtimeEnvironments': {
          const runtimes = await this.azure.listRuntimeEnvironments(account.subscriptionId, account.resourceGroupName, account.name);
          if (runtimes.length === 0) { return [new ErrorItem('No runtime environments in this account.')]; }
          return runtimes.map(runtime => new RuntimeEnvironmentItem(account, runtime));
        }
        case 'assets': {
          const [variables, credentials, connections, certificates] = await Promise.all([
            this.azure.listVariables(account.subscriptionId, account.resourceGroupName, account.name),
            this.azure.listCredentials(account.subscriptionId, account.resourceGroupName, account.name),
            this.azure.listConnections(account.subscriptionId, account.resourceGroupName, account.name),
            this.azure.listCertificates(account.subscriptionId, account.resourceGroupName, account.name),
          ]);

          const items: AccountTreeItem[] = [
            ...variables.map(variable => new AccountSectionChildItem(
              variable.name,
              variable.isEncrypted ? 'Variable · Encrypted' : 'Variable',
              variable.isEncrypted
                ? 'Encrypted variable'
                : `Value: ${variable.value ?? ''}`,
              'symbol-variable'
            )),
            ...credentials.map(credential => new AccountSectionChildItem(
              credential.name,
              'Credential',
              [
                credential.userName ? `Username: ${credential.userName}` : '',
                credential.description ? `Description: ${credential.description}` : '',
              ].filter(Boolean).join('\n') || 'Credential',
              'key'
            )),
            ...connections.map(connection => new AccountSectionChildItem(
              connection.name,
              'Connection',
              [
                connection.connectionType ? `Type: ${connection.connectionType}` : '',
                connection.description ? `Description: ${connection.description}` : '',
              ].filter(Boolean).join('\n') || 'Connection',
              'plug'
            )),
            ...certificates.map(certificate => new AccountSectionChildItem(
              certificate.name,
              'Certificate',
              [
                certificate.thumbprint ? `Thumbprint: ${certificate.thumbprint}` : '',
                certificate.expiryTime ? `Expiry: ${certificate.expiryTime}` : '',
                certificate.isExportable ? 'Exportable' : 'Not exportable',
                certificate.description ? `Description: ${certificate.description}` : '',
              ].filter(Boolean).join('\n') || 'Certificate',
              'shield'
            )),
          ];

          return items.length > 0 ? items : [new ErrorItem('No assets in this account.')];
        }
        case 'hybridWorkerGroups': {
          const groups = await this.azure.listHybridWorkerGroups(account.subscriptionId, account.resourceGroupName, account.name);
          if (groups.length === 0) { return [new ErrorItem('No hybrid worker groups in this account.')]; }
          return groups.map(group => new AccountSectionChildItem(
            group.name,
            group.groupType,
            group.groupType ? `Group Type: ${group.groupType}` : 'Hybrid worker group',
            'server'
          ));
        }
      }
    } catch (err) {
      const label = SECTION_META[kind].label;
      return [new ErrorItem(`Failed to load ${label}: ${String(err)}`)];
    }
  }
}
