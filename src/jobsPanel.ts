import * as vscode from 'vscode';
import type {
  AzureAutomationAccount,
  AutomationJobDetail,
  AutomationJobSummary,
  AutomationJobStream,
  AzureService,
  RunbookSummary,
} from './azureService';

type StatusFilter = 'All' | 'Running' | 'Completed' | 'Failed' | 'Queued';

interface JobsPanelMessage {
  type?: 'refresh' | 'selectJob' | 'exportGridCsv' | 'exportHtml' | 'exportPdf';
  jobId?: string;
}

interface JobsPanelState {
  runbook?: RunbookSummary;
  account?: AzureAutomationAccount;
  jobs: AutomationJobSummary[];
  selectedJobId?: string;
  selectedJobDetail?: AutomationJobDetail;
  loading: boolean;
  detailLoading: boolean;
  error?: string;
  detailError?: string;
}

export class JobsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private state: JobsPanelState = {
    jobs: [],
    loading: false,
    detailLoading: false,
  };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly azure: AzureService,
    private readonly outputChannel: vscode.OutputChannel
  ) {}

  async openForRunbook(runbook: RunbookSummary): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'runbookWorkbench.jobs',
        'Jobs',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extensionUri],
        }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      }, undefined, this.disposables);
      this.panel.webview.onDidReceiveMessage((message: JobsPanelMessage) => {
        void this.handleMessage(message);
      }, undefined, this.disposables);
    } else {
      this.panel.reveal(vscode.ViewColumn.Active, false);
    }

    this.state = {
      runbook,
      account: undefined,
      jobs: [],
      selectedJobId: undefined,
      selectedJobDetail: undefined,
      loading: true,
      detailLoading: false,
      error: undefined,
      detailError: undefined,
    };
    this.render();
    await this.refreshJobs();
  }

  async openForAccount(account: AzureAutomationAccount): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'runbookWorkbench.jobs',
        'Jobs',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extensionUri],
        }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      }, undefined, this.disposables);
      this.panel.webview.onDidReceiveMessage((message: JobsPanelMessage) => {
        void this.handleMessage(message);
      }, undefined, this.disposables);
    } else {
      this.panel.reveal(vscode.ViewColumn.Active, false);
    }

    this.state = {
      runbook: undefined,
      account,
      jobs: [],
      selectedJobId: undefined,
      selectedJobDetail: undefined,
      loading: true,
      detailLoading: false,
      error: undefined,
      detailError: undefined,
    };
    this.render();
    await this.refreshJobs();
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async handleMessage(message: JobsPanelMessage): Promise<void> {
    if (message.type === 'refresh') {
      await this.refreshJobs();
      return;
    }
    if (message.type === 'selectJob' && message.jobId) {
      if (this.state.selectedJobId === message.jobId) {
        this.state.selectedJobId = undefined;
        this.state.selectedJobDetail = undefined;
        this.state.detailLoading = false;
        this.render();
        return;
      }
      this.state.selectedJobId = message.jobId;
      this.state.detailLoading = true;
      this.state.detailError = undefined;
      this.render();
      await this.refreshSelectedJob();
      return;
    }
    if (message.type === 'exportGridCsv') {
      await this.exportGridCsv();
      return;
    }
    if (message.type === 'exportHtml') {
      await this.exportHtmlReport(false);
      return;
    }
    if (message.type === 'exportPdf') {
      await this.exportHtmlReport(true);
    }
  }

  private async refreshJobs(): Promise<void> {
    const runbook = this.state.runbook;
    const account = this.state.account;
    if (!runbook && !account) { return; }

    this.state.loading = true;
    this.state.error = undefined;
    this.render();

    try {
      if (runbook) {
        this.state.jobs = await this.azure.listJobsForRunbook(
          runbook.subscriptionId,
          runbook.resourceGroupName,
          runbook.accountName,
          runbook.name
        );
      } else if (account) {
        this.state.jobs = await this.azure.listJobsForAccount(
          account.subscriptionId,
          account.resourceGroupName,
          account.name
        );
      }
      this.state.loading = false;

      if (this.state.selectedJobId && this.state.jobs.some(job => job.jobId === this.state.selectedJobId)) {
        await this.refreshSelectedJob();
      } else {
        this.state.selectedJobId = undefined;
        this.state.selectedJobDetail = undefined;
        this.state.detailLoading = false;
        this.render();
      }
    } catch (error) {
      this.state.loading = false;
      this.state.error = errorMessage(error);
      this.outputChannel.appendLine(`[jobs] Failed to load jobs for ${(runbook?.name ?? account?.name ?? 'selection')}: ${errorMessage(error)}`);
      this.render();
    }
  }

  private async refreshSelectedJob(): Promise<void> {
    const runbook = this.state.runbook;
    const account = this.state.account;
    const jobId = this.state.selectedJobId;
    if ((!runbook && !account) || !jobId) {
      this.state.detailLoading = false;
      this.render();
      return;
    }

    try {
      const subscriptionId = runbook?.subscriptionId ?? account?.subscriptionId ?? '';
      const resourceGroupName = runbook?.resourceGroupName ?? account?.resourceGroupName ?? '';
      const accountName = runbook?.accountName ?? account?.name ?? '';
      this.state.selectedJobDetail = await this.azure.getJobDetails(
        subscriptionId,
        resourceGroupName,
        accountName,
        jobId
      );
      this.state.detailLoading = false;
      this.state.detailError = undefined;
      this.render();
    } catch (error) {
      this.state.detailLoading = false;
      this.state.detailError = errorMessage(error);
      this.outputChannel.appendLine(`[jobs] Failed to load job detail ${jobId}: ${errorMessage(error)}`);
      this.render();
    }
  }

  private async fetchAllJobDetails(): Promise<AutomationJobDetail[]> {
    const runbook = this.state.runbook;
    const account = this.state.account;
    const subscriptionId = runbook?.subscriptionId ?? account?.subscriptionId ?? '';
    const resourceGroupName = runbook?.resourceGroupName ?? account?.resourceGroupName ?? '';
    const accountName = runbook?.accountName ?? account?.name ?? '';
    const results: AutomationJobDetail[] = [];
    for (const job of this.state.jobs) {
      try {
        const detail = await this.azure.getJobDetails(subscriptionId, resourceGroupName, accountName, job.jobId);
        results.push(detail);
      } catch {
        // skip jobs whose details can't be fetched
      }
    }
    return results;
  }

  private async exportGridCsv(): Promise<void> {
    const runbook = this.state.runbook;
    const account = this.state.account;
    if (!runbook && !account) { return; }
    const baseName = runbook?.name ?? account?.name ?? 'jobs';

    const target = await vscode.window.showSaveDialog({
      saveLabel: 'Export Jobs CSV',
      filters: { CSV: ['csv'] },
      defaultUri: vscode.Uri.file(`${baseName}-jobs.csv`),
    });
    if (!target) { return; }

    const header = ['Job ID', 'Runbook', 'Status', 'Runtime Environment', 'Ran On', 'Created', 'Last Status Update', 'Provisioning'];
    const rows = this.state.jobs.map(job => [
      job.jobId,
      job.runbookName ?? '',
      job.status ?? '',
      job.runtimeEnvironment ?? (runbook ? formatRunbookType(runbook.runbookType) : 'Mixed'),
      job.runOn || 'Azure',
      job.creationTime ?? '',
      job.lastModifiedTime ?? '',
      job.provisioningState ?? '',
    ]);
    const csv = [header, ...rows]
      .map(row => row.map(csvEscape).join(','))
      .join('\n');

    await vscode.workspace.fs.writeFile(target, Buffer.from(csv, 'utf8'));
    this.outputChannel.appendLine(`[jobs] Exported grid CSV: ${target.fsPath}`);
    void vscode.window.showInformationMessage(`Exported jobs grid to ${target.fsPath}`);
  }

  private async exportHtmlReport(openForPrint: boolean): Promise<void> {
    const runbook = this.state.runbook;
    const account = this.state.account;
    if (!runbook && !account) { return; }
    const baseName = runbook?.name ?? account?.name ?? 'jobs';
    const jobCount = this.state.jobs.length;

    if (jobCount > 30) {
      const choice = await vscode.window.showWarningMessage(
        `Exporting details for ${jobCount} jobs requires ${jobCount} API calls and may take a while. Continue?`,
        'Export', 'Cancel'
      );
      if (choice !== 'Export') { return; }
    }

    const target = await vscode.window.showSaveDialog({
      saveLabel: openForPrint ? 'Save for PDF Print' : 'Export HTML Report',
      filters: { HTML: ['html'] },
      defaultUri: vscode.Uri.file(`${baseName}-jobs-report.html`),
    });
    if (!target) { return; }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Fetching details for ${jobCount} job${jobCount === 1 ? '' : 's'}…`,
      cancellable: false,
    }, async () => {
      const allDetails = await this.fetchAllJobDetails();
      const html = generateStandaloneHtmlReport(this.state, allDetails);
      await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
    });

    this.outputChannel.appendLine(`[jobs] Exported HTML report: ${target.fsPath}`);
    if (openForPrint) {
      const action = await vscode.window.showInformationMessage(
        `Report saved. Open in browser and print to PDF (Ctrl+P → Save as PDF).`,
        'Open in Browser'
      );
      if (action === 'Open in Browser') {
        void vscode.env.openExternal(target);
      }
    } else {
      const action = await vscode.window.showInformationMessage(
        `Exported HTML report to ${target.fsPath}`,
        'Open in Browser'
      );
      if (action === 'Open in Browser') {
        void vscode.env.openExternal(target);
      }
    }
  }

  private render(): void {
    if (!this.panel) { return; }
    this.panel.webview.html = renderJobsHtml(this.state);
  }
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function renderJobsHtml(state: JobsPanelState): string {
  const runbook = state.runbook;
  const account = state.account;
  const jobs = state.jobs;
  const counts = summarizeJobs(jobs);

  const title = runbook?.name ?? account?.name ?? 'Jobs';
  const subtitle = runbook
    ? `${runbook.accountName} · ${runbook.resourceGroupName} · ${formatRunbookType(runbook.runbookType)}`
    : account
      ? `${account.name} · ${account.resourceGroupName} · All runbooks`
      : 'No selection';

  const gridBody = state.loading
    ? `<div class="state-message"><span class="spinner"></span>Loading jobs…</div>`
    : state.error
      ? `<div class="state-message error">${escapeHtml(state.error)}</div>`
      : jobs.length === 0
        ? `<div class="state-message muted">No jobs found.</div>`
        : renderJobRows(jobs, state, runbook);

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
      --accent: var(--vscode-textLink-foreground, #0078d4);
      --btn-bg: var(--vscode-button-secondaryBackground, rgba(128,128,128,.1));
      --btn-fg: var(--vscode-button-secondaryForeground, var(--fg));
      --btn-hover: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.2));
      --status-completed: #107c10;
      --status-running: #0078d4;
      --status-failed: #d13438;
      --status-queued: #8764b8;
      --status-warning: #986f0b;
      --detail-bg: color-mix(in srgb, var(--surface) 70%, var(--bg) 30%);
      --cols: 2fr 1.8fr 1.4fr 1.6fr 0.9fr 1.8fr;
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

    /* ── Header ── */
    .page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .page-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.2; }
    .page-subtitle { margin-top: 3px; font-size: 12px; color: var(--muted); }
    .header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

    /* ── Stats ── */
    .stats-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .stat-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border: 1px solid var(--border);
      background: var(--surface);
      font-size: 12px;
    }
    .stat-chip .stat-value { font-weight: 600; font-size: 14px; }
    .stat-chip .stat-label { color: var(--muted); }

    /* ── Buttons ── */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 6px 12px;
      border: 1px solid var(--border);
      background: var(--btn-bg);
      color: var(--btn-fg);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .btn:hover { background: var(--btn-hover); }
    .btn.primary {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .btn.primary:hover { opacity: .88; }
    .btn svg { flex-shrink: 0; }

    /* ── Export dropdown ── */
    .export-wrap { position: relative; }
    .export-dropdown {
      position: absolute;
      right: 0;
      top: calc(100% + 4px);
      z-index: 100;
      min-width: 180px;
      background: var(--vscode-menu-background, var(--bg));
      border: 1px solid var(--border);
      box-shadow: 0 4px 12px rgba(0,0,0,.18);
      display: none;
      flex-direction: column;
    }
    .export-dropdown.open { display: flex; }
    .dropdown-item {
      display: block;
      width: 100%;
      padding: 8px 14px;
      text-align: left;
      background: none;
      border: none;
      color: var(--fg);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .dropdown-item:hover { background: var(--hover); }
    .dropdown-sep { height: 1px; background: var(--border); margin: 3px 0; }

    /* ── Toolbar ── */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .search-wrap {
      display: flex;
      align-items: center;
      gap: 0;
      flex: 1;
      min-width: 200px;
      max-width: 360px;
      border: 1px solid var(--input-border);
      background: var(--input-bg);
    }
    .search-icon {
      padding: 0 8px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1;
      user-select: none;
      pointer-events: none;
    }
    .search-input {
      flex: 1;
      padding: 6px 8px 6px 0;
      border: none;
      background: none;
      color: var(--fg);
      font: inherit;
      font-size: 12px;
      outline: none;
    }
    .search-input::placeholder { color: var(--muted); }
    .filter-group {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .filter-btn {
      padding: 5px 10px;
      border: 1px solid var(--border);
      background: none;
      color: var(--muted);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .filter-btn:hover { background: var(--hover); color: var(--fg); }
    .filter-btn.active {
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border-color: color-mix(in srgb, var(--accent) 50%, transparent);
      color: var(--accent);
      font-weight: 600;
    }
    .row-count {
      margin-left: auto;
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
    }

    /* ── Grid ── */
    .grid-wrap {
      border: 1px solid var(--border);
      overflow-x: auto;
    }
    .grid-header {
      display: grid;
      grid-template-columns: var(--cols);
      gap: 0 12px;
      padding: 8px 16px;
      background: var(--surface);
      border-bottom: 2px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    .grid-col-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .job-item { border-bottom: 1px solid var(--border); }
    .job-item:last-child { border-bottom: none; }
    .job-row {
      display: grid;
      grid-template-columns: var(--cols);
      gap: 0 12px;
      padding: 10px 16px;
      align-items: center;
      cursor: pointer;
      transition: background .1s;
    }
    .job-row:hover { background: var(--hover); }
    .job-item.selected > .job-row {
      background: var(--selected-bg);
      color: var(--selected-fg);
    }
    .cell {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .cell-runbook { font-weight: 500; color: var(--accent); }
    .cell-muted { color: var(--muted); font-size: 12px; }

    /* ── Status badge ── */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      font-weight: 500;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .s-completed .status-dot { background: var(--status-completed); }
    .s-completed .status-text { color: var(--status-completed); }
    .s-running .status-dot { background: var(--status-running); }
    .s-running .status-text { color: var(--status-running); }
    .s-failed .status-dot { background: var(--status-failed); }
    .s-failed .status-text { color: var(--status-failed); }
    .s-queued .status-dot { background: var(--status-queued); }
    .s-queued .status-text { color: var(--status-queued); }
    .s-warning .status-dot { background: var(--status-warning); }
    .s-warning .status-text { color: var(--status-warning); }

    /* ── Inline detail panel ── */
    .job-detail {
      background: var(--detail-bg);
      border-top: 1px solid var(--border);
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .detail-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .detail-title {
      font-size: 14px;
      font-weight: 600;
    }
    .detail-close {
      padding: 2px 6px;
      border: 1px solid var(--border);
      background: none;
      color: var(--muted);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .detail-close:hover { background: var(--hover); color: var(--fg); }
    .detail-fields {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 1px;
      border: 1px solid var(--border);
      background: var(--border);
    }
    .detail-field {
      background: var(--bg);
      padding: 10px 14px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .field-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: var(--muted);
    }
    .field-value {
      font-size: 13px;
      word-break: break-all;
    }
    .field-value.monospace {
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
      font-size: 11px;
    }

    /* ── Tabs ── */
    .tabs-wrap { display: flex; flex-direction: column; gap: 0; }
    .tab-bar {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .tab-btn {
      padding: 7px 14px;
      border: none;
      border-bottom: 2px solid transparent;
      background: none;
      color: var(--muted);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      margin-bottom: -1px;
    }
    .tab-btn:hover { color: var(--fg); background: var(--hover); }
    .tab-btn.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
      font-weight: 600;
    }
    .tab-panel { display: none; padding-top: 12px; }
    .tab-panel.active { display: block; }

    /* ── Log / Stream entries ── */
    .stream-list { display: flex; flex-direction: column; gap: 6px; }
    .stream-entry {
      border: 1px solid var(--border);
      border-left: 3px solid var(--border);
      padding: 8px 12px;
      background: var(--bg);
    }
    .stream-entry.output { border-left-color: var(--status-completed); }
    .stream-entry.error { border-left-color: var(--status-failed); }
    .stream-entry.warning { border-left-color: var(--status-warning); }
    .stream-entry.verbose, .stream-entry.debug, .stream-entry.progress { border-left-color: var(--status-queued); }
    .stream-meta {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 5px;
      font-size: 11px;
      color: var(--muted);
      flex-wrap: wrap;
    }
    .stream-body {
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* ── Parameter grid ── */
    .param-table {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 1px;
      border: 1px solid var(--border);
      background: var(--border);
    }
    .param-name, .param-value {
      background: var(--bg);
      padding: 7px 12px;
      font-size: 12px;
    }
    .param-name {
      font-weight: 600;
      color: var(--muted);
      white-space: nowrap;
    }
    .param-value {
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
      word-break: break-all;
    }

    /* ── States ── */
    .state-message {
      padding: 20px 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
    }
    .state-message.error { color: var(--status-failed); }
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin .8s linear infinite;
      flex-shrink: 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Exception ── */
    .exception-block {
      border: 1px solid var(--border);
      border-left: 3px solid var(--status-failed);
      padding: 10px 14px;
      background: var(--bg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .no-data {
      padding: 12px 4px;
      color: var(--muted);
      font-size: 12px;
    }

    /* ── Loading detail state ── */
    .detail-loading {
      padding: 12px 4px;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="page">

    <!-- ── Header ── -->
    <div class="page-header">
      <div>
        <h1 class="page-title">${escapeHtml(title)}</h1>
        <div class="page-subtitle">${escapeHtml(subtitle)}</div>
      </div>
      <div class="header-actions">
        <button class="btn primary" id="btn-refresh">
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

    <!-- ── Stats ── -->
    <div class="stats-row">
      <div class="stat-chip"><span class="stat-value">${jobs.length}</span><span class="stat-label">Total</span></div>
      <div class="stat-chip"><span class="stat-value" style="color:var(--status-running)">${counts.running}</span><span class="stat-label">Running</span></div>
      <div class="stat-chip"><span class="stat-value" style="color:var(--status-completed)">${counts.completed}</span><span class="stat-label">Completed</span></div>
      <div class="stat-chip"><span class="stat-value" style="color:var(--status-failed)">${counts.failed}</span><span class="stat-label">Failed</span></div>
      <div class="stat-chip"><span class="stat-value" style="color:var(--status-queued)">${counts.queued}</span><span class="stat-label">Queued</span></div>
    </div>

    <!-- ── Toolbar ── -->
    <div class="toolbar">
      <div class="search-wrap">
        <span class="search-icon">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.099zm-5.242 1.656a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z"/></svg>
        </span>
        <input class="search-input" id="job-search" type="search" placeholder="Search jobs…" autocomplete="off" />
      </div>
      <div class="filter-group" id="filter-group">
        ${(['All', 'Running', 'Completed', 'Failed', 'Queued'] as StatusFilter[]).map(f =>
          `<button class="filter-btn${f === 'All' ? ' active' : ''}" data-filter="${f}">${f}</button>`
        ).join('')}
      </div>
      <span class="row-count" id="row-count">${jobs.length} job${jobs.length === 1 ? '' : 's'}</span>
    </div>

    <!-- ── Grid ── -->
    <div class="grid-wrap">
      <div class="grid-header">
        <div class="grid-col-label">Runbook</div>
        <div class="grid-col-label">Job created</div>
        <div class="grid-col-label">Status</div>
        <div class="grid-col-label">Runtime Environment</div>
        <div class="grid-col-label">Ran on</div>
        <div class="grid-col-label">Last status update</div>
      </div>
      <div id="grid-body">${gridBody}</div>
    </div>

  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let activeFilter = 'All';

    function getItems() { return Array.from(document.querySelectorAll('[data-job-id]')); }

    function applyFilters() {
      const term = (document.getElementById('job-search')?.value || '').trim().toLowerCase();
      let visible = 0;
      for (const item of getItems()) {
        const matchText = !term || (item.getAttribute('data-search') || '').includes(term);
        const matchFilter = activeFilter === 'All' || item.getAttribute('data-status') === activeFilter;
        const show = matchText && matchFilter;
        item.style.display = show ? '' : 'none';
        if (show) visible++;
      }
      const rc = document.getElementById('row-count');
      if (rc) rc.textContent = visible + ' job' + (visible === 1 ? '' : 's');
    }

    // Search
    document.getElementById('job-search')?.addEventListener('input', applyFilters);

    // Status filters
    document.getElementById('filter-group')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      activeFilter = btn.getAttribute('data-filter') || 'All';
      document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === btn));
      applyFilters();
    });

    // Job row click — toggle detail
    document.getElementById('grid-body')?.addEventListener('click', e => {
      const item = e.target.closest('[data-job-id]');
      if (!item || e.target.closest('.detail-close') || e.target.closest('[data-tab]')) return;
      vscode.postMessage({ type: 'selectJob', jobId: item.getAttribute('data-job-id') });
    });

    // Close detail button
    document.getElementById('grid-body')?.addEventListener('click', e => {
      if (e.target.closest('.detail-close')) {
        const item = e.target.closest('[data-job-id]');
        if (item) vscode.postMessage({ type: 'selectJob', jobId: item.getAttribute('data-job-id') });
      }
    });

    // Refresh
    document.getElementById('btn-refresh')?.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

    // Export dropdown toggle
    document.getElementById('btn-export-toggle')?.addEventListener('click', e => {
      e.stopPropagation();
      document.getElementById('export-dropdown')?.classList.toggle('open');
    });
    document.addEventListener('click', () => document.getElementById('export-dropdown')?.classList.remove('open'));

    document.getElementById('export-csv')?.addEventListener('click', () => {
      document.getElementById('export-dropdown')?.classList.remove('open');
      vscode.postMessage({ type: 'exportGridCsv' });
    });
    document.getElementById('export-html')?.addEventListener('click', () => {
      document.getElementById('export-dropdown')?.classList.remove('open');
      vscode.postMessage({ type: 'exportHtml' });
    });
    document.getElementById('export-pdf')?.addEventListener('click', () => {
      document.getElementById('export-dropdown')?.classList.remove('open');
      vscode.postMessage({ type: 'exportPdf' });
    });

    // Tab switching (delegated)
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      const container = btn.closest('.tabs-wrap');
      if (!container) return;
      const target = btn.getAttribute('data-tab');
      container.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === btn));
      container.querySelectorAll('[data-tab-panel]').forEach(p => p.classList.toggle('active', p.getAttribute('data-tab-panel') === target));
    });
  </script>
</body>
</html>`;
}

