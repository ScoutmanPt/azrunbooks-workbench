import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { AzureAutomationAccount, AutomationSchedule, JobScheduleLink, AzureService } from './azureService';

interface SchedulesPanelMessage {
  type?: 'refresh' | 'selectSchedule' | 'deleteSchedule' | 'showAddForm' | 'cancelAddForm'
        | 'submitAddForm' | 'exportGridCsv' | 'exportHtml' | 'exportPdf'
        | 'unlinkRunbook';
  name?: string;
  jobScheduleId?: string;
  formData?: ScheduleFormData;
}

interface ScheduleFormData {
  name: string;
  description: string;
  startDate: string;
  startTime: string;
  startTimeIso: string;
  timeZone: string;
  recurrence: 'OneTime' | 'Recurring';
  intervalValue: string;
  intervalUnit: string;
  selectedRunbooks: string[];
}

interface SchedulesPanelState {
  account: AzureAutomationAccount;
  schedules: AutomationSchedule[];
  jobScheduleLinks: JobScheduleLink[];
  availableRunbooks: string[];
  selectedScheduleName?: string;
  loading: boolean;
  detailLoading: boolean;
  error?: string;
  detailError?: string;
  showAddForm: boolean;
  addFormError?: string;
  addFormLoading: boolean;
}

