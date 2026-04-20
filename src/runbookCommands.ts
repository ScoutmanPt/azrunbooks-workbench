import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { AzureService, AzureAutomationAccount, RunbookSummary } from './azureService';
import type { WorkspaceManager } from './workspaceManager';

export interface CreateRunbookPrefill {
  name?: string;
  runbookType?: string;
  description?: string;
  runtimeEnvironment?: string;
}

interface RunbookTypeChoice {
  label: string;
  value: string;
  description?: string;
}

interface RuntimeEnvironmentChoice {
  label: string;
  value: string;
  description?: string;
  detail?: string;
  language?: string;
}

function parseVersionParts(version?: string): number[] {
  if (!version) { return [0]; }
  return version
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(part => Number.parseInt(part, 10))
    .filter(part => Number.isFinite(part));
}

function compareVersionsDescending(left?: string, right?: string): number {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index++) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0);
    if (diff !== 0) { return diff; }
  }
  return 0;
}

function mapRuntimeEnvironmentToRunbookType(
  item: { language?: string; version?: string }
): RunbookTypeChoice | undefined {
  const language = (item.language ?? '').toLowerCase();
  const version = item.version ?? '';

  if (language === 'powershell') {
    const parts = parseVersionParts(version);
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    if (major >= 7) {
      if (major > 7 || minor >= 2) {
        return { label: `PowerShell ${version || '7.x'}`, value: 'PowerShell72' };
      }
      return { label: `PowerShell ${version || '7.x'}`, value: 'PowerShell7' };
    }
    return { label: `PowerShell ${version || '5.1'}`, value: 'PowerShell' };
  }

  if (language === 'python') {
    const major = parseVersionParts(version)[0] ?? 0;
    return major >= 3
      ? { label: `Python ${version || '3'}`, value: 'Python3' }
      : { label: `Python ${version || '2'}`, value: 'Python2' };
  }

  return undefined;
}

function isRuntimeEnvironmentCompatibleWithRunbookType(
  runtimeEnvironment: { language?: string; version?: string },
  runbookType: string
): boolean {
  const language = (runtimeEnvironment.language ?? '').toLowerCase();
  const normalizedType = runbookType.toLowerCase();

  if (normalizedType.startsWith('powershell')) {
    if (language !== 'powershell') { return false; }
    const parts = parseVersionParts(runtimeEnvironment.version ?? '');
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    if (normalizedType === 'powershell72') { return major > 7 || (major === 7 && minor >= 2); }
    if (normalizedType === 'powershell7') { return major === 7 && minor < 2; }
    return major < 7; // classic PowerShell (5.x)
  }

  if (normalizedType.startsWith('python')) {
    if (language !== 'python') { return false; }
    const major = parseVersionParts(runtimeEnvironment.version ?? '')[0] ?? 0;
    if (normalizedType === 'python3') { return major >= 3; }
    if (normalizedType === 'python2') { return major < 3; }
  }

  return false;
}

function normalizeRunbookTypeForRuntimeEnvironment(runbookType: string): string {
  const normalizedType = runbookType.toLowerCase();
  if (normalizedType.startsWith('powershell')) { return 'PowerShell'; }
  if (normalizedType.startsWith('python')) { return 'Python3'; }
  return runbookType;
}

async function getRunbookTypeChoices(
  azure: AzureService,
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  outputChannel: vscode.OutputChannel
): Promise<RunbookTypeChoice[]> {
  const fallback: RunbookTypeChoice[] = [
    { label: 'PowerShell 7.2', value: 'PowerShell72' },
    { label: 'PowerShell 7.1', value: 'PowerShell7' },
    { label: 'PowerShell 5.1', value: 'PowerShell' },
    { label: 'Python 3', value: 'Python3' },
    { label: 'Python 2', value: 'Python2' },
  ];

  try {
    const runtimeEnvironments = await azure.listRuntimeEnvironments(subscriptionId, resourceGroup, accountName);
    if (runtimeEnvironments.length === 0) { return fallback; }

    const runtimeChoices = runtimeEnvironments
      .map(mapRuntimeEnvironmentToRunbookType)
      .filter((choice): choice is RunbookTypeChoice => Boolean(choice));

    const deduped = new Map<string, RunbookTypeChoice>();
    // Always ensure PowerShell 7.2 and 7.1 are available as options for new runbooks,
    // even when the account only has older runtime environments configured.
    for (const choice of fallback.filter(c => c.value === 'PowerShell72' || c.value === 'PowerShell7')) {
      deduped.set(choice.value, choice);
    }
    for (const choice of runtimeChoices) {
      if (!deduped.has(choice.value)) {
        deduped.set(choice.value, choice);
      }
    }

    const ordered = Array.from(deduped.values()).sort((left, right) => {
      const leftPowerShell = left.value.toLowerCase().startsWith('powershell');
      const rightPowerShell = right.value.toLowerCase().startsWith('powershell');
      if (leftPowerShell && rightPowerShell) {
        return compareVersionsDescending(left.label.replace('PowerShell ', ''), right.label.replace('PowerShell ', ''));
      }

      const leftPython = left.value.toLowerCase().startsWith('python');
      const rightPython = right.value.toLowerCase().startsWith('python');
      if (leftPython && rightPython) {
        return compareVersionsDescending(left.label.replace('Python ', ''), right.label.replace('Python ', ''));
      }

      if (leftPowerShell && !rightPowerShell) { return -1; }
      if (!leftPowerShell && rightPowerShell) { return 1; }
      if (leftPython && !rightPython) { return -1; }
      if (!leftPython && rightPython) { return 1; }
      return left.label.localeCompare(right.label);
    });

    return ordered.length > 0 ? ordered : fallback;
  } catch (err) {
    outputChannel.appendLine(`[create-runbook-runtime-fallback] ${accountName}: ${errMessage(err)}`);
    return fallback;
  }
}