function renderJobRows(jobs: AutomationJobSummary[], state: JobsPanelState, runbook?: RunbookSummary): string {
  return jobs.map(job => {
    const isSelected = state.selectedJobId === job.jobId;
    const status = job.status ?? 'Unknown';
    const bucket = normalizeStatusBucket(status);
    const runtimeEnv = job.runtimeEnvironment ?? (runbook ? formatRunbookType(runbook.runbookType) : 'Mixed');
    const ranOn = job.runOn || 'Azure';
    const searchData = [job.jobId, job.runbookName, job.status, runtimeEnv].filter(Boolean).join(' ').toLowerCase();

    let detailHtml = '';
    if (isSelected) {
      if (state.detailLoading) {
        detailHtml = `
          <div class="job-detail">
            <div class="detail-loading"><span class="spinner"></span>Loading job details…</div>
          </div>`;
      } else if (state.detailError) {
        detailHtml = `
          <div class="job-detail">
            <div class="state-message error">${escapeHtml(state.detailError)}</div>
          </div>`;
      } else if (state.selectedJobDetail) {
        detailHtml = renderInlineJobDetail(state.selectedJobDetail);
      }
    }

    return `
      <div class="job-item${isSelected ? ' selected' : ''}"
           data-job-id="${escapeHtml(job.jobId)}"
           data-status="${escapeHtml(bucket)}"
           data-search="${escapeHtml(searchData)}">
        <div class="job-row">
          <span class="cell cell-runbook">${escapeHtml(job.runbookName ?? 'Unknown')}</span>
          <span class="cell cell-muted">${escapeHtml(formatDateTime(job.creationTime ?? job.startTime))}</span>
          <span class="cell">${renderStatusBadge(status)}</span>
          <span class="cell cell-muted">${escapeHtml(runtimeEnv)}</span>
          <span class="cell cell-muted">${escapeHtml(ranOn)}</span>
          <span class="cell cell-muted">${escapeHtml(formatDateTime(job.lastModifiedTime ?? job.endTime))}</span>
        </div>
        ${detailHtml}
      </div>`;
  }).join('');
}

