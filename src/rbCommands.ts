import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { AzureAutomationAccount, AzureService, RunbookSummary, RuntimeEnvironmentCreateRequest } from './azureService';
import { AccountSectionItem, AutomationAccountItem, RunbookItem, RuntimeEnvironmentItem, SubscriptionItem } from './accountsTreeProvider';
import type { AccountsTreeProvider } from './accountsTreeProvider';
import { SUPPORTED_RUNTIME_VERSIONS } from './assetsShared';
import { runbookTypeForFilePath } from './workspaceManager';
import type { WorkspaceManager } from './workspaceManager';
import type { CreateRunbookPrefill, RunbookCommands } from './runbookCommands';
import type { LocalRunner } from './localRunner';
import type { CiCdGenerator } from './cicdGenerator';
import type { RunbookFolderDecorationProvider } from './folderDecorationProvider';
import type { IconThemeManager } from './iconThemeManager';
import type { AuthManager } from './authManager';
import { WorkspaceRunbookItem, WorkspaceRunbooksTreeProvider } from './workspaceRunbooksTreeProvider';
import { executeInstallModuleForLocalDebug } from './installModuleCommands';
import { executeDeployModuleToAzure } from './deployModuleCommands';
import type { WorkspaceProtectionController } from './workspaceProtection';
import { CLOUD_CONFIG } from './cloudConfig';
import { portalUrlForAccount, portalUrlForRunbook } from './portalUrls';
import type { JobsPanel } from './jobsPanel';
import type { SchedulesPanel } from './schedulesPanel';
import type { AssetsPanel } from './assetsPanel';
import type { AppPermissionsPanel } from './appPermissionsPanel';
import {
  CERTIFICATE_BASE64_KEY,
  CERTIFICATE_DESCRIPTION_KEY,
  CERTIFICATE_EXPORTABLE_KEY,
  CERTIFICATE_EXPIRY_KEY,
  CERTIFICATE_PASSWORD_KEY,
  CERTIFICATE_THUMBPRINT_KEY,
  CONNECTION_DESCRIPTION_KEY,
  CONNECTION_TYPE_KEY,
  certificateSettingsFromAzure,
  connectionSettingsFromAzure,
  credentialSettingsFromAzure,
  normalizeAutomationVariableValue,
  parseConnectionSettingsForAzure,
} from './assetHelpers';

// ── Dependencies ──────────────────────────────────────────────────────────────

export interface RbCommandDeps {
  auth: AuthManager;
  azure: AzureService;
  workspace: WorkspaceManager;
  outputChannel: vscode.OutputChannel;
  treeProvider: AccountsTreeProvider;
  workspaceRunbooksProvider: WorkspaceRunbooksTreeProvider;
  folderDecorations: RunbookFolderDecorationProvider;
  iconTheme: IconThemeManager;
  workspaceProtection: WorkspaceProtectionController;
  commands: RunbookCommands;
  runner: LocalRunner;
  cicd: CiCdGenerator;
  jobsPanel: JobsPanel;
  schedulesPanel: SchedulesPanel;
  assetsPanel: AssetsPanel;
  appPermissionsPanel: AppPermissionsPanel;
}

// ── Diff content provider ─────────────────────────────────────────────────────

export class RunbookDiffContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    try {
      return decodeURIComponent(uri.query);
    } catch {
      return '';
    }
  }
}

// ── Workspace auto-init ───────────────────────────────────────────────────────

async function ensureLinked(
  account: { name: string; resourceGroupName: string; subscriptionId: string; subscriptionName: string; location?: string },
  workspace: WorkspaceManager,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  if (workspace.getLinkedAccount(account.name)) { return; }
  outputChannel.appendLine(`[auto-init] Initializing workspace for "${account.name}"…`);
  await workspace.initWorkspace(
    account.name, account.resourceGroupName,
    account.subscriptionId, account.subscriptionName,
    account.location
  );
}

// ── Ref resolution ────────────────────────────────────────────────────────────

/**
 * Extracts { accountName, runbookName, filePath } from a workspace tree item
 * or a vscode.Uri (right-click in the file Explorer).
 */
export function extractRunbookRef(
  arg: unknown
): { accountName: string; runbookName: string; filePath: string } | undefined {
  if (arg instanceof WorkspaceRunbookItem) {
    return { accountName: arg.accountName, runbookName: arg.runbookName, filePath: arg.filePath };
  }
  if (arg instanceof vscode.Uri) {
    const fsPath = arg.fsPath;
    const normalized = fsPath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const idx = parts.findIndex(p => p === 'aaccounts');
    if (idx === -1 || idx + 1 >= parts.length) { return undefined; }
    return {
      accountName: parts[idx + 1],
      runbookName: path.basename(fsPath, path.extname(fsPath)),
      filePath: fsPath,
    };
  }
  return undefined;
}


/** Resolves any runbook arg (accounts tree, workspace tree, or Explorer URI) to a RunbookSummary. */
export async function resolveRunbook(
  item: unknown,
  azure: AzureService,
  workspace: WorkspaceManager
): Promise<RunbookSummary | undefined> {
  if (item instanceof RunbookItem) { return item.runbook; }
  const ref = extractRunbookRef(item);
  if (!ref) { return undefined; }
  return resolveWorkspaceRunbook(ref, azure, workspace);
}

/** Resolves a runbook for local execution, falling back to the local file when Azure does not have it yet. */
export async function resolveRunbookForLocalRun(
  item: unknown,
  azure: AzureService,
  workspace: WorkspaceManager
): Promise<RunbookSummary | undefined> {
  if (item instanceof RunbookItem) { return item.runbook; }

  const ref = extractRunbookRef(item);
  if (!ref) { return undefined; }

  const linked = workspace.getLinkedAccount(ref.accountName);
  if (!linked) {
    void vscode.window.showErrorMessage(
      `Workspace account "${ref.accountName}" is not linked. Run "Initialize Runbook Workspace" for it first.`
    );
    return undefined;
  }

  try {
    const runbooks = await azure.listRunbooks(
      linked.subscriptionId, linked.resourceGroup, linked.accountName, linked.subscriptionName
    );
    const existing = runbooks.find(runbook => runbook.name === ref.runbookName);
    if (existing) { return existing; }
  } catch {
    // Fall back to the local file for local execution if Azure lookup fails unexpectedly.
  }

  return {
    name: ref.runbookName,
    runbookType: item instanceof WorkspaceRunbookItem ? item.runbookType : runbookTypeForFilePath(ref.filePath),
    state: 'New',
    accountName: linked.accountName,
    resourceGroupName: linked.resourceGroup,
    subscriptionId: linked.subscriptionId,
    subscriptionName: linked.subscriptionName,
    accountLocation: linked.location,
  };
}

export async function resolveWorkspaceRunbook(
  item: { accountName: string; runbookName: string },
  azure: AzureService,
  workspace: WorkspaceManager
): Promise<RunbookSummary | undefined> {
  const linked = workspace.getLinkedAccount(item.accountName);
  if (!linked) {
    void vscode.window.showErrorMessage(
      `Workspace account "${item.accountName}" is not linked. Run "Initialize Runbook Workspace" for it first.`
    );
    return undefined;
  }
  const runbooks = await azure.listRunbooks(
    linked.subscriptionId, linked.resourceGroup, linked.accountName, linked.subscriptionName
  );
  const runbook = runbooks.find(r => r.name === item.runbookName);
  if (!runbook) {
    void vscode.window.showErrorMessage(
      `No Azure runbook named "${item.runbookName}" was found in "${linked.accountName}".`
    );
    return undefined;
  }
  return runbook;
}

async function resolveOrCreateRunbookForDeployment(
  item: unknown,
  azure: AzureService,
  workspace: WorkspaceManager,
  commands: RunbookCommands,
  actionLabel: 'upload as draft' | 'publish'
): Promise<RunbookSummary | undefined> {
  const existing = await resolveRunbook(item, azure, workspace);
  if (existing) { return existing; }

  const ref = extractRunbookRef(item);
  if (!ref) { return undefined; }

  const linked = workspace.getLinkedAccount(ref.accountName);
  if (!linked || !linked.location) { return undefined; }

  const runbookType = item instanceof WorkspaceRunbookItem
    ? item.runbookType
    : runbookTypeForFilePath(ref.filePath);

  const create = await vscode.window.showWarningMessage(
    `No Azure runbook named "${ref.runbookName}" was found in "${ref.accountName}". Create it now so we can ${actionLabel}?`,
    { modal: true },
    'Create Runbook',
    'Cancel'
  );
  if (create !== 'Create Runbook') { return undefined; }

  const created = await commands.createRunbook(
    linked.accountName,
    linked.resourceGroup,
    linked.subscriptionId,
    linked.location,
    {
      name: ref.runbookName,
      runbookType,
    }
  );
  if (!created) { return undefined; }

  return {
    name: created.name,
    runbookType: created.runbookType,
    runtimeEnvironment: created.runtimeEnvironment,
    state: 'New',
    accountName: linked.accountName,
    resourceGroupName: linked.resourceGroup,
    subscriptionId: linked.subscriptionId,
    subscriptionName: linked.subscriptionName,
    accountLocation: linked.location,
  };
}

interface CreateRunbookCommandRequest extends CreateRunbookPrefill {
  accountName?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  subscriptionName?: string;
  location?: string;
}

