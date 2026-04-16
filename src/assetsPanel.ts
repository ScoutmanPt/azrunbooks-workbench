import * as vscode from 'vscode';
import type { AzureAutomationAccount, AzureService } from './azureService';
import type { AssetTab, AssetsPanelState, AssetsPanelMessage } from './assetsShared';
import { esc, errMsg, SUPPORTED_RUNTIME_VERSIONS } from './assetsShared';
import type { AuthManager } from './authManager';
import type { LocalRunner } from './localRunner';
import type { WorkspaceManager } from './workspaceManager';
import { executeInstallModuleForLocalDebug } from './installModuleCommands';
import { executeDeployModuleToAzure } from './deployModuleCommands';
import { loadModules, renderModulesPane, MODULES_CSS, MODULES_SCRIPT } from './assetsTabModules';
import {
  loadRuntimeEnvironments, renderRuntimeEnvironmentsPane,
  renderRuntimeEnvironmentsFormBody, renderRuntimeEnvironmentsSubmitButton, RUNTIME_ENVIRONMENTS_FORM_SCRIPT,
} from './assetsTabRuntimeEnvironments';

// ── Tab components ────────────────────────────────────────────────────────────
import {
  loadVariables, getVariableEditPrefill, validateVariableForm, submitVariable, deleteVariable,
  renderVariablesPane, renderVariablesFormBody, renderVariablesSubmitButton, VARIABLES_FORM_SCRIPT,
  VARIABLES_CSV_HEADER, variablesCsvRows, VARIABLES_EXPORT_HEADERS, variablesExportRows,
} from './assetsTabVariables';

import {
  loadCredentials, getCredentialEditPrefill, validateCredentialForm, submitCredential, deleteCredential,
  renderCredentialsPane, renderCredentialsFormBody, renderCredentialsSubmitButton, CREDENTIALS_FORM_SCRIPT,
  CREDENTIALS_CSV_HEADER, credentialsCsvRows, CREDENTIALS_EXPORT_HEADERS, credentialsExportRows,
} from './assetsTabCredentials';

import {
  loadConnections, getConnectionEditPrefill, validateConnectionForm, submitConnection, deleteConnection,
  renderConnectionsPane, renderConnectionsFormBody, renderConnectionsSubmitButton, CONNECTIONS_FORM_SCRIPT,
  CONNECTIONS_CSV_HEADER, connectionsCsvRows, CONNECTIONS_EXPORT_HEADERS, connectionsExportRows,
} from './assetsTabConnections';

import {
  loadCertificates, getCertificateEditPrefill, validateCertificateForm, submitCertificate, deleteCertificate,
  renderCertificatesPane, renderCertificatesFormBody, renderCertificatesSubmitButton, CERTIFICATES_FORM_SCRIPT,
  CERTIFICATES_CSV_HEADER, certificatesCsvRows, CERTIFICATES_EXPORT_HEADERS, certificatesExportRows,
} from './assetsTabCertificates';

async function promptForDefaultPackages(
  initialValue: Record<string, string> | undefined
): Promise<Record<string, string> | undefined> {
  const raw = await vscode.window.showInputBox({
    title: 'Runtime Environment Packages (optional JSON)',
    prompt: 'Example: {"Az":"12.3.0"}',
    value: initialValue && Object.keys(initialValue).length > 0 ? JSON.stringify(initialValue) : '',
    ignoreFocusOut: true,
  });
  if (raw === undefined) { return undefined; }
  if (!raw.trim()) { return {}; }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a JSON object like {"Az":"12.3.0"}');
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([name, version]) => name.trim() && typeof version === 'string' && version.trim())
        .map(([name, version]) => [name.trim(), version.trim()])
    );
  } catch (e) {
    void vscode.window.showErrorMessage(`Invalid package JSON: ${errMsg(e)}`);
    return undefined;
  }
}