function renderStatusBadge(status: string): string {
  const bucket = normalizeStatusBucket(status);
  const cssClass = bucket === 'Completed' ? 's-completed'
    : bucket === 'Running' ? 's-running'
    : bucket === 'Failed' ? 's-failed'
    : bucket === 'Queued' ? 's-queued'
    : 's-queued';

  const icon = bucket === 'Completed'
    ? `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>`
    : `<span class="status-dot"></span>`;

  return `<span class="status-badge ${escapeHtml(cssClass)}">${icon}<span class="status-text">${escapeHtml(status)}</span></span>`;
}

function renderInlineJobDetail(detail: AutomationJobDetail): string {
  const outputStreams = detail.streams.filter(s => s.streamType === 'Output');
  const errorStreams = detail.streams.filter(s => s.streamType === 'Error');
  const warningStreams = detail.streams.filter(s => s.streamType === 'Warning');
  const extraStreams = detail.streams.filter(s => s.streamType === 'Verbose' || s.streamType === 'Debug' || s.streamType === 'Progress');

  return `
    <div class="job-detail">
      <div class="detail-header">
        <div class="detail-title">${escapeHtml(detail.runbookName ?? 'Job')} &mdash; ${escapeHtml(detail.jobId)}</div>
        <button class="detail-close" title="Close detail">&#x2715; Close</button>
      </div>

      <div class="detail-fields">
        ${renderField('Id', detail.jobId, true)}
        ${renderField('Created', formatDateTime(detail.creationTime))}
        ${renderField('Status', detail.status ?? 'Unknown')}
        ${renderField('Last Update', formatDateTime(detail.lastStatusModifiedTime ?? detail.lastModifiedTime))}
        ${renderField('Ran on', detail.runOn || 'Azure')}
        ${renderField('Runbook', detail.runbookName ?? 'Unknown')}
        ${renderField('Ran As', detail.startedBy ?? 'Unknown')}
      </div>

      <div class="tabs-wrap">
        <div class="tab-bar">
          <button class="tab-btn active" data-tab="input">Input</button>
          <button class="tab-btn" data-tab="output">Output</button>
          <button class="tab-btn" data-tab="errors">Errors</button>
          <button class="tab-btn" data-tab="warnings">Warnings</button>
          <button class="tab-btn" data-tab="all">All Logs</button>
          <button class="tab-btn" data-tab="exception">Exception</button>
        </div>
        <div class="tab-panel active" data-tab-panel="input">
          ${renderParameters(detail.parameters)}
        </div>
        <div class="tab-panel" data-tab-panel="output">
          ${renderStreams(outputStreams.length > 0 ? outputStreams : extraStreams, 'No output stream messages were captured for this job.')}
        </div>
        <div class="tab-panel" data-tab-panel="errors">
          ${errorStreams.length > 0
            ? renderStreams(errorStreams, '')
            : detail.exception?.trim()
              ? `<div class="stream-list"><div class="stream-entry error"><div class="stream-meta"><span>Exception</span></div><div class="stream-body">${escapeHtml(detail.exception.trim())}</div></div></div>`
              : renderStreams([], 'No error stream messages were captured.')}
        </div>
        <div class="tab-panel" data-tab-panel="warnings">
          ${renderStreams(warningStreams, 'No warning stream messages were captured.')}
        </div>
        <div class="tab-panel" data-tab-panel="all">
          ${renderStreams(detail.streams, 'No logs were captured for this job.')}
        </div>
        <div class="tab-panel" data-tab-panel="exception">
          <div class="exception-block">${escapeHtml(detail.exception?.trim() || detail.statusDetails?.trim() || 'No exception text was returned by Azure Automation for this job.')}</div>
        </div>
      </div>
    </div>`;
}

