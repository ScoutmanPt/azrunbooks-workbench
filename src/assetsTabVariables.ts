import type { AzureAutomationAccount, AzureService } from './azureService';
import type { VariableItem, VariableFormData, TabState, VariableType } from './assetsShared';
import { esc, csvEsc, errMsg, renderTabToolbar } from './assetsShared';

const VARIABLE_TYPES: VariableType[] = ['String', 'Integer', 'Boolean', 'DateTime'];

// ── Data loading ──────────────────────────────────────────────────────────────

export async function loadVariables(
  azure: AzureService,
  account: AzureAutomationAccount
): Promise<TabState<VariableItem>> {
  try {
    const items = await azure.listVariables(account.subscriptionId, account.resourceGroupName, account.name);
    return { items, loading: false };
  } catch (e) {
    return { items: [], loading: false, error: errMsg(e) };
  }
}

export async function getVariableEditPrefill(
  azure: AzureService,
  account: AzureAutomationAccount,
  name: string
): Promise<Record<string, unknown>> {
  const v = await azure.getVariable(account.subscriptionId, account.resourceGroupName, account.name, name);
  return { name: v.name, value: v.value ?? '', type: v.type ?? 'String', isEncrypted: v.isEncrypted, description: v.description ?? '' };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function validateVariableForm(fd: VariableFormData): string | undefined {
  if (!fd.name.trim()) { return 'Name is required.'; }
  return undefined;
}

export async function submitVariable(
  azure: AzureService,
  account: AzureAutomationAccount,
  fd: VariableFormData
): Promise<void> {
  await azure.createOrUpdateVariable(
    account.subscriptionId, account.resourceGroupName, account.name,
    fd.name.trim(), fd.value, fd.isEncrypted, fd.description.trim() || undefined
  );
}

export async function deleteVariable(
  azure: AzureService,
  account: AzureAutomationAccount,
  name: string
): Promise<void> {
  await azure.deleteVariable(account.subscriptionId, account.resourceGroupName, account.name, name);
}

// ── Grid rendering ────────────────────────────────────────────────────────────

export function renderVariablesPane(tabState: TabState<VariableItem>): string {
  const toolbar = renderTabToolbar('variables');

  if (tabState.error) { return toolbar + `<div class="error-state">Error: ${esc(tabState.error)}</div>`; }
  if (tabState.loading) { return toolbar + '<div class="loading-state">Loading…</div>'; }
  if (tabState.items.length === 0) { return toolbar + '<div class="empty-state">No variables found.</div>'; }

  const header = `
    <div class="grid-header cols-vars">
      <span><input type="checkbox" id="sel-all-variables" title="Select all" /></span>
      <span class="cell">Name</span>
      <span class="cell">Value</span>
      <span class="cell">Encrypted</span>
      <span class="cell">Description</span>
    </div>`;

  const rows = tabState.items.map(v => {
    const search = [v.name, v.isEncrypted ? 'encrypted' : (v.value ?? ''), v.description ?? ''].join(' ').toLowerCase();
    return `
      <div class="grid-row cols-vars" data-tab="variables" data-name="${esc(v.name)}" data-search="${esc(search)}">
        <span class="cb-col"><input type="checkbox" class="row-cb" value="${esc(v.name)}" /></span>
        <span class="cell cell-name">${esc(v.name)}</span>
        <span class="cell ${v.isEncrypted ? 'cell-masked' : ''}">${v.isEncrypted ? '••••••••' : esc(v.value ?? '')}</span>
        <span class="cell">${v.isEncrypted ? '<span class="cell-tag">Yes</span>' : ''}</span>
        <span class="cell cell-muted">${esc(v.description ?? '')}</span>
      </div>`;
  }).join('');

  return toolbar + `<div class="grid-container">${header}${rows}</div>`;
}

// ── Form rendering ────────────────────────────────────────────────────────────

export function renderVariablesFormBody(prefill: Record<string, unknown>, isEdit: boolean): string {
  const name      = isEdit ? esc(String(prefill['name']        ?? '')) : '';
  const val       = isEdit ? esc(String(prefill['value']       ?? '')) : '';
  const type      = isEdit ? (String(prefill['type'] ?? 'String') as VariableType) : 'String';
  const encrypted = isEdit ? prefill['isEncrypted'] === true : false;
  const desc      = isEdit ? esc(String(prefill['description'] ?? '')) : '';

  const typeOptions = VARIABLE_TYPES.map(t =>
    `<option value="${t}"${t === type ? ' selected' : ''}>${t}</option>`
  ).join('');

  return `
    <div class="form-field">
      <label class="form-label required">Name</label>
      <input class="form-input" id="f-name" type="text" value="${name}" ${isEdit ? 'readonly' : ''} placeholder="VariableName" />
    </div>
    <div class="form-field">
      <label class="form-label required">Type</label>
      <select class="form-input" id="f-type">${typeOptions}</select>
    </div>
    <div class="form-field">
      <label class="form-label">Value</label>
      <input class="form-input" id="f-value" type="text" value="${val}"
        placeholder="${encrypted ? '(encrypted — enter new value to update)' : ''}" />
    </div>
    <div class="form-field">
      <div class="form-check-row">
        <input type="checkbox" id="f-encrypted" ${encrypted ? 'checked' : ''} />
        <label for="f-encrypted">Encrypted</label>
      </div>
    </div>
    <div class="form-field">
      <label class="form-label">Description</label>
      <input class="form-input" id="f-description" type="text" value="${desc}" placeholder="Optional description" />
    </div>`;
}

export function renderVariablesSubmitButton(isEdit: boolean): string {
  return `<button class="btn btn-primary" id="f-submit-variable">${isEdit ? 'Save' : 'Create'}</button>`;
}

/** Inline JS snippet wiring the submit button — embedded inside the page <script> block. */
export const VARIABLES_FORM_SCRIPT = `
  document.getElementById('f-submit-variable')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'submitVariableForm', formData: {
      name:        document.getElementById('f-name')?.value      || '',
      type:        document.getElementById('f-type')?.value      || 'String',
      value:       document.getElementById('f-value')?.value     || '',
      isEncrypted: document.getElementById('f-encrypted')?.checked || false,
      description: document.getElementById('f-description')?.value || '',
    }});
  });`;

// ── Export helpers ────────────────────────────────────────────────────────────

export const VARIABLES_CSV_HEADER = 'Name,Value,Encrypted,Description';

export function variablesCsvRows(items: VariableItem[]): string[] {
  return items.map(v =>
    [v.name, v.isEncrypted ? '(encrypted)' : (v.value ?? ''), v.isEncrypted ? 'Yes' : 'No', v.description ?? '']
      .map(csvEsc).join(',')
  );
}

export const VARIABLES_EXPORT_HEADERS = ['Name', 'Value', 'Encrypted', 'Description'];

export function variablesExportRows(items: VariableItem[]): string[][] {
  return items.map(v => [v.name, v.isEncrypted ? '(encrypted)' : (v.value ?? ''), v.isEncrypted ? 'Yes' : 'No', v.description ?? '']);
}