function isCreateRunbookCommandRequest(value: unknown): value is CreateRunbookCommandRequest {
  return value !== null
    && typeof value === 'object'
    && !(value instanceof vscode.Uri)
    && !(value instanceof AutomationAccountItem)
    && !(value instanceof RunbookItem)
    && !(value instanceof SubscriptionItem);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function parseDefaultPackagesInput(
  initialValue: Record<string, string> | undefined
): Promise<Record<string, string> | undefined> {
  const raw = await vscode.window.showInputBox({
    title: 'Default Packages (optional JSON)',
    prompt: 'Example: {"Az":"12.3.0"}',
    value: initialValue && Object.keys(initialValue).length > 0
      ? JSON.stringify(initialValue)
      : '',
    ignoreFocusOut: true,
  });
  if (raw === undefined) { return undefined; }
  if (!raw.trim()) { return {}; }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a JSON object like {"Az":"12.3.0"}');
    }
    const normalized = Object.fromEntries(
      Object.entries(parsed)
        .filter(([name, version]) => name.trim() && typeof version === 'string' && version.trim())
        .map(([name, version]) => [name.trim(), version.trim()])
    );
    return normalized;
  } catch (err) {
    void vscode.window.showErrorMessage(`Invalid package JSON: ${errMessage(err)}`);
    return undefined;
  }
}

async function promptForRuntimeEnvironmentCreate(location: string): Promise<RuntimeEnvironmentCreateRequest | undefined> {
  const name = await vscode.window.showInputBox({
    title: 'Runtime Environment Name',
    prompt: 'Azure Automation Runtime Environment name',
    validateInput: value => /^[a-zA-Z][a-zA-Z0-9-_]*$/.test(value)
      ? null
      : 'Name must start with a letter and contain only letters, numbers, hyphens, and underscores.',
    ignoreFocusOut: true,
  });
  if (!name) { return; }

  const language = await vscode.window.showQuickPick(
    [
      { label: 'PowerShell', value: 'PowerShell', description: 'Use for PowerShell runbooks' },
      { label: 'Python', value: 'Python', description: 'Use for Python runbooks' },
    ],
    { title: 'Runtime Language' }
  );
  if (!language) { return; }

  const versionOptions = (SUPPORTED_RUNTIME_VERSIONS[language.value] ?? []).map(v => ({ label: v, value: v }));
  const version = await vscode.window.showQuickPick(versionOptions, {
    title: `Runtime Version - ${name}`,
  });
  if (!version) { return; }

  const description = await vscode.window.showInputBox({
    title: `Description - ${name} (optional)`,
    prompt: 'Optional description',
    ignoreFocusOut: true,
  });
  if (description === undefined) { return; }

  const defaultPackages = await parseDefaultPackagesInput(undefined);
  if (defaultPackages === undefined) { return; }

  return {
    name,
    location,
    language: language.value,
    version: version.value,
    description: description.trim() || undefined,
    defaultPackages: Object.keys(defaultPackages).length > 0 ? defaultPackages : undefined,
  };
}

async function manageRuntimeEnvironments(
  azure: AzureService,
  account: AzureAutomationAccount,
  outputChannel: vscode.OutputChannel
): Promise<boolean> {
  const runtimes = await azure.listRuntimeEnvironments(account.subscriptionId, account.resourceGroupName, account.name);
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(add) Create Runtime Environment', value: '__create' },
      ...runtimes.map(runtime => ({
        label: runtime.name,
        value: runtime.name,
        description: [runtime.language, runtime.version].filter(Boolean).join(' '),
        detail: runtime.defaultPackages && Object.keys(runtime.defaultPackages).length > 0
          ? `Packages: ${Object.entries(runtime.defaultPackages).map(([name, version]) => `${name}@${version}`).join(', ')}`
          : runtime.description,
      })),
    ],
    { title: `Runtime Environments - ${account.name}` }
  );
  if (!picked) { return false; }

  if (picked.value === '__create') {
    const request = await promptForRuntimeEnvironmentCreate(account.location);
    if (!request) { return false; }
    try {
      await azure.createRuntimeEnvironment(account.subscriptionId, account.resourceGroupName, account.name, request);
      outputChannel.appendLine(`[runtime-environment] Created ${request.name} in ${account.name}`);
      void vscode.window.showInformationMessage(`Created Runtime Environment "${request.name}".`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      outputChannel.appendLine(`[runtime-environment] Failed to create ${request.name}: ${msg}`);
      void vscode.window.showErrorMessage(`Failed to create runtime environment: ${msg}`);
      return false;
    }
    return true;
  }

  const existing = await azure.getRuntimeEnvironment(account.subscriptionId, account.resourceGroupName, account.name, picked.value);
  const action = await vscode.window.showQuickPick(
    [
      { label: 'Update Default Packages', value: 'update' },
      { label: 'Delete Runtime Environment', value: 'delete' },
    ],
    { title: `Runtime Environment - ${existing.name}` }
  );
  if (!action) { return false; }

  if (action.value === 'update') {
    const defaultPackages = await parseDefaultPackagesInput(existing.defaultPackages);
    if (defaultPackages === undefined) { return false; }
    await azure.updateRuntimeEnvironmentDefaultPackages(
      account.subscriptionId,
      account.resourceGroupName,
      account.name,
      existing.name,
      defaultPackages
    );
    outputChannel.appendLine(`[runtime-environment] Updated packages for ${existing.name} in ${account.name}`);
    void vscode.window.showInformationMessage(`Updated Runtime Environment "${existing.name}".`);
    return true;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete Runtime Environment "${existing.name}" from "${account.name}"?`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') { return false; }

  await azure.deleteRuntimeEnvironment(
    account.subscriptionId,
    account.resourceGroupName,
    account.name,
    existing.name
  );
  outputChannel.appendLine(`[runtime-environment] Deleted ${existing.name} from ${account.name}`);
  void vscode.window.showInformationMessage(`Deleted Runtime Environment "${existing.name}".`);
  return true;
}

// ── Asset management quick panel ──────────────────────────────────────────────

async function showAssetsPanel(
  azure: AzureService,
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  workspace: WorkspaceManager,
  outputChannel: vscode.OutputChannel,
  onAzureAssetsChanged: () => Promise<void>
): Promise<void> {
  const ctx = { azure, subscriptionId, resourceGroup, accountName, workspace, outputChannel, onAzureAssetsChanged };
  const section = await vscode.window.showQuickPick(
    [
      { label: '$(symbol-variable) Variables', value: 'variables' },
      { label: '$(key) Credentials',         value: 'credentials' },
      { label: '$(plug) Connections',        value: 'connections' },
      { label: '$(sync) Sync Azure Assets -> local.settings.json', value: 'syncAzureToLocal' },
      { label: '$(cloud-upload) Sync local.settings.json -> Azure Assets', value: 'syncLocalToAzure' },
      { label: '$(extensions) Modules',      value: 'modules' },
    ],
    { title: `Assets - ${accountName}` }
  );
  if (!section) { return; }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Loading ${section.label}…` },
    async () => {
      if (section.value === 'variables') { await manageVariables(ctx); return; }
      if (section.value === 'credentials') { await manageCredentials(ctx); return; }
      if (section.value === 'connections') { await manageConnections(ctx); return; }
      if (section.value === 'syncAzureToLocal') { await syncAzureAssetsToLocal(ctx); return; }
      if (section.value === 'syncLocalToAzure') { await syncLocalAssetsToAzure(ctx); return; }
      if (section.value === 'modules') { await showModules(ctx); }
    }
  );
}

interface AssetPanelContext {
  azure: AzureService;
  subscriptionId: string;
  resourceGroup: string;
  accountName: string;
  workspace: WorkspaceManager;
  outputChannel: vscode.OutputChannel;
  onAzureAssetsChanged: () => Promise<void>;
}

async function refreshWorkspaceAfterAssetMutation(ctx: AssetPanelContext): Promise<void> {
  await ctx.onAzureAssetsChanged();
}

interface ConnectionTypePreset {
  readonly name: string;
  readonly label: string;
  readonly fields: readonly string[];
}

const CONNECTION_TYPE_PRESETS: readonly ConnectionTypePreset[] = [
  {
    name: 'AzureServicePrincipal',
    label: 'Azure Service Principal',
    fields: ['ApplicationId', 'TenantId', 'CertificateThumbprint', 'SubscriptionId'],
  },
  {
    name: 'Azure',
    label: 'Azure',
    fields: ['ApplicationId', 'TenantId', 'CertificateThumbprint', 'SubscriptionId'],
  },
  {
    name: 'AzureClassicCertificate',
    label: 'Azure Classic Certificate',
    fields: ['SubscriptionId', 'CertificateThumbprint'],
  },
];

async function showModules(ctx: AssetPanelContext): Promise<void> {
  const mods = await ctx.azure.listImportedModules(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName);
  const items = mods.map(m => ({
    label: m.name,
    description: `v${m.version}`,
    detail: m.provisioningState !== 'Succeeded' ? `Warning: ${m.provisioningState}` : undefined,
  }));
  await vscode.window.showQuickPick(items, { title: `Modules - ${ctx.accountName}`, canPickMany: false });
}