function renderField(label: string, value: string, monospace = false): string {
  return `
    <div class="detail-field">
      <div class="field-label">${escapeHtml(label)}</div>
      <div class="field-value${monospace ? ' monospace' : ''}">${escapeHtml(value)}</div>
    </div>`;
}

function renderParameters(parameters: Record<string, string>): string {
  const entries = Object.entries(parameters);
  if (entries.length === 0) {
    return '<div class="no-data">No parameters were supplied for this job.</div>';
  }
  return `
    <div class="param-table">
      ${entries.map(([name, value]) => `
        <div class="param-name">${escapeHtml(name)}</div>
        <div class="param-value">${escapeHtml(value)}</div>
      `).join('')}
    </div>`;
}

function renderStreams(streams: AutomationJobStream[], emptyText: string): string {
  if (streams.length === 0) {
    return `<div class="no-data">${escapeHtml(emptyText)}</div>`;
  }
  return `
    <div class="stream-list">
      ${streams.map(s => `
        <div class="stream-entry ${escapeHtml(s.streamType.toLowerCase())}">
          <div class="stream-meta">
            <span>${escapeHtml(s.streamType)}</span>
            <span>${escapeHtml(formatDateTime(s.time))}</span>
          </div>
          <div class="stream-body">${escapeHtml(s.summary || s.streamText || s.value || '(empty)')}</div>
        </div>
      `).join('')}
    </div>`;
}