async function promptForRuntimeEnvironmentCreate(location: string): Promise<{
  name: string;
  location: string;
  language: string;
  version: string;
  description?: string;
  defaultPackages?: Record<string, string>;
} | undefined> {
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
      { label: 'PowerShell', value: 'PowerShell' },
      { label: 'Python', value: 'Python' },
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

  const defaultPackages = await promptForDefaultPackages(undefined);
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

// ── Panel class ───────────────────────────────────────────────────────────────

export class AssetsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private state!: AssetsPanelState;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly azure: AzureService,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly auth: AuthManager,
    private readonly runner: LocalRunner,
    private readonly workspace: WorkspaceManager
  ) {}

  async openForAccount(account: AzureAutomationAccount): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'runbookWorkbench.assets',
        'Assets',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] }
      );
      this.panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
      this.panel.webview.onDidReceiveMessage((msg: AssetsPanelMessage) => {
        void this.handleMessage(msg);
      }, undefined, this.disposables);
    } else {
      this.panel.reveal(vscode.ViewColumn.Active, false);
    }

    this.state = {
      account,
      activeTab: 'variables',
      variables:    { items: [], loading: true },
      credentials:  { items: [], loading: true },
      connections:  { items: [], loading: true },
      certificates: { items: [], loading: true },
      modules:      { items: [], loading: true },
      runtimeEnvironments: { items: [], loading: true },
      form: { open: false, mode: 'new', tab: 'variables', loading: false },
    };
    this.panel.title = `Assets – ${account.name}`;
    this.render();
    await this.refreshAll();
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    vscode.Disposable.from(...this.disposables).dispose();
  }

  // ── Message handler ───────────────────────────────────────────────────────

  private async handleMessage(msg: AssetsPanelMessage): Promise<void> {
    switch (msg.type) {
      case 'switchTab':
        this.state.activeTab = msg.tab;
        break;

      case 'refresh':
        await this.refreshAll();
        break;

      case 'showNewForm':
        if (msg.tab === 'runtimeEnvironments') {
          await this.handleRuntimeEnvironmentAction('create');
          break;
        }
        this.state.form = { open: true, mode: 'new', tab: msg.tab, loading: false };
        this.render();
        break;

      case 'showEditForm':
        await this.openEditForm(msg.tab, msg.name);
        break;

      case 'cancelForm':
        this.state.form = { open: false, mode: 'new', tab: this.state.activeTab, loading: false };
        this.render();
        break;

      case 'submitVariableForm':    await this.runSubmit('variables',    () => {
        const err = validateVariableForm(msg.formData);
        if (err) { throw new Error(err); }
        return submitVariable(this.azure, this.state.account, msg.formData);
      }, msg.formData as unknown as Record<string, unknown>); break;

      case 'submitCredentialForm':  await this.runSubmit('credentials',  () => {
        const err = validateCredentialForm(msg.formData, this.state.form.mode);
        if (err) { throw new Error(err); }
        return submitCredential(this.azure, this.state.account, msg.formData, this.state.form.mode);
      }, msg.formData as unknown as Record<string, unknown>); break;

      case 'submitConnectionForm':  await this.runSubmit('connections',  () => {
        const err = validateConnectionForm(msg.formData);
        if (err) { throw new Error(err); }
        return submitConnection(this.azure, this.state.account, msg.formData);
      }, msg.formData as unknown as Record<string, unknown>); break;

      case 'submitCertificateForm': await this.runSubmit('certificates', () => {
        const err = validateCertificateForm(msg.formData, this.state.form.mode);
        if (err) { throw new Error(err); }
        return submitCertificate(this.azure, this.state.account, msg.formData);
      }, msg.formData as unknown as Record<string, unknown>); break;

      case 'submitRuntimeEnvironmentForm': await this.runSubmit('runtimeEnvironments', () => {
        const fd = msg.formData;
        if (!fd.name.trim())     { throw new Error('Name is required.'); }
        if (!fd.language.trim()) { throw new Error('Language is required.'); }
        if (!fd.version.trim())  { throw new Error('Version is required.'); }
        const pkgMap: Record<string, string> = {};
        fd.packageKeys.forEach((k, i) => { if (k.trim()) { pkgMap[k.trim()] = fd.packageVersions[i] ?? ''; } });
        return this.azure.createRuntimeEnvironment(
          this.state.account.subscriptionId, this.state.account.resourceGroupName, this.state.account.name,
          { name: fd.name.trim(), location: this.state.account.location, language: fd.language, version: fd.version,
            description: fd.description.trim() || undefined,
            defaultPackages: Object.keys(pkgMap).length > 0 ? pkgMap : undefined }
        );
      }, msg.formData as unknown as Record<string, unknown>); break;

      case 'deleteSelected':
        await this.deleteSelected(msg.tab, msg.names);
        break;

      case 'exportCsv':  await this.exportCsv(); break;
      case 'exportHtml': await this.exportHtmlReport(); break;
      case 'exportPdf':  await this.exportPdf(); break;
      case 'exportMd':   await this.exportMarkdown(); break;

      case 'moduleAction':
        await this.handleModuleAction(msg.action, msg.moduleName);
        break;

      case 'runtimeEnvironmentAction':
        await this.handleRuntimeEnvironmentAction(msg.action, msg.name);
        break;
    }
  }

  private async handleModuleAction(action: 'installGallery' | 'importLocal' | 'deployToAzure', moduleName?: string): Promise<void> {
    if (action === 'installGallery' || action === 'importLocal') {
      await executeInstallModuleForLocalDebug(undefined, this.runner, this.outputChannel, action === 'importLocal' ? 'local' : 'gallery');
    } else {
      // deployToAzure — pass moduleName hint so it can pre-select the module
      const itemHint = moduleName ? { moduleName } : undefined;
      await executeDeployModuleToAzure(itemHint, this.auth, this.azure, this.workspace, this.outputChannel);
    }
    // Refresh modules tab after action completes
    await this.reloadTab('modules');
    this.render();
  }

  private async handleRuntimeEnvironmentAction(
    action: 'create' | 'editPackages',
    name?: string
  ): Promise<void> {
    if (action === 'create') {
      this.state.form = { open: true, mode: 'new', tab: 'runtimeEnvironments', loading: false };
      this.render();
      return;
    }

    // editPackages — still uses QuickPick/InputBox flow
    if (!name) { return; }
    const { account } = this.state;
    try {
      const existing = await this.azure.getRuntimeEnvironment(account.subscriptionId, account.resourceGroupName, account.name, name);
      const defaultPackages = await promptForDefaultPackages(existing.defaultPackages);
      if (defaultPackages === undefined) { return; }
      await this.azure.updateRuntimeEnvironmentDefaultPackages(
        account.subscriptionId, account.resourceGroupName, account.name, existing.name, defaultPackages
      );
      this.outputChannel.appendLine(`[assets] Updated runtime environment "${existing.name}" in ${account.name}`);
      void vscode.window.showInformationMessage(`Runtime environment "${existing.name}" updated.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.outputChannel.appendLine(`[assets] Failed to update runtime environment: ${msg}`);
      void vscode.window.showErrorMessage(`Failed to update runtime environment: ${msg}`);
    }

    await this.reloadTab('runtimeEnvironments');
    this.render();
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  private async refreshAll(): Promise<void> {
    const { account } = this.state;
    this.state.variables    = { items: [], loading: true };
    this.state.credentials  = { items: [], loading: true };
    this.state.connections  = { items: [], loading: true };
    this.state.certificates = { items: [], loading: true };
    this.state.modules      = { items: [], loading: true };
    this.state.runtimeEnvironments = { items: [], loading: true };
    this.render();

    const [vars, creds, conns, certs, mods, runtimes] = await Promise.all([
      loadVariables(this.azure, account),
      loadCredentials(this.azure, account),
      loadConnections(this.azure, account),
      loadCertificates(this.azure, account),
      loadModules(this.azure, account, this.workspace.localModulesDir),
      loadRuntimeEnvironments(this.azure, account),
    ]);

    this.state.variables    = vars;
    this.state.credentials  = creds;
    this.state.connections  = conns;
    this.state.certificates = certs;
    this.state.modules      = mods;
    this.state.runtimeEnvironments = runtimes;

    if (vars.error)  { this.outputChannel.appendLine(`[assets] Failed to load variables: ${vars.error}`); }
    if (creds.error) { this.outputChannel.appendLine(`[assets] Failed to load credentials: ${creds.error}`); }
    if (conns.error) { this.outputChannel.appendLine(`[assets] Failed to load connections: ${conns.error}`); }
    if (certs.error) { this.outputChannel.appendLine(`[assets] Failed to load certificates: ${certs.error}`); }
    if (mods.error)  { this.outputChannel.appendLine(`[assets] Failed to load modules: ${mods.error}`); }
    if (runtimes.error) { this.outputChannel.appendLine(`[assets] Failed to load runtime environments: ${runtimes.error}`); }

    this.render();
  }

  private async reloadTab(tab: AssetTab): Promise<void> {
    const { account } = this.state;
    if (tab === 'variables')    { this.state.variables    = await loadVariables(this.azure, account); }
    if (tab === 'credentials')  { this.state.credentials  = await loadCredentials(this.azure, account); }
    if (tab === 'connections')  { this.state.connections  = await loadConnections(this.azure, account); }
    if (tab === 'certificates') { this.state.certificates = await loadCertificates(this.azure, account); }
    if (tab === 'modules')      { this.state.modules      = await loadModules(this.azure, account, this.workspace.localModulesDir); }
    if (tab === 'runtimeEnvironments') {
      this.state.runtimeEnvironments = await loadRuntimeEnvironments(this.azure, account);
    }
  }

  // ── Edit form hydration ───────────────────────────────────────────────────

  private async openEditForm(tab: AssetTab, name: string): Promise<void> {
    const { account } = this.state;
    this.state.form = { open: true, mode: 'edit', tab, loading: true, editName: name };
    this.render();
    try {
      let prefill: Record<string, unknown>;
      if (tab === 'variables')    { prefill = await getVariableEditPrefill(this.azure, account, name); }
      else if (tab === 'credentials') { prefill = await getCredentialEditPrefill(this.azure, account, name); }
      else if (tab === 'connections') { prefill = await getConnectionEditPrefill(this.azure, account, name); }
      else                        { prefill = await getCertificateEditPrefill(this.azure, account, name); }
      this.state.form = { open: true, mode: 'edit', tab, loading: false, editName: name, prefill };
    } catch (e) {
      this.state.form = { ...this.state.form, loading: false, error: errMsg(e) };
    }
    this.render();
  }

  // ── Submit helper ─────────────────────────────────────────────────────────

  private async runSubmit(tab: AssetTab, operation: () => Promise<void>, prefill?: Record<string, unknown>): Promise<void> {
    const { form, account } = this.state;
    this.state.form = { ...form, loading: true, error: undefined };
    this.render();
    try {
      await operation();
      this.outputChannel.appendLine(`[assets] Saved ${tab.slice(0, -1)} in ${account.name}`);
      this.state.form = { open: false, mode: 'new', tab, loading: false };
      await this.reloadTab(tab);
      this.render();
    } catch (e) {
      this.state.form = { ...this.state.form, loading: false, error: errMsg(e), prefill: prefill ?? form.prefill };
      this.render();
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  private async deleteSelected(tab: AssetTab, names: string[]): Promise<void> {
    if (names.length === 0) { return; }
    const { account } = this.state;

    const noun = tab === 'certificates'
      ? 'certificate'
      : tab === 'runtimeEnvironments'
        ? 'runtime environment'
        : tab.slice(0, -1);
    const label = names.length === 1 ? `${noun} "${names[0]}"` : `${names.length} ${tab}`;
    const confirmed = await vscode.window.showWarningMessage(
      `Delete ${label}? This cannot be undone.`, { modal: true }, 'Delete'
    );
    if (confirmed !== 'Delete') { return; }

    for (const name of names) {
      try {
        if (tab === 'variables')    { await deleteVariable(this.azure, account, name); }
        if (tab === 'credentials')  { await deleteCredential(this.azure, account, name); }
        if (tab === 'connections')  { await deleteConnection(this.azure, account, name); }
        if (tab === 'certificates') { await deleteCertificate(this.azure, account, name); }
        if (tab === 'runtimeEnvironments') {
          await this.azure.deleteRuntimeEnvironment(account.subscriptionId, account.resourceGroupName, account.name, name);
        }
        this.outputChannel.appendLine(`[assets] Deleted ${noun} "${name}" from ${account.name}`);
      } catch (e) {
        this.outputChannel.appendLine(`[assets] Failed to delete ${noun} "${name}": ${errMsg(e)}`);
        void vscode.window.showErrorMessage(`Failed to delete ${noun} "${name}": ${errMsg(e)}`);
      }
    }
    await this.reloadTab(tab);
    this.render();
  }

  // ── Export ────────────────────────────────────────────────────────────────

  private getExtensionVersion(): string {
    try {
      const ext = vscode.extensions.getExtension('ScoutmanPt.azure-runbook-workbench');
      if (ext?.packageJSON?.version) { return ext.packageJSON.version as string; }
    } catch {}
    return 'unknown';
  }

  private getDefaultExportDir(): string | undefined {
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length > 0) { return folders[0].uri.fsPath; }
    } catch {}
    return undefined;
  }

  private async exportCsv(): Promise<void> {
    const { account, variables, credentials, connections, certificates } = this.state;
    const version = this.getExtensionVersion();
    const lines: string[] = [
      `# Azure Runbooks Workbench v${version} by @scoutmanpt at https://www.pdragon.co`,
      '',
      '=== Variables ===', VARIABLES_CSV_HEADER, ...variablesCsvRows(variables.items), '',
      '=== Credentials ===', CREDENTIALS_CSV_HEADER, ...credentialsCsvRows(credentials.items), '',
      '=== Connections ===', CONNECTIONS_CSV_HEADER, ...connectionsCsvRows(connections.items), '',
      '=== Certificates ===', CERTIFICATES_CSV_HEADER, ...certificatesCsvRows(certificates.items),
    ];
    const defaultDir = this.getDefaultExportDir();
    const defaultPath = defaultDir ? `${defaultDir}/${account.name}-assets.csv` : `${account.name}-assets.csv`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultPath),
      filters: { 'CSV Files': ['csv'] },
    });
    if (!uri) { return; }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(lines.join('\n'), 'utf-8'));
    void vscode.window.showInformationMessage(`Assets exported to ${uri.fsPath}`);
  }

  private async exportHtmlReport(): Promise<void> {
    const { account } = this.state;
    const version = this.getExtensionVersion();
    const defaultDir = this.getDefaultExportDir();
    const defaultPath = defaultDir ? `${defaultDir}/${account.name}-assets.html` : `${account.name}-assets.html`;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting assets for ${account.name}…`, cancellable: false },
      async () => {
        const html = generateStandaloneHtml(account, this.state, version);
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(defaultPath),
          filters: { 'HTML Files': ['html'] },
        });
        if (!uri) { return; }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(html, 'utf-8'));
        void vscode.window.showInformationMessage(`Assets exported to ${uri.fsPath}`);
      }
    );
  }

  private async exportPdf(): Promise<void> {
    const { account } = this.state;
    const version = this.getExtensionVersion();
    const defaultDir = this.getDefaultExportDir();
    const defaultPath = defaultDir
      ? `${defaultDir}/${account.name}-assets-print.html`
      : `${account.name}-assets-print.html`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultPath),
      filters: { 'HTML Files': ['html'] },
      title: 'Save print-ready HTML (then open in browser → Print → Save as PDF)',
    });
    if (!uri) { return; }
    const html = generateStandaloneHtml(account, this.state, version);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(html, 'utf-8'));
    void vscode.window.showInformationMessage(
      `Saved to ${uri.fsPath} — open it in your browser and use Print → Save as PDF.`,
      'Open'
    ).then(choice => {
      if (choice === 'Open') { void vscode.env.openExternal(uri); }
    });
  }

  private async exportMarkdown(): Promise<void> {
    const { account, variables, credentials, connections, certificates } = this.state;
    const version = this.getExtensionVersion();
    const now = new Date().toLocaleString();

    const mdTable = (headers: string[], rows: string[][]): string => {
      const head = `| ${headers.join(' | ')} |`;
      const sep  = `| ${headers.map(() => '---').join(' | ')} |`;
      const body = rows.map(r => `| ${r.map(c => c.replace(/\|/g, '\\|')).join(' | ')} |`).join('\n');
      return `${head}\n${sep}\n${body}`;
    };

    const lines = [
      `# Assets – ${account.name}`,
      ``,
      `${account.resourceGroupName} · ${account.subscriptionName ?? account.subscriptionId} · Exported ${now}`,
      ``,
      `## Variables`,
      ``,
      mdTable(VARIABLES_EXPORT_HEADERS,    variablesExportRows(variables.items)),
      ``,
      `## Credentials`,
      ``,
      mdTable(CREDENTIALS_EXPORT_HEADERS,  credentialsExportRows(credentials.items)),
      ``,
      `## Connections`,
      ``,
      mdTable(CONNECTIONS_EXPORT_HEADERS,  connectionsExportRows(connections.items)),
      ``,
      `## Certificates`,
      ``,
      mdTable(CERTIFICATES_EXPORT_HEADERS, certificatesExportRows(certificates.items)),
      ``,
      `---`,
      ``,
      `*Azure Runbooks Workbench v${version} by @scoutmanpt — [www.pdragon.co](https://www.pdragon.co)*`,
    ];

    const defaultDir = this.getDefaultExportDir();
    const defaultPath = defaultDir ? `${defaultDir}/${account.name}-assets.md` : `${account.name}-assets.md`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultPath),
      filters: { 'Markdown Files': ['md'] },
    });
    if (!uri) { return; }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(lines.join('\n'), 'utf-8'));
    void vscode.window.showInformationMessage(`Assets exported to ${uri.fsPath}`);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private render(): void {
    if (!this.panel) { return; }
    this.panel.webview.html = renderHtml(this.state);
  }
}

