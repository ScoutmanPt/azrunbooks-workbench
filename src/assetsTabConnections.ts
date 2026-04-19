import type { AzureAutomationAccount, AzureService } from './azureService';
import type { ConnectionItem, ConnectionFormData, TabState } from './assetsShared';
import { esc, csvEsc, errMsg, renderTabToolbar } from './assetsShared';

// ── Data loading ──────────────────────────────────────────────────────────────

export async function loadConnections(
  azure: AzureService,
  account: AzureAutomationAccount
): Promise<TabState<ConnectionItem>> {
  try {
    const raw = await azure.listConnections(account.subscriptionId, account.resourceGroupName, account.name);
    return { items: raw.map(c => ({ name: c.name, connectionType: c.connectionType, description: c.description })), loading: false };
  } catch (e) {
    return { items: [], loading: false, error: errMsg(e) };
  }
}

export async function getConnectionEditPrefill(
  azure: AzureService,
  account: AzureAutomationAccount,
  name: string
): Promise<Record<string, unknown>> {
  const c = await azure.getConnection(account.subscriptionId, account.resourceGroupName, account.name, name);
  return { name: c.name, connectionType: c.connectionType ?? '', description: c.description ?? '', fieldValues: c.fieldValues };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function validateConnectionForm(fd: ConnectionFormData): string | undefined {
  if (!fd.name.trim()) { return 'Name is required.'; }
  if (!fd.connectionType.trim()) { return 'Connection type is required.'; }
  return undefined;
}

export async function submitConnection(
  azure: AzureService,
  account: AzureAutomationAccount,
  fd: ConnectionFormData
): Promise<void> {
  const fieldMap: Record<string, string> = {};
  fd.fieldKeys.forEach((k, i) => { if (k.trim()) { fieldMap[k.trim()] = fd.fieldValues[i] ?? ''; } });
  await azure.createOrUpdateConnection(
    account.subscriptionId, account.resourceGroupName, account.name,
    fd.name.trim(), fd.connectionType.trim(), fieldMap, fd.description.trim() || undefined
  );
}

export async function deleteConnection(
  azure: AzureService,
  account: AzureAutomationAccount,
  name: string
): Promise<void> {
  await azure.deleteConnection(account.subscriptionId, account.resourceGroupName, account.name, name);
}

// ── Grid rendering ────────────────────────────────────────────────────────────

export function renderConnectionsPane(tabState: TabState<ConnectionItem>): string {
  const toolbar = renderTabToolbar('connections');

  if (tabState.error) { return toolbar + `<div class="error-state">Error: ${esc(tabState.error)}</div>`; }
  if (tabState.loading) { return toolbar + '<div class="loading-state">Loading…</div>'; }
  if (tabState.items.length === 0) { return toolbar + '<div class="empty-state">No connections found.</div>'; }

  const header = `
    <div class="grid-header cols-conns">
      <span><input type="checkbox" id="sel-all-connections" title="Select all" /></span>
      <span class="cell">Name</span>
      <span class="cell">Connection Type</span>
      <span class="cell">Description</span>
    </div>`;

  const rows = tabState.items.map(c => {
    const search = [c.name, c.connectionType ?? '', c.description ?? ''].join(' ').toLowerCase();
    return `
      <div class="grid-row cols-conns" data-tab="connections" data-name="${esc(c.name)}" data-search="${esc(search)}">
        <span class="cb-col"><input type="checkbox" class="row-cb" value="${esc(c.name)}" /></span>
        <span class="cell cell-name">${esc(c.name)}</span>
        <span class="cell"><span class="cell-tag">${esc(c.connectionType ?? 'Unknown')}</span></span>
        <span class="cell cell-muted">${esc(c.description ?? '')}</span>
      </div>`;
  }).join('');

  return toolbar + `<div class="grid-container">${header}${rows}</div>`;
}

// ── Form rendering ────────────────────────────────────────────────────────────

const CONNECTION_TYPE_FIELDS: Record<string, string[]> = {
  'Azure':                    ['AutomationCertificateName', 'SubscriptionID'],
  'AzureClassicCertificate':  ['SubscriptionName', 'SubscriptionId', 'CertificateAssetName'],
  'AzureServicePrincipal':    ['ApplicationId', 'TenantId', 'CertificateThumbprint', 'SubscriptionId'],
};

export function renderConnectionsFormBody(prefill: Record<string, unknown>, isEdit: boolean): string {
  const name     = esc(String(prefill['name']           ?? ''));
  const connType = esc(String(prefill['connectionType'] ?? ''));
  const desc     = esc(String(prefill['description']    ?? ''));

  // Normalise field values into a Record regardless of source (Azure API object vs error-restore arrays)
  let fieldVals: Record<string, string> = {};
  if (prefill['fieldValues'] && !Array.isArray(prefill['fieldValues'])) {
    fieldVals = prefill['fieldValues'] as Record<string, string>;
  } else if (Array.isArray(prefill['fieldKeys'])) {
    const keys = prefill['fieldKeys'] as string[];
    const vals = Array.isArray(prefill['fieldValues']) ? prefill['fieldValues'] as string[] : [];
    keys.forEach((k, i) => { if (k) { fieldVals[k] = vals[i] ?? ''; } });
  }

  // ── Field section for new connections ─────────────────────────────────────
  const typedFieldSections = isEdit ? '' : Object.entries(CONNECTION_TYPE_FIELDS).map(([type, fields]) => `
    <div id="fields-${type}" class="type-fields"${connType !== type ? ' style="display:none"' : ''}>
      ${fields.map(f => `
      <div class="form-field">
        <label class="form-label required">${esc(f)}</label>
        <input class="form-input typed-field" data-key="${esc(f)}" type="text"
          value="${esc(fieldVals[f] ?? '')}" placeholder="${esc(f)}" />
      </div>`).join('')}
    </div>`).join('');

  // ── Generic key/value rows for edit mode ──────────────────────────────────
  const existingRows = Object.entries(fieldVals).map(([k, v]) => `
    <div class="field-row">
      <input class="form-input field-key" value="${esc(k)}" placeholder="Key" />
      <input class="form-input field-val" value="${esc(v)}" placeholder="Value" />
      <button class="field-row-btn" type="button" title="Remove">&times;</button>
    </div>`).join('');

  const emptyRow = `
    <div class="field-row">
      <input class="form-input field-key" placeholder="Key" />
      <input class="form-input field-val" placeholder="Value" />
      <button class="field-row-btn" type="button" title="Remove">&times;</button>
    </div>`;

  const genericFieldRows = `
    <div class="form-field">
      <label class="form-label">Field Values</label>
      <div class="field-rows" id="field-rows-container">${Object.keys(fieldVals).length > 0 ? existingRows : emptyRow}</div>
      <button class="add-field-btn" id="add-field-row" type="button">+ Add field</button>
    </div>`;

  return `
    <div class="form-field">
      <label class="form-label required">Name</label>
      <input class="form-input" id="f-name" type="text" value="${name}" ${isEdit ? 'readonly' : ''} placeholder="ConnectionName" />
    </div>
    <div class="form-field">
      <label class="form-label required">Connection Type</label>
      ${isEdit
        ? `<input class="form-input" id="f-conn-type" type="text" value="${connType}" readonly />`
        : `<select class="form-input" id="f-conn-type">
        <option value="" disabled ${connType === '' ? 'selected' : ''}>Select a connection type...</option>
        <option value="Azure" ${connType === 'Azure' ? 'selected' : ''}>Azure</option>
        <option value="AzureClassicCertificate" ${connType === 'AzureClassicCertificate' ? 'selected' : ''}>AzureClassicCertificate</option>
        <option value="AzureServicePrincipal" ${connType === 'AzureServicePrincipal' ? 'selected' : ''}>AzureServicePrincipal</option>
      </select>`}
    </div>
    <div class="form-field">
      <label class="form-label">Description</label>
      <input class="form-input" id="f-description" type="text" value="${desc}" placeholder="Optional description" />
    </div>
    ${isEdit ? genericFieldRows : `<div id="typed-fields-wrapper">${typedFieldSections}</div>`}`;
}

export function renderConnectionsSubmitButton(isEdit: boolean): string {
  return `<button class="btn btn-primary" id="f-submit-connection">${isEdit ? 'Save' : 'Create'}</button>`;
}

export const CONNECTIONS_FORM_SCRIPT = `
  (function() {
    // ── Generic key/value rows (edit mode only) ──────────────────────────────
    const addBtn = document.getElementById('add-field-row');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const container = document.getElementById('field-rows-container');
        if (!container) return;
        const row = document.createElement('div');
        row.className = 'field-row';
        row.innerHTML = '<input class="form-input field-key" placeholder="Key" />'
          + '<input class="form-input field-val" placeholder="Value" />'
          + '<button class="field-row-btn" type="button" title="Remove">&times;</button>';
        row.querySelector('.field-row-btn')?.addEventListener('click', () => row.remove());
        container.appendChild(row);
      });
      document.querySelectorAll('#field-rows-container .field-row-btn').forEach(btn => {
        btn.addEventListener('click', () => btn.closest('.field-row')?.remove());
      });
    }

    // ── Type-specific field sections (new connection mode) ───────────────────
    const typeSelect = document.getElementById('f-conn-type');
    if (typeSelect && typeSelect.tagName === 'SELECT') {
      const showSection = (type) => {
        document.querySelectorAll('.type-fields').forEach(el => { el.style.display = 'none'; });
        if (type) {
          const section = document.getElementById('fields-' + type);
          if (section) { section.style.display = ''; }
        }
      };
      typeSelect.addEventListener('change', (e) => showSection(e.target.value));
    }

    // ── Submit ───────────────────────────────────────────────────────────────
    document.getElementById('f-submit-connection')?.addEventListener('click', () => {
      const connType = document.getElementById('f-conn-type')?.value || '';
      const typedSection = document.getElementById('fields-' + connType);
      let fieldKeys, fieldValues;
      if (typedSection) {
        const inputs = Array.from(typedSection.querySelectorAll('.typed-field'));
        fieldKeys   = inputs.map(el => el.dataset.key || '');
        fieldValues = inputs.map(el => el.value || '');
      } else {
        fieldKeys   = Array.from(document.querySelectorAll('#field-rows-container .field-key')).map(el => el.value);
        fieldValues = Array.from(document.querySelectorAll('#field-rows-container .field-val')).map(el => el.value);
      }
      vscode.postMessage({ type: 'submitConnectionForm', formData: {
        name:           document.getElementById('f-name')?.value        || '',
        connectionType: connType,
        description:    document.getElementById('f-description')?.value || '',
        fieldKeys,
        fieldValues,
      }});
    });
  })();`;

// ── Export helpers ────────────────────────────────────────────────────────────

export const CONNECTIONS_CSV_HEADER = 'Name,Connection Type,Description';

export function connectionsCsvRows(items: ConnectionItem[]): string[] {
  return items.map(c => [c.name, c.connectionType ?? '', c.description ?? ''].map(csvEsc).join(','));
}

export const CONNECTIONS_EXPORT_HEADERS = ['Name', 'Connection Type', 'Description'];

export function connectionsExportRows(items: ConnectionItem[]): string[][] {
  return items.map(c => [c.name, c.connectionType ?? '', c.description ?? '']);
}