// ---------------------------------------------------------------------------
// HTML report export (standalone, print-friendly)
// ---------------------------------------------------------------------------

function generateStandaloneHtmlReport(state: JobsPanelState, allDetails: AutomationJobDetail[]): string {
  const runbook = state.runbook;
  const account = state.account;
  const jobs = state.jobs;
  const title = runbook?.name ?? account?.name ?? 'Jobs';
  const subtitle = runbook
    ? `${runbook.accountName} · ${runbook.resourceGroupName} · ${formatRunbookType(runbook.runbookType)}`
    : account
      ? `${account.name} · ${account.resourceGroupName} · All runbooks`
      : '';
  const exportDate = new Date().toLocaleString();
  const detailMap = new Map(allDetails.map(d => [d.jobId, d]));

  const jobRows = jobs.map(job => {
    const status = job.status ?? 'Unknown';
    const runtimeEnv = job.runtimeEnvironment ?? (runbook ? formatRunbookType(runbook.runbookType) : 'Mixed');
    const ranOn = job.runOn || 'Azure';
    const detail = detailMap.get(job.jobId);

    const detailSection = detail ? `
      <tr class="detail-row">
        <td colspan="6">
          <table class="detail-table">
            <tr>
              <td><strong>Id:</strong> ${escapeHtml(detail.jobId)}</td>
              <td><strong>Created:</strong> ${escapeHtml(formatDateTime(detail.creationTime))}</td>
            </tr>
            <tr>
              <td><strong>Status:</strong> ${escapeHtml(detail.status ?? '')}</td>
              <td><strong>Last Update:</strong> ${escapeHtml(formatDateTime(detail.lastStatusModifiedTime ?? detail.lastModifiedTime))}</td>
            </tr>
            <tr>
              <td><strong>Ran on:</strong> ${escapeHtml(detail.runOn || 'Azure')}</td>
              <td><strong>Runbook:</strong> ${escapeHtml(detail.runbookName ?? '')}</td>
            </tr>
            <tr>
              <td colspan="2"><strong>Ran As:</strong> ${escapeHtml(detail.startedBy ?? 'Unknown')}</td>
            </tr>
          </table>
          ${renderReportStreams(detail.streams)}
          ${detail.exception?.trim() ? `<p><strong>Exception:</strong></p><pre class="code-block">${escapeHtml(detail.exception)}</pre>` : ''}
        </td>
      </tr>` : '';

    return `
      <tr class="job-row-report">
        <td>${escapeHtml(job.runbookName ?? '')}</td>
        <td>${escapeHtml(formatDateTime(job.creationTime ?? job.startTime))}</td>
        <td>${escapeHtml(status)}</td>
        <td>${escapeHtml(runtimeEnv)}</td>
        <td>${escapeHtml(ranOn)}</td>
        <td>${escapeHtml(formatDateTime(job.lastModifiedTime ?? job.endTime))}</td>
      </tr>
      ${detailSection}`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Jobs Report — ${escapeHtml(title)}</title>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #1b1b1b; margin: 24px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .subtitle { color: #666; font-size: 11px; margin-bottom: 4px; }
    .export-info { color: #888; font-size: 11px; margin-bottom: 20px; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 0; }
    th { background: #f3f2f1; text-align: left; padding: 7px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; border-bottom: 2px solid #ddd; }
    td { padding: 8px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
    .job-row-report:hover { background: #f9f9f9; }
    .detail-row td { background: #fafafa; padding: 10px 16px; }
    .detail-table { width: 100%; border: none; margin-bottom: 8px; }
    .detail-table td { border: none; padding: 3px 8px; font-size: 11px; }
    .streams-section { margin-top: 8px; }
    .stream-entry { border-left: 3px solid #ccc; padding: 5px 10px; margin-bottom: 5px; font-size: 11px; }
    .stream-entry.output { border-left-color: #107c10; }
    .stream-entry.error { border-left-color: #d13438; }
    .stream-entry.warning { border-left-color: #986f0b; }
    .stream-meta { color: #888; font-size: 10px; margin-bottom: 3px; }
    pre.code-block { background: #f3f2f1; padding: 8px; font-size: 11px; white-space: pre-wrap; word-break: break-all; border: 1px solid #ddd; }
    @media print {
      body { margin: 0; }
      .detail-row { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)} — Jobs Report</h1>
  <div class="subtitle">${escapeHtml(subtitle)}</div>
  <div class="export-info">Exported on ${escapeHtml(exportDate)} &mdash; ${jobs.length} job${jobs.length === 1 ? '' : 's'}</div>
  <table>
    <thead>
      <tr>
        <th>Runbook</th>
        <th>Job created</th>
        <th>Status</th>
        <th>Runtime Environment</th>
        <th>Ran on</th>
        <th>Last status update</th>
      </tr>
    </thead>
    <tbody>
      ${jobRows}
    </tbody>
  </table>
</body>
</html>`;
}

function renderReportStreams(streams: AutomationJobStream[]): string {
  if (streams.length === 0) { return ''; }
  return `
    <div class="streams-section">
      ${streams.slice(0, 20).map(s => `
        <div class="stream-entry ${escapeHtml(s.streamType.toLowerCase())}">
          <div class="stream-meta">${escapeHtml(s.streamType)} — ${escapeHtml(formatDateTime(s.time))}</div>
          <div>${escapeHtml(s.summary || s.streamText || s.value || '')}</div>
        </div>`).join('')}
      ${streams.length > 20 ? `<div class="stream-entry"><em>… and ${streams.length - 20} more entries</em></div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeJobs(jobs: AutomationJobSummary[]): { running: number; completed: number; failed: number; queued: number } {
  let running = 0;
  let completed = 0;
  let failed = 0;
  let queued = 0;
  for (const job of jobs) {
    const bucket = normalizeStatusBucket(job.status ?? 'Unknown');
    if (bucket === 'Running') { running++; }
    else if (bucket === 'Completed') { completed++; }
    else if (bucket === 'Failed') { failed++; }
    else { queued++; }
  }
  return { running, completed, failed, queued };
}

function normalizeStatusBucket(status: string): StatusFilter {
  const s = status.trim().toLowerCase();
  if (s === 'completed') { return 'Completed'; }
  if (s === 'running' || s === 'stopping' || s === 'resuming' || s === 'suspending') { return 'Running'; }
  if (s === 'failed' || s === 'stopped' || s === 'suspended' || s === 'blocked' || s === 'disconnected' || s === 'removing') { return 'Failed'; }
  return 'Queued';
}

function formatRunbookType(type: string): string {
  const map: Record<string, string> = {
    PowerShell: 'PowerShell-5.1',
    PowerShell72: 'PowerShell-7.2',
    Python2: 'Python-2',
    Python3: 'Python-3.8',
    GraphPowerShell: 'Graph (PowerShell)',
    GraphPowerShellWorkflow: 'Graph (Workflow)',
    PowerShellWorkflow: 'PowerShell Workflow',
    Script: 'Script',
  };
  return map[type] ?? type;
}

function formatDateTime(value?: string): string {
  if (!value) { return 'Unknown'; }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) { return value; }
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function csvEscape(value: string): string {
  const normalized = value.replaceAll('"', '""');
  return `"${normalized}"`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
