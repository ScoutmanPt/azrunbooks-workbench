import * as vscode from 'vscode';

type SessionStatus = 'running' | 'completed' | 'failed';
type SessionStream = 'stdout' | 'stderr' | 'meta';

interface SessionChunk {
  readonly stream: SessionStream;
  readonly text: string;
}

interface RunbookSession {
  readonly id: string;
  readonly runbookName: string;
  readonly runtime: string;
  readonly startedAt: Date;
  status: SessionStatus;
  exitSummary?: string;
  readonly chunks: SessionChunk[];
}

export class RunbookSessionsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly sessions: RunbookSession[] = [];
  private selectedSessionId?: string;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.onDidReceiveMessage((message: { type?: string; sessionId?: string }) => {
      if (message.type === 'select' && message.sessionId) {
        this.selectedSessionId = message.sessionId;
        this.refresh();
      }
      if (message.type === 'clear') {
        this.clearSessions();
      }
    });
    this.refresh();
  }

  startSession(runbookName: string, runtime: string): string {
    const session: RunbookSession = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      runbookName,
      runtime,
      startedAt: new Date(),
      status: 'running',
      chunks: [],
    };
    this.sessions.unshift(session);
    this.selectedSessionId = session.id;
    this.trimSessions();
    this.refresh();
    return session.id;
  }

  appendOutput(sessionId: string, text: string, stream: SessionStream): void {
    if (!text) { return; }
    const session = this.sessions.find(item => item.id === sessionId);
    if (!session) { return; }
    session.chunks.push({ stream, text });
    this.refresh();
  }

  completeSession(sessionId: string, success: boolean, exitSummary: string): void {
    const session = this.sessions.find(item => item.id === sessionId);
    if (!session) { return; }
    session.status = success ? 'completed' : 'failed';
    session.exitSummary = exitSummary;
    this.refresh();
  }

  clearSessions(): void {
    this.sessions.length = 0;
    this.selectedSessionId = undefined;
    this.refresh();
  }

  dispose(): void {
    this.view = undefined;
  }

  private refresh(): void {
    if (!this.view) { return; }
    this.view.webview.html = this.render();
  }

  private render(): string {
    const selected = this.sessions.find(item => item.id === this.selectedSessionId) ?? this.sessions[0];
    const sessionButtons = this.sessions.length === 0
      ? '<div class="empty-list">No runbook sessions yet.</div>'
      : this.sessions.map(session => {
        const isActive = selected?.id === session.id;
        const statusClass = `status-${session.status}`;
        return `
          <button class="session ${isActive ? 'selected' : ''}" data-session-id="${escapeHtml(session.id)}">
            <span class="name">${escapeHtml(session.runbookName)}</span>
            <span class="meta ${statusClass}">${escapeHtml(session.runtime)} • ${escapeHtml(labelForStatus(session.status))}</span>
            <span class="time">${escapeHtml(formatTime(session.startedAt))}</span>
          </button>
        `;
      }).join('');

    const logBody = selected
      ? renderSessionOutput(selected)
      : '<div class="empty-log">Run a script locally to see live output here.</div>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
      --border: var(--vscode-panel-border, rgba(128,128,128,.35));
      --muted: var(--vscode-descriptionForeground, #999);
      --bg-soft: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 94%, white 6%);
      --stderr: #ff7b72;
      --meta: var(--vscode-textLink-foreground, #4ea1ff);
      --selected: color-mix(in srgb, var(--vscode-list-activeSelectionBackground, #094771) 70%, transparent);
    }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .shell {
      display: grid;
      grid-template-columns: 220px 1fr;
      min-height: 100vh;
    }
    .sidebar {
      border-right: 1px solid var(--border);
      background: var(--bg-soft);
      padding: 10px;
      box-sizing: border-box;
    }
    .sidebar-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      gap: 8px;
    }
    .title {
      font-weight: 600;
      font-size: 12px;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .clear {
      border: 1px solid var(--border);
      background: transparent;
      color: inherit;
      border-radius: 6px;
      padding: 4px 8px;
      cursor: pointer;
    }
    .session {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: transparent;
      color: inherit;
      text-align: left;
      padding: 10px;
      margin-bottom: 8px;
      cursor: pointer;
    }
    .session.selected { background: var(--selected); }
    .name, .meta, .time { display: block; }
    .name { font-weight: 600; margin-bottom: 4px; }
    .meta, .time, .empty-list, .empty-log, .subtitle { color: var(--muted); font-size: 12px; }
    .status-running { color: #4ec9b0; }
    .status-completed { color: #89d185; }
    .status-failed { color: var(--stderr); }
    .content {
      padding: 12px;
      box-sizing: border-box;
    }
    .header {
      margin-bottom: 12px;
    }
    .header h2 {
      margin: 0 0 4px 0;
      font-size: 16px;
    }
    .log {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.5;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px;
      min-height: 240px;
      background: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 92%, black 8%);
    }
    .stderr { color: var(--stderr); }
    .meta-line { color: var(--meta); }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="sidebar-top">
        <div class="title">Sessions</div>
        <button class="clear" id="clear-sessions">Clear</button>
      </div>
      ${sessionButtons}
    </aside>
    <main class="content">
      ${selected ? `
        <div class="header">
          <h2>${escapeHtml(selected.runbookName)}</h2>
          <div class="subtitle">${escapeHtml(selected.runtime)} • ${escapeHtml(labelForStatus(selected.status))} • Started ${escapeHtml(formatTime(selected.startedAt))}</div>
        </div>
      ` : ''}
      <div class="log">${logBody}</div>
    </main>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('clear-sessions')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });
    for (const button of document.querySelectorAll('[data-session-id]')) {
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'select', sessionId: button.getAttribute('data-session-id') });
      });
    }
  </script>
</body>
</html>`;
  }

  private trimSessions(): void {
    while (this.sessions.length > 15) {
      this.sessions.pop();
    }
  }
}

function renderSessionOutput(session: RunbookSession): string {
  if (session.chunks.length === 0) {
    return '<div class="empty-log">Waiting for output...</div>';
  }
  return session.chunks.map(chunk => {
    const className = chunk.stream === 'stderr'
      ? 'stderr'
      : chunk.stream === 'meta'
        ? 'meta-line'
        : '';
    return `<span class="${className}">${escapeHtml(chunk.text)}</span>`;
  }).join('');
}

function labelForStatus(status: SessionStatus): string {
  switch (status) {
    case 'running': return 'Running';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
  }
}

function formatTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
