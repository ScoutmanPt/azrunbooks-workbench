import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AuthManager } from './authManager';
import type { AzureService } from './azureService';
import type { WorkspaceManager } from './workspaceManager';

const BLOB_API_VERSION = '2021-08-06';
const STAGING_CONTAINER = 'arw-modules';

// ── Entry point ───────────────────────────────────────────────────────────────

export async function executeDeployModuleToAzure(
  item: unknown,
  auth: AuthManager,
  azure: AzureService,
  workspace: WorkspaceManager,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  // 1. Resolve which local module to deploy
  const localModule = await resolveLocalModule(item, workspace);
  if (!localModule) { return; }

  // 2. Pick target linked Automation Account
  const account = await pickLinkedAccount(workspace);
  if (!account) { return; }

  // 3. Pick staging method
  const stagingMethod = await vscode.window.showQuickPick(
    [
      { label: '$(cloud) Use an existing storage account', value: 'existing' as const },
      { label: '$(add) Create a new storage account', value: 'create' as const },
      { label: '$(link) I will provide the URL directly', value: 'url' as const },
    ],
    {
      title: 'Deploy Module to Azure Automation',
      placeHolder: 'How should the module be staged for Azure to download?',
      ignoreFocusOut: true,
    }
  );
  if (!stagingMethod) { return; }

  outputChannel.appendLine(`\n[deploy-module] Deploying "${localModule.name}" (${localModule.version}) → "${account.accountName}"`);

  let contentUri: string;
  let cleanupFn: (() => Promise<void>) | undefined;

  if (stagingMethod.value === 'url') {
    // ── Option 3: user-provided URL ─────────────────────────────────────────
    const url = await vscode.window.showInputBox({
      title: 'Deploy Module to Azure Automation',
      prompt: 'Enter a URL to the module .zip accessible by Azure (e.g. a blob SAS URL or public raw URL)',
      placeHolder: 'https://...',
      ignoreFocusOut: true,
    });
    if (!url?.trim()) { return; }
    contentUri = url.trim();
  } else {
    // ── Options 1 & 2: storage account staging ──────────────────────────────
    let zipPath: string | undefined;
    try {
      zipPath = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Packaging "${localModule.name}"…` },
        () => zipModuleFolder(localModule.dir, localModule.name)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputChannel.appendLine(`[deploy-module] Zip failed: ${msg}`);
      void vscode.window.showErrorMessage(`Failed to package module "${localModule.name}": ${msg}`);
      return;
    }

    try {
      // Get or create storage account
      let sa: { name: string; resourceGroup: string; blobEndpoint: string } | undefined;
      if (stagingMethod.value === 'create') {
        sa = await createAndPickStorageAccount(azure, auth, account.subscriptionId, outputChannel);
      } else {
        sa = await pickExistingStorageAccount(azure, auth, account.subscriptionId, outputChannel);
      }
      if (!sa) { return; }

      // Get account key
      const key = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Retrieving storage account key…' },
        () => azure.getStorageAccountKey(account.subscriptionId, sa!.resourceGroup, sa!.name)
      );

      // Upload blob and build SAS URL
      const blobName = `${localModule.name}-${localModule.version}-${Date.now()}.zip`;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Uploading module zip to storage…` },
        async () => {
          await ensureBlobContainer(sa!.blobEndpoint, sa!.name, key, STAGING_CONTAINER, outputChannel);
          await uploadBlob(sa!.blobEndpoint, sa!.name, key, STAGING_CONTAINER, blobName, fs.readFileSync(zipPath!), outputChannel);
        }
      );

      contentUri = generateServiceSasUrl(sa.name, key, STAGING_CONTAINER, blobName, sa.blobEndpoint);
      outputChannel.appendLine(`[deploy-module] Staged at: ${sa.blobEndpoint}/${STAGING_CONTAINER}/${blobName}`);

      cleanupFn = async () => {
        try {
          await deleteBlob(sa!.blobEndpoint, sa!.name, key, STAGING_CONTAINER, blobName);
          outputChannel.appendLine(`[deploy-module] Cleaned up staging blob "${blobName}"`);
        } catch (err) {
          outputChannel.appendLine(`[deploy-module] Warning: could not clean up staging blob: ${err instanceof Error ? err.message : err}`);
        }
      };
    } finally {
      if (zipPath) { fs.rmSync(path.dirname(zipPath), { recursive: true, force: true }); }
    }
  }

  // 4. Import to Azure Automation (LRO — waits for completion)
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Importing "${localModule.name}" into "${account.accountName}"… (this may take a few minutes)` },
      () => azure.importModuleToAutomation(account.subscriptionId, account.resourceGroup, account.accountName, localModule.name, contentUri)
    );
    void vscode.window.showInformationMessage(`Module "${localModule.name}" successfully imported into "${account.accountName}".`);
    outputChannel.appendLine(`[deploy-module] Import complete.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[deploy-module] Import failed: ${msg}`);
    void vscode.window.showErrorMessage(`Failed to import module "${localModule.name}" into Azure Automation: ${msg}`);
  } finally {
    await cleanupFn?.();
  }
}

// ── Local module resolution ───────────────────────────────────────────────────

async function resolveLocalModule(
  item: unknown,
  workspace: WorkspaceManager
): Promise<{ name: string; version: string; dir: string } | undefined> {
  const localModulesDir = workspace.localModulesDir;

  // Pre-selected hint from the Assets panel webview
  if (item && typeof item === 'object' && 'moduleName' in item && typeof (item as { moduleName: unknown }).moduleName === 'string') {
    const moduleName = (item as { moduleName: string }).moduleName;
    const moduleRoot = path.join(localModulesDir, moduleName);
    const version = latestVersion(moduleRoot);
    if (version) {
      return { name: moduleName, version, dir: path.join(moduleRoot, version) };
    }
  }

  // Try to infer from file explorer right-click (module folder or file inside it)
  if (item instanceof vscode.Uri) {
    const rel = path.relative(localModulesDir, item.fsPath);
    const parts = rel.split(path.sep).filter(Boolean);
    if (parts.length >= 1 && !parts[0].startsWith('..')) {
      const moduleName = parts[0];
      const moduleRoot = path.join(localModulesDir, moduleName);
      const version = latestVersion(moduleRoot);
      if (version) {
        return { name: moduleName, version, dir: path.join(moduleRoot, version) };
      }
    }
  }

  // Fall back to QuickPick
  if (!fs.existsSync(localModulesDir)) {
    void vscode.window.showErrorMessage('No local modules found in .settings/cache/modules. Install or import a module first.');
    return undefined;
  }

  const modules = fs.readdirSync(localModulesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .flatMap(e => {
      const moduleRoot = path.join(localModulesDir, e.name);
      const version = latestVersion(moduleRoot);
      return version ? [{ name: e.name, version, dir: path.join(moduleRoot, version) }] : [];
    });

  if (!modules.length) {
    void vscode.window.showErrorMessage('No local modules found in .settings/cache/modules. Install or import a module first.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    modules.map(m => ({ label: m.name, description: `v${m.version}`, module: m })),
    { title: 'Deploy Module to Azure Automation', placeHolder: 'Select the local module to deploy', ignoreFocusOut: true }
  );
  return picked?.module;
}

function latestVersion(moduleRoot: string): string | undefined {
  if (!fs.existsSync(moduleRoot)) { return undefined; }
  const versions = fs.readdirSync(moduleRoot, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
  return versions[0];
}

// ── Account selection ─────────────────────────────────────────────────────────

async function pickLinkedAccount(workspace: WorkspaceManager) {
  const accounts = workspace.getLinkedAccounts();
  if (!accounts.length) {
    void vscode.window.showErrorMessage('No linked Automation Accounts. Link an account to this workspace first.');
    return undefined;
  }
  if (accounts.length === 1) { return accounts[0]; }
  const picked = await vscode.window.showQuickPick(
    accounts.map(a => ({ label: a.accountName, description: `${a.subscriptionName} · ${a.resourceGroup}`, account: a })),
    { title: 'Deploy Module to Azure Automation', placeHolder: 'Select the target Automation Account', ignoreFocusOut: true }
  );
  return picked?.account;
}

// ── Storage account helpers ───────────────────────────────────────────────────

async function pickExistingStorageAccount(
  azure: AzureService,
  auth: AuthManager,
  subscriptionId: string,
  outputChannel: vscode.OutputChannel
): Promise<{ name: string; resourceGroup: string; blobEndpoint: string } | undefined> {
  let accounts: Array<{ name: string; resourceGroup: string }>;
  try {
    accounts = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading storage accounts…' },
      () => azure.listStorageAccounts(subscriptionId)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[deploy-module] listStorageAccounts failed: ${msg}`);
    void vscode.window.showErrorMessage(`Failed to list storage accounts: ${msg}`);
    return undefined;
  }

  if (!accounts.length) {
    void vscode.window.showWarningMessage('No storage accounts found in this subscription. Use "Create a new storage account" instead.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    accounts.map(a => ({ label: a.name, description: a.resourceGroup, account: a })),
    { title: 'Deploy Module to Azure Automation', placeHolder: 'Select a storage account for staging the module zip', ignoreFocusOut: true }
  );
  if (!picked) { return undefined; }

  return {
    name: picked.account.name,
    resourceGroup: picked.account.resourceGroup,
    blobEndpoint: auth.getBlobEndpointBase(picked.account.name),
  };
}