async function manageVariables(ctx: AssetPanelContext): Promise<void> {
  const vars = await ctx.azure.listVariables(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName);
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(add) Create Variable', value: '__create' },
      { label: '$(sync) Pull All Variables To local.settings.json', value: '__pullAll' },
      { label: '$(cloud-upload) Push Local Variables To Azure', value: '__pushAll' },
      ...vars.map(v => ({
        label: v.name,
        value: v.name,
        description: v.isEncrypted ? 'encrypted' : (v.value ?? '(empty)'),
        detail: v.description,
      })),
    ],
    { title: `Variables - ${ctx.accountName}` }
  );
  if (!picked) { return; }

  if (picked.value === '__create') { await createOrEditVariable(ctx); return; }
  if (picked.value === '__pullAll') { await syncVariablesAzureToLocal(ctx); return; }
  if (picked.value === '__pushAll') { await syncVariablesLocalToAzure(ctx); return; }

  const action = await vscode.window.showQuickPick(
    [
      { label: 'Edit In Azure', value: 'edit' },
      { label: 'Delete From Azure', value: 'delete' },
      { label: 'Copy To local.settings.json', value: 'pull' },
    ],
    { title: `Variable - ${picked.label}` }
  );
  if (!action) { return; }

  if (action.value === 'edit') { await createOrEditVariable(ctx, picked.value); return; }
  if (action.value === 'delete') {
    const confirm = await vscode.window.showWarningMessage(
      `Delete variable "${picked.value}" from Azure?`,
      { modal: true },
      'Delete'
    );
    if (confirm === 'Delete') {
      await ctx.azure.deleteVariable(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName, picked.value);
      await refreshWorkspaceAfterAssetMutation(ctx);
      ctx.outputChannel.appendLine(`[assets] Deleted variable ${picked.value} from Azure`);
      void vscode.window.showInformationMessage(`Deleted variable "${picked.value}" from Azure.`);
    }
    return;
  }
  await pullVariableToLocalSettings(ctx, picked.value);
}

async function createOrEditVariable(ctx: AssetPanelContext, variableName?: string): Promise<void> {
  const existing = variableName
    ? await ctx.azure.getVariable(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName, variableName)
    : undefined;
  const name = variableName ?? await vscode.window.showInputBox({
    title: 'Variable Name',
    prompt: 'Azure Automation variable name',
    ignoreFocusOut: true,
  });
  if (!name?.trim()) { return; }

  const encryption = await vscode.window.showQuickPick(
    [
      { label: 'Plain Text', value: 'plain' },
      { label: 'Encrypted', value: 'encrypted' },
    ],
    {
      title: `Variable Encryption - ${name}`,
      placeHolder: existing?.isEncrypted ? 'Current: Encrypted' : 'Current: Plain Text',
    }
  );
  if (!encryption) { return; }

  const value = await vscode.window.showInputBox({
    title: `Variable Value - ${name}`,
    prompt: encryption.value === 'encrypted'
      ? 'Enter the encrypted variable value'
      : 'Enter the variable value',
    value: existing?.isEncrypted ? '' : (existing?.value ?? ''),
    ignoreFocusOut: true,
  });
  if (value === undefined) { return; }

  const description = await vscode.window.showInputBox({
    title: `Variable Description - ${name}`,
    prompt: 'Optional description',
    value: existing?.description ?? '',
    ignoreFocusOut: true,
  });
  if (description === undefined) { return; }

  await ctx.azure.createOrUpdateVariable(
    ctx.subscriptionId,
    ctx.resourceGroup,
    ctx.accountName,
    name.trim(),
    value,
    encryption.value === 'encrypted',
    description || undefined
  );
  await refreshWorkspaceAfterAssetMutation(ctx);
  ctx.outputChannel.appendLine(`[assets] Saved variable ${name.trim()} in Azure`);
  void vscode.window.showInformationMessage(`Saved variable "${name.trim()}" in Azure.`);
}

async function pullVariableToLocalSettings(ctx: AssetPanelContext, variableName: string): Promise<void> {
  const variable = await ctx.azure.getVariable(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName, variableName);
  const settings = ctx.workspace.readLocalSettings(ctx.accountName);
  settings.Assets.Variables[variable.name] = variable.isEncrypted ? '' : normalizeAutomationVariableValue(variable.value);
  ctx.workspace.writeLocalSettings(ctx.accountName, settings);
  ctx.outputChannel.appendLine(`[assets] Copied variable ${variable.name} to local.settings.json`);
  if (variable.isEncrypted) {
    void vscode.window.showWarningMessage(
      `Variable "${variable.name}" is encrypted in Azure. A blank placeholder was added to local.settings.json so you can fill in the secret locally.`
    );
    return;
  }
  void vscode.window.showInformationMessage(`Copied variable "${variable.name}" to local.settings.json.`);
}

async function syncVariablesAzureToLocal(ctx: AssetPanelContext): Promise<void> {
  const variables = await ctx.azure.listVariables(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName);
  const settings = ctx.workspace.readLocalSettings(ctx.accountName);
  let copied = 0;
  let placeholders = 0;
  for (const variable of variables) {
    settings.Assets.Variables[variable.name] = variable.isEncrypted ? '' : normalizeAutomationVariableValue(variable.value);
    if (variable.isEncrypted) {
      placeholders++;
    } else {
      copied++;
    }
  }
  ctx.workspace.writeLocalSettings(ctx.accountName, settings);
  ctx.outputChannel.appendLine(
    `[assets] Synced ${copied} plain variable(s) and ${placeholders} encrypted placeholder(s) from Azure to local.settings.json`
  );
  if (placeholders > 0) {
    void vscode.window.showWarningMessage(
      `Synced ${copied} plain variable(s) and ${placeholders} encrypted placeholder(s) to local.settings.json. Fill in encrypted secrets locally.`
    );
    return;
  }
  void vscode.window.showInformationMessage(`Synced ${copied} variable(s) to local.settings.json.`);
}

async function syncVariablesLocalToAzure(ctx: AssetPanelContext): Promise<void> {
  const settings = ctx.workspace.readLocalSettings(ctx.accountName);
  const names = Object.keys(settings.Assets.Variables);
  for (const name of names) {
    await ctx.azure.createOrUpdateVariable(
      ctx.subscriptionId,
      ctx.resourceGroup,
      ctx.accountName,
      name,
      normalizeAutomationVariableValue(settings.Assets.Variables[name]),
      false
    );
  }
  await refreshWorkspaceAfterAssetMutation(ctx);
  ctx.outputChannel.appendLine(`[assets] Pushed ${names.length} variable(s) from local.settings.json to Azure`);
  void vscode.window.showInformationMessage(`Pushed ${names.length} variable(s) to Azure.`);
}

async function manageCredentials(ctx: AssetPanelContext): Promise<void> {
  const credentials = await ctx.azure.listCredentials(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName);
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(add) Create Credential', value: '__create' },
      { label: '$(sync) Pull All Credentials To local.settings.json', value: '__pullAll' },
      { label: '$(cloud-upload) Push Local Credentials To Azure', value: '__pushAll' },
      ...credentials.map(c => ({
        label: c.name,
        value: c.name,
        description: c.userName ?? '(no username)',
        detail: c.description,
      })),
    ],
    { title: `Credentials - ${ctx.accountName}` }
  );
  if (!picked) { return; }

  if (picked.value === '__create') { await createOrEditCredential(ctx); return; }
  if (picked.value === '__pullAll') { await syncCredentialsAzureToLocal(ctx); return; }
  if (picked.value === '__pushAll') { await syncCredentialsLocalToAzure(ctx); return; }

  const action = await vscode.window.showQuickPick(
    [
      { label: 'Edit In Azure', value: 'edit' },
      { label: 'Delete From Azure', value: 'delete' },
      { label: 'Copy To local.settings.json', value: 'pull' },
    ],
    { title: `Credential - ${picked.label}` }
  );
  if (!action) { return; }

  if (action.value === 'edit') { await createOrEditCredential(ctx, picked.value); return; }
  if (action.value === 'delete') {
    const confirm = await vscode.window.showWarningMessage(
      `Delete credential "${picked.value}" from Azure?`,
      { modal: true },
      'Delete'
    );
    if (confirm === 'Delete') {
      await ctx.azure.deleteCredential(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName, picked.value);
      await refreshWorkspaceAfterAssetMutation(ctx);
      ctx.outputChannel.appendLine(`[assets] Deleted credential ${picked.value} from Azure`);
      void vscode.window.showInformationMessage(`Deleted credential "${picked.value}" from Azure.`);
    }
    return;
  }
  await pullCredentialToLocalSettings(ctx, picked.value);
}