export class SchedulesPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private state!: SchedulesPanelState;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly azure: AzureService,
    private readonly outputChannel: vscode.OutputChannel
  ) {}

  async openForAccount(account: AzureAutomationAccount): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'runbookWorkbench.schedules',
        'Schedules',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extensionUri],
        }
      );
      this.panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
      this.panel.webview.onDidReceiveMessage((msg: SchedulesPanelMessage) => {
        void this.handleMessage(msg);
      }, undefined, this.disposables);
    } else {
      this.panel.reveal(vscode.ViewColumn.Active, false);
    }

    this.state = {
      account,
      schedules: [],
      jobScheduleLinks: [],
      availableRunbooks: [],
      selectedScheduleName: undefined,
      loading: true,
      detailLoading: false,
      error: undefined,
      detailError: undefined,
      showAddForm: false,
      addFormError: undefined,
      addFormLoading: false,
    };
    this.render();
    await this.refresh();
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async handleMessage(msg: SchedulesPanelMessage): Promise<void> {
    switch (msg.type) {
      case 'refresh':
        await this.refresh();
        break;
      case 'selectSchedule':
        if (msg.name) {
          this.state.selectedScheduleName =
            this.state.selectedScheduleName === msg.name ? undefined : msg.name;
          this.render();
        }
        break;
      case 'showAddForm':
        this.state.showAddForm = true;
        this.state.addFormError = undefined;
        this.render();
        break;
      case 'cancelAddForm':
        this.state.showAddForm = false;
        this.state.addFormError = undefined;
        this.render();
        break;
      case 'submitAddForm':
        if (msg.formData) { await this.createSchedule(msg.formData); }
        break;
      case 'deleteSchedule':
        if (msg.name) { await this.deleteSchedule(msg.name); }
        break;
      case 'unlinkRunbook':
        if (msg.jobScheduleId) { await this.unlinkRunbook(msg.jobScheduleId); }
        break;
      case 'exportGridCsv':
        await this.exportCsv();
        break;
      case 'exportHtml':
        await this.exportHtmlReport(false);
        break;
      case 'exportPdf':
        await this.exportHtmlReport(true);
        break;
    }
  }

  private async refresh(): Promise<void> {
    const { account } = this.state;
    this.state.loading = true;
    this.state.error = undefined;
    this.render();
    try {
      const [schedules, jobScheduleLinks, runbooks] = await Promise.all([
        this.azure.listSchedules(account.subscriptionId, account.resourceGroupName, account.name),
        this.azure.listJobSchedules(account.subscriptionId, account.resourceGroupName, account.name).catch(() => [] as JobScheduleLink[]),
        this.azure.listRunbooks(account.subscriptionId, account.resourceGroupName, account.name, account.subscriptionName).catch(() => []),
      ]);
      this.state.schedules = schedules;
      this.state.jobScheduleLinks = jobScheduleLinks;
      this.state.availableRunbooks = runbooks.map(r => r.name).sort();
      this.state.loading = false;
      if (this.state.selectedScheduleName && !schedules.some(s => s.name === this.state.selectedScheduleName)) {
        this.state.selectedScheduleName = undefined;
      }
      this.render();
    } catch (error) {
      this.state.loading = false;
      this.state.error = errMsg(error);
      this.outputChannel.appendLine(`[schedules] Failed to load schedules for ${account.name}: ${errMsg(error)}`);
      this.render();
    }
  }

  private async createSchedule(form: ScheduleFormData): Promise<void> {
    const { account } = this.state;
    if (!form.name.trim()) {
      this.state.addFormError = 'Name is required.';
      this.render();
      return;
    }
    if (!form.startDate || !form.startTime) {
      this.state.addFormError = 'Start date and time are required.';
      this.render();
      return;
    }

    this.state.addFormLoading = true;
    this.state.addFormError = undefined;
    this.render();

    try {
      const startTime = form.startTimeIso ? new Date(form.startTimeIso) : new Date(`${form.startDate}T${form.startTime}:00Z`);
      const frequency = form.recurrence === 'OneTime' ? 'OneTime' : form.intervalUnit;
      const interval = form.recurrence === 'Recurring' ? (parseInt(form.intervalValue, 10) || 1) : undefined;

      const scheduleName = form.name.trim();
      await this.azure.createSchedule(
        account.subscriptionId,
        account.resourceGroupName,
        account.name,
        {
          name: scheduleName,
          description: form.description.trim() || undefined,
          startTime,
          frequency,
          interval,
          timeZone: form.timeZone || 'UTC',
        }
      );

      // Link selected runbooks
      const selectedRunbooks = Array.isArray(form.selectedRunbooks) ? form.selectedRunbooks : [];
      for (const runbookName of selectedRunbooks) {
        try {
          await this.azure.createJobSchedule(
            account.subscriptionId,
            account.resourceGroupName,
            account.name,
            randomUUID(),
            scheduleName,
            runbookName
          );
        } catch (rbError) {
          this.outputChannel.appendLine(`[schedules] Warning: failed to link runbook "${runbookName}": ${errMsg(rbError)}`);
        }
      }

      this.outputChannel.appendLine(`[schedules] Created schedule "${scheduleName}" in ${account.name}${selectedRunbooks.length ? ` (linked ${selectedRunbooks.length} runbook(s))` : ''}`);
      this.state.showAddForm = false;
      this.state.addFormLoading = false;
      this.state.addFormError = undefined;
      await this.refresh();
    } catch (error) {
      this.state.addFormLoading = false;
      this.state.addFormError = errMsg(error);
      this.render();
    }
  }

  private async deleteSchedule(name: string): Promise<void> {
    const { account } = this.state;
    const confirm = await vscode.window.showWarningMessage(
      `Delete schedule "${name}"? This cannot be undone.`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') { return; }

    try {
      await this.azure.deleteSchedule(account.subscriptionId, account.resourceGroupName, account.name, name);
      this.outputChannel.appendLine(`[schedules] Deleted schedule "${name}" from ${account.name}`);
      if (this.state.selectedScheduleName === name) { this.state.selectedScheduleName = undefined; }
      await this.refresh();
    } catch (error) {
      this.outputChannel.appendLine(`[schedules] Failed to delete schedule "${name}": ${errMsg(error)}`);
      void vscode.window.showErrorMessage(`Failed to delete schedule: ${errMsg(error)}`);
    }
  }

  private async unlinkRunbook(jobScheduleId: string): Promise<void> {
    const { account } = this.state;
    const link = this.state.jobScheduleLinks.find(l => l.jobScheduleId === jobScheduleId);
    const label = link ? `runbook "${link.runbookName}" from schedule "${link.scheduleName}"` : `job schedule ${jobScheduleId}`;
    const confirm = await vscode.window.showWarningMessage(
      `Unlink ${label}?`,
      { modal: true },
      'Unlink'
    );
    if (confirm !== 'Unlink') { return; }
    try {
      await this.azure.deleteJobSchedule(account.subscriptionId, account.resourceGroupName, account.name, jobScheduleId);
      this.outputChannel.appendLine(`[schedules] Unlinked ${label}`);
      this.state.jobScheduleLinks = this.state.jobScheduleLinks.filter(l => l.jobScheduleId !== jobScheduleId);
      this.render();
    } catch (error) {
      void vscode.window.showErrorMessage(`Failed to unlink: ${errMsg(error)}`);
    }
  }

  private async exportCsv(): Promise<void> {
    const { account, schedules } = this.state;
    const target = await vscode.window.showSaveDialog({
      saveLabel: 'Export Schedules CSV',
      filters: { CSV: ['csv'] },
      defaultUri: vscode.Uri.file(`${account.name}-schedules.csv`),
    });
    if (!target) { return; }

    const header = ['Name', 'Frequency', 'Interval', 'Next Run', 'Time Zone', 'Status', 'Description', 'Start Time', 'Expiry'];
    const rows = schedules.map(s => [
      s.name,
      s.frequency,
      s.interval?.toString() ?? '',
      s.nextRun ?? '',
      s.timeZone ?? '',
      s.isEnabled ? 'Enabled' : 'Disabled',
      s.description ?? '',
      s.startTime ?? '',
      s.expiryTime ?? '',
    ]);
    const csv = [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
    await vscode.workspace.fs.writeFile(target, Buffer.from(csv, 'utf8'));
    this.outputChannel.appendLine(`[schedules] Exported CSV: ${target.fsPath}`);
    void vscode.window.showInformationMessage(`Exported schedules to ${target.fsPath}`);
  }

  private async exportHtmlReport(openForPrint: boolean): Promise<void> {
    const { account, schedules } = this.state;
    const target = await vscode.window.showSaveDialog({
      saveLabel: openForPrint ? 'Save for PDF Print' : 'Export HTML Report',
      filters: { HTML: ['html'] },
      defaultUri: vscode.Uri.file(`${account.name}-schedules-report.html`),
    });
    if (!target) { return; }

    const html = generateStandaloneHtml(account, schedules);
    await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
    this.outputChannel.appendLine(`[schedules] Exported HTML report: ${target.fsPath}`);

    const action = await vscode.window.showInformationMessage(
      openForPrint
        ? 'Report saved. Open in browser and print to PDF (Ctrl+P → Save as PDF).'
        : `Exported HTML report to ${target.fsPath}`,
      'Open in Browser'
    );
    if (action === 'Open in Browser') {
      void vscode.env.openExternal(target);
    }
  }

  private render(): void {
    if (!this.panel) { return; }
    this.panel.webview.html = renderHtml(this.state);
  }
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function renderHtml(state: SchedulesPanelState): string {
  const { account, schedules, loading, error } = state;
  const enabledCount = schedules.filter(s => s.isEnabled).length;
  const disabledCount = schedules.length - enabledCount;

  const gridBody = loading
    ? `<div class="state-msg"><span class="spinner"></span>Loading schedules…</div>`
    : error
      ? `<div class="state-msg error">${esc(error)}</div>`
      : schedules.length === 0
        ? `<div class="state-msg muted">No schedules found for this account.</div>`
        : renderRows(schedules, state);

  const addFormHtml = state.showAddForm ? renderAddForm(state) : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground, rgba(128,128,128,.9));
      --border: var(--vscode-panel-border, rgba(128,128,128,.2));
      --surface: var(--vscode-sideBar-background, rgba(0,0,0,.04));
      --hover: var(--vscode-list-hoverBackground, rgba(128,128,128,.07));
      --selected-bg: var(--vscode-list-activeSelectionBackground, rgba(0,120,212,.15));
      --selected-fg: var(--vscode-list-activeSelectionForeground, var(--fg));
      --input-bg: var(--vscode-input-background, rgba(128,128,128,.07));
      --input-border: var(--vscode-input-border, rgba(128,128,128,.4));
      --focus-border: var(--vscode-focusBorder, #0078d4);
      --accent: var(--vscode-textLink-foreground, #0078d4);
      --btn-bg: var(--vscode-button-secondaryBackground, rgba(128,128,128,.1));
      --btn-fg: var(--vscode-button-secondaryForeground, var(--fg));
      --btn-hover: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.2));
      --danger: #d13438;
      --enabled-color: #107c10;
      --disabled-color: #8a8a8a;
      --detail-bg: color-mix(in srgb, var(--surface) 70%, var(--bg) 30%);
      --overlay-bg: color-mix(in srgb, var(--bg) 95%, #000 5%);
      --cols: 2fr 2fr 1.6fr 1.2fr;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.5;
    }
    .page { padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; }

    /* Header */
    .page-header {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 12px; flex-wrap: wrap;
      padding-bottom: 16px; border-bottom: 1px solid var(--border);
    }
    .page-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.2; }
    .page-subtitle { margin-top: 3px; font-size: 12px; color: var(--muted); }
    .header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

    /* Stats */
    .stats-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .stat-chip {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 10px; border: 1px solid var(--border); background: var(--surface); font-size: 12px;
    }
    .stat-chip .stat-value { font-weight: 600; font-size: 14px; }
    .stat-chip .stat-label { color: var(--muted); }

    /* Buttons */
    .btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 6px 12px; border: 1px solid var(--border);
      background: var(--btn-bg); color: var(--btn-fg);
      font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
    }
    .btn:hover { background: var(--btn-hover); }
    .btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .btn.primary:hover { opacity: .88; }
    .btn.danger { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
    .btn.danger:hover { background: color-mix(in srgb, var(--danger) 20%, transparent); }
    .btn:disabled { opacity: .45; cursor: default; pointer-events: none; }

    /* Export dropdown */
    .export-wrap { position: relative; }
    .export-dropdown {
      position: absolute; right: 0; top: calc(100% + 4px); z-index: 100;
      min-width: 200px; background: var(--vscode-menu-background, var(--bg));
      border: 1px solid var(--border); box-shadow: 0 4px 12px rgba(0,0,0,.18);
      display: none; flex-direction: column;
    }
    .export-dropdown.open { display: flex; }
    .dropdown-item {
      display: block; width: 100%; padding: 8px 14px; text-align: left;
      background: none; border: none; color: var(--fg); font: inherit; font-size: 12px; cursor: pointer;
    }
    .dropdown-item:hover { background: var(--hover); }
    .dropdown-sep { height: 1px; background: var(--border); margin: 3px 0; }

    /* Toolbar */
    .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .search-wrap {
      display: flex; align-items: center; flex: 1; min-width: 200px; max-width: 360px;
      border: 1px solid var(--input-border); background: var(--input-bg);
    }
    .search-icon { padding: 0 8px; color: var(--muted); font-size: 14px; line-height: 1; user-select: none; pointer-events: none; }
    .search-input {
      flex: 1; padding: 6px 8px 6px 0; border: none; background: none;
      color: var(--fg); font: inherit; font-size: 12px; outline: none;
    }
    .search-input::placeholder { color: var(--muted); }
    .filter-group { display: flex; gap: 4px; flex-wrap: wrap; }
    .filter-btn {
      padding: 5px 10px; border: 1px solid var(--border); background: none;
      color: var(--muted); font: inherit; font-size: 12px; cursor: pointer;
    }
    .filter-btn:hover { background: var(--hover); color: var(--fg); }
    .filter-btn.active {
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border-color: color-mix(in srgb, var(--accent) 50%, transparent);
      color: var(--accent); font-weight: 600;
    }
    .row-count { margin-left: auto; font-size: 11px; color: var(--muted); white-space: nowrap; }

    /* Grid */
    .grid-wrap { border: 1px solid var(--border); overflow-x: auto; }
    .grid-header {
      display: grid; grid-template-columns: var(--cols); gap: 0 12px;
      padding: 8px 16px; background: var(--surface); border-bottom: 2px solid var(--border);
      position: sticky; top: 0; z-index: 2;
    }
    .grid-col-label {
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: .05em; color: var(--muted); white-space: nowrap;
    }
    .schedule-item { border-bottom: 1px solid var(--border); }
    .schedule-item:last-child { border-bottom: none; }
    .schedule-row {
      display: grid; grid-template-columns: var(--cols); gap: 0 12px;
      padding: 10px 16px; align-items: center; cursor: pointer; transition: background .1s;
    }
    .schedule-row:hover { background: var(--hover); }
    .schedule-item.selected > .schedule-row {
      background: var(--selected-bg); color: var(--selected-fg);
    }
    .cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
    .cell-name { font-weight: 500; color: var(--accent); }
    .cell-muted { color: var(--muted); font-size: 12px; }

    /* Status badge */
    .status-badge {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 12px; font-weight: 500;
    }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .s-enabled .status-dot { background: var(--enabled-color); }
    .s-enabled .status-text { color: var(--enabled-color); }
    .s-disabled .status-dot { background: var(--disabled-color); }
    .s-disabled .status-text { color: var(--disabled-color); }

    /* Inline detail */
    .schedule-detail {
      background: var(--detail-bg); border-top: 1px solid var(--border);
      padding: 16px 20px; display: flex; flex-direction: column; gap: 14px;
    }
    .detail-header {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; flex-wrap: wrap;
    }
    .detail-title { font-size: 14px; font-weight: 600; }
    .detail-actions { display: flex; gap: 8px; }
    .detail-fields {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 1px; border: 1px solid var(--border); background: var(--border);
    }
    .detail-field {
      background: var(--bg); padding: 10px 14px;
      display: flex; flex-direction: column; gap: 3px;
    }
    .field-label {
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: .05em; color: var(--muted);
    }
    .field-value { font-size: 13px; word-break: break-all; }
    .recurrence-badge {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 8px; border: 1px solid var(--border); font-size: 12px;
    }

    /* State messages */
    .state-msg {
      padding: 20px 16px; display: flex; align-items: center;
      gap: 8px; color: var(--muted); font-size: 13px;
    }
    .state-msg.error { color: var(--danger); }
    .spinner {
      width: 14px; height: 14px; border: 2px solid var(--border);
      border-top-color: var(--accent); border-radius: 50%;
      animation: spin .8s linear infinite; flex-shrink: 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Add form overlay */
    .form-overlay {
      position: fixed; inset: 0; z-index: 200;
      background: rgba(0,0,0,.35);
      display: flex; align-items: flex-start; justify-content: flex-end;
    }
    .form-panel {
      width: 420px; max-width: 96vw;
      height: 100vh; overflow-y: auto;
      background: var(--overlay-bg);
      border-left: 1px solid var(--border);
      display: flex; flex-direction: column;
      box-shadow: -4px 0 16px rgba(0,0,0,.2);
    }
    .form-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 20px 20px 16px; border-bottom: 1px solid var(--border);
      position: sticky; top: 0; background: var(--overlay-bg); z-index: 1;
    }
    .form-title { margin: 0; font-size: 18px; font-weight: 600; }
    .form-close {
      padding: 4px 8px; border: 1px solid var(--border); background: none;
      color: var(--muted); font: inherit; font-size: 16px; cursor: pointer; line-height: 1;
    }
    .form-close:hover { background: var(--hover); color: var(--fg); }
    .form-body { padding: 20px; display: flex; flex-direction: column; gap: 18px; flex: 1; }
    .form-field { display: flex; flex-direction: column; gap: 6px; }
    .form-label {
      font-size: 12px; font-weight: 600;
    }
    .form-label.required::after { content: ' *'; color: var(--danger); }
    .form-input, .form-textarea, .form-select {
      padding: 7px 10px; border: 1px solid var(--input-border);
      background: var(--input-bg); color: var(--fg);
      font: inherit; font-size: 13px; outline: none; width: 100%;
    }
    .form-input:focus, .form-textarea:focus, .form-select:focus {
      border-color: var(--focus-border);
      outline: 1px solid var(--focus-border);
    }
    .form-textarea { min-height: 72px; resize: vertical; }
    .form-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .form-row-equal { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .radio-group { display: flex; gap: 20px; align-items: center; }
    .radio-label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; }
    .radio-label input[type="radio"] { accent-color: var(--accent); cursor: pointer; }
    .recurring-fields { display: flex; flex-direction: column; gap: 14px; }
    .form-error {
      padding: 8px 12px; background: color-mix(in srgb, var(--danger) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
      color: var(--danger); font-size: 12px;
    }
    .form-footer {
      padding: 16px 20px; border-top: 1px solid var(--border);
      display: flex; gap: 8px; background: var(--overlay-bg);
      position: sticky; bottom: 0;
    }
    .form-loading { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }

    /* Runbook checklist in form */
    .runbook-search-wrap { margin-bottom: 6px; }
    .runbook-checklist {
      max-height: 180px; overflow-y: auto;
      border: 1px solid var(--input-border); background: var(--input-bg);
      padding: 4px 0;
    }
    .rb-check-label {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 10px; cursor: pointer; font-size: 12px;
    }
    .rb-check-label:hover { background: var(--hover); }
    .rb-check-label input[type="checkbox"] { accent-color: var(--accent); flex-shrink: 0; cursor: pointer; }
    .rb-check-label.hidden { display: none; }

    /* Runbooks section in detail panel */
    .runbooks-section {
      border-top: 1px solid var(--border); padding-top: 12px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .runbooks-label {
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: .05em; color: var(--muted);
    }
    .runbooks-empty { font-size: 12px; color: var(--muted); }
    .runbooks-list { display: flex; flex-direction: column; gap: 4px; }
    .runbook-chip {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 10px; border: 1px solid var(--border);
      background: var(--bg); gap: 8px;
    }
    .runbook-chip-name {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; color: var(--accent); font-weight: 500; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .runbook-unlink-btn {
      padding: 2px 5px; border: 1px solid var(--border); background: none;
      color: var(--muted); cursor: pointer; flex-shrink: 0; line-height: 1;
      display: flex; align-items: center;
    }
    .runbook-unlink-btn:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
  </style>
</head>
<body>
  <div class="page">
    <!-- Header -->
    <div class="page-header">
      <div>
        <h1 class="page-title">Schedules</h1>
        <div class="page-subtitle">${esc(account.name)} &middot; ${esc(account.resourceGroupName)}</div>
      </div>
      <div class="header-actions">
        <button class="btn primary" id="btn-add">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z"/></svg>
          Add a schedule
        </button>
        <button class="btn" id="btn-refresh">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c-.335.415-.927 1.341-.927 3.424 0 2.391-1.153 3.224-1.858 3.555l1.023 1.317C11.29 13.074 13 11.614 13 9c0-2.092.464-3.065.753-3.495l-.302.104zm-9.108 6.28l-1.023-1.317C2.71 9.926 1 8.466 1 5.851c0-2.092-.464-3.065-.753-3.495l.302.104.579-.939 1.068.812.076.094c.335.415.927 1.341.927 3.424 0 2.391 1.153 3.224 1.858 3.555l-1.023 1.317z"/></svg>
          Refresh
        </button>
        <div class="export-wrap">
          <button class="btn" id="btn-export-toggle">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 10L3 5h3V1h4v4h3L8 10zm-5 4v-2h10v2H3z"/></svg>
            Export
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M0 2l4 4 4-4z"/></svg>
          </button>
          <div class="export-dropdown" id="export-dropdown">
            <button class="dropdown-item" id="export-csv">Export Grid (CSV)</button>
            <div class="dropdown-sep"></div>
            <button class="dropdown-item" id="export-html">Export Full Report (HTML)</button>
            <button class="dropdown-item" id="export-pdf">Export as PDF&hellip;</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Stats -->
    <div class="stats-row">
      <div class="stat-chip"><span class="stat-value">${schedules.length}</span><span class="stat-label">Total</span></div>
      <div class="stat-chip"><span class="stat-value" style="color:var(--enabled-color)">${enabledCount}</span><span class="stat-label">Enabled</span></div>
      <div class="stat-chip"><span class="stat-value" style="color:var(--disabled-color)">${disabledCount}</span><span class="stat-label">Disabled</span></div>
    </div>

    <!-- Toolbar -->
    <div class="toolbar">
      <div class="search-wrap">
        <span class="search-icon">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.099zm-5.242 1.656a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z"/></svg>
        </span>
        <input class="search-input" id="sched-search" type="search" placeholder="Search schedules…" autocomplete="off" />
      </div>
      <div class="filter-group" id="filter-group">
        <button class="filter-btn active" data-filter="All">All</button>
        <button class="filter-btn" data-filter="Enabled">Enabled</button>
        <button class="filter-btn" data-filter="Disabled">Disabled</button>
      </div>
      <span class="row-count" id="row-count">${schedules.length} schedule${schedules.length === 1 ? '' : 's'}</span>
    </div>

    <!-- Grid -->
    <div class="grid-wrap">
      <div class="grid-header">
        <div class="grid-col-label">Name</div>
        <div class="grid-col-label">Next run</div>
        <div class="grid-col-label">Time zone</div>
        <div class="grid-col-label">Status</div>
      </div>
      <div id="grid-body">${gridBody}</div>
    </div>
  </div>

  ${addFormHtml}

  <script>
    const vscode = acquireVsCodeApi();
    let activeFilter = 'All';

    function getItems() { return Array.from(document.querySelectorAll('[data-schedule-name]')); }

    function applyFilters() {
      const term = (document.getElementById('sched-search')?.value || '').trim().toLowerCase();
      let visible = 0;
      for (const item of getItems()) {
        const matchText = !term || (item.getAttribute('data-search') || '').includes(term);
        const matchFilter = activeFilter === 'All' || item.getAttribute('data-status') === activeFilter;
        const show = matchText && matchFilter;
        item.style.display = show ? '' : 'none';
        if (show) visible++;
      }
      const rc = document.getElementById('row-count');
      if (rc) rc.textContent = visible + ' schedule' + (visible === 1 ? '' : 's');
    }

    document.getElementById('sched-search')?.addEventListener('input', applyFilters);

    document.getElementById('filter-group')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      activeFilter = btn.getAttribute('data-filter') || 'All';
      document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === btn));
      applyFilters();
    });

    document.getElementById('grid-body')?.addEventListener('click', e => {
      if (e.target.closest('[data-delete-schedule]') || e.target.closest('[data-unlink-job-schedule]')) return;
      const item = e.target.closest('[data-schedule-name]');
      if (!item) return;
      vscode.postMessage({ type: 'selectSchedule', name: item.getAttribute('data-schedule-name') });
    });

    document.getElementById('grid-body')?.addEventListener('click', e => {
      const delBtn = e.target.closest('[data-delete-schedule]');
      if (delBtn) { vscode.postMessage({ type: 'deleteSchedule', name: delBtn.getAttribute('data-delete-schedule') }); return; }
      const unlinkBtn = e.target.closest('[data-unlink-job-schedule]');
      if (unlinkBtn) { vscode.postMessage({ type: 'unlinkRunbook', jobScheduleId: unlinkBtn.getAttribute('data-unlink-job-schedule') }); }
    });

    document.getElementById('btn-add')?.addEventListener('click', () => vscode.postMessage({ type: 'showAddForm' }));
    document.getElementById('btn-refresh')?.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

    document.getElementById('btn-export-toggle')?.addEventListener('click', e => {
      e.stopPropagation();
      document.getElementById('export-dropdown')?.classList.toggle('open');
    });
    document.addEventListener('click', () => document.getElementById('export-dropdown')?.classList.remove('open'));
    document.getElementById('export-csv')?.addEventListener('click', () => { document.getElementById('export-dropdown')?.classList.remove('open'); vscode.postMessage({ type: 'exportGridCsv' }); });
    document.getElementById('export-html')?.addEventListener('click', () => { document.getElementById('export-dropdown')?.classList.remove('open'); vscode.postMessage({ type: 'exportHtml' }); });
    document.getElementById('export-pdf')?.addEventListener('click', () => { document.getElementById('export-dropdown')?.classList.remove('open'); vscode.postMessage({ type: 'exportPdf' }); });

    // Add form
    const form = document.getElementById('add-form-panel');
    if (form) {
      // Timezone select population
      const tzSelect = document.getElementById('f-timezone');
      if (tzSelect) {
        const zones = typeof Intl !== 'undefined' && Intl.supportedValuesOf
          ? Intl.supportedValuesOf('timeZone')
          : ['UTC','Europe/London','America/New_York','America/Los_Angeles','Europe/Paris','Asia/Tokyo'];
        const userTz = Intl?.DateTimeFormat()?.resolvedOptions()?.timeZone || 'UTC';
        for (const tz of zones) {
          const opt = document.createElement('option');
          opt.value = tz;
          opt.textContent = tz;
          if (tz === userTz) opt.selected = true;
          tzSelect.appendChild(opt);
        }
      }

      // Recurrence toggle
      document.querySelectorAll('input[name="recurrence"]').forEach(radio => {
        radio.addEventListener('change', () => {
          const val = document.querySelector('input[name="recurrence"]:checked')?.value;
          const rf = document.getElementById('recurring-fields');
          if (rf) rf.style.display = val === 'Recurring' ? '' : 'none';
        });
      });

      // Runbook filter
      document.getElementById('f-rb-search')?.addEventListener('input', e => {
        const term = e.target.value.trim().toLowerCase();
        document.querySelectorAll('#f-rb-list .rb-check-label').forEach(label => {
          const name = label.querySelector('span')?.textContent?.toLowerCase() || '';
          label.classList.toggle('hidden', !!term && !name.includes(term));
        });
      });

      // Cancel
      document.getElementById('form-close')?.addEventListener('click', () => vscode.postMessage({ type: 'cancelAddForm' }));
      document.getElementById('f-cancel')?.addEventListener('click', () => vscode.postMessage({ type: 'cancelAddForm' }));

      // Set default start date/time to now + 10 minutes
      const now = new Date(Date.now() + 10 * 60000);
      const pad = n => String(n).padStart(2, '0');
      const dateVal = now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate());
      const timeVal = pad(now.getHours()) + ':' + pad(now.getMinutes());
      const sd = document.getElementById('f-start-date');
      const st = document.getElementById('f-start-time');
      if (sd && !sd.value) sd.value = dateVal;
      if (st && !st.value) st.value = timeVal;

      // Convert a local date/time string (YYYY-MM-DD, HH:MM) expressed in tzName to a UTC ISO string.
      function localToUtc(dateStr, timeStr, tzName) {
        // Treat the input as if it were UTC, then measure the offset of tzName at that instant
        const probe = new Date(dateStr + 'T' + timeStr + ':00Z');
        const fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: tzName,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
        const parts = fmt.formatToParts(probe);
        const g = type => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
        const h = g('hour') === 24 ? 0 : g('hour');
        // Reconstruct what the tz thinks probe's time is (as a UTC timestamp)
        const tzAsUtc = Date.UTC(g('year'), g('month') - 1, g('day'), h, g('minute'), g('second'));
        // The real offset is probe (treated as UTC) minus what the tz reported
        const offsetMs = probe.getTime() - tzAsUtc;
        // Apply offset to get actual UTC time for the user's local input
        return new Date(probe.getTime() + offsetMs).toISOString();
      }

      // Submit
      document.getElementById('f-submit')?.addEventListener('click', () => {
        const selectedRunbooks = Array.from(
          document.querySelectorAll('input[name="f-runbook"]:checked')
        ).map(cb => cb.value);
        const startDate = document.getElementById('f-start-date')?.value || '';
        const startTime = document.getElementById('f-start-time')?.value || '';
        const timeZone = document.getElementById('f-timezone')?.value || 'UTC';
        const startTimeIso = startDate && startTime ? localToUtc(startDate, startTime, timeZone) : '';
        const fd = {
          name: document.getElementById('f-name')?.value || '',
          description: document.getElementById('f-description')?.value || '',
          startDate,
          startTime,
          startTimeIso,
          timeZone,
          recurrence: document.querySelector('input[name="recurrence"]:checked')?.value || 'OneTime',
          intervalValue: document.getElementById('f-interval-value')?.value || '1',
          intervalUnit: document.getElementById('f-interval-unit')?.value || 'Hour',
          selectedRunbooks,
        };
        vscode.postMessage({ type: 'submitAddForm', formData: fd });
      });
    }
  </script>
