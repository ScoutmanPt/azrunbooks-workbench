/**
 * Minimal vscode API mock for unit tests running outside the VS Code host.
 * Only stubs the surface area used by the modules under test.
 */

export class Uri {
  constructor(
    public scheme: string,
    public fsPath: string,
    public query = ''
  ) {}

  static parse(s: string): Uri {
    const [rawScheme, rest = ''] = s.split(':', 2);
    return new Uri(rawScheme, `${rawScheme}:${rest}`, '');
  }

  static file(p: string): Uri {
    return new Uri('file', p, '');
  }
}

export class ThemeIcon {
  constructor(public id: string, public color?: unknown) {}
}
export class ThemeColor {
  constructor(public id: string) {}
}
export class TreeItem {
  label: string;
  collapsibleState: number;
  description?: string;
  iconPath?: unknown;
  contextValue?: string;
  tooltip?: string;
  command?: unknown;
  resourceUri?: unknown;
  constructor(label: string, state = 0) {
    this.label = label;
    this.collapsibleState = state;
  }
}
export class EventEmitter<T> {
  private _listeners: Array<(e: T) => void> = [];
  get event() {
    return (listener: (e: T) => void) => { this._listeners.push(listener); };
  }
  fire(e: T) { this._listeners.forEach(l => l(e)); }
  dispose() { this._listeners = []; }
}

export class Disposable {
  constructor(private readonly fn: () => void = () => {}) {}
  dispose() { this.fn(); }
  static from(...disposables: Array<{ dispose(): void } | undefined>): Disposable {
    return new Disposable(() => {
      for (const disposable of disposables) {
        disposable?.dispose();
      }
    });
  }
}

export class Webview {
  html = '';
  options?: unknown;
  private readonly listeners: Array<(message: unknown) => void> = [];
  onDidReceiveMessage(listener: (message: unknown) => void) {
    this.listeners.push(listener);
    return new Disposable();
  }
  async __fireMessage(message: unknown) {
    for (const listener of this.listeners) {
      await listener(message);
    }
  }
}

export class WebviewView {
  webview = new Webview();
}

export class WebviewPanel {
  webview = new Webview();
  visible = true;
  title: string;
  viewColumn: number;
  private readonly disposeListeners: Array<() => void> = [];

  constructor(title: string, viewColumn: number) {
    this.title = title;
    this.viewColumn = viewColumn;
  }

  reveal(viewColumn?: number): void {
    if (typeof viewColumn === 'number') {
      this.viewColumn = viewColumn;
    }
    this.visible = true;
  }

  onDidDispose(listener: () => void): Disposable {
    this.disposeListeners.push(listener);
    return new Disposable();
  }

  dispose(): void {
    this.visible = false;
    for (const listener of this.disposeListeners) {
      listener();
    }
  }
}