/**
 * Like promptForRuntimeEnvironment but returns null when the user presses
 * Escape (so callers can abort the operation), vs undefined when there are no
 * compatible environments (so callers can proceed without changing anything).
 */
async function pickRuntimeEnvironmentForPublish(
  azure: AzureService,
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  runbookType: string,
  outputChannel: vscode.OutputChannel,
  currentEnv?: string
): Promise<{ env: string | undefined } | null> {
  try {
    const runtimeEnvironments = await azure.listRuntimeEnvironments(subscriptionId, resourceGroup, accountName);
    // Show all environments of the same language so the user can freely upgrade
    // or change the runtime (e.g. move a PS 5.1 runbook to a PS 7.2 environment).
    const language = runbookType.toLowerCase().startsWith('python') ? 'python' : 'powershell';
    const compatible = runtimeEnvironments
      .filter(item => (item.language ?? '').toLowerCase() === language)
      .map<RuntimeEnvironmentChoice>(item => ({
        label: item.name,
        value: item.name,
        description: [item.language, item.version].filter(Boolean).join(' '),
        detail: item.defaultPackages && Object.keys(item.defaultPackages).length > 0
          ? `Packages: ${Object.entries(item.defaultPackages).map(([name, version]) => `${name}@${version}`).join(', ')}`
          : item.description,
        language: item.language,
      }));

    if (compatible.length === 0) { return { env: currentEnv }; }

    const noneChoice: RuntimeEnvironmentChoice = {
      label: 'No linked Runtime Environment',
      value: '',
      description: 'Keep the classic runbook type only',
    };
    const preferred = compatible.find(item => item.value === currentEnv);
    // When no current env is set, default to "None" first so the user doesn't
    // accidentally link an incompatible or unintended runtime environment.
    const ordered = preferred
      ? [
          { ...preferred, description: preferred.description ? `${preferred.description} · Current` : 'Current' },
          ...compatible.filter(item => item.value !== preferred.value),
          noneChoice,
        ]
      : [noneChoice, ...compatible];

    const selected = await vscode.window.showQuickPick(ordered, {
      title: 'Select Runtime Environment',
      placeHolder: 'Select a runtime environment for this runbook',
      ignoreFocusOut: true,
    });
    if (!selected) { return null; }  // user cancelled (Escape)
    return { env: selected.value || undefined };
  } catch (err) {
    outputChannel.appendLine(`[runtime-environment-prompt-fallback] ${accountName}: ${errMessage(err)}`);
    return { env: currentEnv };  // proceed unchanged on error
  }
}

async function promptForRuntimeEnvironment(
  azure: AzureService,
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  runbookType: string,
  outputChannel: vscode.OutputChannel,
  preferredRuntimeEnvironment?: string
): Promise<string | undefined> {
  try {
    const runtimeEnvironments = await azure.listRuntimeEnvironments(subscriptionId, resourceGroup, accountName);
    const language = runbookType.toLowerCase().startsWith('python') ? 'python' : 'powershell';
    const compatible = runtimeEnvironments
      .filter(item => (item.language ?? '').toLowerCase() === language)
      .map<RuntimeEnvironmentChoice>(item => ({
        label: item.name,
        value: item.name,
        description: [item.language, item.version].filter(Boolean).join(' '),
        detail: item.defaultPackages && Object.keys(item.defaultPackages).length > 0
          ? `Packages: ${Object.entries(item.defaultPackages).map(([name, version]) => `${name}@${version}`).join(', ')}`
          : item.description,
        language: item.language,
      }));

    if (compatible.length === 0) { return undefined; }

    const noneChoice: RuntimeEnvironmentChoice = {
      label: 'No linked Runtime Environment',
      value: '',
      description: 'Keep the classic runbook type only',
    };

    const preferred = compatible.find(item => item.value === preferredRuntimeEnvironment);
    const ordered = preferred
      ? [
          { ...preferred, description: preferred.description ? `${preferred.description} · Current selection` : 'Current selection' },
          ...compatible.filter(item => item.value !== preferred.value),
          noneChoice,
        ]
      : [...compatible, noneChoice];

    const selected = await vscode.window.showQuickPick(ordered, {
      title: 'Select Runtime Environment',
      placeHolder: `Select a runtime environment (${language === 'python' ? 'Python' : 'PowerShell'})`,
    });
    if (!selected) { return undefined; }
    return selected.value || undefined;
  } catch (err) {
    outputChannel.appendLine(`[runtime-environment-prompt-fallback] ${accountName}: ${errMessage(err)}`);
    return undefined;
  }
}

/**
 * RunbookCommands handles VS Code command implementations for all runbook
 * operations: fetch, publish, diff, job lifecycle, and workspace init.
 */
export class RunbookCommands {
  constructor(
    private readonly azure: AzureService,
    private readonly workspace: WorkspaceManager,
    private readonly outputChannel: vscode.OutputChannel
  ) {}

