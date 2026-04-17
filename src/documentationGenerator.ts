import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { AzureAutomationAccount, AzureService, AutomationSchedule, JobScheduleLink, RuntimeEnvironmentSummary, RunbookSummary } from './azureService';
import type { WorkspaceManager } from './workspaceManager';

// ── Data model ─────────────────────────────────────────────────────────────────

interface AccountDocData {
  account: AzureAutomationAccount;
  runbooks: RunbookSummary[];
  variables: Array<{ name: string; value: string | undefined; type: string; isEncrypted: boolean; description?: string }>;
  credentials: Array<{ name: string; userName: string | undefined; description: string | undefined }>;
  connections: Array<{ name: string; connectionType: string | undefined; description: string | undefined }>;
  certificates: Array<{ name: string; thumbprint: string | undefined; expiryTime: string | undefined; description: string | undefined; isExportable: boolean }>;
  modules: Array<{ name: string; version: string; provisioningState: string }>;
  schedules: AutomationSchedule[];
  jobSchedules: JobScheduleLink[];
  runtimeEnvironments: RuntimeEnvironmentSummary[];
  hybridWorkerGroups: Array<{ name: string; groupType: string | undefined }>;
}

// ── Generator class ────────────────────────────────────────────────────────────

export class DocumentationGenerator {
  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly azure: AzureService,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly extensionPath: string,
    private readonly version: string,
  ) {}

  async generate(account: AzureAutomationAccount): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Generating documentation for "${account.name}"…` },
      async () => {
        const data = await this.fetchAll(account);
        const outputDir = this.resolveOutputDir(account.name);
        fs.mkdirSync(outputDir, { recursive: true });

        const mdPath   = path.join(outputDir, `${account.name}.docs.md`);
        const htmlPath = path.join(outputDir, `${account.name}.docs.html`);

        fs.writeFileSync(mdPath,   this.buildMarkdown(data),   'utf8');
        fs.writeFileSync(htmlPath, this.buildHtml(data),       'utf8');

        this.outputChannel.appendLine(`[docs] Markdown : ${mdPath}`);
        this.outputChannel.appendLine(`[docs] HTML     : ${htmlPath}`);

        await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');

        const choice = await vscode.window.showInformationMessage(
          `Documentation generated for "${account.name}".`,
          'Open Markdown',
          'Open HTML'
        );
        if (choice === 'Open Markdown') {
          const doc = await vscode.workspace.openTextDocument(mdPath);
          await vscode.window.showTextDocument(doc);
        } else if (choice === 'Open HTML') {
          await vscode.env.openExternal(vscode.Uri.file(htmlPath));
        }
      }
    );
  }

  // ── Data fetching ────────────────────────────────────────────────────────────

  private async fetchAll(account: AzureAutomationAccount): Promise<AccountDocData> {
    const { subscriptionId, resourceGroupName, name } = account;

    const [
      runbooks,
      variables,
      credentials,
      connections,
      certificates,
      modules,
      schedules,
      jobSchedules,
      runtimeEnvironments,
      hybridWorkerGroups,
    ] = await Promise.all([
      this.azure.listRunbooks(subscriptionId, resourceGroupName, name, account.subscriptionName).catch(() => []),
      this.azure.listVariables(subscriptionId, resourceGroupName, name).catch(() => []),
      this.azure.listCredentials(subscriptionId, resourceGroupName, name).catch(() => []),
      this.azure.listConnections(subscriptionId, resourceGroupName, name).catch(() => []),
      this.azure.listCertificates(subscriptionId, resourceGroupName, name).catch(() => []),
      this.azure.listImportedModules(subscriptionId, resourceGroupName, name).catch(() => []),
      this.azure.listSchedules(subscriptionId, resourceGroupName, name).catch(() => []),
      this.azure.listJobSchedules(subscriptionId, resourceGroupName, name).catch(() => []),
      this.azure.listRuntimeEnvironments(subscriptionId, resourceGroupName, name).catch(() => []),
      this.azure.listHybridWorkerGroups(subscriptionId, resourceGroupName, name).catch(() => []),
    ]);

    return { account, runbooks, variables, credentials, connections, certificates, modules, schedules, jobSchedules, runtimeEnvironments, hybridWorkerGroups };
  }

  private resolveOutputDir(accountName: string): string {
    if (this.workspace.isWorkspaceOpen) {
      return path.join(this.workspace.accountDirForAccount(accountName), 'docs');
    }
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0
      ? path.join(folders[0].uri.fsPath, 'docs')
      : path.join(require('os').tmpdir(), 'azrunbooks-docs');
  }

  // ── Markdown builder ─────────────────────────────────────────────────────────

  private buildMarkdown(d: AccountDocData): string {
    const { account } = d;
    const generated = new Date().toISOString();
    const lines: string[] = [];

    lines.push(`> Azure Runbooks Workbench v${this.version} by @scoutmanpt · pdragon.co`);
    lines.push('');
    lines.push(`# ${account.name} — Automation Account Documentation`);
    lines.push('');
    lines.push(`**Subscription:** ${account.subscriptionName} (\`${account.subscriptionId}\`)`);
    lines.push(`**Resource Group:** ${account.resourceGroupName}`);
    lines.push(`**Location:** ${account.location || 'N/A'}`);
    lines.push(`**Generated:** ${generated}`);
    lines.push('');

    lines.push('## Table of Contents');
    lines.push('');
    lines.push('1. [Runbooks](#runbooks)');
    lines.push('2. [Runtime Environments](#runtime-environments)');
    lines.push('3. [Modules](#modules)');
    lines.push('4. [Variables](#variables)');
    lines.push('5. [Credentials](#credentials)');
    lines.push('6. [Connections](#connections)');
    lines.push('7. [Certificates](#certificates)');
    lines.push('8. [Schedules](#schedules)');
    lines.push('9. [Schedule Links](#schedule-links)');
    lines.push('10. [Hybrid Worker Groups](#hybrid-worker-groups)');
    lines.push('');

    // ── Runbooks ────────────────────────────────────────────────────────────
    lines.push('## Runbooks');
    lines.push('');
    if (d.runbooks.length === 0) {
      lines.push('_No runbooks found._');
    } else {
      lines.push('| Name | Type | State | Runtime Environment | Last Modified |');
      lines.push('|------|------|-------|---------------------|---------------|');
      for (const r of sortBy(d.runbooks, x => x.name)) {
        const mod = r.lastModifiedTime ? formatDate(r.lastModifiedTime) : '—';
        lines.push(`| \`${esc(r.name)}\` | ${esc(r.runbookType)} | ${esc(r.state)} | ${esc(r.runtimeEnvironment ?? '—')} | ${mod} |`);
      }
      for (const r of sortBy(d.runbooks, x => x.name)) {
        if (r.description) {
          lines.push('');
          lines.push(`### ${r.name}`);
          lines.push('');
          lines.push(r.description);
        }
      }
    }
    lines.push('');

    // ── Runtime Environments ─────────────────────────────────────────────────
    lines.push('## Runtime Environments');
    lines.push('');
    if (d.runtimeEnvironments.length === 0) {
      lines.push('_No custom runtime environments found._');
    } else {
      lines.push('| Name | Language | Version | Description |');
      lines.push('|------|----------|---------|-------------|');
      for (const e of sortBy(d.runtimeEnvironments, x => x.name)) {
        lines.push(`| \`${esc(e.name)}\` | ${esc(e.language ?? '—')} | ${esc(e.version ?? '—')} | ${esc(e.description ?? '—')} |`);
      }
    }
    lines.push('');

    // ── Modules ──────────────────────────────────────────────────────────────
    lines.push('## Modules');
    lines.push('');
    if (d.modules.length === 0) {
      lines.push('_No modules found._');
    } else {
      lines.push('| Name | Version | State |');
      lines.push('|------|---------|-------|');
      for (const m of sortBy(d.modules, x => x.name)) {
        lines.push(`| \`${esc(m.name)}\` | ${esc(m.version)} | ${esc(m.provisioningState)} |`);
      }
    }
    lines.push('');

    // ── Variables ────────────────────────────────────────────────────────────
    lines.push('## Variables');
    lines.push('');
    if (d.variables.length === 0) {
      lines.push('_No variables found._');
    } else {
      lines.push('| Name | Type | Encrypted | Description |');
      lines.push('|------|------|-----------|-------------|');
      for (const v of sortBy(d.variables, x => x.name)) {
        lines.push(`| \`${esc(v.name)}\` | ${esc(v.type)} | ${v.isEncrypted ? 'Yes' : 'No'} | ${esc(v.description ?? '—')} |`);
      }
    }
    lines.push('');

    // ── Credentials ──────────────────────────────────────────────────────────
    lines.push('## Credentials');
    lines.push('');
    if (d.credentials.length === 0) {
      lines.push('_No credentials found._');
    } else {
      lines.push('| Name | Username | Description |');
      lines.push('|------|----------|-------------|');
      for (const c of sortBy(d.credentials, x => x.name)) {
        lines.push(`| \`${esc(c.name)}\` | ${esc(c.userName ?? '—')} | ${esc(c.description ?? '—')} |`);
      }
    }
    lines.push('');

    // ── Connections ──────────────────────────────────────────────────────────
    lines.push('## Connections');
    lines.push('');
    if (d.connections.length === 0) {
      lines.push('_No connections found._');
    } else {
      lines.push('| Name | Type | Description |');
      lines.push('|------|------|-------------|');
      for (const c of sortBy(d.connections, x => x.name)) {
        lines.push(`| \`${esc(c.name)}\` | ${esc(c.connectionType ?? '—')} | ${esc(c.description ?? '—')} |`);
      }
    }
    lines.push('');

    // ── Certificates ─────────────────────────────────────────────────────────
    lines.push('## Certificates');
    lines.push('');
    if (d.certificates.length === 0) {
      lines.push('_No certificates found._');
    } else {
      lines.push('| Name | Thumbprint | Expiry | Exportable | Description |');
      lines.push('|------|-----------|--------|------------|-------------|');
      for (const c of sortBy(d.certificates, x => x.name)) {
        const expiry = c.expiryTime ? formatDate(new Date(c.expiryTime)) : '—';
        lines.push(`| \`${esc(c.name)}\` | \`${esc(c.thumbprint ?? '—')}\` | ${expiry} | ${c.isExportable ? 'Yes' : 'No'} | ${esc(c.description ?? '—')} |`);
      }
    }
    lines.push('');

    // ── Schedules ────────────────────────────────────────────────────────────
    lines.push('## Schedules');
    lines.push('');
    if (d.schedules.length === 0) {
      lines.push('_No schedules found._');
    } else {
      lines.push('| Name | Frequency | Interval | Next Run | Enabled | Description |');
      lines.push('|------|-----------|----------|----------|---------|-------------|');
      for (const s of sortBy(d.schedules, x => x.name)) {
        const next = s.nextRun ? formatDate(new Date(s.nextRun)) : '—';
        const interval = s.interval !== undefined ? String(s.interval) : '—';
        lines.push(`| \`${esc(s.name)}\` | ${esc(s.frequency)} | ${interval} | ${next} | ${s.isEnabled ? 'Yes' : 'No'} | ${esc(s.description ?? '—')} |`);
      }
    }
    lines.push('');

    // ── Schedule Links ────────────────────────────────────────────────────────
    lines.push('## Schedule Links');
    lines.push('');
    if (d.jobSchedules.length === 0) {
      lines.push('_No schedule links found._');
    } else {
      lines.push('| Runbook | Schedule | Run On |');
      lines.push('|---------|----------|--------|');
      for (const js of sortBy(d.jobSchedules, x => x.runbookName)) {
        lines.push(`| \`${esc(js.runbookName)}\` | \`${esc(js.scheduleName)}\` | ${esc(js.runOn ?? 'Azure')} |`);
      }
    }
    lines.push('');

    // ── Hybrid Worker Groups ──────────────────────────────────────────────────
    lines.push('## Hybrid Worker Groups');
    lines.push('');
    if (d.hybridWorkerGroups.length === 0) {
      lines.push('_No hybrid worker groups found._');
    } else {
      lines.push('| Name | Type |');
      lines.push('|------|------|');
      for (const g of sortBy(d.hybridWorkerGroups, x => x.name)) {
        lines.push(`| \`${esc(g.name)}\` | ${esc(g.groupType ?? '—')} |`);
      }
    }
    lines.push('');

    return lines.join('\n');
  }

  private iconBase64(): string {
    try {
      const iconPath = path.join(this.extensionPath, 'resources', 'icon.png');
      return fs.readFileSync(iconPath).toString('base64');
    } catch {
      return '';
    }
  }

  // ── HTML builder ─────────────────────────────────────────────────────────────

  private buildHtml(d: AccountDocData): string {
    const { account } = d;
    const generated = new Date().toISOString();
    const iconB64 = this.iconBase64();
    const iconTag = iconB64
      ? `<div class="hdr-icon-wrap"><img src="data:image/png;base64,${iconB64}" alt="Azure Runbooks Workbench" class="hdr-icon"></div>`
      : '';

    const sections: Array<{ id: string; title: string; body: string }> = [
      { id: 'overview',             title: 'Overview',             body: this.htmlOverview(account, generated) },
      { id: 'runbooks',             title: 'Runbooks',             body: this.htmlRunbooks(d.runbooks) },
      { id: 'runtime-environments', title: 'Runtime Environments', body: this.htmlRuntimeEnvironments(d.runtimeEnvironments) },
      { id: 'modules',              title: 'Modules',              body: this.htmlModules(d.modules) },
      { id: 'variables',            title: 'Variables',            body: this.htmlVariables(d.variables) },
      { id: 'credentials',          title: 'Credentials',          body: this.htmlCredentials(d.credentials) },
      { id: 'connections',          title: 'Connections',          body: this.htmlConnections(d.connections) },
      { id: 'certificates',         title: 'Certificates',         body: this.htmlCertificates(d.certificates) },
      { id: 'schedules',            title: 'Schedules',            body: this.htmlSchedules(d.schedules) },
      { id: 'schedule-links',       title: 'Schedule Links',       body: this.htmlJobSchedules(d.jobSchedules) },
      { id: 'hybrid-worker-groups', title: 'Hybrid Worker Groups', body: this.htmlHybridWorkerGroups(d.hybridWorkerGroups) },
    ];

    const toc = sections
      .map(s => `<li><a href="#${s.id}">${h(s.title)}</a></li>`)
      .join('\n        ');

    const content = sections
      .map(s => `<section id="${s.id}">\n  <h2>${h(s.title)}</h2>\n  ${s.body}\n</section>`)
      .join('\n\n');

    const version = this.version;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${h(account.name)} — Automation Account Docs</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --nav-width: 260px;
      --color-bg: #fff;
      --color-surface: #f8f8f8;
      --color-border: #e1e1e1;
      --color-text: #1b1b1b;
      --color-text-subtle: #616161;
      --color-accent: #0067b8;
      --color-accent-hover: #004d8a;
      --color-tag-bg: #eff6ff;
      --color-tag-text: #0067b8;
      --color-yes: #107c10;
      --color-no: #d13438;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: "Cascadia Mono", "Fira Code", Consolas, monospace;
    }

    body {
      font-family: var(--font);
      font-size: 14px;
      color: var(--color-text);
      background: var(--color-bg);
      line-height: 1.6;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    /* ── Top header bar ── */
    header {
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 24px;
      height: 52px;
      background: var(--color-accent);
      color: #fff;
      flex-shrink: 0;
    }

    .hdr-icon-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      background: #fff;
      border-radius: 50%;
      flex-shrink: 0;
      padding: 4px;
    }

    .hdr-icon {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }

    .hdr-title {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: .01em;
      white-space: nowrap;
      color: #fff;
    }

    .hdr-spacer { flex: 1; }

    .hdr-brand {
      font-size: 11px;
      opacity: .85;
      white-space: nowrap;
      color: #fff;
    }

    .hdr-brand a {
      color: #fff;
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    /* ── Body row (nav + main) ── */
    .body-row {
      display: flex;
      flex: 1;
    }

    /* ── Sidebar ── */
    nav {
      position: sticky;
      top: 52px;
      width: var(--nav-width);
      min-width: var(--nav-width);
      height: calc(100vh - 52px);
      overflow-y: auto;
      background: var(--color-surface);
      border-right: 1px solid var(--color-border);
      padding: 24px 0;
    }

    nav .nav-header {
      padding: 0 20px 16px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--color-text-subtle);
      border-bottom: 1px solid var(--color-border);
      margin-bottom: 8px;
    }

    nav ul {
      list-style: none;
      padding: 0;
    }

    nav ul li a {
      display: block;
      padding: 6px 20px;
      color: var(--color-text);
      text-decoration: none;
      font-size: 13px;
      border-left: 3px solid transparent;
    }

    nav ul li a:hover {
      color: var(--color-accent);
      background: rgba(0,103,184,.06);
      border-left-color: var(--color-accent);
    }

    /* ── Main ── */
    main {
      flex: 1;
      padding: 40px 48px;
      max-width: 1100px;
    }

    h1 {
      font-size: 28px;
      font-weight: 600;
      color: var(--color-text);
      margin-bottom: 4px;
      line-height: 1.2;
    }

    .subtitle {
      font-size: 13px;
      color: var(--color-text-subtle);
      margin-bottom: 32px;
    }

    section {
      margin-bottom: 48px;
      scroll-margin-top: 16px;
    }

    h2 {
      font-size: 20px;
      font-weight: 600;
      color: var(--color-text);
      padding-bottom: 8px;
      border-bottom: 2px solid var(--color-border);
      margin-bottom: 16px;
    }

    p.empty {
      color: var(--color-text-subtle);
      font-style: italic;
    }

    /* ── Tables ── */
    .table-wrap { overflow-x: auto; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    thead th {
      text-align: left;
      padding: 8px 12px;
      background: var(--color-surface);
      border-bottom: 2px solid var(--color-border);
      font-weight: 600;
      color: var(--color-text-subtle);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .05em;
      white-space: nowrap;
    }

    tbody tr { border-bottom: 1px solid var(--color-border); }
    tbody tr:last-child { border-bottom: none; }
    tbody tr:hover { background: rgba(0,103,184,.03); }

    td {
      padding: 8px 12px;
      vertical-align: top;
    }

    /* ── Inline code ── */
    code {
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--color-tag-bg);
      color: var(--color-tag-text);
      padding: 1px 5px;
      border-radius: 3px;
    }

    /* ── Meta pills ── */
    .meta {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 24px;
    }

    .meta-item {
      font-size: 12px;
      color: var(--color-text-subtle);
    }

    .meta-item strong {
      color: var(--color-text);
      font-weight: 600;
    }

    /* ── Yes / No badges ── */
    .badge-yes { color: var(--color-yes); font-weight: 600; }
    .badge-no  { color: var(--color-no);  font-weight: 600; }

    /* ── State badges ── */
    .state {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
    }
    .state-published { background: #dff6dd; color: #107c10; }
    .state-draft     { background: #fff4ce; color: #6b5a0a; }
    .state-new       { background: #e9e9e9; color: #616161; }

    /* ── Description cards (for runbooks with descriptions) ── */
    .desc-card {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-left: 4px solid var(--color-accent);
      border-radius: 4px;
      padding: 12px 16px;
      margin: 8px 0 16px;
      font-size: 13px;
    }

    .desc-card h3 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 4px;
    }
  </style>
</head>
<body>

<header>
  ${iconTag}
  <span class="hdr-title">Azure Automation Account Documentation</span>
  <span class="hdr-spacer"></span>
  <span class="hdr-brand">Azure Runbooks Workbench v${h(version)} by <a href="https://www.linkedin.com/in/rodrigomgpinto/" target="_blank" rel="noopener">@scoutmanpt</a> &nbsp;·&nbsp; <a href="https://www.pdragon.co" target="_blank" rel="noopener">pdragon.co</a></span>
</header>

<div class="body-row">

<nav>
  <div class="nav-header">Documentation</div>
  <ul>
    ${toc}
  </ul>
</nav>

<main>
  <h1>${h(account.name)}</h1>
  <p class="subtitle">Azure Automation Account &nbsp;·&nbsp; Generated ${generated}</p>

  ${content}
</main>

</div><!-- .body-row -->

</body>
</html>`;
  }

  // ── HTML section helpers ─────────────────────────────────────────────────────

  private htmlOverview(account: AzureAutomationAccount, generated: string): string {
    return `<div class="meta">
  <span class="meta-item"><strong>Subscription</strong> ${h(account.subscriptionName)} <code>${h(account.subscriptionId)}</code></span>
  <span class="meta-item"><strong>Resource Group</strong> <code>${h(account.resourceGroupName)}</code></span>
  <span class="meta-item"><strong>Location</strong> ${h(account.location || 'N/A')}</span>
  <span class="meta-item"><strong>Generated</strong> ${h(generated)}</span>
</div>`;
  }

  private htmlRunbooks(runbooks: RunbookSummary[]): string {
    if (runbooks.length === 0) { return '<p class="empty">No runbooks found.</p>'; }
    const sorted = sortBy(runbooks, x => x.name);
    const rows = sorted.map(r => {
      const mod = r.lastModifiedTime ? formatDate(r.lastModifiedTime) : '—';
      const state = stateBadge(r.state);
      return `<tr>
    <td><code>${h(r.name)}</code></td>
    <td>${h(r.runbookType)}</td>
    <td>${state}</td>
    <td>${h(r.runtimeEnvironment ?? '—')}</td>
    <td style="white-space:nowrap">${h(mod)}</td>
  </tr>`;
    }).join('\n  ');

    const cards = sorted
      .filter(r => r.description)
      .map(r => `<div class="desc-card"><h3>${h(r.name)}</h3><p>${h(r.description!)}</p></div>`)
      .join('\n');

    return `<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Type</th><th>State</th><th>Runtime Environment</th><th>Last Modified</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>${cards ? '\n' + cards : ''}`;
  }

  private htmlRuntimeEnvironments(envs: RuntimeEnvironmentSummary[]): string {
    if (envs.length === 0) { return '<p class="empty">No custom runtime environments found.</p>'; }
    const rows = sortBy(envs, x => x.name).map(e => `<tr>
    <td><code>${h(e.name)}</code></td>
    <td>${h(e.language ?? '—')}</td>
    <td>${h(e.version ?? '—')}</td>
    <td>${h(e.description ?? '—')}</td>
  </tr>`).join('\n  ');
    return `<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Language</th><th>Version</th><th>Description</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
  }

  private htmlModules(modules: Array<{ name: string; version: string; provisioningState: string }>): string {
    if (modules.length === 0) { return '<p class="empty">No modules found.</p>'; }
    const rows = sortBy(modules, x => x.name).map(m => `<tr>
    <td><code>${h(m.name)}</code></td>
    <td>${h(m.version)}</td>
    <td>${h(m.provisioningState)}</td>
  </tr>`).join('\n  ');
    return `<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Version</th><th>State</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
  }

  private htmlVariables(variables: Array<{ name: string; value: string | undefined; type: string; isEncrypted: boolean; description?: string }>): string {
    if (variables.length === 0) { return '<p class="empty">No variables found.</p>'; }
    const rows = sortBy(variables, x => x.name).map(v => `<tr>
    <td><code>${h(v.name)}</code></td>
    <td>${h(v.type)}</td>
    <td>${yesNo(v.isEncrypted)}</td>
    <td>${h(v.description ?? '—')}</td>
  </tr>`).join('\n  ');
    return `<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Type</th><th>Encrypted</th><th>Description</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
  }

  private htmlCredentials(credentials: Array<{ name: string; userName: string | undefined; description: string | undefined }>): string {
    if (credentials.length === 0) { return '<p class="empty">No credentials found.</p>'; }
    const rows = sortBy(credentials, x => x.name).map(c => `<tr>
    <td><code>${h(c.name)}</code></td>
    <td>${h(c.userName ?? '—')}</td>
    <td>${h(c.description ?? '—')}</td>
  </tr>`).join('\n  ');
    return `<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Username</th><th>Description</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
  }

  private htmlConnections(connections: Array<{ name: string; connectionType: string | undefined; description: string | undefined }>): string {
    if (connections.length === 0) { return '<p class="empty">No connections found.</p>'; }
    const rows = sortBy(connections, x => x.name).map(c => `<tr>
    <td><code>${h(c.name)}</code></td>
    <td>${h(c.connectionType ?? '—')}</td>
    <td>${h(c.description ?? '—')}</td>
  </tr>`).join('\n  ');
    return `<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
  }

  private htmlCertificates(certificates: Array<{ name: string; thumbprint: string | undefined; expiryTime: string | undefined; description: string | undefined; isExportable: boolean }>): string {
    if (certificates.length === 0) { return '<p class="empty">No certificates found.</p>'; }
    const rows = sortBy(certificates, x => x.name).map(c => {
      const expiry = c.expiryTime ? formatDate(new Date(c.expiryTime)) : '—';
      return `<tr>
    <td><code>${h(c.name)}</code></td>
    <td><code style="font-size:11px">${h(c.thumbprint ?? '—')}</code></td>
    <td style="white-space:nowrap">${h(expiry)}</td>
    <td>${yesNo(c.isExportable)}</td>
    <td>${h(c.description ?? '—')}</td>
  </tr>`;
    }).join('\n  ');
    return `<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Thumbprint</th><th>Expiry</th><th>Exportable</th><th>Description</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
  }

  private htmlSchedules(schedules: AutomationSchedule[]): string {
    if (schedules.length === 0) { return '<p class="empty">No schedules found.</p>'; }
    const rows = sortBy(schedules, x => x.name).map(s => {
      const next = s.nextRun ? formatDate(new Date(s.nextRun)) : '—';
      const interval = s.interval !== undefined ? String(s.interval) : '—';
      return `<tr>
    <td><code>${h(s.name)}</code></td>
    <td>${h(s.frequency)}</td>
    <td>${h(interval)}</td>
    <td style="white-space:nowrap">${h(next)}</td>
    <td>${yesNo(s.isEnabled)}</td>
    <td>${h(s.description ?? '—')}</td>
  </tr>`;
    }).join('\n  ');
    return `<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Frequency</th><th>Interval</th><th>Next Run</th><th>Enabled</th><th>Description</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
  }

  private htmlJobSchedules(jobSchedules: JobScheduleLink[]): string {
    if (jobSchedules.length === 0) { return '<p class="empty">No schedule links found.</p>'; }
    const rows = sortBy(jobSchedules, x => x.runbookName).map(js => `<tr>
    <td><code>${h(js.runbookName)}</code></td>
    <td><code>${h(js.scheduleName)}</code></td>
    <td>${h(js.runOn ?? 'Azure')}</td>
  </tr>`).join('\n  ');
    return `<div class="table-wrap"><table>
  <thead><tr><th>Runbook</th><th>Schedule</th><th>Run On</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
  }

  private htmlHybridWorkerGroups(groups: Array<{ name: string; groupType: string | undefined }>): string {
    if (groups.length === 0) { return '<p class="empty">No hybrid worker groups found.</p>'; }
    const rows = sortBy(groups, x => x.name).map(g => `<tr>
    <td><code>${h(g.name)}</code></td>
    <td>${h(g.groupType ?? '—')}</td>
  </tr>`).join('\n  ');
    return `<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Type</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

/** HTML-escape a string for safe output. */
function h(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Markdown pipe-escape: replace pipe characters to avoid breaking table cells. */
function esc(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function sortBy<T>(arr: T[], key: (item: T) => string): T[] {
  return [...arr].sort((a, b) => key(a).localeCompare(key(b)));
}

function formatDate(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function yesNo(value: boolean): string {
  return value
    ? '<span class="badge-yes">Yes</span>'
    : '<span class="badge-no">No</span>';
}

function stateBadge(state: string): string {
  const lower = state.toLowerCase();
  if (lower === 'published') { return `<span class="state state-published">${h(state)}</span>`; }
  if (lower === 'draft')     { return `<span class="state state-draft">${h(state)}</span>`; }
  return `<span class="state state-new">${h(state)}</span>`;
}