async function createAndPickStorageAccount(
  azure: AzureService,
  auth: AuthManager,
  subscriptionId: string,
  outputChannel: vscode.OutputChannel
): Promise<{ name: string; resourceGroup: string; blobEndpoint: string } | undefined> {
  // Pick resource group
  let resourceGroups: Array<{ name: string; location: string }>;
  try {
    resourceGroups = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading resource groups…' },
      () => azure.listResourceGroups(subscriptionId)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Failed to list resource groups: ${msg}`);
    return undefined;
  }

  if (!resourceGroups.length) {
    void vscode.window.showErrorMessage('No resource groups found in this subscription.');
    return undefined;
  }

  const pickedRg = await vscode.window.showQuickPick(
    resourceGroups.map(rg => ({ label: rg.name, description: rg.location, rg })),
    { title: 'Create Storage Account', placeHolder: 'Select a resource group', ignoreFocusOut: true }
  );
  if (!pickedRg) { return undefined; }

  // Enter storage account name
  const saName = await vscode.window.showInputBox({
    title: 'Create Storage Account',
    prompt: 'Storage account name (3–24 lowercase letters and numbers, must be globally unique)',
    placeHolder: 'mymodulestaging',
    validateInput: v => {
      if (!v || !/^[a-z0-9]{3,24}$/.test(v)) { return 'Must be 3–24 lowercase letters and numbers only'; }
      return undefined;
    },
    ignoreFocusOut: true,
  });
  if (!saName?.trim()) { return undefined; }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating storage account "${saName}"… (this may take up to a minute)` },
      () => azure.createStorageAccount(subscriptionId, pickedRg.rg.name, saName, pickedRg.rg.location)
    );
    outputChannel.appendLine(`[deploy-module] Created storage account "${saName}" in "${pickedRg.rg.name}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[deploy-module] createStorageAccount failed: ${msg}`);
    void vscode.window.showErrorMessage(`Failed to create storage account "${saName}": ${msg}`);
    return undefined;
  }

  return {
    name: saName,
    resourceGroup: pickedRg.rg.name,
    blobEndpoint: auth.getBlobEndpointBase(saName),
  };
}

