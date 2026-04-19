import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkspaceManager } from './workspaceManager';

export interface WorkspaceProtectionController extends vscode.Disposable {
  runWithoutProtection<T>(action: () => T | Promise<T>): Promise<T>;
}

export function registerWorkspaceProtection(workspace: WorkspaceManager): WorkspaceProtectionController {
  const suppressedRenames = new Set<string>();
  const warnedRenames = new Set<string>();
  const pendingDeleteBackups = new Map<string, string>();
  let protectionSuspensionDepth = 0;

  const protectionSuspended = (): boolean => protectionSuspensionDepth > 0;

  const settingsRoot = path.dirname(workspace.mockTemplatesDir);
  const tempArtifactsRoot = workspace.tempArtifactsRootDir;

  const isAllowedDeletePath = (targetPath: string): boolean => {
    if (targetPath === tempArtifactsRoot) { return true; }
    return targetPath.startsWith(tempArtifactsRoot + path.sep);
  };

  const accountRoots = (): string[] => {
    const roots: string[] = [];
    if (!fs.existsSync(workspace.accountsDir)) { return roots; }

    for (const name of fs.readdirSync(workspace.accountsDir)) {
      if (name === 'mocks') { continue; }
      const accountDir = path.join(workspace.accountsDir, name);
      try {
        if (!fs.statSync(accountDir).isDirectory()) { continue; }
      } catch {
        continue;
      }
      roots.push(accountDir);
    }

    return roots;
  };

  const protectedRoots = (): string[] => {
    const roots = new Set<string>();
    roots.add(workspace.accountsDir);
    roots.add(settingsRoot);
    for (const accountDir of accountRoots()) {
      roots.add(accountDir);
    }
    return [...roots];
  };

  const isNestedAccountDirectory = (targetPath: string, assumeDirectory = false): boolean => {
    for (const accountDir of accountRoots()) {
      if (!targetPath.startsWith(accountDir + path.sep)) { continue; }
      const relative = path.relative(accountDir, targetPath);
      if (!relative || relative.startsWith('..')) { continue; }
      const segments = relative.split(path.sep).filter(Boolean);
      if (segments.length === 0) { continue; }
      if (segments[0] === '.settings') { return true; }
      if (segments.length !== 1) { return true; }
      if (!fs.existsSync(targetPath)) { return assumeDirectory; }
      try {
        return fs.statSync(targetPath).isDirectory();
      } catch {
        return assumeDirectory;
      }
    }
    return false;
  };

  const isProtectedPath = (targetPath: string): boolean => {
    if (isAllowedDeletePath(targetPath)) {
      return false;
    }
    for (const protectedRoot of protectedRoots()) {
      if (targetPath === protectedRoot) { return true; }
    }
    if (targetPath.startsWith(settingsRoot + path.sep)) {
      return true;
    }
    return false;
  };

  const isProtectedRename = (oldPath: string, newPath: string): boolean =>
    isProtectedPath(oldPath) || isProtectedPath(newPath);

  const runbookNameWithSpaces = (targetPath: string): string | undefined => {
    const ext = path.extname(targetPath).toLowerCase();
    if (ext !== '.ps1' && ext !== '.py') { return undefined; }

    for (const accountDir of accountRoots()) {
      if (!targetPath.startsWith(accountDir + path.sep)) { continue; }
      const relative = path.relative(accountDir, targetPath);
      if (!relative || relative.startsWith('..')) { continue; }
      const segments = relative.split(path.sep).filter(Boolean);
      if (segments.length !== 1) { return undefined; }
      const runbookName = path.basename(targetPath, ext);
      if (runbookName.includes(' ')) {
        return runbookName;
      }
      return undefined;
    }
    return undefined;
  };

  const captureBackup = (sourcePath: string): string | undefined => {
    if (!fs.existsSync(sourcePath)) { return undefined; }
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbw-protect-'));
    const backupPath = path.join(backupDir, path.basename(sourcePath));
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      fs.cpSync(sourcePath, backupPath, { recursive: true });
    } else {
      fs.copyFileSync(sourcePath, backupPath);
    }
    return backupPath;
  };

  const restoreBackup = (backupPath: string, targetPath: string): void => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const stat = fs.statSync(backupPath);
    if (stat.isDirectory()) {
      fs.cpSync(backupPath, targetPath, { recursive: true });
    } else {
      fs.copyFileSync(backupPath, targetPath);
    }
  };

  const cleanupBackup = (backupPath: string): void => {
    try {
      fs.rmSync(path.dirname(backupPath), { recursive: true, force: true });
    } catch {
      // Best effort cleanup only.
    }
  };

  const willRename = vscode.workspace.onWillRenameFiles((event) => {
    if (!workspace.isWorkspaceOpen) { return; }
    if (protectionSuspended()) { return; }

    for (const file of event.files) {
      const oldPath = file.oldUri.fsPath;
      const newPath = file.newUri.fsPath;
      const renameKey = `${oldPath}=>${newPath}`;
      if (!isProtectedRename(oldPath, newPath)) { continue; }
      if (suppressedRenames.has(renameKey) || warnedRenames.has(renameKey)) { continue; }

      warnedRenames.add(renameKey);
      void vscode.window.showWarningMessage(
        `Protected workspace items cannot be renamed or moved. The extension will restore "${path.basename(oldPath)}".`
      );
    }

    for (const file of event.files) {
      const runbookName = runbookNameWithSpaces(file.newUri.fsPath);
      if (!runbookName) { continue; }
      void vscode.window.showWarningMessage(
        `Runbook names cannot contain spaces in Azure Automation. "${runbookName}" may not sync, publish, or create correctly.`
      );
    }
  });

  const willDelete = vscode.workspace.onWillDeleteFiles((event) => {
    if (!workspace.isWorkspaceOpen) { return; }
    if (protectionSuspended()) { return; }

    for (const file of event.files) {
      const targetPath = file.fsPath;
      if (!isProtectedPath(targetPath)) { continue; }

      if (!pendingDeleteBackups.has(targetPath)) {
        const backupPath = captureBackup(targetPath);
        if (backupPath) {
          pendingDeleteBackups.set(targetPath, backupPath);
        }
      }

      void vscode.window.showWarningMessage(
        `Protected workspace items cannot be deleted. The extension will restore "${path.basename(targetPath)}".`
      );
    }
  });

  const didRename = vscode.workspace.onDidRenameFiles(async (event) => {
    if (!workspace.isWorkspaceOpen) { return; }
    if (protectionSuspended()) { return; }

    const revertedItems: string[] = [];

    for (const file of event.files) {
      const oldPath = file.oldUri.fsPath;
      const newPath = file.newUri.fsPath;
      const renameKey = `${oldPath}=>${newPath}`;
      warnedRenames.delete(renameKey);

      if (suppressedRenames.has(renameKey)) {
        suppressedRenames.delete(renameKey);
        continue;
      }

      if (!isProtectedRename(oldPath, newPath)) { continue; }
      if (!fs.existsSync(newPath)) { continue; }

      const reverseKey = `${newPath}=>${oldPath}`;
      suppressedRenames.add(reverseKey);

      try {
        fs.renameSync(newPath, oldPath);
        revertedItems.push(path.basename(oldPath));
      } catch {
        suppressedRenames.delete(reverseKey);
        void vscode.window.showWarningMessage(
          `Protected workspace items cannot be renamed or moved. The extension could not restore "${path.basename(oldPath)}" automatically.`
        );
      }
    }

    if (revertedItems.length) {
      void vscode.window.showWarningMessage(
        `Protected workspace items cannot be renamed or moved. Reverted: ${revertedItems.join(', ')}.`
      );
    }
  });

  const didDelete = vscode.workspace.onDidDeleteFiles(async (event) => {
    if (!workspace.isWorkspaceOpen) { return; }
    if (protectionSuspended()) { return; }

    const restoredItems: string[] = [];

    for (const file of event.files) {
      const targetPath = file.fsPath;
      const backupPath = pendingDeleteBackups.get(targetPath);
      pendingDeleteBackups.delete(targetPath);
      if (!backupPath) { continue; }

      try {
        restoreBackup(backupPath, targetPath);
        restoredItems.push(path.basename(targetPath));
      } catch {
        void vscode.window.showWarningMessage(
          `Protected workspace items cannot be deleted. The extension could not restore "${path.basename(targetPath)}" automatically.`
        );
      } finally {
        cleanupBackup(backupPath);
      }
    }

    if (restoredItems.length) {
      void vscode.window.showWarningMessage(
        `Protected workspace items cannot be renamed, moved, or deleted. Restored: ${restoredItems.join(', ')}.`
      );
    }
  });

  const didCreate = vscode.workspace.onDidCreateFiles(async (event) => {
    if (!workspace.isWorkspaceOpen) { return; }
    if (protectionSuspended()) { return; }

    const invalidRunbookNames: string[] = [];

    for (const file of event.files) {
      const runbookName = runbookNameWithSpaces(file.fsPath);
      if (!runbookName) { continue; }
      invalidRunbookNames.push(runbookName);
    }

    if (invalidRunbookNames.length) {
      void vscode.window.showWarningMessage(
        `Runbook names cannot contain spaces in Azure Automation. Problematic file(s): ${invalidRunbookNames.join(', ')}.`
      );
    }
  });

  return {
    async runWithoutProtection<T>(action: () => T | Promise<T>): Promise<T> {
      protectionSuspensionDepth += 1;
      try {
        return await action();
      } finally {
        protectionSuspensionDepth = Math.max(0, protectionSuspensionDepth - 1);
      }
    },
    dispose(): void {
      vscode.Disposable.from(willRename, willDelete, didRename, didDelete, didCreate).dispose();
    },
  };
}