async function createOrEditCredential(ctx: AssetPanelContext, credentialName?: string): Promise<void> {
  const existing = credentialName
    ? await ctx.azure.getCredential(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName, credentialName)
    : undefined;
  const name = credentialName ?? await vscode.window.showInputBox({
    title: 'Credential Name',
    prompt: 'Azure Automation credential name',
    ignoreFocusOut: true,
  });
  if (!name?.trim()) { return; }

  const userName = await vscode.window.showInputBox({
    title: `Credential Username - ${name}`,
    prompt: 'Username',
    value: existing?.userName ?? '',
    ignoreFocusOut: true,
  });
  if (!userName?.trim()) { return; }

  const password = await vscode.window.showInputBox({
    title: `Credential Password - ${name}`,
    prompt: credentialName ? 'Leave blank to keep the current password' : 'Password',
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) { return; }

  const description = await vscode.window.showInputBox({
    title: `Credential Description - ${name}`,
    prompt: 'Optional description',
    value: existing?.description ?? '',
    ignoreFocusOut: true,
  });
  if (description === undefined) { return; }

  if (!credentialName && !password) {
    void vscode.window.showErrorMessage('A password is required when creating a new credential.');
    return;
  }

  if (credentialName) {
    await ctx.azure.updateCredential(
      ctx.subscriptionId,
      ctx.resourceGroup,
      ctx.accountName,
      name.trim(),
      userName.trim(),
      password || undefined,
      description || undefined
    );
  } else {
    await ctx.azure.createOrUpdateCredential(
      ctx.subscriptionId,
      ctx.resourceGroup,
      ctx.accountName,
      name.trim(),
      userName.trim(),
      password,
      description || undefined
    );
  }

  await refreshWorkspaceAfterAssetMutation(ctx);
  ctx.outputChannel.appendLine(`[assets] Saved credential ${name.trim()} in Azure`);
  void vscode.window.showInformationMessage(`Saved credential "${name.trim()}" in Azure.`);
}

async function pullCredentialToLocalSettings(ctx: AssetPanelContext, credentialName: string): Promise<void> {
  const credential = await ctx.azure.getCredential(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName, credentialName);
  const settings = ctx.workspace.readLocalSettings(ctx.accountName);
  settings.Assets.Credentials[credential.name] = {
    ...credentialSettingsFromAzure(credential.userName),
    Password: settings.Assets.Credentials[credential.name]?.Password ?? '',
  };
  ctx.workspace.writeLocalSettings(ctx.accountName, settings);
  ctx.outputChannel.appendLine(`[assets] Copied credential ${credential.name} to local.settings.json`);
  void vscode.window.showWarningMessage(
    `Copied credential "${credential.name}" to local.settings.json. Azure does not return the password, so fill it locally if you need local execution.`
  );
}

async function syncCredentialsAzureToLocal(ctx: AssetPanelContext): Promise<void> {
  const credentials = await ctx.azure.listCredentials(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName);
  const settings = ctx.workspace.readLocalSettings(ctx.accountName);
  for (const credential of credentials) {
    settings.Assets.Credentials[credential.name] = {
      ...credentialSettingsFromAzure(credential.userName),
      Password: settings.Assets.Credentials[credential.name]?.Password ?? '',
    };
  }
  ctx.workspace.writeLocalSettings(ctx.accountName, settings);
  ctx.outputChannel.appendLine(`[assets] Synced ${credentials.length} credential(s) from Azure to local.settings.json`);
  void vscode.window.showWarningMessage(
    `Synced ${credentials.length} credential(s) to local.settings.json. Passwords are not returned by Azure, so local passwords stay empty unless you fill them in.`
  );
}

async function syncCredentialsLocalToAzure(ctx: AssetPanelContext): Promise<void> {
  const settings = ctx.workspace.readLocalSettings(ctx.accountName);
  const failures: string[] = [];
  let pushed = 0;

  for (const [name, credential] of Object.entries(settings.Assets.Credentials)) {
    if (!credential.Username.trim()) {
      failures.push(`${name}: missing Username`);
      continue;
    }
    if (!credential.Password.trim()) {
      failures.push(`${name}: missing Password`);
      continue;
    }
    await ctx.azure.createOrUpdateCredential(
      ctx.subscriptionId,
      ctx.resourceGroup,
      ctx.accountName,
      name,
      credential.Username,
      credential.Password,
    );
    pushed++;
  }

  await refreshWorkspaceAfterAssetMutation(ctx);
  await showSyncSummary('credential', pushed, failures);
  ctx.outputChannel.appendLine(`[assets] Pushed ${pushed} credential(s) to Azure${failures.length ? `; failed ${failures.length}` : ''}`);
}

async function manageConnections(ctx: AssetPanelContext): Promise<void> {
  const connections = await ctx.azure.listConnections(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName);
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(add) Create Connection', value: '__create' },
      { label: '$(sync) Pull All Connections To local.settings.json', value: '__pullAll' },
      { label: '$(cloud-upload) Push Local Connections To Azure', value: '__pushAll' },
      ...connections.map(c => ({
        label: c.name,
        value: c.name,
        description: c.connectionType ?? '(no type)',
        detail: c.description,
      })),
    ],
    { title: `Connections - ${ctx.accountName}` }
  );
  if (!picked) { return; }

  if (picked.value === '__create') { await createOrEditConnection(ctx); return; }
  if (picked.value === '__pullAll') { await syncConnectionsAzureToLocal(ctx); return; }
  if (picked.value === '__pushAll') { await syncConnectionsLocalToAzure(ctx); return; }

  const action = await vscode.window.showQuickPick(
    [
      { label: 'Edit In Azure', value: 'edit' },
      { label: 'Delete From Azure', value: 'delete' },
      { label: 'Copy To local.settings.json', value: 'pull' },
    ],
    { title: `Connection - ${picked.label}` }
  );
  if (!action) { return; }

  if (action.value === 'edit') { await createOrEditConnection(ctx, picked.value); return; }
  if (action.value === 'delete') {
    const confirm = await vscode.window.showWarningMessage(
      `Delete connection "${picked.value}" from Azure?`,
      { modal: true },
      'Delete'
    );
    if (confirm === 'Delete') {
      await ctx.azure.deleteConnection(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName, picked.value);
      await refreshWorkspaceAfterAssetMutation(ctx);
      ctx.outputChannel.appendLine(`[assets] Deleted connection ${picked.value} from Azure`);
      void vscode.window.showInformationMessage(`Deleted connection "${picked.value}" from Azure.`);
    }
    return;
  }
  await pullConnectionToLocalSettings(ctx, picked.value);
}

async function createOrEditConnection(ctx: AssetPanelContext, connectionName?: string): Promise<void> {
  const existing = connectionName
    ? await ctx.azure.getConnection(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName, connectionName)
    : undefined;
  const name = connectionName ?? await vscode.window.showInputBox({
    title: 'Connection Name',
    prompt: 'Azure Automation connection name',
    ignoreFocusOut: true,
  });
  if (!name?.trim()) { return; }

  const type = await promptForConnectionType(name, existing?.connectionType);
  if (!type?.trim()) {
    void vscode.window.showErrorMessage('Connection type is required.');
    return;
  }

  const fieldValues = await promptForConnectionFieldValues(name, type, existing?.fieldValues ?? {});
  if (!fieldValues) { return; }

  const description = await vscode.window.showInputBox({
    title: `Connection Description - ${name}`,
    prompt: `Optional description. For local settings sync, this is stored under "${CONNECTION_DESCRIPTION_KEY}".`,
    value: existing?.description ?? '',
    ignoreFocusOut: true,
  });
  if (description === undefined) { return; }

  if (connectionName) {
    await ctx.azure.updateConnection(
      ctx.subscriptionId,
      ctx.resourceGroup,
      ctx.accountName,
      name.trim(),
      fieldValues,
      description || undefined
    );
  } else {
    await ctx.azure.createOrUpdateConnection(
      ctx.subscriptionId,
      ctx.resourceGroup,
      ctx.accountName,
      name.trim(),
      type.trim(),
      fieldValues,
      description || undefined
    );
  }

  await refreshWorkspaceAfterAssetMutation(ctx);
  ctx.outputChannel.appendLine(`[assets] Saved connection ${name.trim()} in Azure`);
  void vscode.window.showInformationMessage(`Saved connection "${name.trim()}" in Azure.`);
}

async function pullConnectionToLocalSettings(ctx: AssetPanelContext, connectionName: string): Promise<void> {
  const connection = await ctx.azure.getConnection(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName, connectionName);
  const settings = ctx.workspace.readLocalSettings(ctx.accountName);
  settings.Assets.Connections[connection.name] = connectionSettingsFromAzure(
    connection.connectionType,
    connection.fieldValues,
    connection.description
  );
  ctx.workspace.writeLocalSettings(ctx.accountName, settings);
  ctx.outputChannel.appendLine(`[assets] Copied connection ${connection.name} to local.settings.json`);
  void vscode.window.showInformationMessage(`Copied connection "${connection.name}" to local.settings.json.`);
}

async function syncConnectionsAzureToLocal(ctx: AssetPanelContext): Promise<void> {
  const connections = await ctx.azure.listConnections(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName);
  const settings = ctx.workspace.readLocalSettings(ctx.accountName);
  for (const connection of connections) {
    const detail = await ctx.azure.getConnection(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName, connection.name);
    settings.Assets.Connections[detail.name] = connectionSettingsFromAzure(
      detail.connectionType,
      detail.fieldValues,
      detail.description
    );
  }
  ctx.workspace.writeLocalSettings(ctx.accountName, settings);
  ctx.outputChannel.appendLine(`[assets] Synced ${connections.length} connection(s) from Azure to local.settings.json`);
  void vscode.window.showInformationMessage(`Synced ${connections.length} connection(s) to local.settings.json.`);
}

async function syncCertificatesAzureToLocal(ctx: AssetPanelContext): Promise<void> {
  const certificates = await ctx.azure.listCertificates(ctx.subscriptionId, ctx.resourceGroup, ctx.accountName);
  const settings = ctx.workspace.readLocalSettings(ctx.accountName);
  for (const certificate of certificates) {
    settings.Assets.Certificates[certificate.name] = certificateSettingsFromAzure(
      certificate.thumbprint,
      certificate.expiryTime,
      certificate.isExportable,
      certificate.description
    );
  }
  ctx.workspace.writeLocalSettings(ctx.accountName, settings);
  ctx.outputChannel.appendLine(`[assets] Synced ${certificates.length} certificate(s) from Azure to local.settings.json`);
  void vscode.window.showWarningMessage(
    `Synced ${certificates.length} certificate(s) to local.settings.json. Azure does not return private certificate material, so "${CERTIFICATE_BASE64_KEY}" and "${CERTIFICATE_PASSWORD_KEY}" stay blank unless you fill them locally.`
  );
}