// ── Zip packaging ─────────────────────────────────────────────────────────────

async function zipModuleFolder(sourceDir: string, moduleName: string): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arw-module-'));
  const zipPath = path.join(tmpDir, `${moduleName}.zip`);

  await new Promise<void>((resolve, reject) => {
    // pwsh is required by the extension for local run/debug — safe to rely on here
    const psCmd = `Compress-Archive -Path '${sourceDir.replace(/'/g, "''")}${path.sep}*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    const child = cp.spawn('pwsh', ['-NoLogo', '-NonInteractive', '-Command', psCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) { resolve(); }
      else { reject(new Error(stderr.trim() || `pwsh Compress-Archive exited with code ${code}`)); }
    });
  });

  return zipPath;
}

// ── Blob storage operations ───────────────────────────────────────────────────

function sharedKeyHeader(
  accountName: string,
  accountKey: string,
  method: string,
  contentLength: number | '',
  contentType: string,
  xmsDate: string,
  sortedXmsHeaders: string[], // each "header-name:value" (no newline), already sorted
  canonicalizedResource: string
): string {
  const canonHeaders = sortedXmsHeaders.map(h => `${h}\n`).join('');
  const stringToSign = [
    method,
    '',               // Content-Encoding
    '',               // Content-Language
    String(contentLength),
    '',               // Content-MD5
    contentType,
    '',               // Date (using x-ms-date)
    '',               // If-Modified-Since
    '',               // If-Match
    '',               // If-None-Match
    '',               // If-Unmodified-Since
    '',               // Range
    canonHeaders,
    canonicalizedResource,
  ].join('\n');

  const sig = crypto
    .createHmac('sha256', Buffer.from(accountKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');

  return `SharedKey ${accountName}:${sig}`;
}

async function ensureBlobContainer(
  blobEndpoint: string,
  accountName: string,
  accountKey: string,
  containerName: string,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const url = `${blobEndpoint}/${containerName}?restype=container`;
  const xmsDate = new Date().toUTCString();
  const auth = sharedKeyHeader(
    accountName, accountKey, 'PUT', 0, '', xmsDate,
    [`x-ms-date:${xmsDate}`, `x-ms-version:${BLOB_API_VERSION}`],
    `/${accountName}/${containerName}\nrestype:container`
  );

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: auth,
      'x-ms-date': xmsDate,
      'x-ms-version': BLOB_API_VERSION,
      'Content-Length': '0',
    },
  });

  if (res.status === 201) {
    outputChannel.appendLine(`[deploy-module] Created blob container "${containerName}"`);
  } else if (res.status === 409) {
    // Container already exists — fine
  } else {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to create/access blob container: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
  }
}

async function uploadBlob(
  blobEndpoint: string,
  accountName: string,
  accountKey: string,
  containerName: string,
  blobName: string,
  data: Buffer,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const url = `${blobEndpoint}/${containerName}/${encodeURIComponent(blobName)}`;
  const xmsDate = new Date().toUTCString();
  const contentType = 'application/zip';
  const auth = sharedKeyHeader(
    accountName, accountKey, 'PUT', data.length, contentType, xmsDate,
    [`x-ms-blob-type:BlockBlob`, `x-ms-date:${xmsDate}`, `x-ms-version:${BLOB_API_VERSION}`],
    `/${accountName}/${containerName}/${blobName}`
  );

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: auth,
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-date': xmsDate,
      'x-ms-version': BLOB_API_VERSION,
      'Content-Type': contentType,
      'Content-Length': String(data.length),
    },
    body: data,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Blob upload failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
  }
  outputChannel.appendLine(`[deploy-module] Uploaded "${blobName}" (${data.length} bytes)`);
}

function generateServiceSasUrl(
  accountName: string,
  accountKey: string,
  containerName: string,
  blobName: string,
  blobEndpoint: string
): string {
  const signedVersion = BLOB_API_VERSION;
  const expiry = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2-hour window
  const expiryStr = expiry.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const canonResource = `/blob/${accountName}/${containerName}/${blobName}`;

  // Service SAS string-to-sign (version 2020-04-08+)
  const stringToSign = [
    'r',            // signedPermissions: read
    '',             // signedStart
    expiryStr,      // signedExpiry
    canonResource,
    '',             // signedIdentifier
    '',             // signedIP
    'https',        // signedProtocol
    signedVersion,  // signedVersion
    'b',            // signedResource: blob
    '',             // signedSnapshotTime
    '',             // signedEncryptionScope
    '',             // rscc
    '',             // rscd
    '',             // rsce
    '',             // rscl
    '',             // rsct
  ].join('\n');

  const sig = crypto
    .createHmac('sha256', Buffer.from(accountKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');

  const params = new URLSearchParams({
    sv: signedVersion,
    sr: 'b',
    sp: 'r',
    se: expiryStr,
    spr: 'https',
    sig,
  });

  return `${blobEndpoint}/${containerName}/${encodeURIComponent(blobName)}?${params.toString()}`;
}

async function deleteBlob(
  blobEndpoint: string,
  accountName: string,
  accountKey: string,
  containerName: string,
  blobName: string
): Promise<void> {
  const url = `${blobEndpoint}/${containerName}/${encodeURIComponent(blobName)}`;
  const xmsDate = new Date().toUTCString();
  const auth = sharedKeyHeader(
    accountName, accountKey, 'DELETE', '', '', xmsDate,
    [`x-ms-date:${xmsDate}`, `x-ms-version:${BLOB_API_VERSION}`],
    `/${accountName}/${containerName}/${blobName}`
  );

  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: auth,
      'x-ms-date': xmsDate,
      'x-ms-version': BLOB_API_VERSION,
    },
  });

  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`Blob delete failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
  }
}