// ── Shell HTML (layout + shared scripts) ─────────────────────────────────────

function renderHtml(state: AssetsPanelState): string {
  const { account, activeTab, form } = state;
  const tabs: AssetTab[] = ['variables', 'credentials', 'connections', 'certificates', 'modules', 'runtimeEnvironments'];
  const tabLabels: Record<AssetTab, string> = {
    variables: 'Variables', credentials: 'Credentials',
    connections: 'Connections', certificates: 'Certificates', modules: 'Classic Modules',
    runtimeEnvironments: 'Runtime Environments',
  };

  const tabBar = tabs.map(t => `
    <button class="tab-btn${t === activeTab ? ' active' : ''}" data-tab="${t}">
      ${tabLabels[t]}
      <span class="tab-badge" id="badge-${t}">${state[t].items.length}</span>
    </button>`).join('');

  const tabPanes = tabs.map(t => {
    let content = '';
    if (t === 'variables')    { content = renderVariablesPane(state.variables); }
    if (t === 'credentials')  { content = renderCredentialsPane(state.credentials); }
    if (t === 'connections')  { content = renderConnectionsPane(state.connections); }
    if (t === 'certificates') { content = renderCertificatesPane(state.certificates); }
    if (t === 'modules')      { content = renderModulesPane(state.modules); }
    if (t === 'runtimeEnvironments') { content = renderRuntimeEnvironmentsPane(state.runtimeEnvironments); }
    return `<div class="tab-pane" id="pane-${t}"${t !== activeTab ? ' style="display:none"' : ''}>${content}</div>`;
  }).join('');

  const formHtml    = form.open ? renderForm(state) : '';
  const overlayHtml = form.open ? '<div class="overlay" id="overlay"></div>' : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:       var(--vscode-editor-background);
    --fg:       var(--vscode-editor-foreground);
    --surface:  var(--vscode-sideBar-background, var(--vscode-editor-background));
    --border:   var(--vscode-panel-border, var(--vscode-widget-border, #444));
    --muted:    var(--vscode-descriptionForeground);
    --accent:   var(--vscode-textLink-foreground);
    --hover:    var(--vscode-list-hoverBackground);
    --sel:      var(--vscode-list-activeSelectionBackground);
    --sel-fg:   var(--vscode-list-activeSelectionForeground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #555);
    --btn-bg:   var(--vscode-button-background);
    --btn-fg:   var(--vscode-button-foreground);
    --btn-hov:  var(--vscode-button-hoverBackground);
    --btn2-bg:  var(--vscode-button-secondaryBackground);
    --btn2-fg:  var(--vscode-button-secondaryForeground);
    --btn2-hov: var(--vscode-button-secondaryHoverBackground);
    --danger:   var(--vscode-statusBarItem-errorBackground, #c72e2e);
    --danger-fg: var(--vscode-statusBarItem-errorForeground, #fff);
    --badge-bg: var(--vscode-badge-background);
    --badge-fg: var(--vscode-badge-foreground);
  }
  body { background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family); font-size: 13px; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  .header { padding: 12px 16px 0; flex-shrink: 0; }
  .header-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .title { font-size: 15px; font-weight: 600; }
  .subtitle { font-size: 11px; color: var(--muted); margin-top: 1px; }
  .header-actions { display: flex; gap: 8px; align-items: center; }
  .tab-bar { display: flex; border-bottom: 1px solid var(--border); flex-shrink: 0; overflow-x: auto; padding: 0 16px; }
  .tab-btn { padding: 9px 16px; border: none; border-bottom: 2px solid transparent; background: none; color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  .tab-btn:hover { color: var(--fg); background: var(--hover); }
  .tab-btn.active { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
  .tab-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; background: var(--badge-bg, #444); color: var(--badge-fg, #ccc); font-size: 11px; font-weight: 600; border-radius: 9px; }
  .tab-pane { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  .pane-toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; flex-shrink: 0; }
  .search-box { flex: 1; padding: 5px 9px; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 3px; font: inherit; font-size: 13px; }
  .search-box:focus { outline: 1px solid var(--accent); }
  .grid-container { flex: 1; overflow-y: auto; padding: 0 16px 16px; }
  .grid-header, .grid-row { display: grid; align-items: center; }
  .grid-header { position: sticky; top: 0; background: var(--surface); border-bottom: 1px solid var(--border); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); height: 34px; z-index: 1; margin: 0 -16px; padding: 0 26px; }
  .grid-row { min-height: 38px; border-bottom: 1px solid var(--border); cursor: pointer; padding: 0 10px; }
  .grid-row:hover { background: var(--hover); }
  .grid-row.selected { background: var(--sel); color: var(--sel-fg); }
  .grid-row .cb-col { width: 28px; flex-shrink: 0; display: flex; align-items: center; }
  .grid-row input[type=checkbox] { cursor: pointer; accent-color: var(--accent); width: 14px; height: 14px; }
  .cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 6px; }
  .cell-name { font-weight: 500; }
  .cell-muted { color: var(--muted); font-size: 12px; }
  .cell-tag { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); display: inline-block; }
  .cell-masked { font-family: monospace; letter-spacing: 2px; color: var(--muted); }
  .empty-state { text-align: center; color: var(--muted); padding: 40px 0; font-size: 13px; }
  .error-state { color: var(--danger); padding: 12px 16px; font-size: 13px; }
  .loading-state { color: var(--muted); padding: 12px 16px; font-size: 13px; }
  .btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; border: none; border-radius: 3px; cursor: pointer; font: inherit; font-size: 13px; white-space: nowrap; }
  .btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
  .btn-primary:hover { background: var(--btn-hov); }
  .btn-secondary { background: var(--btn2-bg); color: var(--btn2-fg); }
  .btn-secondary:hover { background: var(--btn2-hov); }
  .btn-danger { background: var(--danger); color: var(--danger-fg); }
  .btn-danger:hover { opacity: 0.85; }
  .btn-ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
  .btn-ghost:hover { background: var(--hover); color: var(--fg); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 100; }
  .form-panel { position: fixed; top: 0; right: 0; bottom: 0; width: 400px; max-width: 100vw; background: var(--surface); border-left: 1px solid var(--border); z-index: 101; display: flex; flex-direction: column; box-shadow: -4px 0 24px rgba(0,0,0,0.35); overflow: hidden; }
  .form-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .form-title { font-size: 14px; font-weight: 600; }
  .form-close { background: none; border: none; cursor: pointer; color: var(--muted); font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 3px; }
  .form-close:hover { background: var(--hover); color: var(--fg); }
  .form-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
  .form-field { display: flex; flex-direction: column; gap: 5px; }
  .form-label { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .form-label.required::after { content: ' *'; color: var(--danger); }
  .form-input, .form-textarea { padding: 6px 8px; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 3px; font: inherit; font-size: 13px; width: 100%; }
  .form-input:focus, .form-textarea:focus { outline: 1px solid var(--accent); }
  .form-textarea { resize: vertical; min-height: 64px; }
  .form-hint { font-size: 11px; color: var(--muted); }
  .form-check-row { display: flex; align-items: center; gap: 8px; }
  .form-check-row input[type=checkbox] { width: 15px; height: 15px; accent-color: var(--accent); }
  .form-error { color: var(--danger); font-size: 12px; padding: 8px 10px; background: color-mix(in srgb, var(--danger) 12%, transparent); border-radius: 3px; border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); }
  .form-footer { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); flex-shrink: 0; }
  .form-footer .btn { flex: 1; justify-content: center; }
  .field-rows { display: flex; flex-direction: column; gap: 6px; }
  .field-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; align-items: center; }
  .field-row-btn { background: none; border: none; cursor: pointer; color: var(--muted); font-size: 16px; padding: 2px 4px; border-radius: 3px; }
  .field-row-btn:hover { color: var(--danger); }
  .add-field-btn { background: none; border: 1px dashed var(--border); color: var(--muted); padding: 4px 10px; border-radius: 3px; font: inherit; font-size: 12px; cursor: pointer; margin-top: 2px; }
  .add-field-btn:hover { background: var(--hover); color: var(--fg); }
  .cols-vars  { grid-template-columns: 28px 2fr 2.5fr 90px 1.5fr; }
  .cols-creds { grid-template-columns: 28px 2.5fr 2fr 1.5fr; }
  .cols-conns { grid-template-columns: 28px 2.5fr 2fr 1.5fr; }
  .cols-certs { grid-template-columns: 28px 2fr 2fr 1.5fr 80px 1.5fr; }
  .cols-runtimes { grid-template-columns: 28px 2fr 1.4fr 2.4fr 1.1fr; }
  ${MODULES_CSS}
</style>
</head>
<body>
<div class="header">
  <div class="header-top">
    <div>
      <div class="title">Assets</div>
      <div class="subtitle">${esc(account.name)} &middot; ${esc(account.resourceGroupName)} &middot; ${esc(account.subscriptionName ?? account.subscriptionId)}</div>
    </div>
    <div class="header-actions">
      <button class="btn btn-ghost" id="btn-refresh">&#8635; Refresh</button>
      <button class="btn btn-ghost" id="btn-export-csv">&#8595; CSV</button>
      <button class="btn btn-ghost" id="btn-export-html">&#8595; HTML</button>
      <button class="btn btn-ghost" id="btn-export-md">&#8595; MD</button>
    </div>
  </div>
</div>

<div class="tab-bar" id="tab-bar">${tabBar}</div>
<div style="flex:1;overflow:hidden;display:flex;flex-direction:column">${tabPanes}</div>

${overlayHtml}
${formHtml}

<script>
  const vscode = acquireVsCodeApi();
  const TABS = ['variables','credentials','connections','certificates','modules','runtimeEnvironments'];

  // Tab switching (client-side, no round-trip)
  function switchTab(name) {
    TABS.forEach(t => {
      const pane = document.getElementById('pane-' + t);
      if (pane) pane.style.display = t === name ? 'flex' : 'none';
      document.querySelector('[data-tab="' + t + '"]')?.classList.toggle('active', t === name);
    });
    vscode.postMessage({ type: 'switchTab', tab: name });
  }
  document.getElementById('tab-bar')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-tab]');
    if (btn) switchTab(btn.getAttribute('data-tab'));
  });

  // Header buttons
  document.getElementById('btn-refresh')?.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('btn-export-csv')?.addEventListener('click', () => vscode.postMessage({ type: 'exportCsv' }));
  document.getElementById('btn-export-html')?.addEventListener('click', () => vscode.postMessage({ type: 'exportHtml' }));
  document.getElementById('btn-export-md')?.addEventListener('click', () => vscode.postMessage({ type: 'exportMd' }));
  document.getElementById('btn-export-pdf')?.addEventListener('click', () => vscode.postMessage({ type: 'exportPdf' }));

  // Overlay close
  document.getElementById('overlay')?.addEventListener('click', () => vscode.postMessage({ type: 'cancelForm' }));

  // Per-tab search, new, delete, select-all
  TABS.forEach(tab => {
    document.getElementById('search-' + tab)?.addEventListener('input', e => {
      const term = e.target.value.trim().toLowerCase();
      document.querySelectorAll('#pane-' + tab + ' .grid-row[data-search]').forEach(row => {
        row.style.display = (!term || row.getAttribute('data-search').includes(term)) ? '' : 'none';
      });
    });
    document.getElementById('btn-new-' + tab)?.addEventListener('click', () => vscode.postMessage({ type: 'showNewForm', tab }));
    document.getElementById('btn-delete-' + tab)?.addEventListener('click', () => {
      const names = Array.from(document.querySelectorAll('#pane-' + tab + ' .row-cb:checked')).map(cb => cb.value);
      if (names.length) vscode.postMessage({ type: 'deleteSelected', tab, names });
    });
    document.getElementById('sel-all-' + tab)?.addEventListener('change', e => {
      document.querySelectorAll('#pane-' + tab + ' .row-cb').forEach(cb => {
        cb.checked = e.target.checked;
        cb.closest('.grid-row')?.classList.toggle('selected', e.target.checked);
      });
    });
  });

  // Row checkbox toggle
  document.body.addEventListener('change', e => {
    if (e.target.classList.contains('row-cb'))
      e.target.closest('.grid-row')?.classList.toggle('selected', e.target.checked);
  });

  // Row click → edit
  document.body.addEventListener('click', e => {
    if (e.target.closest('.cb-col')) return;
    const row = e.target.closest('.grid-row[data-tab][data-name]');
    if (!row) return;
    const tab = row.getAttribute('data-tab');
    const name = row.getAttribute('data-name');
    if (tab === 'runtimeEnvironments') {
      vscode.postMessage({ type: 'runtimeEnvironmentAction', action: 'editPackages', name });
      return;
    }
    vscode.postMessage({ type: 'showEditForm', tab, name });
  });

  // Form cancel
  document.getElementById('form-close')?.addEventListener('click', () => vscode.postMessage({ type: 'cancelForm' }));
  document.getElementById('f-cancel')?.addEventListener('click', () => vscode.postMessage({ type: 'cancelForm' }));

  // Tab-specific form submit scripts
  ${VARIABLES_FORM_SCRIPT}
  ${CREDENTIALS_FORM_SCRIPT}
  ${CONNECTIONS_FORM_SCRIPT}
  ${CERTIFICATES_FORM_SCRIPT}
  ${RUNTIME_ENVIRONMENTS_FORM_SCRIPT}
  ${MODULES_SCRIPT}
