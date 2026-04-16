import * as vscode from 'vscode';
import { AuthManager } from './authManager';
import { AzureService } from './azureService';
import { AccountsTreeProvider } from './accountsTreeProvider';
import { SubscriptionColorRegistry } from './subscriptionColorRegistry';
import { LocalStateDecorationProvider, RunbookFolderDecorationProvider, RunbookRuntimeDecorationProvider } from './folderDecorationProvider';
import { IconThemeManager } from './iconThemeManager';
import { WorkspaceManager } from './workspaceManager';
import { RunbookCommands } from './runbookCommands';
import { LocalRunner } from './localRunner';
import { CiCdGenerator } from './cicdGenerator';
import { WorkspaceRunbooksTreeProvider, LinkedTwinDecorationProvider } from './workspaceRunbooksTreeProvider';
import { RunbookDiffContentProvider, registerRbCommands } from './rbCommands';
import { RunbookSessionsViewProvider } from './runbookSessionsViewProvider';
import { registerWorkspaceProtection } from './workspaceProtection';
import { JobsPanel } from './jobsPanel';
import { SchedulesPanel } from './schedulesPanel';
import { AssetsPanel } from './assetsPanel';
import { AppPermissionsPanel } from './appPermissionsPanel';

export function activate(context: vscode.ExtensionContext): void {
  // ── Core services ────────────────────────────────────────────────────────
  const auth          = new AuthManager(context);
  const azure         = new AzureService(auth);
  const workspace     = new WorkspaceManager(context.extensionPath);
  const outputChannel = vscode.window.createOutputChannel('Azure Runbook Workbench');

  const colorRegistry            = new SubscriptionColorRegistry();
  const treeProvider             = new AccountsTreeProvider(auth, azure, colorRegistry);
  const folderDecorations        = new RunbookFolderDecorationProvider(workspace, colorRegistry);
  const localStateDecorations    = new LocalStateDecorationProvider(workspace);
  const runtimeDecorations       = new RunbookRuntimeDecorationProvider(workspace);
  const iconTheme                = new IconThemeManager(context.extensionPath, workspace, colorRegistry);
  iconTheme.update();
  const commands                 = new RunbookCommands(azure, workspace, outputChannel);
  const runbookSessionsView      = new RunbookSessionsViewProvider(context.extensionUri);
  const jobsPanel                = new JobsPanel(context.extensionUri, azure, outputChannel);
  const schedulesPanel           = new SchedulesPanel(context.extensionUri, azure, outputChannel);
  const runner                   = new LocalRunner(workspace, outputChannel, runbookSessionsView, context.extensionPath, context.extension.packageJSON.version as string);
  const assetsPanel              = new AssetsPanel(context.extensionUri, azure, outputChannel, auth, runner, workspace);
  const appPermissionsPanel      = new AppPermissionsPanel(context.extensionUri, azure, auth, outputChannel, workspace);
  const cicd                     = new CiCdGenerator(workspace, outputChannel, azure, context.extensionPath);
  const workspaceRunbooksProvider = new WorkspaceRunbooksTreeProvider(
    workspace,
    colorRegistry,
    () => auth.getCloudName()
  );
  const workspaceProtection      = registerWorkspaceProtection(workspace);

  // ── Tree views ───────────────────────────────────────────────────────────
  const accountsView = vscode.window.createTreeView('runbookWorkbench.accounts', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  const workspaceView = vscode.window.createTreeView('runbookWorkbench.workspace', {
    treeDataProvider: workspaceRunbooksProvider,
    showCollapseAll: false,
  });
  // ── Workflow file guard ──────────────────────────────────────────────────
  const WORKFLOW_RE = /^\s*workflow\s+\w[\w-]*\s*\{/m;
  const warnedDocs = new Set<string>();

  function isWorkflowDoc(doc: vscode.TextDocument): boolean {
    if (!doc.fileName.endsWith('.ps1')) { return false; }
    if (!workspace.isWorkspaceOpen) { return false; }
    const normalized = doc.fileName.replace(/\\/g, '/');
    const accountsRoot = `${workspace.accountsDir.replace(/\\/g, '/')}/`;
    if (!normalized.startsWith(accountsRoot)) { return false; }
    return WORKFLOW_RE.test(doc.getText());
  }

  function applyWorkflowGuard(editor: vscode.TextEditor | undefined): void {
    if (!editor) { return; }
    const filePath = editor.document.fileName;
    if (!isWorkflowDoc(editor.document)) { return; }
    if (!warnedDocs.has(filePath)) {
      warnedDocs.add(filePath);
      void vscode.window.showWarningMessage(
        `"${filePath.split(/[\\/]/).pop()}" is a PowerShell Workflow. Workflow runbooks are not supported for local execution in PowerShell 6+.`
      );
    }
  }

  // ── Subscriptions ────────────────────────────────────────────────────────
  // Trigger an immediate refresh so badges appear without waiting for a file event
  setTimeout(() => runtimeDecorations.refresh(), 0);
  setTimeout(() => applyWorkflowGuard(vscode.window.activeTextEditor), 200);
  void revealLocalRunsPanelOnFirstActivation(context);

  context.subscriptions.push(
    auth,
    accountsView,
    workspaceView,
    outputChannel,
    runbookSessionsView,
    jobsPanel,
    schedulesPanel,
    assetsPanel,
    appPermissionsPanel,
    vscode.window.registerWebviewViewProvider('runbookWorkbench.localRuns', runbookSessionsView),
    vscode.commands.registerCommand('runbookWorkbench.clearRunbookSessions', () => {
      runbookSessionsView.clearSessions();
    }),
    vscode.workspace.registerTextDocumentContentProvider('runbookWorkbench-diff', new RunbookDiffContentProvider()),
    vscode.window.registerFileDecorationProvider(new LinkedTwinDecorationProvider()),
    vscode.window.registerFileDecorationProvider(folderDecorations),
    vscode.window.registerFileDecorationProvider(localStateDecorations),
    vscode.window.registerFileDecorationProvider(runtimeDecorations),
    workspaceProtection,
    vscode.window.onDidChangeActiveTextEditor(applyWorkflowGuard),
    vscode.workspace.onDidOpenTextDocument(doc => {
      // Wait for the editor to become active after the document opens
      setTimeout(() => {
        const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
        applyWorkflowGuard(editor ?? vscode.window.activeTextEditor);
      }, 200);
    }),
    ...registerRbCommands({
      auth, azure, workspace, outputChannel,
      treeProvider, workspaceRunbooksProvider,
      folderDecorations, iconTheme, workspaceProtection,
      commands, runner, cicd, jobsPanel, schedulesPanel, assetsPanel, appPermissionsPanel,
    }),
  );
}

export function deactivate(): void {
  // No-op - subscriptions are cleaned up automatically
}

async function revealLocalRunsPanelOnFirstActivation(context: vscode.ExtensionContext): Promise<void> {
  const key = 'runbookWorkbench.localRunsPanelRevealed';
  if (context.globalState.get<boolean>(key)) { return; }
  try {
    await vscode.commands.executeCommand('workbench.view.extension.runbookWorkbenchPanel');
  } catch {
    // Ignore if the host chooses not to expose the generated focus command.
  }
  await context.globalState.update(key, true);
}