  async fetchRunbook(runbook: RunbookSummary, type: 'published' | 'draft'): Promise<void> {
    if (!this.workspace.isWorkspaceOpen) {
      const init = await vscode.window.showWarningMessage(
        'No runbook workspace is initialized. Initialize one now?',
        'Initialize',
        'Cancel'
      );
      if (init !== 'Initialize') { return; }
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Fetching ${runbook.name}…`, cancellable: false },
      async () => {
        try {
          const content = await this.fetchRunbookContentOrEmpty(runbook, type);
          const filePath = this.workspace.writeRunbookFile(
            runbook.accountName,
            runbook.name,
            runbook.runbookType,
            content,
            undefined,
            runbook.runtimeEnvironment
          );
          const doc = await vscode.workspace.openTextDocument(filePath);
          await vscode.window.showTextDocument(doc);
          this.outputChannel.appendLine(`[fetch] ${runbook.name} (${type}) → ${filePath}`);
          if (content.length === 0) {
            const warning = `"${runbook.name}" has no Azure content yet. Created an empty local file.`;
            this.outputChannel.appendLine(`[fetch-warning] ${runbook.name} (${type}): no content returned; wrote empty file`);
            void vscode.window.showWarningMessage(warning);
          }
        } catch (err: unknown) {
          let message = `Failed to fetch runbook "${runbook.name}" (${type}).`;
          if (err !== null && typeof err === 'object') {
            const e = err as Record<string, unknown>;
            if (e['status'] === 404 || (typeof e['message'] === 'string' && e['message'].includes('404'))) {
              message += ' Runbook not found in Azure Automation account.';
            } else if (typeof e['message'] === 'string') {
              message += `\n${e['message']}`;
            }
          }
          this.outputChannel.appendLine(`[fetch-error] ${runbook.name} (${type}): ${errMessage(err)}`);
          void vscode.window.showErrorMessage(message);
        }
      }
    );
  }

  async publishRunbook(
    runbook: RunbookSummary,
    options?: { skipConfirm?: boolean; suppressSuccessMessage?: boolean }
  ): Promise<void> {
    const local = this.workspace.readRunbookFile(runbook.accountName, runbook.name, runbook.runbookType);
    if (local === undefined) {
      void vscode.window.showErrorMessage(
        `No local copy of "${runbook.name}" found. Fetch it first.`
      );
      return;
    }

    if (!options?.skipConfirm) {
      // Step 1: pick runtime environment
      const envResult = await pickRuntimeEnvironmentForPublish(
        this.azure,
        runbook.subscriptionId,
        runbook.resourceGroupName,
        runbook.accountName,
        runbook.runbookType,
        this.outputChannel,
        runbook.runtimeEnvironment
      );
      if (envResult === null) { return; }  // user cancelled (Escape)

      // Step 2: summary confirmation with all publish details
      const effectiveRunbookType = envResult.env
        ? normalizeRunbookTypeForRuntimeEnvironment(runbook.runbookType)
        : runbook.runbookType;
      const confirm = await vscode.window.showWarningMessage(
        `Publish "${runbook.name}"?`,
        {
          modal: true,
          detail: [
            `Account:             ${runbook.accountName}`,
            `Runbook type:        ${effectiveRunbookType}`,
            `Runtime environment: ${envResult.env ?? 'None (classic)'}`,
            ``,
            `This will overwrite the published version in Azure.`,
          ].join('\n'),
        },
        'Publish'
      );
      if (confirm !== 'Publish') { return; }

      // Step 3: apply runtime environment change if needed
      if (envResult.env !== runbook.runtimeEnvironment) {
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Updating runtime environment for "${runbook.name}"…` },
            () => this.azure.updateRunbookRuntimeEnvironment(
              runbook.subscriptionId,
              runbook.resourceGroupName,
              runbook.accountName,
              runbook.name,
              runbook.runbookType,
              envResult.env ?? ''
            )
          );
          this.workspace.setRunbookMeta(runbook.accountName, runbook.name, runbook.runbookType, envResult.env);
          this.outputChannel.appendLine(`[publish] ${runbook.name} runtime environment → ${envResult.env ?? 'none'}`);
          runbook = { ...runbook, runtimeEnvironment: envResult.env };
        } catch (err) {
          this.outputChannel.appendLine(`[publish-runtime-error] ${runbook.name}: ${errMessage(err)}`);
          void vscode.window.showErrorMessage(`Failed to update runtime environment for "${runbook.name}": ${errMessage(err)}`);
          return;
        }
      }
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Publishing ${runbook.name}…` },
      async () => {
        try {
          // Step 1: upload local as draft
          await this.azure.uploadDraftContent(
            runbook.subscriptionId,
            runbook.resourceGroupName,
            runbook.accountName,
            runbook.name,
            local
          );
          // Step 2: publish the draft
          await this.azure.publishRunbook(
            runbook.subscriptionId,
            runbook.resourceGroupName,
            runbook.accountName,
            runbook.name
          );
          // Step 3: re-apply runtime environment after publish — Azure may reset it
          // during the draft upload/publish cycle, so we enforce it as a final PATCH.
          if (runbook.runtimeEnvironment) {
            try {
              await this.azure.updateRunbookRuntimeEnvironment(
                runbook.subscriptionId,
                runbook.resourceGroupName,
                runbook.accountName,
                runbook.name,
                runbook.runbookType,
                runbook.runtimeEnvironment
              );
              this.outputChannel.appendLine(`[publish] ${runbook.name} runtime environment re-applied → ${runbook.runtimeEnvironment}`);
            } catch (envErr) {
              this.outputChannel.appendLine(`[publish-runtime-reapply-warning] ${runbook.name}: ${errMessage(envErr)}`);
            }
          }
          // Record deploy hash
          const hash = crypto.createHash('sha256').update(local).digest('hex');
          this.workspace.recordDeploy(runbook.accountName, runbook.name, hash);
          this.outputChannel.appendLine(`[publish] ${runbook.name} → published (${hash.slice(0, 8)})`);
          if (!options?.suppressSuccessMessage) {
            void vscode.window.showInformationMessage(`"${runbook.name}" published successfully.`);
          }
        } catch (err) {
          this.outputChannel.appendLine(`[publish-error] ${runbook.name}: ${errMessage(err)}`);
          void vscode.window.showErrorMessage(`Failed to publish "${runbook.name}": ${errMessage(err)}`);
        }
      }
    );
  }

  async uploadAsDraft(
    runbook: RunbookSummary,
    options?: { suppressSuccessMessage?: boolean }
  ): Promise<void> {
    const local = this.workspace.readRunbookFile(runbook.accountName, runbook.name, runbook.runbookType);
    if (local === undefined) {
      void vscode.window.showErrorMessage(`No local copy of "${runbook.name}" found.`);
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Uploading draft for ${runbook.name}…` },
      async () => {
        try {
          await this.azure.uploadDraftContent(
            runbook.subscriptionId,
            runbook.resourceGroupName,
            runbook.accountName,
            runbook.name,
            local
          );
          this.outputChannel.appendLine(`[draft] ${runbook.name} uploaded as draft`);
          if (!options?.suppressSuccessMessage) {
            void vscode.window.showInformationMessage(`"${runbook.name}" uploaded as draft.`);
          }
        } catch (err) {
          this.outputChannel.appendLine(`[draft-error] ${runbook.name}: ${errMessage(err)}`);
          void vscode.window.showErrorMessage(`Failed to upload draft for "${runbook.name}": ${errMessage(err)}`);
        }
      }
    );
  }

  async diffRunbook(runbook: RunbookSummary): Promise<void> {
    const local = this.workspace.readRunbookFile(runbook.accountName, runbook.name, runbook.runbookType);
    if (local === undefined) {
      void vscode.window.showErrorMessage(`No local copy of "${runbook.name}" found. Fetch it first.`);
      return;
    }

    const remoteChoice = await vscode.window.showQuickPick(
      [{ label: 'Published', value: 'published' }, { label: 'Draft', value: 'draft' }],
      { title: `Compare local "${runbook.name}" against:` }
    );
    if (!remoteChoice) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Fetching remote content for diff…' },
      async () => {
        try {
          const remote = await this.azure.getRunbookContent(
            runbook.subscriptionId,
            runbook.resourceGroupName,
            runbook.accountName,
            runbook.name,
            remoteChoice.value as 'published' | 'draft'
          );

          const remoteUri = vscode.Uri.parse(
            `runbookWorkbench-diff:${runbook.name}-${remoteChoice.value}`
          ).with({ query: encodeURIComponent(remote) });

          const localFilePath =
            this.workspace.findRunbookFilePath(runbook.accountName, runbook.name, runbook.runbookType) ??
            this.workspace.writeRunbookFile(
              runbook.accountName,
              runbook.name,
              runbook.runbookType,
              local,
              undefined,
              runbook.runtimeEnvironment
            );
          const localUri = vscode.Uri.file(localFilePath);

          await vscode.commands.executeCommand(
            'vscode.diff',
            remoteUri,
            localUri,
            `${runbook.name}: ${remoteChoice.label} ↔ Local`
          );
        } catch (err) {
          this.outputChannel.appendLine(`[diff-error] ${runbook.name}: ${errMessage(err)}`);
          void vscode.window.showErrorMessage(`Failed to fetch remote content for diff: ${errMessage(err)}`);
        }
      }
    );
  }

  async startTestJob(runbook: RunbookSummary): Promise<void> {
    const params = await promptForParameters('Start Test Job');
    if (params === undefined) { return; }

    // Upload current local copy as draft first
    const local = this.workspace.readRunbookFile(runbook.accountName, runbook.name, runbook.runbookType);
    if (local) {
      await this.azure.uploadDraftContent(
        runbook.subscriptionId,
        runbook.resourceGroupName,
        runbook.accountName,
        runbook.name,
        local
      );
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Starting test job for ${runbook.name}…` },
      async () => {
        try {
          const status = await this.azure.startTestJob(
            runbook.subscriptionId,
            runbook.resourceGroupName,
            runbook.accountName,
            runbook.name,
            params
          );
          this.outputChannel.appendLine(`[test-job] ${runbook.name} → ${status}`);
          this.outputChannel.show(true);
          void this.pollTestJobOutput(runbook);
        } catch (err) {
          this.outputChannel.appendLine(`[test-job-error] ${runbook.name}: ${errMessage(err)}`);
          void vscode.window.showErrorMessage(`Failed to start test job for "${runbook.name}": ${errMessage(err)}`);
        }
      }
    );
  }

  async startJob(runbook: RunbookSummary): Promise<void> {
    const params = await promptForParameters('Start Automation Job');
    if (params === undefined) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Starting automation job for ${runbook.name}…` },
      async () => {
        try {
          const { jobId, status } = await this.azure.startJob(
            runbook.subscriptionId,
            runbook.resourceGroupName,
            runbook.accountName,
            runbook.name,
            params
          );
          this.outputChannel.appendLine(`[job] ${runbook.name} → ${status} (${jobId})`);
          this.outputChannel.show(true);
          void vscode.window.showInformationMessage(
            `Started automation job for "${runbook.name}" (${jobId}).`
          );
          void this.pollJobOutput(runbook, jobId);
        } catch (err) {
          this.outputChannel.appendLine(`[job-error] ${runbook.name}: ${errMessage(err)}`);
          void vscode.window.showErrorMessage(`Failed to start automation job for "${runbook.name}": ${errMessage(err)}`);
        }
      }
    );
  }

  async stopTestJob(runbook: RunbookSummary): Promise<void> {
    try {
      await this.azure.stopTestJob(
        runbook.subscriptionId,
        runbook.resourceGroupName,
        runbook.accountName,
        runbook.name
      );
      this.outputChannel.appendLine(`[test-job] ${runbook.name} → stopped`);
      void vscode.window.showInformationMessage(`Test job for "${runbook.name}" stopped.`);
    } catch (err) {
      this.outputChannel.appendLine(`[test-job-error] stop ${runbook.name}: ${errMessage(err)}`);
      void vscode.window.showErrorMessage(`Failed to stop test job for "${runbook.name}": ${errMessage(err)}`);
    }
  }

  private async pollTestJobOutput(runbook: RunbookSummary): Promise<void> {
    const MAX_POLLS = 60; // 5 minutes at 5s intervals
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      try {
        const { summary, streams } = await this.azure.getTestJobOutput(
          runbook.subscriptionId,
          runbook.resourceGroupName,
          runbook.accountName,
          runbook.name
        );
        for (const s of streams) {
          this.outputChannel.appendLine(`[${s.streamType.padEnd(7)}] ${s.value}`);
        }
        if (summary === 'Completed' || summary === 'Failed' || summary === 'Stopped') {
          this.outputChannel.appendLine(`[test-job] Final status: ${summary}`);
          return;
        }
      } catch (err) {
        this.outputChannel.appendLine(`[test-job-error] polling ${runbook.name}: ${errMessage(err)}`);
        return;
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    this.outputChannel.appendLine('[test-job] Polling timeout - check Azure portal for final status.');
  }

  private async pollJobOutput(runbook: RunbookSummary, jobId: string): Promise<void> {
    const MAX_POLLS = 60; // 5 minutes at 5s intervals
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      try {
        const { summary, streams } = await this.azure.getJobOutput(
          runbook.subscriptionId,
          runbook.resourceGroupName,
          runbook.accountName,
          jobId
        );
        for (const s of streams) {
          this.outputChannel.appendLine(`[${s.streamType.padEnd(7)}] ${s.value}`);
        }
        if (summary === 'Completed' || summary === 'Failed' || summary === 'Stopped' || summary === 'Suspended') {
          this.outputChannel.appendLine(`[job] Final status for ${jobId}: ${summary}`);
          return;
        }
      } catch (err) {
        this.outputChannel.appendLine(`[job-error] polling ${runbook.name} (${jobId}): ${errMessage(err)}`);
        return;
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    this.outputChannel.appendLine(`[job] Polling timeout for ${jobId} - check Azure portal for final status.`);
  }

  async createRunbook(
    accountName: string,
    resourceGroup: string,
    subscriptionId: string,
    accountLocation: string,
    prefill?: CreateRunbookPrefill
  ): Promise<{ name: string; runbookType: string; runtimeEnvironment?: string } | undefined> {
    const name = await vscode.window.showInputBox({
      title: 'New Runbook Name',
      placeHolder: 'e.g. Cleanup-OldVMs',
      value: prefill?.name ?? '',
      validateInput: v => /^[a-zA-Z][a-zA-Z0-9-_]*$/.test(v) ? null : 'Name must start with a letter and contain only letters, numbers, hyphens, underscores.',
    });
    if (!name) { return; }

    const typeChoices = await getRunbookTypeChoices(this.azure, subscriptionId, resourceGroup, accountName, this.outputChannel);
    const preferredDefault = typeChoices.find(choice => choice.value === 'PowerShell72')
      ?? typeChoices.find(choice => choice.value === 'PowerShell7')
      ?? typeChoices[0];
    // Never let a legacy PowerShell 5.1 prefill override the default for a new runbook.
    const detectedType = prefill?.runbookType && prefill.runbookType.toLowerCase() !== 'powershell'
      ? typeChoices.find(c => c.value.toLowerCase() === prefill.runbookType!.toLowerCase())
      : undefined;
    const selectedDefault = detectedType ?? preferredDefault;
    const orderedTypeChoices = selectedDefault
      ? [
          {
            ...selectedDefault,
            description: detectedType ? 'Detected from local file' : 'Default for new runbooks',
          },
          ...typeChoices.filter(c => c.value !== selectedDefault.value),
        ]
      : typeChoices;
    const typeChoice = await vscode.window.showQuickPick(orderedTypeChoices, {
      title: 'Select Runbook Type',
      placeHolder: detectedType
        ? `Detected type: ${detectedType.label}`
        : selectedDefault
          ? `Default type: ${selectedDefault.label}`
          : undefined,
    });
    if (!typeChoice) { return; }

    const runtimeEnvironment = await promptForRuntimeEnvironment(
      this.azure,
      subscriptionId,
      resourceGroup,
      accountName,
      typeChoice.value,
      this.outputChannel,
      prefill?.runtimeEnvironment
    );

    const description = await vscode.window.showInputBox({
      title: 'Runbook Description (optional)',
      placeHolder: 'What does this runbook do?',
      value: prefill?.description ?? '',
    });

    let created = false;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating ${name}…` },
      async () => {
        try {
          const effectiveRunbookType = runtimeEnvironment
            ? normalizeRunbookTypeForRuntimeEnvironment(typeChoice.value)
            : typeChoice.value;
          await this.azure.createRunbook(
            subscriptionId,
            resourceGroup,
            accountName,
            accountLocation,
            name,
            effectiveRunbookType,
            description ?? '',
            runtimeEnvironment
          );
          this.workspace.setRunbookMeta(accountName, name, effectiveRunbookType, runtimeEnvironment);
          this.outputChannel.appendLine(
            `[create] ${name} (${typeChoice.label}${runtimeEnvironment ? ` · runtime ${runtimeEnvironment}` : ''}) created in ${accountName}`
          );
          created = true;
        } catch (err) {
          this.outputChannel.appendLine(`[create-error] ${name}: ${errMessage(err)}`);
          void vscode.window.showErrorMessage(`Failed to create runbook "${name}": ${errMessage(err)}`);
        }
      }
    );
    return created
      ? {
          name,
          runbookType: runtimeEnvironment ? normalizeRunbookTypeForRuntimeEnvironment(typeChoice.value) : typeChoice.value,
          runtimeEnvironment,
        }
      : undefined;
  }

  async changeRunbookRuntimeEnvironment(runbook: RunbookSummary): Promise<void> {
    const runtimeEnvironment = await promptForRuntimeEnvironment(
      this.azure,
      runbook.subscriptionId,
      runbook.resourceGroupName,
      runbook.accountName,
      runbook.runbookType,
      this.outputChannel,
      runbook.runtimeEnvironment
    );
    if (!runtimeEnvironment) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Updating Runtime Environment for ${runbook.name}…` },
      async () => {
        try {
          await this.azure.updateRunbookRuntimeEnvironment(
            runbook.subscriptionId,
            runbook.resourceGroupName,
            runbook.accountName,
            runbook.name,
            runbook.runbookType,
            runtimeEnvironment
          );
          this.workspace.setRunbookMeta(runbook.accountName, runbook.name, runbook.runbookType, runtimeEnvironment);
          this.outputChannel.appendLine(`[runbook-runtime] ${runbook.name} → ${runtimeEnvironment}`);
          void vscode.window.showInformationMessage(
            `Updated "${runbook.name}" to use Runtime Environment "${runtimeEnvironment}".`
          );
        } catch (err) {
          this.outputChannel.appendLine(`[runbook-runtime-error] ${runbook.name}: ${errMessage(err)}`);
          void vscode.window.showErrorMessage(
            `Failed to update Runtime Environment for "${runbook.name}": ${errMessage(err)}`
          );
        }
      }
    );
  }

  async deleteRunbook(runbook: RunbookSummary): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Delete "${runbook.name}" from Azure? This cannot be undone.`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Deleting ${runbook.name}…` },
      async () => {
        try {
          await this.azure.deleteRunbook(
            runbook.subscriptionId,
            runbook.resourceGroupName,
            runbook.accountName,
            runbook.name
          );
          if (!this.workspace.findRunbookFilePath(runbook.accountName, runbook.name, runbook.runbookType)) {
            this.workspace.removeRunbookMeta(runbook.accountName, runbook.name);
          }
          this.outputChannel.appendLine(`[delete] ${runbook.name} deleted`);
          void vscode.window.showInformationMessage(`"${runbook.name}" deleted.`);
        } catch (err) {
          this.outputChannel.appendLine(`[delete-error] ${runbook.name}: ${errMessage(err)}`);
          void vscode.window.showErrorMessage(`Failed to delete "${runbook.name}": ${errMessage(err)}`);
        }
      }
    );
  }

  async fetchAllForAccount(account: AzureAutomationAccount): Promise<void> {
    const { subscriptionId, resourceGroupName, name: accountName } = account;
    const log = (msg: string) => this.outputChannel.appendLine(msg);
    const sectionStatus: Array<{ section: string; count: number; status: 'fetched' | 'empty' | 'failed'; reason?: string }> = [];
    const replace = (folder: string, items: Array<{ itemName: string; data: object }>) => {
      this.workspace.replaceSectionItemFiles(accountName, folder, items);
    };
    const recordSuccess = (section: string, folder: string, count: number) => {
      this.workspace.markSectionFetched(accountName, folder);
      sectionStatus.push({
        section,
        count,
        status: count > 0 ? 'fetched' : 'empty',
      });
    };
    const recordFailure = (section: string, err: unknown) => {
      sectionStatus.push({
        section,
        count: 0,
        status: 'failed',
        reason: errMessage(err),
      });
    };

    // Fetch runbooks first (shows progress notification)
    await this.fetchAllRunbooks(account);

    // Fetch all other sections in parallel
    await Promise.allSettled([
      this.azure.listSchedules(subscriptionId, resourceGroupName, accountName)
        .then(items => {
          replace('Schedules', items.map(item => ({ itemName: item.name, data: item })));
          recordSuccess('Schedules', 'Schedules', items.length);
          log(`[fetch-all] ${items.length} schedule(s) from ${accountName}`);
        })
        .catch(err => { recordFailure('Schedules', err); log(`[fetch-all-error] schedules ${accountName}: ${errMessage(err)}`); }),

      Promise.all([
        this.azure.listVariables(subscriptionId, resourceGroupName, accountName),
        this.azure.listCredentials(subscriptionId, resourceGroupName, accountName),
        this.azure.listConnections(subscriptionId, resourceGroupName, accountName),
        this.azure.listCertificates(subscriptionId, resourceGroupName, accountName),
      ])
        .then(([variables, credentials, connections, certificates]) => {
          replace('Assets', [
            ...variables.map(item => ({ itemName: item.name, data: { ...item, _type: 'variable' } })),
            ...credentials.map(item => ({ itemName: `cred__${item.name}`, data: { ...item, name: `cred__${item.name}` } })),
            ...connections.map(item => ({ itemName: `conn__${item.name}`, data: { ...item, name: `conn__${item.name}` } })),
            ...certificates.map(item => ({ itemName: `cert__${item.name}`, data: { ...item, name: `cert__${item.name}` } })),
          ]);
          recordSuccess('Variables', 'Assets', variables.length);
          recordSuccess('Credentials', 'Assets', credentials.length);
          recordSuccess('Connections', 'Assets', connections.length);
          recordSuccess('Certificates', 'Assets', certificates.length);
          log(`[fetch-all] ${variables.length} variable(s) from ${accountName}`);
          log(`[fetch-all] ${credentials.length} credential(s) from ${accountName}`);
          log(`[fetch-all] ${connections.length} connection(s) from ${accountName}`);
          log(`[fetch-all] ${certificates.length} certificate(s) from ${accountName}`);
        })
        .catch(err => {
          recordFailure('Variables', err);
          recordFailure('Credentials', err);
          recordFailure('Connections', err);
          recordFailure('Certificates', err);
          log(`[fetch-all-error] assets ${accountName}: ${errMessage(err)}`);
        }),

      this.azure.listImportedModules(subscriptionId, resourceGroupName, accountName)
        .then(items => {
          replace('PowerShellModules', items.map(item => ({ itemName: item.name, data: item })));
          recordSuccess('PowerShell Modules', 'PowerShellModules', items.length);
          log(`[fetch-all] ${items.length} PS module(s) from ${accountName}`);
        })
        .catch(err => { recordFailure('PowerShell Modules', err); log(`[fetch-all-error] PS modules ${accountName}: ${errMessage(err)}`); }),

      this.azure.listPythonPackages(subscriptionId, resourceGroupName, accountName)
        .then(items => {
          replace('PythonPackages', items.map(item => ({ itemName: item.name, data: item })));
          recordSuccess('Python Packages', 'PythonPackages', items.length);
          log(`[fetch-all] ${items.length} Python package(s) from ${accountName}`);
        })
        .catch(err => { recordFailure('Python Packages', err); log(`[fetch-all-error] Python packages ${accountName}: ${errMessage(err)}`); }),

      this.azure.listRuntimeEnvironments(subscriptionId, resourceGroupName, accountName)
        .then(items => {
          replace('RuntimeEnvironments', items.map(item => ({ itemName: item.name, data: item })));
          recordSuccess('Runtime Environments', 'RuntimeEnvironments', items.length);
          log(`[fetch-all] ${items.length} runtime environment(s) from ${accountName}`);
        })
        .catch(err => { recordFailure('Runtime Environments', err); log(`[fetch-all-error] runtime environments ${accountName}: ${errMessage(err)}`); }),

      this.azure.listHybridWorkerGroups(subscriptionId, resourceGroupName, accountName)
        .then(items => {
          replace('HybridWorkerGroups', items.map(item => ({ itemName: item.name, data: item })));
          recordSuccess('Hybrid Worker Groups', 'HybridWorkerGroups', items.length);
          log(`[fetch-all] ${items.length} hybrid worker group(s) from ${accountName}`);
        })
        .catch(err => { recordFailure('Hybrid Worker Groups', err); log(`[fetch-all-error] hybrid worker groups ${accountName}: ${errMessage(err)}`); }),

      this.azure.listRecentJobs(subscriptionId, resourceGroupName, accountName)
        .then(items => {
          replace('RecentJobs', items.map(item => ({ itemName: item.jobId, data: { ...item, name: item.jobId } })));
          recordSuccess('Recent Jobs', 'RecentJobs', items.length);
          log(`[fetch-all] ${items.length} job(s) from ${accountName}`);
        })
        .catch(err => { recordFailure('Recent Jobs', err); log(`[fetch-all-error] jobs ${accountName}: ${errMessage(err)}`); }),
    ]);

    const fetched = sectionStatus.filter(s => s.status === 'fetched');
    const empty = sectionStatus.filter(s => s.status === 'empty');
    const failed = sectionStatus.filter(s => s.status === 'failed');

    const summaryLines = [
      fetched.length > 0
        ? `Fetched: ${fetched.map(s => `${s.section} (${s.count})`).join(', ')}`
        : undefined,
      empty.length > 0
        ? `Empty in Azure: ${empty.map(s => s.section).join(', ')}`
        : undefined,
      failed.length > 0
        ? `Failed: ${failed.map(s => `${s.section}${s.reason ? ` - ${s.reason}` : ''}`).join(' | ')}`
        : undefined,
    ].filter((line): line is string => Boolean(line));

    if (summaryLines.length > 0) {
      log(`[fetch-all-summary] ${accountName}: ${summaryLines.join(' || ')}`);
    }

    if (failed.length > 0) {
      void vscode.window.showWarningMessage(
        `Fetch All finished for "${accountName}". ${summaryLines.join(' ')}`
      );
      return;
    }

    void vscode.window.showInformationMessage(
      `Fetch All finished for "${accountName}". ${summaryLines.join(' ')}`
    );
  }

  async fetchAllRunbooks(account: AzureAutomationAccount): Promise<void> {
    this.workspace.ensureAccountFolder(account.name);
    const runbooks = await this.azure.listRunbooks(account.subscriptionId, account.resourceGroupName, account.name, account.subscriptionName);
    if (runbooks.length === 0) {
      void vscode.window.showInformationMessage(`No runbooks found in "${account.name}".`);
      return;
    }

    let fetched = 0;
    const emptyContentRunbooks: string[] = [];

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Fetching all runbooks from ${account.name}…`, cancellable: false },
      async (progress) => {
        for (const runbook of runbooks) {
          const state = runbook.state.toLowerCase();
          const contentType: 'published' | 'draft' = state === 'published' ? 'published' : 'draft';

          try {
            progress.report({ message: runbook.name, increment: 100 / runbooks.length });
            const content = await this.fetchRunbookContentOrEmpty(runbook, contentType);
            this.workspace.writeRunbookFile(
              runbook.accountName,
              runbook.name,
              runbook.runbookType,
              content,
              undefined,
              runbook.runtimeEnvironment
            );
            if (content.length === 0) {
              emptyContentRunbooks.push(runbook.name);
              this.outputChannel.appendLine(`[fetch-all-warning] ${runbook.name}: no content returned; wrote empty file`);
            } else {
              this.outputChannel.appendLine(`[fetch-all] ${runbook.name}`);
            }
            fetched++;
          } catch (err) {
            this.outputChannel.appendLine(`[fetch-all-error] ${runbook.name}: ${errMessage(err)}`);
          }
        }
        void vscode.window.showInformationMessage(
          `Fetched ${fetched} runbook(s) from "${account.name}".`
        );
        if (emptyContentRunbooks.length > 0) {
          void vscode.window.showWarningMessage(
            `Fetched ${emptyContentRunbooks.length} runbook(s) from "${account.name}" with no content. Empty local files were created for: ${emptyContentRunbooks.join(', ')}`
          );
        }
      }
    );
  }

  async syncRunbooks(account: AzureAutomationAccount): Promise<void> {
    this.workspace.ensureAccountFolder(account.name);
    const remoteRunbooks = await this.azure.listRunbooks(
      account.subscriptionId,
      account.resourceGroupName,
      account.name,
      account.subscriptionName
    );

    const remoteNames = new Set(remoteRunbooks.map(runbook => runbook.name));
    const localRunbooks = this.workspace
      .listWorkspaceRunbooks()
      .filter(runbook => runbook.accountName === account.name);

    const localOnlyRunbooks: string[] = [];
    for (const localRunbook of localRunbooks) {
      if (remoteNames.has(localRunbook.runbookName)) { continue; }
      localOnlyRunbooks.push(localRunbook.runbookName);
      this.outputChannel.appendLine(`[sync-runbooks] Preserved local-only runbook: ${localRunbook.runbookName}`);
    }

    if (remoteRunbooks.length === 0) {
      void vscode.window.showInformationMessage(
        localOnlyRunbooks.length > 0
          ? `Sync finished for "${account.name}". Azure has no runbooks. Preserved ${localOnlyRunbooks.length} local-only runbook(s).`
          : `Sync finished for "${account.name}". Azure has no runbooks.`
      );
      return;
    }

    let fetched = 0;
    const emptyContentRunbooks: string[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Syncing runbooks from ${account.name}…`, cancellable: false },
      async (progress) => {
        for (const runbook of remoteRunbooks) {
          const state = runbook.state.toLowerCase();
          const contentType: 'published' | 'draft' = state === 'published' ? 'published' : 'draft';

          try {
            progress.report({ message: runbook.name, increment: 100 / remoteRunbooks.length });
            const content = await this.fetchRunbookContentOrEmpty(runbook, contentType);
            this.workspace.writeRunbookFile(
              runbook.accountName,
              runbook.name,
              runbook.runbookType,
              content,
              undefined,
              runbook.runtimeEnvironment
            );
            if (content.length === 0) {
              emptyContentRunbooks.push(runbook.name);
              this.outputChannel.appendLine(`[sync-runbooks-warning] ${runbook.name}: no content returned; wrote empty file`);
            } else {
              this.outputChannel.appendLine(`[sync-runbooks] ${runbook.name}`);
            }
            fetched++;
          } catch (err) {
            this.outputChannel.appendLine(`[sync-runbooks-error] ${runbook.name}: ${errMessage(err)}`);
          }
        }
      }
    );

    const summaryParts = [
      `Fetched ${fetched} runbook(s)`,
      localOnlyRunbooks.length > 0 ? `preserved ${localOnlyRunbooks.length} local-only runbook(s)` : undefined,
      emptyContentRunbooks.length > 0 ? `empty in Azure: ${emptyContentRunbooks.join(', ')}` : undefined,
    ].filter((part): part is string => Boolean(part));

    void vscode.window.showInformationMessage(`Sync finished for "${account.name}". ${summaryParts.join('; ')}.`);
    if (localOnlyRunbooks.length > 0) {
      void vscode.window.showWarningMessage(
        `Preserved local-only runbook(s) during sync: ${localOnlyRunbooks.join(', ')}`
      );
    }
  }

  private async fetchRunbookContentOrEmpty(runbook: RunbookSummary, type: 'published' | 'draft'): Promise<string> {
    try {
      return await this.azure.getRunbookContent(
        runbook.subscriptionId,
        runbook.resourceGroupName,
        runbook.accountName,
        runbook.name,
        type
      );
    } catch (err) {
      if (isNoContentError(err)) {
        return '';
      }
      throw err;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function errMessage(err: unknown): string {
  if (err instanceof Error) { return err.message; }
  return String(err);
}

function isNoContentError(err: unknown): boolean {
  return errMessage(err).includes('No content stream returned');
}

async function promptForParameters(title: string): Promise<Record<string, string> | undefined> {
  const raw = await vscode.window.showInputBox({
    title,
    prompt: 'Enter parameters as JSON object, or leave empty',
    placeHolder: '{ "Param1": "value1", "Param2": "value2" }',
    value: '{}',
  });
  if (raw === undefined) { return undefined; }
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch (err) {
    void vscode.window.showErrorMessage(`Invalid JSON for parameters: ${errMessage(err)}`);
    return undefined;
  }
}