</script>
</body>
</html>`;
}

// ── Form shell (delegates body to the active tab component) ──────────────────

function renderForm(state: AssetsPanelState): string {
  const { form } = state;
  const isEdit = form.mode === 'edit';
  const tabLabel: Record<AssetTab, string> = {
    variables: 'Variable', credentials: 'Credential',
    connections: 'Connection', certificates: 'Certificate', modules: 'Module',
    runtimeEnvironments: 'Runtime Environment',
  };
  const title = `${isEdit ? 'Edit' : 'New'} ${tabLabel[form.tab]}`;

  let body = '';
  let submitBtn = '';

  if (!form.loading) {
    const p = form.prefill ?? {};
    if (form.tab === 'variables') {
      body = renderVariablesFormBody(p, isEdit);
      submitBtn = renderVariablesSubmitButton(isEdit);
    } else if (form.tab === 'credentials') {
      body = renderCredentialsFormBody(p, isEdit);
      submitBtn = renderCredentialsSubmitButton(isEdit);
    } else if (form.tab === 'connections') {
      body = renderConnectionsFormBody(p, isEdit);
      submitBtn = renderConnectionsSubmitButton(isEdit);
    } else if (form.tab === 'certificates') {
      body = renderCertificatesFormBody(p, isEdit);
      submitBtn = renderCertificatesSubmitButton(isEdit);
    } else if (form.tab === 'runtimeEnvironments') {
      body = renderRuntimeEnvironmentsFormBody(p);
      submitBtn = renderRuntimeEnvironmentsSubmitButton();
    }
  }

  const errorHtml   = form.error   ? `<div class="form-error">${esc(form.error)}</div>` : '';
  const loadingHtml = form.loading ? '<div class="form-hint" style="text-align:center">Loading…</div>' : '';

  return `
  <div class="form-panel">
    <div class="form-header">
      <span class="form-title">${esc(title)}</span>
      <button class="form-close" id="form-close">&times;</button>
    </div>
    <div class="form-body">${errorHtml}${loadingHtml}${body}</div>
    <div class="form-footer">
      ${submitBtn}
      <button class="btn btn-secondary" id="f-cancel">Cancel</button>
    </div>
  </div>`;
}

// ── Standalone HTML export ────────────────────────────────────────────────────

function generateStandaloneHtml(account: AzureAutomationAccount, state: AssetsPanelState, version: string): string {
  const now = new Date().toLocaleString();
  const TS = 'border-collapse:collapse;width:100%;margin-bottom:32px;font-family:sans-serif;font-size:13px';
  const TH = 'background:#f0f0f0;border:1px solid #ccc;padding:7px 10px;text-align:left;font-size:11px;text-transform:uppercase';
  const TD = 'border:1px solid #ddd;padding:6px 10px';

  const makeTable = (caption: string, headers: string[], rows: string[][]): string => {
    const thead = headers.map(h => `<th style="${TH}">${h}</th>`).join('');
    const tbody = rows.map(r => `<tr>${r.map(c => `<td style="${TD}">${c}</td>`).join('')}</tr>`).join('');
    return `<h2 style="font-family:sans-serif;font-size:14px;margin:24px 0 8px">${caption}</h2>
