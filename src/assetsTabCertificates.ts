import type { AzureAutomationAccount, AzureService } from './azureService';
import type { CertificateItem, CertificateFormData, TabState } from './assetsShared';
import { esc, csvEsc, formatDt, errMsg, renderTabToolbar } from './assetsShared';

// ── Data loading ──────────────────────────────────────────────────────────────

export async function loadCertificates(
  azure: AzureService,
  account: AzureAutomationAccount
): Promise<TabState<CertificateItem>> {
  try {
    const raw = await azure.listCertificates(account.subscriptionId, account.resourceGroupName, account.name);
    return {
      items: raw.map(c => ({
        name: c.name,
        thumbprint: c.thumbprint,
        expiryTime: c.expiryTime,
        description: c.description,
        isExportable: c.isExportable,
      })),
      loading: false,
    };
  } catch (e) {
    return { items: [], loading: false, error: errMsg(e) };
  }
}

export async function getCertificateEditPrefill(
  azure: AzureService,
  account: AzureAutomationAccount,
  name: string
): Promise<Record<string, unknown>> {
  const c = await azure.getCertificate(account.subscriptionId, account.resourceGroupName, account.name, name);
  return { name: c.name, base64Value: '', isExportable: c.isExportable, description: c.description ?? '' };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function validateCertificateForm(fd: CertificateFormData, mode: 'new' | 'edit'): string | undefined {
  if (!fd.name.trim()) { return 'Name is required.'; }
  if (mode === 'new' && !fd.base64Value.trim()) { return 'Certificate data (base64) is required.'; }
  if (mode === 'edit' && !fd.base64Value.trim()) {
    return 'To update a certificate, provide the base64 certificate data again.';
  }
  return undefined;
}

export async function submitCertificate(
  azure: AzureService,
  account: AzureAutomationAccount,
  fd: CertificateFormData
): Promise<void> {
  await azure.createOrUpdateCertificate(
    account.subscriptionId, account.resourceGroupName, account.name,
    fd.name.trim(), fd.base64Value.trim(), fd.isExportable, fd.description.trim() || undefined
  );
}

export async function deleteCertificate(
  azure: AzureService,
  account: AzureAutomationAccount,
  name: string
): Promise<void> {
  await azure.deleteCertificate(account.subscriptionId, account.resourceGroupName, account.name, name);
}

// ── Grid rendering ────────────────────────────────────────────────────────────

export function renderCertificatesPane(tabState: TabState<CertificateItem>): string {
  const toolbar = renderTabToolbar('certificates');

  if (tabState.error) { return toolbar + `<div class="error-state">Error: ${esc(tabState.error)}</div>`; }
  if (tabState.loading) { return toolbar + '<div class="loading-state">Loading…</div>'; }
  if (tabState.items.length === 0) { return toolbar + '<div class="empty-state">No certificates found.</div>'; }

  const header = `
    <div class="grid-header cols-certs">
      <span><input type="checkbox" id="sel-all-certificates" title="Select all" /></span>
      <span class="cell">Name</span>
      <span class="cell">Thumbprint</span>
      <span class="cell">Expiry</span>
      <span class="cell">Exportable</span>
      <span class="cell">Description</span>
    </div>`;

  const rows = tabState.items.map(c => {
    const search = [c.name, c.thumbprint ?? '', formatDt(c.expiryTime), c.description ?? ''].join(' ').toLowerCase();
    const thumb = c.thumbprint ? c.thumbprint.substring(0, 16) + '…' : '';
    return `
      <div class="grid-row cols-certs" data-tab="certificates" data-name="${esc(c.name)}" data-search="${esc(search)}">
        <span class="cb-col"><input type="checkbox" class="row-cb" value="${esc(c.name)}" /></span>
        <span class="cell cell-name">${esc(c.name)}</span>
        <span class="cell cell-muted" style="font-family:monospace;font-size:11px">${esc(thumb)}</span>
        <span class="cell cell-muted">${esc(formatDt(c.expiryTime))}</span>
        <span class="cell">${c.isExportable ? '<span class="cell-tag">Yes</span>' : ''}</span>
        <span class="cell cell-muted">${esc(c.description ?? '')}</span>
      </div>`;
  }).join('');

  return toolbar + `<div class="grid-container">${header}${rows}</div>`;
}

// ── Form rendering ────────────────────────────────────────────────────────────

export function renderCertificatesFormBody(prefill: Record<string, unknown>, isEdit: boolean): string {
  const name       = isEdit ? esc(String(prefill['name']        ?? '')) : '';
  const exportable = isEdit ? prefill['isExportable'] === true : false;
  const desc       = isEdit ? esc(String(prefill['description'] ?? '')) : '';

  return `
    <div class="form-field">
      <label class="form-label required">Name</label>
      <input class="form-input" id="f-name" type="text" value="${name}" ${isEdit ? 'readonly' : ''} placeholder="CertificateName" />
    </div>
    <div class="form-field">
      <label class="form-label${isEdit ? '' : ' required'}">Certificate (Base64)</label>
      <textarea class="form-textarea" id="f-base64" rows="5"
        placeholder="${isEdit ? 'Paste new base64 certificate data to update' : 'Paste base64-encoded certificate (.cer/.pfx)'}"></textarea>
    </div>
    <div class="form-field">
      <div class="form-check-row">
        <input type="checkbox" id="f-exportable" ${exportable ? 'checked' : ''} />
        <label for="f-exportable">Exportable</label>
      </div>
    </div>
    <div class="form-field">
      <label class="form-label">Description</label>
      <input class="form-input" id="f-description" type="text" value="${desc}" placeholder="Optional description" />
    </div>`;
}

export function renderCertificatesSubmitButton(isEdit: boolean): string {
  return `<button class="btn btn-primary" id="f-submit-certificate">${isEdit ? 'Save' : 'Create'}</button>`;
}

export const CERTIFICATES_FORM_SCRIPT = `
  document.getElementById('f-submit-certificate')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'submitCertificateForm', formData: {
      name:        document.getElementById('f-name')?.value        || '',
      base64Value: document.getElementById('f-base64')?.value      || '',
      isExportable: document.getElementById('f-exportable')?.checked || false,
      description: document.getElementById('f-description')?.value || '',
    }});
  });`;

// ── Export helpers ────────────────────────────────────────────────────────────

export const CERTIFICATES_CSV_HEADER = 'Name,Thumbprint,Expiry,Exportable,Description';

export function certificatesCsvRows(items: CertificateItem[]): string[] {
  return items.map(c =>
    [c.name, c.thumbprint ?? '', formatDt(c.expiryTime), c.isExportable ? 'Yes' : 'No', c.description ?? '']
      .map(csvEsc).join(',')
  );
}

export const CERTIFICATES_EXPORT_HEADERS = ['Name', 'Thumbprint', 'Expiry', 'Exportable', 'Description'];

export function certificatesExportRows(items: CertificateItem[]): string[][] {
  return items.map(c => [c.name, c.thumbprint ?? '', formatDt(c.expiryTime), c.isExportable ? 'Yes' : 'No', c.description ?? '']);
}
