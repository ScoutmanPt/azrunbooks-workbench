import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
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

  // 3. Pick runtime environment (or classic PowerShell modules)
  const runtimeEnv = await pickRuntimeEnvironment(azure, account.subscriptionId, account.resourceGroup, account.accountName, outputChannel);
  if (runtimeEnv === undefined) { return; }   // user cancelled

  // 4. Check if the module is available on PowerShell Gallery
  let psGalleryUrl: string | undefined;
  try {
    psGalleryUrl = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking PowerShell Gallery for "${localModule.name}"…` },
      () => checkPsGalleryModule(localModule.name, localModule.version, outputChannel)
    );
  } catch { /* best-effort */ }

  // 5. Pick staging method
  const stagingItems: Array<{ label: string; description?: string; value: 'psgallery' | 'existing' | 'create' | 'url' }> = [
    ...(psGalleryUrl ? [{
      label: '$(package) Use PowerShell Gallery (direct)',
      description: `v${localModule.version} — no storage account needed`,
      value: 'psgallery' as const,
    }] : []),
    { label: '$(cloud) Use an existing storage account', value: 'existing' as const },
    { label: '$(add) Create a new storage account', value: 'create' as const },
    { label: '$(link) I will provide the URL directly', value: 'url' as const },
  ];
  const stagingMethod = await vscode.window.showQuickPick(stagingItems, {
    title: 'Deploy Module to Azure Automation',
    placeHolder: 'How should the module be staged for Azure to download?',
    ignoreFocusOut: true,
  });
  if (!stagingMethod) { return; }

  outputChannel.appendLine(`\n[deploy-module] Deploying "${localModule.name}" (${localModule.version}) → "${account.accountName}"`);
  void vscode.window.showInformationMessage(`Deploying "${localModule.name}" to "${account.accountName}"…`);

  let contentUri: string;
  let cleanupFn: (() => Promise<void>) | undefined;

  if (stagingMethod.value === 'psgallery') {
    // ── Option 0: PowerShell Gallery direct URL ──────────────────────────────
    contentUri = psGalleryUrl!;
  } else if (stagingMethod.value === 'url') {
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

    // Read zip into memory immediately so the temp dir can be cleaned up safely.
    let zipBuffer: Buffer;
    try {
      zipBuffer = fs.readFileSync(zipPath!);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputChannel.appendLine(`[deploy-module] Failed to read zip at ${zipPath}: ${msg}`);
      outputChannel.show(true);
      void vscode.window.showErrorMessage(`Failed to read module zip: ${msg}`);
      return;
    } finally {
      fs.rmSync(path.dirname(zipPath!), { recursive: true, force: true });
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
          await uploadBlob(sa!.blobEndpoint, sa!.name, key, STAGING_CONTAINER, blobName, zipBuffer, outputChannel);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputChannel.appendLine(`[deploy-module] Staging failed: ${msg}`);
      outputChannel.show(true);
      void vscode.window.showErrorMessage(`Failed to stage module "${localModule.name}": ${msg}`);
      return;
    }
  }

  // 5. Import to Azure Automation (LRO — waits for completion)
  const importTitle = runtimeEnv
    ? `Importing "${localModule.name}" into runtime environment "${runtimeEnv}"… (this may take a few minutes)`
    : `Importing "${localModule.name}" into "${account.accountName}"… (this may take a few minutes)`;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: importTitle },
      () => runtimeEnv
        ? azure.importPackageToRuntimeEnvironment(account.subscriptionId, account.resourceGroup, account.accountName, runtimeEnv, localModule.name, contentUri)
        : azure.importModuleToAutomation(account.subscriptionId, account.resourceGroup, account.accountName, localModule.name, contentUri)
    );
    const dest = runtimeEnv ? `runtime environment "${runtimeEnv}"` : `"${account.accountName}"`;
    void vscode.window.showInformationMessage(`Module "${localModule.name}" successfully imported into ${dest}.`);
    outputChannel.appendLine(`[deploy-module] "${localModule.name}" (${localModule.version}) deployed to ${dest} — done.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[deploy-module] Import failed: ${msg}`);
    outputChannel.show(true);
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

// ── PowerShell Gallery check ────────────────────────────────────────────────

async function checkPsGalleryModule(name: string, version: string, outputChannel: vscode.OutputChannel): Promise<string | undefined> {
  // Use the OData metadata endpoint — reliable GET that returns 200 or 404
  // without triggering a CDN redirect chain (which HEAD does not follow reliably).
  const metaUrl = `https://www.powershellgallery.com/api/v2/Packages(Id='${encodeURIComponent(name)}',Version='${encodeURIComponent(version)}')`;
  const downloadUrl = `https://www.powershellgallery.com/api/v2/package/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(metaUrl, { method: 'GET', signal: controller.signal });
    if (res.ok) {
      outputChannel.appendLine(`[deploy-module] Found "${name}" v${version} on PowerShell Gallery`);
      return downloadUrl;
    }
    outputChannel.appendLine(`[deploy-module] "${name}" v${version} not found on PowerShell Gallery (${res.status})`);
    return undefined;
  } catch (err) {
    outputChannel.appendLine(`[deploy-module] PowerShell Gallery check failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ── Runtime environment selection ────────────────────────────────────────────

/**
 * Returns the selected runtime environment name, an empty string for classic
 * PowerShell modules, or undefined if the user cancelled.
 */
async function pickRuntimeEnvironment(
  azure: AzureService,
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  outputChannel: vscode.OutputChannel
): Promise<string | undefined> {
  let envs: Array<{ name: string; language?: string; version?: string }>;
  try {
    envs = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading runtime environments…' },
      () => azure.listRuntimeEnvironments(subscriptionId, resourceGroup, accountName)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[deploy-module] listRuntimeEnvironments failed: ${msg}`);
    envs = [];
  }

  const items: Array<{ label: string; description?: string; value: string }> = [
    {
      label: '$(gear) Classic PowerShell Modules',
      description: 'Global modules for the Automation Account (pre-runtime environments)',
      value: '',
    },
    ...envs.map(e => ({
      label: e.name,
      description: [e.language, e.version].filter(Boolean).join(' '),
      value: e.name,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Deploy Module to Azure Automation',
    placeHolder: 'Select a runtime environment (or classic modules)',
    ignoreFocusOut: true,
  });

  return picked?.value;
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

let _crc32Table: Uint32Array | undefined;
function crc32(buf: Buffer): number {
  if (!_crc32Table) {
    _crc32Table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) { c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); }
      _crc32Table[i] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) { crc = _crc32Table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8); }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localHeaders: Buffer[] = [];
  const centralDirs: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const uncompressedSize = entry.data.length;
    const compressed = zlib.deflateRawSync(entry.data, { level: 6 });
    const compressedSize = compressed.length;
    const dosDate = 0x5421; // 2022-01-01 placeholder
    const dosTime = 0x0000;

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);   // signature
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // flags: UTF-8
    local.writeUInt16LE(8, 8);             // compression: deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);            // extra length
    nameBytes.copy(local, 30);
    localHeaders.push(local, compressed);

    // Central directory entry
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);  // signature
    central.writeUInt16LE(20, 4);           // version made by
    central.writeUInt16LE(20, 6);           // version needed
    central.writeUInt16LE(0x0800, 8);       // flags: UTF-8
    central.writeUInt16LE(8, 10);           // compression: deflate
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);           // extra length
    central.writeUInt16LE(0, 32);           // comment length
    central.writeUInt16LE(0, 34);           // disk start
    central.writeUInt16LE(0, 36);           // internal attrs
    central.writeUInt32LE(0, 38);           // external attrs
    central.writeUInt32LE(offset, 42);      // local header offset
    nameBytes.copy(central, 46);
    centralDirs.push(central);

    offset += 30 + nameBytes.length + compressedSize;
  }

  const centralOffset = offset;
  const centralBuf = Buffer.concat(centralDirs);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                        // disk number
  eocd.writeUInt16LE(0, 6);                        // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);                       // comment length

  return Buffer.concat([...localHeaders, centralBuf, eocd]);
}

function collectFiles(dir: string, base: string): Array<{ name: string; data: Buffer }> {
  const results: Array<{ name: string; data: Buffer }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const entryName = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, entryName));
    } else if (entry.isFile()) {
      results.push({ name: entryName, data: fs.readFileSync(fullPath) });
    }
  }
  return results;
}

async function zipModuleFolder(sourceDir: string, moduleName: string): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arw-module-'));
  const zipPath = path.join(tmpDir, `${moduleName}.zip`);
  const entries = collectFiles(sourceDir, '');
  const zipBuffer = buildZipBuffer(entries);
  fs.writeFileSync(zipPath, zipBuffer);
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
  // Per Azure docs (API 2015-02-21+): Content-Length must be empty string when 0.
  const contentLengthStr = contentLength === 0 || contentLength === '' ? '' : String(contentLength);
  // canonHeaders must end with \n; each header on its own line joined with \n.
  const canonHeaders = sortedXmsHeaders.join('\n') + '\n';
  const stringToSign =
    [method, '', '', contentLengthStr, '', contentType, '', '', '', '', '', ''].join('\n') +
    '\n' + canonHeaders + canonicalizedResource;

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