async function syncConnectionsLocalToAzure(ctx: AssetPanelContext): Promise<void> {
  const settings = ctx.workspace.readLocalSettings(ctx.accountName);
  const failures: string[] = [];
  let pushed = 0;

  for (const [name, rawValues] of Object.entries(settings.Assets.Connections)) {
    const parsed = parseConnectionSettingsForAzure(rawValues);
    if (!parsed.connectionType) {
      failures.push(`${name}: missing ${CONNECTION_TYPE_KEY}`);
      continue;
    }
    await ctx.azure.createOrUpdateConnection(
      ctx.subscriptionId,
      ctx.resourceGroup,
      ctx.accountName,
      name,
      parsed.connectionType,
      parsed.fieldValues,
      parsed.description
    );
    pushed++;
  }

  await refreshWorkspaceAfterAssetMutation(ctx);
  await showSyncSummary('connection', pushed, failures);
  ctx.outputChannel.appendLine(`[assets] Pushed ${pushed} connection(s) to Azure${failures.length ? `; failed ${failures.length}` : ''}`);
}

async function syncAzureAssetsToLocal(ctx: AssetPanelContext): Promise<void> {
  await syncVariablesAzureToLocal(ctx);
  await syncCredentialsAzureToLocal(ctx);
  await syncConnectionsAzureToLocal(ctx);
  await syncCertificatesAzureToLocal(ctx);
}

async function syncLocalAssetsToAzure(ctx: AssetPanelContext): Promise<void> {
  await syncVariablesLocalToAzure(ctx);
  await syncCredentialsLocalToAzure(ctx);
  await syncConnectionsLocalToAzure(ctx);
}

async function showSyncSummary(kind: string, pushed: number, failures: string[]): Promise<void> {
  if (failures.length === 0) {
    void vscode.window.showInformationMessage(`Pushed ${pushed} ${kind}(s) to Azure.`);
    return;
  }
  const summary = failures.slice(0, 5).join(' | ');
  void vscode.window.showWarningMessage(
    `Pushed ${pushed} ${kind}(s) to Azure. ${failures.length} item(s) were skipped: ${summary}`
  );
}

async function syncAzureAssetsToLocalSettingsForAccount(
  azure: AzureService,
  workspace: WorkspaceManager,
  outputChannel: vscode.OutputChannel,
  account: { subscriptionId: string; resourceGroupName: string; name: string }
): Promise<void> {
  const [variables, credentials, connections, certificates] = await Promise.all([
    azure.listVariables(account.subscriptionId, account.resourceGroupName, account.name),
    azure.listCredentials(account.subscriptionId, account.resourceGroupName, account.name),
    azure.listConnections(account.subscriptionId, account.resourceGroupName, account.name),
    azure.listCertificates(account.subscriptionId, account.resourceGroupName, account.name),
  ]);

  const settings = workspace.readLocalSettings(account.name);
  for (const variable of variables) {
    settings.Assets.Variables[variable.name] = variable.isEncrypted ? '' : normalizeAutomationVariableValue(variable.value);
  }
  for (const credential of credentials) {
    settings.Assets.Credentials[credential.name] = {
      ...credentialSettingsFromAzure(credential.userName),
      Password: settings.Assets.Credentials[credential.name]?.Password ?? '',
    };
  }
  for (const connection of connections) {
    const detail = await azure.getConnection(account.subscriptionId, account.resourceGroupName, account.name, connection.name);
    settings.Assets.Connections[detail.name] = connectionSettingsFromAzure(
      detail.connectionType,
      detail.fieldValues,
      detail.description
    );
  }
  for (const certificate of certificates) {
    settings.Assets.Certificates[certificate.name] = certificateSettingsFromAzure(
      certificate.thumbprint,
      certificate.expiryTime,
      certificate.isExportable,
      certificate.description
    );
  }

  workspace.writeLocalSettings(account.name, settings);
  outputChannel.appendLine(
    `[sync] Synced assets to local.settings.json for ${account.name}: ${variables.length} variable(s), ${credentials.length} credential(s), ${connections.length} connection(s), ${certificates.length} certificate(s)`
  );
}

async function promptForConnectionType(connectionName: string, existingType?: string): Promise<string | undefined> {
  const preset = existingType
    ? CONNECTION_TYPE_PRESETS.find(item => item.name === existingType)
    : undefined;

  const pick = await vscode.window.showQuickPick(
    [
      ...CONNECTION_TYPE_PRESETS.map(item => ({
        label: item.label,
        description: item.name,
        value: item.name,
      })),
      { label: 'Custom Type', description: 'Enter a custom connection type name', value: '__custom' },
    ],
    {
      title: `Connection Type - ${connectionName}`,
      placeHolder: preset ? `Current: ${preset.label}` : existingType ? `Current: ${existingType}` : undefined,
    }
  );
  if (!pick) { return undefined; }
  if (pick.value !== '__custom') { return pick.value; }

  return vscode.window.showInputBox({
    title: `Custom Connection Type - ${connectionName}`,
    prompt: `Connection type name. For local settings sync, this is stored under "${CONNECTION_TYPE_KEY}".`,
    value: existingType ?? '',
    ignoreFocusOut: true,
  });
}

async function promptForConnectionFieldValues(
  connectionName: string,
  connectionType: string,
  existingValues: Record<string, string>
): Promise<Record<string, string> | undefined> {
  const preset = CONNECTION_TYPE_PRESETS.find(item => item.name === connectionType);
  const mode = await vscode.window.showQuickPick(
    [
      ...(preset ? [{ label: 'Guided Fields', description: 'Recommended for common connection types', value: 'guided' }] : []),
      { label: 'Raw JSON', description: 'Advanced mode', value: 'json' },
    ],
    {
      title: `Connection Fields - ${connectionName}`,
      placeHolder: preset ? `Detected preset for ${preset.label}` : 'Use raw JSON for custom connection types',
    }
  );
  if (!mode) { return undefined; }

  if (mode.value === 'guided' && preset) {
    return promptForGuidedConnectionFields(connectionName, preset, existingValues);
  }

  const fieldValuesRaw = await vscode.window.showInputBox({
    title: `Connection Field Values - ${connectionName}`,
    prompt: 'Enter a JSON object of field values',
    value: JSON.stringify(existingValues, null, 2),
    ignoreFocusOut: true,
    validateInput: input => {
      try {
        const parsed = JSON.parse(input || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? undefined
          : 'Enter a JSON object like {"ApplicationId":"..."}';
      } catch {
        return 'Enter valid JSON.';
      }
    },
  });
  if (fieldValuesRaw === undefined) { return undefined; }
  return normalizeStringRecord(JSON.parse(fieldValuesRaw || '{}'));
}

async function promptForGuidedConnectionFields(
  connectionName: string,
  preset: ConnectionTypePreset,
  existingValues: Record<string, string>
): Promise<Record<string, string> | undefined> {
  const values: Record<string, string> = {};
  for (const field of preset.fields) {
    const value = await vscode.window.showInputBox({
      title: `${preset.label} - ${field}`,
      prompt: `Enter ${field} for ${connectionName}`,
      value: existingValues[field] ?? '',
      ignoreFocusOut: true,
    });
    if (value === undefined) { return undefined; }
    values[field] = value;
  }
  return values;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return {}; }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item ?? '')])
  );
}

// ── Command registration ──────────────────────────────────────────────────────

/**
 * Commands that work without a workspace being open (auth, setup, or UI-only).
 * Every other command will be blocked with an actionable error if no folder is open.
 */
const WORKSPACE_EXEMPT = new Set([
  'runbookWorkbench.signIn',
  'runbookWorkbench.signOut',
  'runbookWorkbench.selectCloud',
  'runbookWorkbench.refresh',
  'runbookWorkbench.refreshWorkspaceRunbooks',
  'runbookWorkbench.initWorkspace',
  'runbookWorkbench.initAndFetchAllInSubscription',
  'runbookWorkbench.createAutomationAccount',
  'runbookWorkbench.manageRuntimeEnvironments',
  'runbookWorkbench.changeRunbookRuntimeEnvironment',
]);

function resolveCommandItemOrActiveEditor(item: unknown): unknown {
  return item ?? vscode.window.activeTextEditor?.document.uri;
}

function getAccountNameFromExplorerUri(item: unknown): string | undefined {
  if (!(item instanceof vscode.Uri)) { return undefined; }
  const normalized = item.fsPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const idx = parts.findIndex(p => p === 'aaccounts');
  if (idx === -1 || idx + 1 >= parts.length) { return undefined; }
  return parts[idx + 1];
}

async function resolvePortalUrl(
  item: unknown,
  auth: AuthManager,
  azure: AzureService,
  workspace: WorkspaceManager
): Promise<string | undefined> {
  const runbook = await resolveRunbook(item, azure, workspace);
  if (runbook) {
    return portalUrlForRunbook({
      subscriptionId: runbook.subscriptionId,
      resourceGroupName: runbook.resourceGroupName,
      name: runbook.accountName,
      runbookName: runbook.name,
    }, auth.getCloudName());
  }

  const account = resolveAutomationAccountFromItem(item, workspace);
  if (account) {
    return portalUrlForAccount({
      subscriptionId: account.subscriptionId,
      resourceGroupName: account.resourceGroupName,
      name: account.name,
    }, auth.getCloudName());
  }

  return undefined;
}