</body>
</html>`;
}

function renderRows(schedules: AutomationSchedule[], state: SchedulesPanelState): string {
  return schedules.map(s => {
    const isSelected = state.selectedScheduleName === s.name;
    const statusClass = s.isEnabled ? 's-enabled' : 's-disabled';
    const statusText = s.isEnabled ? 'Enabled' : 'Disabled';
    const linkedRunbooks = state.jobScheduleLinks
      .filter(l => l.scheduleName === s.name)
      .map(l => l.runbookName);
    const searchData = [s.name, s.description, s.timeZone, s.frequency, statusText, ...linkedRunbooks]
      .filter(Boolean).join(' ').toLowerCase();

    const detailHtml = isSelected ? renderInlineDetail(s, state.jobScheduleLinks) : '';

    return `
      <div class="schedule-item${isSelected ? ' selected' : ''}"
           data-schedule-name="${esc(s.name)}"
           data-status="${esc(statusText)}"
           data-search="${esc(searchData)}">
        <div class="schedule-row">
          <span class="cell cell-name">${esc(s.name)}</span>
          <span class="cell cell-muted">${esc(formatDt(s.nextRun))}</span>
          <span class="cell cell-muted">${esc(s.timeZone ?? 'UTC')}</span>
          <span class="cell">${renderStatusBadge(s.isEnabled, statusClass, statusText)}</span>
        </div>
        ${detailHtml}
      </div>`;
  }).join('');
}

function renderStatusBadge(enabled: boolean, cssClass: string, text: string): string {
  void enabled;
  return `<span class="status-badge ${esc(cssClass)}"><span class="status-dot"></span><span class="status-text">${esc(text)}</span></span>`;
}

function renderInlineDetail(s: AutomationSchedule, jobScheduleLinks: JobScheduleLink[]): string {
  const recurrenceLabel = s.frequency === 'OneTime'
    ? 'Once'
    : `Every ${s.interval ?? 1} ${s.frequency}(s)`;

  const links = jobScheduleLinks.filter(l => l.scheduleName === s.name);
  const runbooksSection = `
    <div class="runbooks-section">
      <div class="runbooks-label">Linked Runbooks</div>
      ${links.length === 0
        ? `<div class="runbooks-empty">No runbooks linked to this schedule.</div>`
        : `<div class="runbooks-list">
            ${links.map(l => `
              <div class="runbook-chip">
                <span class="runbook-chip-name">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0"><path d="M14 2H2a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2V4a2 2 0 00-2-2zM2 12V6h12v6H2z"/></svg>
                  ${esc(l.runbookName)}
                </span>
                <button class="runbook-unlink-btn" data-unlink-job-schedule="${esc(l.jobScheduleId)}" title="Unlink runbook">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 11.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z"/></svg>
                </button>
              </div>`).join('')}
          </div>`
      }
    </div>`;

  return `
    <div class="schedule-detail">
      <div class="detail-header">
        <div class="detail-title">${esc(s.name)}</div>
        <div class="detail-actions">
          <button class="btn btn-sm danger" data-delete-schedule="${esc(s.name)}">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 01-1-1V2a1 1 0 011-1H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1v1zM4.118 4L4 4.059V13a1 1 0 001 1h6a1 1 0 001-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
            Delete schedule
          </button>
        </div>
      </div>
      <div class="detail-fields">
        ${renderField('Name', s.name)}
        ${renderField('Status', s.isEnabled ? 'Enabled' : 'Disabled')}
        ${renderField('Recurrence', recurrenceLabel)}
        ${renderField('Start Time', formatDt(s.startTime))}
        ${renderField('Next Run', formatDt(s.nextRun))}
        ${renderField('Expiry', s.expiryTime ? formatDt(s.expiryTime) : 'No expiry')}
        ${renderField('Time Zone', s.timeZone ?? 'UTC')}
        ${renderField('Frequency', s.frequency)}
        ${s.interval !== undefined ? renderField('Interval', String(s.interval)) : ''}
        ${s.description ? renderField('Description', s.description) : ''}
        ${renderField('Created', formatDt(s.creationTime))}
        ${renderField('Last Modified', formatDt(s.lastModifiedTime))}
      </div>
      ${runbooksSection}
    </div>`;
}

function renderField(label: string, value: string): string {
  return `
    <div class="detail-field">
      <div class="field-label">${esc(label)}</div>
      <div class="field-value">${esc(value)}</div>
    </div>`;
}

function renderAddForm(state: SchedulesPanelState): string {
  const loading = state.addFormLoading;
  const errHtml = state.addFormError
    ? `<div class="form-error">${esc(state.addFormError)}</div>`
    : '';

  return `
    <div class="form-overlay" id="add-form-overlay">
      <div class="form-panel" id="add-form-panel">
        <div class="form-header">
          <h2 class="form-title">New Schedule</h2>
          <button class="form-close" id="form-close" title="Close">&times;</button>
        </div>
        <div class="form-body">
          ${errHtml}
          <div class="form-field">
            <label class="form-label required" for="f-name">Name</label>
            <input class="form-input" id="f-name" type="text" placeholder="Schedule name" autocomplete="off" />
          </div>
          <div class="form-field">
            <label class="form-label" for="f-description">Description</label>
            <textarea class="form-textarea" id="f-description" placeholder="Optional description"></textarea>
          </div>
          <div class="form-field">
            <label class="form-label required">Starts</label>
            <div class="form-row-equal">
              <input class="form-input" id="f-start-date" type="date" />
              <input class="form-input" id="f-start-time" type="time" step="60" />
            </div>
          </div>
          <div class="form-field">
            <label class="form-label" for="f-timezone">Time zone</label>
            <select class="form-select" id="f-timezone"></select>
          </div>
          <div class="form-field">
            <label class="form-label">Recurrence</label>
            <div class="radio-group">
              <label class="radio-label"><input type="radio" name="recurrence" value="OneTime" checked /> Once</label>
              <label class="radio-label"><input type="radio" name="recurrence" value="Recurring" /> Recurring</label>
            </div>
          </div>
          <div id="recurring-fields" class="recurring-fields" style="display:none">
            <div class="form-field">
              <label class="form-label">Recur every</label>
              <div class="form-row-equal">
                <input class="form-input" id="f-interval-value" type="number" value="1" min="1" placeholder="Interval" />
                <select class="form-select" id="f-interval-unit">
                  <option value="Minute">Minute(s)</option>
                  <option value="Hour" selected>Hour(s)</option>
                  <option value="Day">Day(s)</option>
                  <option value="Week">Week(s)</option>
                  <option value="Month">Month(s)</option>
                </select>
              </div>
            </div>
          </div>
          <div class="form-field">
            <label class="form-label">Runbooks</label>
            <div class="runbook-search-wrap">
              <input class="form-input" id="f-rb-search" type="search" placeholder="Filter runbooks…" autocomplete="off" />
            </div>
            <div class="runbook-checklist" id="f-rb-list">
              ${state.availableRunbooks.length === 0
                ? `<div class="runbooks-empty">No runbooks available in this account.</div>`
                : state.availableRunbooks.map(rb => `
                    <label class="rb-check-label">
                      <input type="checkbox" name="f-runbook" value="${esc(rb)}" />
                      <span>${esc(rb)}</span>
                    </label>`).join('')
              }
            </div>
          </div>
        </div>
        <div class="form-footer">
          ${loading
            ? `<div class="form-loading"><span class="spinner"></span>Creating schedule…</div>`
            : `<button class="btn primary" id="f-submit">Create</button>
               <button class="btn" id="f-cancel">Cancel</button>`
          }
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Standalone HTML report
// ---------------------------------------------------------------------------

