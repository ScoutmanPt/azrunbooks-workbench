import type { AzureAutomationAccount } from './azureService';

// ── Well-known API identifiers ────────────────────────────────────────────────

export type KnownApi = 'graph' | 'sharepoint' | 'azure';
export type PermissionKind = 'delegated' | 'application';

export const KNOWN_API_APP_IDS: Record<KnownApi, string> = {
  graph:      '00000003-0000-0000-c000-000000000000', // Microsoft Graph
  sharepoint: '00000003-0000-0ff1-ce00-000000000000', // SharePoint Online
  azure:      '797f4846-ba00-4fd7-ba43-dac1f8f63013', // Azure Service Management
};

export const KNOWN_API_LABELS: Record<KnownApi, string> = {
  graph:      'Microsoft Graph',
  sharepoint: 'SharePoint Online',
  azure:      'Azure Service Management',
};

// ── Domain objects ────────────────────────────────────────────────────────────

export interface AppSearchResult {
  /** Graph object ID (application or service principal) */
  id: string;
  appId: string;
  displayName: string;
  /** 'application' = app registration, 'servicePrincipal' = enterprise app / managed identity */
  kind: 'application' | 'servicePrincipal';
  servicePrincipalType?: string;
}

export interface RequiredResourceAccess {
  resourceAppId: string;
  resourceAccess: Array<{ id: string; type: string }>;
}

export interface ConfiguredPermission {
  id: string;
  value: string;
  displayName: string;
  description: string;
  type: 'Scope' | 'Role';   // Delegated = Scope, Application = Role
  resourceAppId: string;
  resourceDisplayName: string;
  adminConsentRequired?: boolean;
}

export interface PermissionEntry {
  id: string;
  value: string;
  displayName: string;
  description: string;
  adminConsentRequired?: boolean;
}

export interface ApiPermissions {
  delegated: PermissionEntry[];
  application: PermissionEntry[];
}

// ── Panel state ───────────────────────────────────────────────────────────────

export interface AppPermissionsPanelState {
  account: AzureAutomationAccount;

  // Identity pre-fill
  identityPrincipalId: string;
  identityAppId: string;      // derived from principalId via Graph
  identityLoading: boolean;

  // Search view
  searchQuery: string;
  searchResults: AppSearchResult[];
  searchLoading: boolean;
  searchError?: string;

  // Detail view (null = search view is active)
  selectedApp: SelectedAppState | null;

  // Add-permissions slide-over
  addPanel: AddPanelState | null;
}

export interface SelectedAppState {
  id: string;
  appId: string;
  displayName: string;
  kind: 'application' | 'servicePrincipal';
  servicePrincipalType?: string;
  /** Object ID of the backing app registration (set when kind = servicePrincipal and the app exists in this tenant). */
  linkedAppObjectId?: string;
  permissions: ConfiguredPermission[];
  loading: boolean;
  error?: string;
  saving: boolean;
  saveError?: string;
}

export interface AddPanelState {
  appObjectId: string;         // object ID of the application being edited
  servicePrincipalId?: string; // object ID when editing direct service principal permissions
  allowDelegated: boolean;
  currentRequiredAccess: RequiredResourceAccess[];
  currentPermissionIds: string[];
  tab: KnownApi;
  kind: PermissionKind;
  search: string;
  pendingSelections: Partial<Record<KnownApi, Partial<Record<PermissionKind, string[]>>>>;
  // per-API permissions cache (undefined = not yet loaded)
  cache: Partial<Record<KnownApi, ApiPermissions>>;
  loading: boolean;
  error?: string;
  saving: boolean;
  saveError?: string;
}

// ── Messages (webview → host) ─────────────────────────────────────────────────

export type AppPermissionsMessage =
  | { type: 'search'; query: string }
  | { type: 'selectApp'; id: string; appId: string; displayName: string; kind: 'application' | 'servicePrincipal'; servicePrincipalType?: string }
  | { type: 'backToSearch' }
  | { type: 'removePermission'; resourceAppId: string; permissionId: string }
  | { type: 'showAddPanel' }
  | { type: 'closeAddPanel' }
  | { type: 'addPanelSwitchTab'; tab: KnownApi }
  | { type: 'addPanelSwitchKind'; kind: PermissionKind }
  | { type: 'addPanelSearch'; query: string }
  | { type: 'addPanelTogglePermission'; permissionId: string; checked: boolean }
  | { type: 'addPermissions' }
  | { type: 'refresh' };

// ── Utilities ─────────────────────────────────────────────────────────────────

export function esc(s: string | undefined | null): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