<table style="${TS}"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Assets – ${esc(account.name)}</title>
<style>body{font-family:sans-serif;padding:24px 32px}@media print{button{display:none}}</style>
</head>
<body>
<h1 style="font-size:18px;font-family:sans-serif;margin-bottom:4px">Assets – ${esc(account.name)}</h1>
<p style="font-size:12px;color:#666;font-family:sans-serif;margin-bottom:16px">${esc(account.resourceGroupName)} &middot; ${esc(account.subscriptionName ?? account.subscriptionId)} &middot; Exported ${now}</p>
<button onclick="window.print()" style="margin-bottom:20px;padding:6px 14px;cursor:pointer">Print / Save as PDF</button>
${makeTable('Variables',    VARIABLES_EXPORT_HEADERS,    variablesExportRows(state.variables.items))}
${makeTable('Credentials',  CREDENTIALS_EXPORT_HEADERS,  credentialsExportRows(state.credentials.items))}
${makeTable('Connections',  CONNECTIONS_EXPORT_HEADERS,  connectionsExportRows(state.connections.items))}
${makeTable('Certificates', CERTIFICATES_EXPORT_HEADERS, certificatesExportRows(state.certificates.items))}
<hr style="margin-top:32px;border:none;border-top:1px solid #ddd" />
<p style="font-size:11px;color:#999;font-family:sans-serif;margin-top:8px">
  Azure Runbooks Workbench v${esc(version)} by @scoutmanpt &mdash;
  <a href="https://www.pdragon.co" style="color:#999">www.pdragon.co</a>
</p>
</body></html>`;
}