async function promptForAutomationAccountCreate(
  azure: AzureService,
  subscription: { id: string; name: string }
): Promise<{ accountName: string; resourceGroupName: string; location: string; createdResourceGroup: boolean } | undefined> {
  const resourceGroups = await azure.listResourceGroups(subscription.id);
  const createNewPick = { label: '$(add) Create New Resource Group', value: '__createNew' };
  const pickedResourceGroup = await vscode.window.showQuickPick(
    [
      ...resourceGroups.map(rg => ({
        label: rg.name,
        value: rg.name,
        description: rg.location || 'No location',
      })),
      createNewPick,
    ],
    {
      title: `Create Automation Account - ${subscription.name}`,
      placeHolder: 'Choose an existing resource group or create a new one',
      ignoreFocusOut: true,
    }
  );
  if (!pickedResourceGroup) { return undefined; }

  let resourceGroupName = pickedResourceGroup.value;
  let location = resourceGroups.find(rg => rg.name === pickedResourceGroup.value)?.location ?? '';
  let createdResourceGroup = false;

  if (pickedResourceGroup.value === createNewPick.value) {
    const newResourceGroupName = await vscode.window.showInputBox({
      title: `Create Automation Account - ${subscription.name}`,
      prompt: 'New resource group name',
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'Resource group name is required.',
    });
    if (!newResourceGroupName?.trim()) { return undefined; }
    resourceGroupName = newResourceGroupName.trim();

    const newLocation = await vscode.window.showInputBox({
      title: `Create Automation Account - ${subscription.name}`,
      prompt: 'Azure location for the new resource group and Automation Account',
      placeHolder: 'e.g. westeurope, northeurope, eastus',
      value: resourceGroups[0]?.location ?? '',
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'Location is required.',
    });
    if (!newLocation?.trim()) { return undefined; }
    location = newLocation.trim();
    createdResourceGroup = true;
  }

  const accountName = await vscode.window.showInputBox({
    title: `Create Automation Account - ${subscription.name}`,
    prompt: 'Automation Account name',
    ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : 'Automation Account name is required.',
  });
  if (!accountName?.trim()) { return undefined; }

  return {
    accountName: accountName.trim(),
    resourceGroupName,
    location,
    createdResourceGroup,
  };
}

async function resolveSubscriptionForAutomationAccountCreate(
  item: unknown,
  azure: AzureService
): Promise<{ id: string; name: string } | undefined> {
  if (item instanceof SubscriptionItem) {
    return { id: item.subscription.id, name: item.subscription.name };
  }

  if (item instanceof vscode.Uri) {
    const normalized = item.fsPath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const isAccountsRoot = parts[parts.length - 1] === 'aaccounts';
    if (!isAccountsRoot) { return undefined; }

    const subscriptions = await azure.listSubscriptions();
    if (subscriptions.length === 0) {
      void vscode.window.showInformationMessage('No subscriptions found for this signed-in account.');
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      subscriptions.map(sub => ({
        label: sub.name,
        description: sub.id,
        value: { id: sub.id, name: sub.name },
      })),
      {
        title: 'Create Automation Account',
        placeHolder: 'Choose the subscription where the Automation Account will be created',
        ignoreFocusOut: true,
      }
    );
    return picked?.value;
  }

  return undefined;
}