export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum ViewColumn { Active = -1, One = 1 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum ProgressLocation { Notification = 15 }

// Configurable workspace state for tests
export const _testState = {
  workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
  config: {} as Record<string, unknown>,
  ui: {} as Record<string, unknown[]>,
  debug: {
    startCalls: [] as unknown[],
  },
  webviewPanels: [] as WebviewPanel[],
  messages: {
    info: [] as string[],
    warn: [] as string[],
    error: [] as string[],
  },
};

function nextUiValue(key: string): unknown {
  const queue = _testState.ui[key];
  if (!Array.isArray(queue) || queue.length === 0) { return undefined; }
  return queue.shift();
}

const workspaceListeners = {
  willRename: [] as Array<(event: { files: Array<{ oldUri: Uri; newUri: Uri }> }) => void>,
  willDelete: [] as Array<(event: { files: Uri[] }) => void>,
  didRename: [] as Array<(event: { files: Array<{ oldUri: Uri; newUri: Uri }> }) => void>,
  didDelete: [] as Array<(event: { files: Uri[] }) => void>,
  didCreate: [] as Array<(event: { files: Uri[] }) => void>,
};

function registerWorkspaceListener<T>(
  bucket: Array<(event: T) => void>,
  listener: (event: T) => void
): Disposable {
  bucket.push(listener);
  return new Disposable(() => {
    const index = bucket.indexOf(listener);
    if (index >= 0) {
      bucket.splice(index, 1);
    }
  });
}

export function __fireWillRenameFiles(event: { files: Array<{ oldUri: Uri; newUri: Uri }> }): void {
  for (const listener of workspaceListeners.willRename) {
    listener(event);
  }
}

export function __fireWillDeleteFiles(event: { files: Uri[] }): void {
  for (const listener of workspaceListeners.willDelete) {
    listener(event);
  }
}

export function __fireDidRenameFiles(event: { files: Array<{ oldUri: Uri; newUri: Uri }> }): void {
  for (const listener of workspaceListeners.didRename) {
    listener(event);
  }
}

export function __fireDidDeleteFiles(event: { files: Uri[] }): void {
  for (const listener of workspaceListeners.didDelete) {
    listener(event);
  }
}

export function __fireDidCreateFiles(event: { files: Uri[] }): void {
  for (const listener of workspaceListeners.didCreate) {
    listener(event);
  }
}

export const workspace = {
  get workspaceFolders() { return _testState.workspaceFolders; },
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, def?: T): T => (_testState.config[key] as T) ?? def as T,
    update: async (key: string, value: unknown) => {
      _testState.config[key] = value;
    },
    inspect: () => undefined,
  }),
  openTextDocument: async (p: unknown) => ({ uri: p }),
  fs: {
    writeFile: async () => undefined,
  },
  workspaceFile: undefined,
  onWillRenameFiles: (listener: (event: { files: Array<{ oldUri: Uri; newUri: Uri }> }) => void) =>
    registerWorkspaceListener(workspaceListeners.willRename, listener),
  onWillDeleteFiles: (listener: (event: { files: Uri[] }) => void) =>
    registerWorkspaceListener(workspaceListeners.willDelete, listener),
  onDidRenameFiles: (listener: (event: { files: Array<{ oldUri: Uri; newUri: Uri }> }) => void) =>
    registerWorkspaceListener(workspaceListeners.didRename, listener),
  onDidDeleteFiles: (listener: (event: { files: Uri[] }) => void) =>
    registerWorkspaceListener(workspaceListeners.didDelete, listener),
  onDidCreateFiles: (listener: (event: { files: Uri[] }) => void) =>
    registerWorkspaceListener(workspaceListeners.didCreate, listener),
};

export const window = {
  showErrorMessage:       async (message?: string, ..._a: unknown[]) => {
    if (message) { _testState.messages.error.push(message); }
    return undefined;
  },
  showWarningMessage:     async (message?: string, ..._a: unknown[]) => {
    if (message) { _testState.messages.warn.push(message); }
    return nextUiValue('showWarningMessage');
  },
  showInformationMessage: async (message?: string, ..._a: unknown[]) => {
    if (message) { _testState.messages.info.push(message); }
    return nextUiValue('showInformationMessage');
  },
  showQuickPick:          async (..._a: unknown[]) => nextUiValue('showQuickPick'),
  showInputBox:           async (..._a: unknown[]) => nextUiValue('showInputBox'),
  showSaveDialog:         async (..._a: unknown[]) => nextUiValue('showSaveDialog'),
  showTextDocument:       async (..._a: unknown[]) => undefined,
  withProgress:           async (_o: unknown, fn: (p: { report: () => void }) => Promise<unknown>) => fn({ report: () => {} }),
  createTerminal:         (_opts?: unknown) => ({ show: () => {}, sendText: () => {}, dispose: () => {}, name: 'mock-terminal' }),
  createWebviewPanel:     (_viewType: string, title: string, viewColumn: number) => {
    const panel = new WebviewPanel(title, viewColumn);
    _testState.webviewPanels.push(panel);
    return panel;
  },
  onDidCloseTerminal:     (_listener: (terminal: unknown) => void) => new Disposable(),
  registerWebviewViewProvider: () => new Disposable(),
  createOutputChannel:    () => ({ appendLine: () => {}, append: () => {}, show: () => {}, dispose: () => {} }),
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async (..._a: unknown[]) => undefined,
};

export const debug = {
  startDebugging: async (...a: unknown[]) => {
    _testState.debug.startCalls.push(a);
    return true;
  },
  onDidTerminateDebugSession: (_listener: (session: { name: string }) => void) => new Disposable(),
};

export const authentication = {
  getSession: async () => undefined,
};

export const env = {
  openExternal: async (_uri: unknown) => true,
};