function generateStandaloneHtml(account: AzureAutomationAccount, schedules: AutomationSchedule[]): string {
  const exportDate = new Date().toLocaleString();
  const rows = schedules.map(s => {
    const recurrence = s.frequency === 'OneTime' ? 'Once' : `Every ${s.interval ?? 1} ${s.frequency}(s)`;
    return `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${esc(formatDt(s.nextRun))}</td>
        <td>${esc(s.timeZone ?? 'UTC')}</td>
        <td>${esc(s.isEnabled ? 'Enabled' : 'Disabled')}</td>
        <td>${esc(recurrence)}</td>
        <td>${esc(formatDt(s.startTime))}</td>
        <td>${esc(s.expiryTime ? formatDt(s.expiryTime) : 'No expiry')}</td>
        <td>${esc(s.description ?? '')}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Schedules Report — ${esc(account.name)}</title>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #1b1b1b; margin: 24px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .subtitle { color: #666; font-size: 11px; margin-bottom: 4px; }
    .export-info { color: #888; font-size: 11px; margin-bottom: 20px; }
    table { border-collapse: collapse; width: 100%; }
    th { background: #f3f2f1; text-align: left; padding: 7px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; border-bottom: 2px solid #ddd; }
    td { padding: 8px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
    tr:hover { background: #f9f9f9; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body>
  <h1>${esc(account.name)} — Schedules Report</h1>
  <div class="subtitle">${esc(account.resourceGroupName)} · ${esc(account.subscriptionName)}</div>
  <div class="export-info">Exported on ${esc(exportDate)} — ${schedules.length} schedule${schedules.length === 1 ? '' : 's'}</div>
  <table>
    <thead>
      <tr>
        <th>Name</th><th>Next run</th><th>Time zone</th><th>Status</th>
        <th>Recurrence</th><th>Start time</th><th>Expiry</th><th>Description</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDt(value?: string): string {
  if (!value) { return 'Unknown'; }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) { return value; }
  return d.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function csvEscape(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
