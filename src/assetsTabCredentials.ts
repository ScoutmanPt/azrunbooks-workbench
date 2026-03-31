import type { AzureAutomationAccount, AzureService } from './azureService';
import type { CredentialItem, CredentialFormData, TabState } from './assetsShared';
import { esc, csvEsc, errMsg, renderTabToolbar } from './assetsShared';

// ── Data loading ──────────────────────────────────────────────────────────────

export async function loadCredentials(
  azure: AzureService,
  account: AzureAutomationAccount
): Promise<TabState<CredentialItem>> {
  try {
    const raw = await azure.listCredentials(account.subscriptionId, account.resourceGroupName, account.name);
    return { items: raw.map(c => ({ name: c.name, userName: c.userName, description: c.description })), loading: false };
  } catch (e) {
    return { items: [], loading: false, error: errMsg(e) };
  }
}

export async function getCredentialEditPrefill(
  azure: AzureService,
  account: AzureAutomationAccount,
  name: string
): Promise<Record<string, unknown>> {
  const c = await azure.getCredential(account.subscriptionId, account.resourceGroupName, account.name, name);
  return { name: c.name, userName: c.userName ?? '', password: '', description: c.description ?? '' };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function validateCredentialForm(fd: CredentialFormData, mode: 'new' | 'edit'): string | undefined {
  if (!fd.name.trim()) { return 'Name is required.'; }
  if (mode === 'new' && !fd.password) { return 'Password is required.'; }
  return undefined;
}

export async function submitCredential(
  azure: AzureService,
  account: AzureAutomationAccount,
  fd: CredentialFormData,
  mode: 'new' | 'edit'
): Promise<void> {
  if (mode === 'edit' && !fd.password) {
    await azure.updateCredential(
      account.subscriptionId, account.resourceGroupName, account.name,
      fd.name.trim(), fd.userName, undefined, fd.description.trim() || undefined
    );
  } else {
    await azure.createOrUpdateCredential(
      account.subscriptionId, account.resourceGroupName, account.name,
      fd.name.trim(), fd.userName, fd.password, fd.description.trim() || undefined
    );
  }
}

export async function deleteCredential(
  azure: AzureService,
  account: AzureAutomationAccount,
  name: string
): Promise<void> {
  await azure.deleteCredential(account.subscriptionId, account.resourceGroupName, account.name, name);
}

// ── Grid rendering ────────────────────────────────────────────────────────────

export function renderCredentialsPane(tabState: TabState<CredentialItem>): string {
  const toolbar = renderTabToolbar('credentials');

  if (tabState.error) { return toolbar + `<div class="error-state">Error: ${esc(tabState.error)}</div>`; }
  if (tabState.loading) { return toolbar + '<div class="loading-state">Loading…</div>'; }
  if (tabState.items.length === 0) { return toolbar + '<div class="empty-state">No credentials found.</div>'; }

  const header = `
    <div class="grid-header cols-creds">
      <span><input type="checkbox" id="sel-all-credentials" title="Select all" /></span>
      <span class="cell">Name</span>
      <span class="cell">Username</span>
      <span class="cell">Description</span>
    </div>`;

  const rows = tabState.items.map(c => {
    const search = [c.name, c.userName ?? '', c.description ?? ''].join(' ').toLowerCase();
    return `
      <div class="grid-row cols-creds" data-tab="credentials" data-name="${esc(c.name)}" data-search="${esc(search)}">
        <span class="cb-col"><input type="checkbox" class="row-cb" value="${esc(c.name)}" /></span>
        <span class="cell cell-name">${esc(c.name)}</span>
        <span class="cell cell-muted">${esc(c.userName ?? '')}</span>
        <span class="cell cell-muted">${esc(c.description ?? '')}</span>
      </div>`;
  }).join('');

  return toolbar + `<div class="grid-container">${header}${rows}</div>`;
}

// ── Form rendering ────────────────────────────────────────────────────────────

export function renderCredentialsFormBody(prefill: Record<string, unknown>, isEdit: boolean): string {
  const name     = isEdit ? esc(String(prefill['name']        ?? '')) : '';
  const userName = isEdit ? esc(String(prefill['userName']    ?? '')) : '';
  const desc     = isEdit ? esc(String(prefill['description'] ?? '')) : '';

  return `
    <div class="form-field">
      <label class="form-label required">Name</label>
      <input class="form-input" id="f-name" type="text" value="${name}" ${isEdit ? 'readonly' : ''} placeholder="CredentialName" />
    </div>
    <div class="form-field">
      <label class="form-label required">Username</label>
      <input class="form-input" id="f-username" type="text" value="${userName}" placeholder="user@example.com" />
    </div>
    <div class="form-field">
      <label class="form-label${isEdit ? '' : ' required'}">Password</label>
      <input class="form-input" id="f-password" type="password"
        placeholder="${isEdit ? 'Leave blank to keep current' : 'Password'}" />
    </div>
    <div class="form-field">
      <label class="form-label">Description</label>
      <input class="form-input" id="f-description" type="text" value="${desc}" placeholder="Optional description" />
    </div>`;
}

export function renderCredentialsSubmitButton(isEdit: boolean): string {
  return `<button class="btn btn-primary" id="f-submit-credential">${isEdit ? 'Save' : 'Create'}</button>`;
}

export const CREDENTIALS_FORM_SCRIPT = `
  document.getElementById('f-submit-credential')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'submitCredentialForm', formData: {
      name:        document.getElementById('f-name')?.value      || '',
      userName:    document.getElementById('f-username')?.value  || '',
      password:    document.getElementById('f-password')?.value  || '',
      description: document.getElementById('f-description')?.value || '',
    }});
  });`;

// ── Export helpers ────────────────────────────────────────────────────────────

export const CREDENTIALS_CSV_HEADER = 'Name,Username,Description';

export function credentialsCsvRows(items: CredentialItem[]): string[] {
  return items.map(c => [c.name, c.userName ?? '', c.description ?? ''].map(csvEsc).join(','));
}

export const CREDENTIALS_EXPORT_HEADERS = ['Name', 'Username', 'Description'];

export function credentialsExportRows(items: CredentialItem[]): string[][] {
  return items.map(c => [c.name, c.userName ?? '', c.description ?? '']);
}