export function registerRbCommands(deps: RbCommandDeps): vscode.Disposable[] {
  const {
    auth, azure, workspace, outputChannel,
    treeProvider, workspaceRunbooksProvider,
    folderDecorations, iconTheme, workspaceProtection,
    commands, runner, cicd, jobsPanel, schedulesPanel, assetsPanel, appPermissionsPanel,
  } = deps;

  const reg = (id: string, fn: (...args: unknown[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      if (!WORKSPACE_EXEMPT.has(id) && !workspace.isWorkspaceOpen) {
        const choice = await vscode.window.showErrorMessage(
          'No workspace folder is open. Open a folder and initialize it with an Automation Account first.',
          'Open Folder'
        );
        if (choice === 'Open Folder') {
          void vscode.commands.executeCommand('vscode.openFolder');
        }
        return;
      }
      try {
        await fn(...args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[command-error] ${id}: ${msg}`);
        void vscode.window.showErrorMessage(`${id} failed: ${msg}`);
      }
    });

  return [
    reg('runbookWorkbench.signIn', async () => {
      const ok = await auth.signIn(false);
      if (ok) {
        void vscode.window.showInformationMessage(`Signed in as ${auth.accountName}`);
        treeProvider.refresh();
      }
    }),

    reg('runbookWorkbench.signOut', async () => {
      await auth.signOut();
      treeProvider.refresh();
    }),

    reg('runbookWorkbench.selectCloud', async () => {
      await auth.selectCloud();
      treeProvider.refresh();
    }),

    reg('runbookWorkbench.refresh', () => {
      treeProvider.refresh();
    }),

    reg('runbookWorkbench.refreshWorkspaceRunbooks', () => {
      workspaceRunbooksProvider.refresh();
      iconTheme.update();
    }),

    reg('runbookWorkbench.initWorkspace', async (item: unknown) => {
      const account = item instanceof AutomationAccountItem ? item.account : undefined;
      if (!account) {
        void vscode.window.showErrorMessage('Select an Automation Account in the tree first.');
        return;
      }
      if (!workspace.isWorkspaceOpen) {
        void vscode.window.showErrorMessage('Open a folder in VS Code before initializing a workspace.');
        return;
      }
      const before = workspace.getLinkedAccounts();
      outputChannel.appendLine(`[init] Before: ${before.map(a => a.accountName).join(', ') || '(none)'}`);
      await workspace.initWorkspace(account.name, account.resourceGroupName, account.subscriptionId, account.subscriptionName, account.location);
      const after = workspace.getLinkedAccounts();
      outputChannel.appendLine(`[init] After: ${after.map(a => a.accountName).join(', ')}`);
      workspaceRunbooksProvider.refresh();
      folderDecorations.refresh();
      iconTheme.update();
      void vscode.window.showInformationMessage(
        `Workspace initialized for "${account.name}". Open local.settings.json to configure asset mocks.`
      );
      const doc = await vscode.workspace.openTextDocument(workspace.localSettingsPath);
      await vscode.window.showTextDocument(doc);
    }),

    reg('runbookWorkbench.initAndFetchAllInSubscription', async (item: unknown) => {
      if (!(item instanceof SubscriptionItem)) { return; }
      if (!workspace.isWorkspaceOpen) {
        void vscode.window.showErrorMessage('Open a folder in VS Code before initializing a workspace.');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Setting up "${item.subscription.name}"…` },
        async () => {
          const accounts = await azure.listAutomationAccounts(item.subscription.id, item.subscription.name);
          if (accounts.length === 0) {
            void vscode.window.showInformationMessage('No Automation Accounts found in this subscription.');
            return;
          }
          for (const account of accounts) {
            outputChannel.appendLine(`[setup] Initializing ${account.name}…`);
            await workspace.initWorkspace(account.name, account.resourceGroupName, account.subscriptionId, account.subscriptionName, account.location);
          }
          for (const account of accounts) {
            outputChannel.appendLine(`[setup] Fetching all resources for ${account.name}…`);
            await commands.fetchAllForAccount(account);
          }
          workspaceRunbooksProvider.refresh();
          folderDecorations.refresh();
          iconTheme.update();
          void vscode.window.showInformationMessage(
            `Setup complete: ${accounts.length} account(s) from "${item.subscription.name}" initialized and fetched.`
          );
        }
      );
    }),

    reg('runbookWorkbench.createAutomationAccount', async (item: unknown) => {
      const subscription = await resolveSubscriptionForAutomationAccountCreate(item, azure);
      if (!subscription) { return; }

      const request = await promptForAutomationAccountCreate(azure, subscription);
      if (!request) { return; }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Creating Automation Account "${request.accountName}"…`,
        },
        async () => {
          if (request.createdResourceGroup) {
            outputChannel.appendLine(
              `[create-account] Creating resource group "${request.resourceGroupName}" in ${request.location}…`
            );
            await azure.createOrUpdateResourceGroup(
              subscription.id,
              request.resourceGroupName,
              request.location
            );
          }

          outputChannel.appendLine(
            `[create-account] Creating automation account "${request.accountName}" in resource group "${request.resourceGroupName}"…`
          );
          await azure.createAutomationAccount(
            subscription.id,
            request.resourceGroupName,
            request.accountName,
            request.location
          );
        }
      );

      if (workspace.isWorkspaceOpen) {
        await workspace.initWorkspace(
          request.accountName,
          request.resourceGroupName,
          subscription.id,
          subscription.name,
          request.location
        );
        workspaceRunbooksProvider.refresh();
        folderDecorations.refresh();
        iconTheme.update();
      }

      await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
      treeProvider.refresh();
      void vscode.window.showInformationMessage(
        workspace.isWorkspaceOpen
          ? `Automation Account "${request.accountName}" was created and added to the workspace.`
          : `Automation Account "${request.accountName}" was created in "${request.resourceGroupName}".`
      );
    }),

    reg('runbookWorkbench.deleteWorkspace', async (item: unknown) => {
      if (!(item instanceof vscode.Uri) || path.basename(item.fsPath) !== 'aaccounts') { return; }

      const confirm = await vscode.window.showWarningMessage(
        'Delete the entire local Runbook Workspace? This removes all ARW-managed local content, including automation account folders, cached/settings data, mocks, local.settings.json, and generated CI/CD pipeline files. Azure resources will not be deleted.',
        { modal: true },
        'Delete Entire Workspace'
      );
      if (confirm !== 'Delete Entire Workspace') { return; }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Deleting local Runbook Workspace...',
        },
        async () => {
          await workspaceProtection.runWithoutProtection(async () => {
            workspace.clearWorkspace();
          });
        }
      );

      treeProvider.refresh();
      workspaceRunbooksProvider.refresh();
      folderDecorations.refresh();
      iconTheme.update();
      await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
      void vscode.window.showInformationMessage('ARW-managed local workspace content was deleted. Azure resources were not changed.');
    }),

    reg('runbookWorkbench.deleteTmpFolder', async (item: unknown) => {
      if (!(item instanceof vscode.Uri)) { return; }
      const confirm = await vscode.window.showWarningMessage(
        'Delete all temporary run/debug artifacts in .settings/tmp? This cannot be undone.',
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') { return; }
      await workspaceProtection.runWithoutProtection(async () => {
        fs.rmSync(item.fsPath, { recursive: true, force: true });
      });
      await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    }),

    reg('runbookWorkbench.deployLocalModuleToAzure', async (item: unknown) => {
      await executeDeployModuleToAzure(item, auth, azure, workspace, outputChannel);
    }),

    reg('runbookWorkbench.deleteLocalModule', async (item: unknown) => {
      if (!(item instanceof vscode.Uri)) { return; }
      const moduleName = path.basename(item.fsPath);
      const confirm = await vscode.window.showWarningMessage(
        `Delete local module "${moduleName}"? It can be re-installed via "Install Module for Local Debug".`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') { return; }
      await workspaceProtection.runWithoutProtection(async () => {
        fs.rmSync(item.fsPath, { recursive: true, force: true });
      });
      await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
    }),

    reg('runbookWorkbench.fetchAllRunbooks', async (item: unknown) => {
      if (!(item instanceof AutomationAccountItem)) { return; }
      await ensureLinked(item.account, workspace, outputChannel);
      await commands.fetchAllRunbooks(item.account);
      workspaceRunbooksProvider.refresh();
      iconTheme.update();
    }),

    reg('runbookWorkbench.syncAccount', async (item: unknown) => {
      const account = resolveAutomationAccountFromItem(item, workspace);
      if (!account) { return; }
      await ensureLinked(account, workspace, outputChannel);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Syncing "${account.name}" with Azure...`,
        },
        async () => {
          await commands.syncRunbooks(account);
          await commands.fetchAllForAccount(account);
          await syncAzureAssetsToLocalSettingsForAccount(azure, workspace, outputChannel, account);
        }
      );

      treeProvider.refresh();
      workspaceRunbooksProvider.refresh();
      folderDecorations.refresh();
      iconTheme.update();
    }),

    reg('runbookWorkbench.fetchRunbook', async (item: unknown) => {
      const runbook = await resolveRunbook(item, azure, workspace);
      if (!runbook) { return; }
      await ensureLinked({
        name: runbook.accountName, resourceGroupName: runbook.resourceGroupName,
        subscriptionId: runbook.subscriptionId, subscriptionName: runbook.subscriptionName,
        location: runbook.accountLocation,
      }, workspace, outputChannel);
      await commands.fetchRunbook(runbook, 'published');
      treeProvider.refresh();
      workspaceRunbooksProvider.refresh();
      iconTheme.update();
    }),

    reg('runbookWorkbench.fetchDraftRunbook', async (item: unknown) => {
      const runbook = await resolveRunbook(item, azure, workspace);
      if (!runbook) { return; }
      await ensureLinked({
        name: runbook.accountName, resourceGroupName: runbook.resourceGroupName,
        subscriptionId: runbook.subscriptionId, subscriptionName: runbook.subscriptionName,
        location: runbook.accountLocation,
      }, workspace, outputChannel);
      await commands.fetchRunbook(runbook, 'draft');
      workspaceRunbooksProvider.refresh();
      iconTheme.update();
    }),

    reg('runbookWorkbench.publishRunbook', async (item: unknown, allItems: unknown) => {
      const selectedItems = Array.isArray(allItems) && allItems.length > 1 ? allItems : [item];
      if (selectedItems.length === 1) {
        const runbook = await resolveOrCreateRunbookForDeployment(item, azure, workspace, commands, 'publish');
        if (!runbook) { return; }
        await commands.publishRunbook(runbook);
        treeProvider.refresh();
        workspaceRunbooksProvider.refresh();
        iconTheme.update();
        return;
      }

      const resolved: RunbookSummary[] = [];
      for (const selectedItem of selectedItems) {
        const runbook = await resolveOrCreateRunbookForDeployment(selectedItem, azure, workspace, commands, 'publish');
        if (runbook) {
          resolved.push(runbook);
        }
      }
      if (resolved.length === 0) { return; }

      const confirm = await vscode.window.showWarningMessage(
        `Publish ${resolved.length} runbook(s) to Azure? This will overwrite the published versions.`,
        { modal: true },
        'Publish'
      );
      if (confirm !== 'Publish') { return; }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Publishing ${resolved.length} runbook(s)…` },
        async () => {
          for (const runbook of resolved) {
            await commands.publishRunbook(runbook, { skipConfirm: true, suppressSuccessMessage: true });
          }
        }
      );

      void vscode.window.showInformationMessage(`Published ${resolved.length} runbook(s).`);
      treeProvider.refresh();
      workspaceRunbooksProvider.refresh();
      iconTheme.update();
    }),

    reg('runbookWorkbench.uploadAsDraft', async (item: unknown, allItems: unknown) => {
      const selectedItems = Array.isArray(allItems) && allItems.length > 1 ? allItems : [item];
      if (selectedItems.length === 1) {
        const runbook = await resolveOrCreateRunbookForDeployment(item, azure, workspace, commands, 'upload as draft');
        if (!runbook) { return; }
        await commands.uploadAsDraft(runbook);
        treeProvider.refresh();
        workspaceRunbooksProvider.refresh();
        iconTheme.update();
        return;
      }

      const resolved: RunbookSummary[] = [];
      for (const selectedItem of selectedItems) {
        const runbook = await resolveOrCreateRunbookForDeployment(selectedItem, azure, workspace, commands, 'upload as draft');
        if (runbook) {
          resolved.push(runbook);
        }
      }
      if (resolved.length === 0) { return; }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Uploading ${resolved.length} draft(s)…` },
        async () => {
          for (const runbook of resolved) {
            await commands.uploadAsDraft(runbook, { suppressSuccessMessage: true });
          }
        }
      );

      void vscode.window.showInformationMessage(`Uploaded ${resolved.length} runbook draft(s).`);
      treeProvider.refresh();
      workspaceRunbooksProvider.refresh();
      iconTheme.update();
    }),

    reg('runbookWorkbench.diffRunbook', async (item: unknown) => {
      const runbook = await resolveRunbook(item, azure, workspace);
      if (!runbook) { return; }
      await commands.diffRunbook(runbook);
    }),

    reg('runbookWorkbench.startTestJob', async (item: unknown) => {
      const runbook = await resolveRunbook(item, azure, workspace);
      if (!runbook) { return; }
      await commands.startTestJob(runbook);
    }),

    reg('runbookWorkbench.stopTestJob', async (item: unknown) => {
      if (!(item instanceof RunbookItem)) { return; }
      await commands.stopTestJob(item.runbook);
    }),

    reg('runbookWorkbench.startJob', async (item: unknown) => {
      const runbook = await resolveRunbook(item, azure, workspace);
      if (!runbook) { return; }
      await commands.startJob(runbook);
    }),

    reg('runbookWorkbench.viewJobs', async (item: unknown) => {
      const runbook = await resolveRunbook(item, azure, workspace);
      if (runbook) {
        await jobsPanel.openForRunbook(runbook);
        return;
      }
      const account = resolveAutomationAccountFromItem(item, workspace);
      if (!account) { return; }
      await jobsPanel.openForAccount(account);
    }),

    reg('runbookWorkbench.viewSchedules', async (item: unknown) => {
      const account = resolveAutomationAccountFromItem(item, workspace);
      if (!account) { return; }
      await schedulesPanel.openForAccount(account);
    }),

    reg('runbookWorkbench.viewAssets', async (item: unknown) => {
      const account = resolveAutomationAccountFromItem(item, workspace);
      if (!account) { return; }
      await assetsPanel.openForAccount(account);
    }),

    reg('runbookWorkbench.viewAppPermissions', async (item: unknown) => {
      const account = resolveAutomationAccountFromItem(item, workspace);
      if (!account) { return; }
      await appPermissionsPanel.openForAccount(account);
    }),

    reg('runbookWorkbench.runLocal', async (item: unknown) => {
      const runbook = await resolveRunbookForLocalRun(resolveCommandItemOrActiveEditor(item), azure, workspace);
      if (!runbook) { return; }
      await runner.run(runbook);
    }),

    reg('runbookWorkbench.debugLocal', async (item: unknown) => {
      const runbook = await resolveRunbookForLocalRun(resolveCommandItemOrActiveEditor(item), azure, workspace);
      if (!runbook) { return; }
      await runner.debug(runbook);
    }),

    reg('runbookWorkbench.createRunbook', async (item: unknown) => {
      let accountName: string | undefined;
      let resourceGroup: string | undefined;
      let subscriptionId: string | undefined;
      let subscriptionName: string | undefined;
      let location: string | undefined;
      let prefill: CreateRunbookPrefill | undefined;

      if (item instanceof AutomationAccountItem) {
        accountName      = item.account.name;
        resourceGroup    = item.account.resourceGroupName;
        subscriptionId   = item.account.subscriptionId;
        subscriptionName = item.account.subscriptionName;
        location         = item.account.location;
      } else if (item instanceof vscode.Uri) {
        const parts = item.fsPath.replace(/\\/g, '/').split('/');
        const idx = parts.findIndex(p => p === 'aaccounts');
        if (idx === -1 || idx + 1 >= parts.length) { return; }
        accountName = parts[idx + 1];
        const linked = workspace.getLinkedAccount(accountName);
        if (!linked) {
          void vscode.window.showErrorMessage(`Account "${accountName}" is not linked. Run "Initialize Runbook Workspace" first.`);
          return;
        }
        resourceGroup    = linked.resourceGroup;
        subscriptionId   = linked.subscriptionId;
        subscriptionName = linked.subscriptionName;
        location         = linked.location;
        if (!location) {
          void vscode.window.showErrorMessage(
            `Account "${accountName}" is missing location data. Re-run "Initialize Runbook Workspace" to fix it.`
          );
          return;
        }
      } else if (isCreateRunbookCommandRequest(item)) {
        accountName = item.accountName;
        resourceGroup = item.resourceGroup;
        subscriptionId = item.subscriptionId;
        subscriptionName = item.subscriptionName;
        location = item.location;
        prefill = {
          name: item.name,
          runbookType: item.runbookType,
          description: item.description,
          runtimeEnvironment: item.runtimeEnvironment,
        };

        if (accountName && (!resourceGroup || !subscriptionId || !subscriptionName || !location)) {
          const linked = workspace.getLinkedAccount(accountName);
          if (linked) {
            resourceGroup ??= linked.resourceGroup;
            subscriptionId ??= linked.subscriptionId;
            subscriptionName ??= linked.subscriptionName;
            location ??= linked.location;
          }
        }
      }

      if (!accountName || !resourceGroup || !subscriptionId || !subscriptionName || !location) { return; }
      const created = await commands.createRunbook(accountName, resourceGroup, subscriptionId, location, prefill);
      if (created) {
        await commands.fetchRunbook({
          name: created.name,
          runbookType: created.runbookType,
          runtimeEnvironment: created.runtimeEnvironment,
          state: 'New',
          accountName,
          resourceGroupName: resourceGroup,
          subscriptionId,
          subscriptionName,
        }, 'draft');
      }
      treeProvider.refresh();
      workspaceRunbooksProvider.refresh();
      iconTheme.update();
    }),

    reg('runbookWorkbench.deleteRunbook', async (item: unknown, allItems: unknown) => {
      if (item instanceof RunbookItem) {
        await commands.deleteRunbook(item.runbook);
        await commands.syncRunbooks({
          name: item.runbook.accountName,
          resourceGroupName: item.runbook.resourceGroupName,
          subscriptionId: item.runbook.subscriptionId,
          subscriptionName: item.runbook.subscriptionName,
          location: item.runbook.accountLocation ?? '',
          id: '',
        });
        treeProvider.refresh();
        workspaceRunbooksProvider.refresh();
        return;
      }

      // ── Bulk delete (multi-select in workspace tree) ──────────────────────
      const selected = (Array.isArray(allItems) && (allItems as unknown[]).length > 1 ? allItems as unknown[] : [item])
        .map(i => extractRunbookRef(i))
        .filter((r): r is NonNullable<typeof r> => r !== undefined);

      if (selected.length === 0) { return; }

      const names = selected.map(r => r.runbookName).join(', ');
      const label = selected.length === 1 ? `"${names}"` : `${selected.length} runbooks (${names})`;

      if (!auth.isSignedIn) {
        void vscode.window.showErrorMessage('You must be signed in to delete runbooks from Azure.');
        return;
      }

      const confirmDelete = await vscode.window.showWarningMessage(
        `Delete ${label} locally and from Azure? This cannot be undone.`,
        { modal: true }, 'Delete locally and from Azure'
      );
      if (confirmDelete !== 'Delete locally and from Azure') { return; }

      const deletedRemote: typeof selected = [];
      const failedRemote: Array<{ ref: typeof selected[number]; reason: string }> = [];

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Deleting ${selected.length} runbook(s) from Azure…` },
        async () => {
          for (const ref of selected) {
            const runbook = await resolveWorkspaceRunbook(ref, azure, workspace);
            if (!runbook) {
              failedRemote.push({ ref, reason: 'Runbook could not be resolved in Azure.' });
              outputChannel.appendLine(`[bulk-delete-error] ${ref.runbookName}: Runbook could not be resolved in Azure`);
              continue;
            }

            try {
              await azure.deleteRunbook(runbook.subscriptionId, runbook.resourceGroupName, runbook.accountName, runbook.name);
              deletedRemote.push(ref);
              outputChannel.appendLine(`[bulk-delete] ${ref.runbookName}: deleted from Azure`);
            } catch (err) {
              const reason = String(err);
              failedRemote.push({ ref, reason });
              outputChannel.appendLine(`[bulk-delete-error] ${ref.runbookName}: ${reason}`);
            }
          }
        }
      );

      for (const ref of deletedRemote) {
        workspace.deleteRunbookFile(ref.filePath);
      }

      const syncedAccounts = new Set<string>();
      for (const ref of deletedRemote) {
        if (syncedAccounts.has(ref.accountName)) { continue; }
        const account = resolveAutomationAccountFromItem(vscode.Uri.file(workspace.accountDirForAccount(ref.accountName)), workspace);
        if (!account) { continue; }
        await commands.syncRunbooks(account);
        syncedAccounts.add(ref.accountName);
      }

      treeProvider.refresh();
      workspaceRunbooksProvider.refresh();
      iconTheme.update();

      if (deletedRemote.length > 0) {
        const successLabel = deletedRemote.length === 1
          ? `"${deletedRemote[0].runbookName}"`
          : `${deletedRemote.length} runbooks`;
        void vscode.window.showInformationMessage(`Deleted ${successLabel} locally and from Azure.`);
      }

      if (failedRemote.length > 0) {
        const summary = failedRemote.map(f => `${f.ref.runbookName}: ${f.reason}`).join(' | ');
        void vscode.window.showErrorMessage(`Failed to delete ${failedRemote.length} runbook(s): ${summary}`);
      }
    }),

    reg('runbookWorkbench.openLocalSettings', async () => {
      const doc = await vscode.workspace.openTextDocument(workspace.localSettingsPath);
      await vscode.window.showTextDocument(doc);
    }),

    reg('runbookWorkbench.generateCiCd', async (_item: unknown) => {
      const accountName = getAccountNameFromExplorerUri(_item);
      await cicd.generate(accountName);
    }),

    reg('runbookWorkbench.manageAssets', async (item: unknown) => {
      let account = item instanceof AutomationAccountItem ? item.account : undefined;
      if (!account) {
        const accountName = getAccountNameFromExplorerUri(item);
        if (accountName) {
          const linked = workspace.getLinkedAccount(accountName);
          if (linked) {
            account = {
              name: linked.accountName,
              resourceGroupName: linked.resourceGroup,
              subscriptionId: linked.subscriptionId,
              subscriptionName: linked.subscriptionName,
              location: linked.location ?? '',
              id: '',
            };
          }
        }
      }
      if (!account) { return; }
      await showAssetsPanel(
        azure,
        account.subscriptionId,
        account.resourceGroupName,
        account.name,
        workspace,
        outputChannel,
        async () => {
          await commands.fetchAllForAccount(account!);
          workspaceRunbooksProvider.refresh();
          folderDecorations.refresh();
          iconTheme.update();
          await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
        }
      );
    }),

    reg('runbookWorkbench.manageRuntimeEnvironments', async (item: unknown) => {
      const account = resolveAutomationAccountFromItem(item, workspace);
      if (!account) { return; }
      try {
        const changed = await manageRuntimeEnvironments(azure, account, outputChannel);
        if (!changed) { return; }
        await commands.fetchAllForAccount(account);
        treeProvider.refresh();
        workspaceRunbooksProvider.refresh();
        folderDecorations.refresh();
        iconTheme.update();
      } catch (err) {
        outputChannel.appendLine(`[runtime-environment-error] ${account.name}: ${errMessage(err)}`);
        void vscode.window.showErrorMessage(`Failed to manage Runtime Environments for "${account.name}": ${errMessage(err)}`);
      }
    }),

    reg('runbookWorkbench.changeRunbookRuntimeEnvironment', async (item: unknown) => {
      const runbook = await resolveRunbook(item, azure, workspace);
      if (!runbook) { return; }
      await commands.changeRunbookRuntimeEnvironment(runbook);
      treeProvider.refresh();
      workspaceRunbooksProvider.refresh();
      iconTheme.update();
    }),

    reg('runbookWorkbench.installModuleForLocalDebug', async (item: unknown) => {
      await executeInstallModuleForLocalDebug(resolveCommandItemOrActiveEditor(item), runner, outputChannel);
    }),

    reg('runbookWorkbench.showInPortal', async (item: unknown) => {
      const url = await resolvePortalUrl(item, auth, azure, workspace);
      if (!url) {
        void vscode.window.showErrorMessage('Could not resolve an Automation Account or runbook to open in Azure Portal.');
        return;
      }
      outputChannel.appendLine(`[portal] ${url}`);
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    reg('runbookWorkbench.openWorkspaceRunbook', async (item: unknown) => {
      if (item instanceof WorkspaceRunbookItem) {
        const doc = await vscode.workspace.openTextDocument(item.filePath);
        await vscode.window.showTextDocument(doc);
      }
    }),
  ];
}

function resolveAutomationAccountFromItem(
  item: unknown,
  workspace: WorkspaceManager
): AzureAutomationAccount | undefined {
  if (item instanceof AutomationAccountItem) {
    return item.account;
  }
  if (item instanceof AccountSectionItem) {
    return item.account;
  }
  if (item instanceof RuntimeEnvironmentItem) {
    return item.account;
  }

  const accountName = getAccountNameFromExplorerUri(item);
  if (!accountName) { return undefined; }

  const linked = workspace.getLinkedAccount(accountName);
  if (!linked) { return undefined; }

  return {
    name: linked.accountName,
    resourceGroupName: linked.resourceGroup,
    subscriptionId: linked.subscriptionId,
    subscriptionName: linked.subscriptionName,
    location: linked.location ?? '',
    id: '',
  };
}
