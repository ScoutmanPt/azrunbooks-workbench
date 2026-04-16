import type { AzureAutomationAccount } from './azureService';

// ── Tab identifier ────────────────────────────────────────────────────────────

export type AssetTab = 'variables' | 'credentials' | 'connections' | 'certificates' | 'modules' | 'runtimeEnvironments';

// ── State shapes ──────────────────────────────────────────────────────────────

export interface TabState<T> {
  items: T[];
  loading: boolean;
  error?: string;
}

export interface AssetFormState {
  open: boolean;
  mode: 'new' | 'edit';
  tab: AssetTab;
  loading: boolean;
  error?: string;
  editName?: string;
  prefill?: Record<string, unknown>;
}

export interface ModuleItem {
  name: string;
  version: string;
  source: 'local' | 'azure';
  provisioningState?: string; // azure only
}

export interface RuntimeEnvironmentItem {
  name: string;
  language?: string;
  version?: string;
  description?: string;
  provisioningState?: string;
  defaultPackages?: Record<string, string>;
}

export interface AssetsPanelState {
  account: AzureAutomationAccount;
  activeTab: AssetTab;
  variables: TabState<VariableItem>;
  credentials: TabState<CredentialItem>;
  connections: TabState<ConnectionItem>;
  certificates: TabState<CertificateItem>;
  modules: TabState<ModuleItem>;
  runtimeEnvironments: TabState<RuntimeEnvironmentItem>;
  form: AssetFormState;
}

// ── Per-tab item shapes ───────────────────────────────────────────────────────

export type VariableType = 'String' | 'Integer' | 'Boolean' | 'DateTime';

export interface VariableItem {
  name: string;
  value: string | undefined;
  isEncrypted: boolean;
  description?: string;
}

export interface CredentialItem {
  name: string;
  userName: string | undefined;
  description?: string;
}

export interface ConnectionItem {
  name: string;
  connectionType: string | undefined;
  description?: string;
}

export interface CertificateItem {
  name: string;
  thumbprint: string | undefined;
  expiryTime: string | undefined;
  description?: string;
  isExportable: boolean;
}

// ── Message types (webview → extension host) ──────────────────────────────────

export type AssetsPanelMessage =
  | { type: 'switchTab'; tab: AssetTab }
  | { type: 'refresh' }
  | { type: 'showNewForm'; tab: AssetTab }
  | { type: 'showEditForm'; tab: AssetTab; name: string }
  | { type: 'cancelForm' }
  | { type: 'submitVariableForm';            formData: VariableFormData }
  | { type: 'submitCredentialForm';          formData: CredentialFormData }
  | { type: 'submitConnectionForm';          formData: ConnectionFormData }
  | { type: 'submitCertificateForm';         formData: CertificateFormData }
  | { type: 'submitRuntimeEnvironmentForm';  formData: RuntimeEnvironmentFormData }
  | { type: 'deleteSelected'; tab: AssetTab; names: string[] }
  | { type: 'exportCsv' }
  | { type: 'exportHtml' }
  | { type: 'exportPdf' }
  | { type: 'exportMd' }
  | { type: 'moduleAction'; action: 'installGallery' | 'importLocal' | 'deployToAzure'; moduleName?: string }
  | { type: 'runtimeEnvironmentAction'; action: 'create' | 'editPackages'; name?: string };

// ── Per-tab form data ─────────────────────────────────────────────────────────

export interface VariableFormData {
  name: string;
  value: string;
  type: VariableType;
  isEncrypted: boolean;
  description: string;
}

export interface CredentialFormData {
  name: string;
  userName: string;
  password: string;
  description: string;
}

export interface ConnectionFormData {
  name: string;
  connectionType: string;
  description: string;
  fieldKeys: string[];
  fieldValues: string[];
}

export interface CertificateFormData {
  name: string;
  base64Value: string;
  isExportable: boolean;
  description: string;
}

export interface RuntimeEnvironmentFormData {
  name: string;
  language: string;
  version: string;
  description: string;
  packageKeys: string[];
  packageVersions: string[];
}

// ── Supported runtime versions (single source of truth) ──────────────────────

export const SUPPORTED_RUNTIME_VERSIONS: Record<string, string[]> = {
  PowerShell: ['7.6', '7.4', '7.2', '5.1'],
  Python:     ['3.10', '3.8'],
};

// ── Utilities ─────────────────────────────────────────────────────────────────

export function esc(s: string | undefined | null): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function csvEsc(s: string): string {
  if (/[",\n]/.test(s)) { return '"' + s.replace(/"/g, '""') + '"'; }
  return s;
}

export function formatDt(iso: string | undefined | null): string {
  if (!iso) { return ''; }
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) { return e.message; }
  return String(e);
}

// ── Shared toolbar HTML ───────────────────────────────────────────────────────

export function renderTabToolbar(tab: AssetTab): string {
  return `
    <div class="pane-toolbar">
      <input class="search-box" id="search-${tab}" type="text" placeholder="Search ${tab}…" />
      <button class="btn btn-primary" id="btn-new-${tab}">+ New</button>
      <button class="btn btn-danger" id="btn-delete-${tab}">Delete</button>
    </div>`;
}
