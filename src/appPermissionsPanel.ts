/**
 * Main orchestrator for the "Manage App Permissions" panel.
 * Handles search view, detail view, and add-permissions slide-over.
 */
import * as vscode from 'vscode';
import type { AzureService } from './azureService';
import type { AuthManager } from './authManager';
import type { WorkspaceManager } from './workspaceManager';
import type { AzureAutomationAccount } from './azureService';
import type {
  AppPermissionsPanelState, SelectedAppState, AppPermissionsMessage,
  RequiredResourceAccess, AddPanelState, AppSearchResult,
} from './appPermissionsShared';
import { KNOWN_API_APP_IDS, KNOWN_API_LABELS, esc, errMsg } from './appPermissionsShared';
import { renderDetailView, DETAIL_SCRIPT, DETAIL_CSS } from './appPermissionsDetail';
import { renderAddPanel, ADD_PANEL_SCRIPT, ADD_PANEL_CSS } from './appPermissionsAddPanel';

// ── Panel class ───────────────────────────────────────────────────────────────

export class AppPermissionsPanel {
  private _panel: vscode.WebviewPanel | undefined;
  private _state: AppPermissionsPanelState | undefined;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _azure: AzureService,
    private readonly _auth: AuthManager,
    private readonly _output: vscode.OutputChannel,
    private readonly _workspace: WorkspaceManager,
  ) {}

  async openForAccount(account: AzureAutomationAccount): Promise<void> {
    if (this._panel) {
      this._panel.reveal();
      const key = (a: AzureAutomationAccount) => `${a.subscriptionId}/${a.resourceGroupName}/${a.name}`;
      if (!this._state || key(this._state.account) !== key(account)) {
        this._panel.title = `App Permissions — ${account.name}`;
        await this._initState(account);
      }
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      'appPermissions',
      `App Permissions — ${account.name}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this._panel.onDidDispose(() => { this._panel = undefined; this._state = undefined; });
    this._panel.webview.onDidReceiveMessage((msg: AppPermissionsMessage) => this._handleMessage(msg));

    await this._initState(account);
  }

  dispose(): void {
    this._panel?.dispose();
  }

  // ── Initialisation ──────────────────────────────────────────────────────────

  private async _initState(account: AzureAutomationAccount): Promise<void> {
    // Keep AuthManager in sync with the latest PnP app ID so device-code flow can use it.
    this._auth.setPnpAppId(this._workspace.getGlobalPnPAppId());
    // Start with loading state — identity lookup in progress
    this._state = {
      account,
      identityPrincipalId: '',
      identityAppId: '',
      identityLoading: true,
      searchQuery: '',
      searchResults: [],
      searchLoading: false,
      selectedApp: null,
      addPanel: null,
    };
    this._render();

    try {
      const identity = await this._azure.getAutomationAccountIdentity(
        account.subscriptionId, account.resourceGroupName, account.name
      );
      const principalId = identity?.principalId ?? '';
      let appId = '';

      if (principalId) {
        try {
          const sp = await this._azure.graphGetServicePrincipalById(principalId);
          appId = sp?.appId ?? '';
          if (!appId) {
            appId = principalId;
          }
        } catch {
          appId = principalId;
        }
      }

      this._state = { ...this._state, identityPrincipalId: principalId, identityAppId: appId, identityLoading: false };
    } catch (e) {
      this._state = { ...this._state, identityLoading: false };
      this._output.appendLine(`[AppPermissions] identity lookup failed: ${errMsg(e)}`);
    }

    this._render();
  }

  // ── Message handler ─────────────────────────────────────────────────────────

  private async _handleMessage(msg: AppPermissionsMessage): Promise<void> {
    if (!this._state) { return; }

    switch (msg.type) {
      case 'search':
        this._state = { ...this._state, searchQuery: msg.query, searchLoading: true, searchError: undefined };
        this._render();
        await this._doSearch(msg.query);
        break;

      case 'selectApp':
        await this._selectApp({ id: msg.id, appId: msg.appId, displayName: msg.displayName, kind: msg.kind, servicePrincipalType: msg.servicePrincipalType });
        break;

      case 'backToSearch':
        this._state = { ...this._state, selectedApp: null, addPanel: null };
        this._render();
        break;

      case 'showAddPanel':
        if (this._state.selectedApp) {
          await this._openAddPanel();
        }
        break;

      case 'closeAddPanel':
        this._state = { ...this._state, addPanel: null };
        this._render();
        break;

      case 'addPanelSwitchTab':
        if (this._state.addPanel) {
          const addPanel = { ...this._state.addPanel, tab: msg.tab, search: '' };
          this._state = { ...this._state, addPanel };
          this._render();
          await this._loadAddPanelPerms(msg.tab);
        }
        break;

      case 'addPanelSwitchKind':
        if (this._state.addPanel) {
          if (msg.kind === 'delegated' && !this._state.addPanel.allowDelegated) { break; }
          this._state = { ...this._state, addPanel: { ...this._state.addPanel, kind: msg.kind } };
          this._render();
        }
        break;

      case 'addPanelSearch':
        if (this._state.addPanel) {
          this._state = { ...this._state, addPanel: { ...this._state.addPanel, search: (msg as { query: string } & AppPermissionsMessage).query ?? '' } };
          this._render();
        }
        break;

      case 'addPanelTogglePermission':
        if (this._state.addPanel) {
          const { tab, kind, pendingSelections } = this._state.addPanel;
          const existing = pendingSelections[tab]?.[kind] ?? [];
          const next = msg.checked
            ? [...new Set([...existing, msg.permissionId])]
            : existing.filter(id => id !== msg.permissionId);
          this._state = {
            ...this._state,
            addPanel: {
              ...this._state.addPanel,
              pendingSelections: {
                ...pendingSelections,
                [tab]: {
                  ...(pendingSelections[tab] ?? {}),
                  [kind]: next,
                },
              },
            },
          };
          this._render();
        }
        break;

      case 'addPermissions':
        await this._addPermissions();
        break;

      case 'removePermission':
        await this._removePermission(msg.resourceAppId, msg.permissionId);
        break;

      case 'removeAllPermissions':
        await this._removeAllPermissions();
        break;

      case 'refresh':
        if (this._state.selectedApp) {
          await this._reloadSelectedApp();
        } else {
          await this._doSearch(this._state.searchQuery);
        }
        break;
    }
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  private async _doSearch(query: string): Promise<void> {
    if (!this._state) { return; }
    // If the user didn't provide a query, try using the workspace-level PnPAppId
    let effectiveQuery = query ?? '';
    if (!effectiveQuery) {
      try {
        const pnp = this._workspace.getGlobalPnPAppId();
        if (pnp) { effectiveQuery = pnp; }
      } catch {}
    }
    try {
      const [apps, sps] = await Promise.all([
        this._azure.graphSearchApplications(effectiveQuery),
        this._azure.graphSearchServicePrincipals(effectiveQuery),
      ]);

      const appResults: AppSearchResult[] = apps.map(a => ({
        id: a.id, appId: a.appId, displayName: a.displayName, kind: 'application' as const,
      }));
      const spResults: AppSearchResult[] = sps.map(s => ({
        id: s.id, appId: s.appId, displayName: s.displayName, kind: 'servicePrincipal' as const,
        servicePrincipalType: s.servicePrincipalType,
      }));

      // Deduplicate by object ID only — keep both an app registration and its
      // corresponding enterprise application (different object IDs, different purposes).
      const seen = new Set<string>();
      const deduped = [...appResults, ...spResults].filter(r => {
        if (seen.has(r.id)) { return false; }
        seen.add(r.id);
        return true;
      });
      // Sort: App Registrations → Enterprise Applications → Managed Identities → others
      const kindOrder = (r: AppSearchResult) => {
        if (r.kind === 'application') { return 0; }
        if (r.servicePrincipalType === 'Application') { return 1; }
        if (r.servicePrincipalType === 'ManagedIdentity') { return 2; }
        return 3;
      };
      deduped.sort((a, b) => kindOrder(a) - kindOrder(b) || a.displayName.localeCompare(b.displayName));

      this._state = { ...this._state, searchResults: deduped, searchLoading: false, searchError: undefined };
    } catch (e) {
      const errText = errMsg(e);
      // Log full error (includes client/app id when available) to output for debugging
      this._output.appendLine(`[AppPermissions] search failed for "${query}": ${errText}`);
      // Try to surface a clientAppId if azureService appended one to the error text.
      const match = /clientAppId:\s*([A-Za-z0-9-_.]+)/i.exec(errText);
      const clientAppId = match ? match[1] : undefined;
      const isVsCodeApp = clientAppId === 'aebc6443-996d-45c2-90f0-388ff96faa56';
      const clientPart = clientAppId ? `, clientAppId: ${clientAppId}` : '';
      const hint = isVsCodeApp
        ? ' — The VS Code app lacks Application.Read.All. Run "az login" in your terminal so the Azure CLI token is used instead.'
        : '';
      this._state = { ...this._state, searchLoading: false, searchError: `${errText} (search query: ${query}${clientPart})${hint}` };
    }
    this._render();
  }

  // ── Select app / load permissions ───────────────────────────────────────────

  private async _selectApp(result: AppSearchResult): Promise<void> {
    if (!this._state) { return; }

    const selectedApp: SelectedAppState = {
      id: result.id,
      appId: result.appId,
      displayName: result.displayName,
      kind: result.kind,
      servicePrincipalType: result.servicePrincipalType,
      permissions: [],
      loading: true,
      saving: false,
    };
    this._state = { ...this._state, selectedApp, addPanel: null };
    this._render();

    try {
      // For service principals, resolve the backing app registration so we can
      // read and write requiredResourceAccess on it.
      let linkedAppObjectId: string | undefined;
      if (result.kind === 'servicePrincipal' && result.appId) {
        const apps = await this._azure.graphSearchApplications(result.appId).catch(() => []);
        const match = apps.find(a => a.appId === result.appId);
        linkedAppObjectId = match?.id;
      }

      const permissions = await this._fetchConfiguredPermissions(result, linkedAppObjectId);
      this._state = { ...this._state!, selectedApp: { ...this._state!.selectedApp!, linkedAppObjectId, permissions, loading: false } };
    } catch (e) {
      this._state = { ...this._state!, selectedApp: { ...this._state!.selectedApp!, loading: false, error: errMsg(e) } };
    }
    this._render();
  }

  private async _reloadSelectedApp(): Promise<void> {
    if (!this._state?.selectedApp) { return; }
    const app = this._state.selectedApp;
    this._state = { ...this._state!, selectedApp: { ...app, loading: true, error: undefined } };
    this._render();
    try {
      const permissions = await this._fetchConfiguredPermissions({
        id: app.id,
        appId: app.appId,
        displayName: app.displayName,
        kind: app.kind,
        servicePrincipalType: app.servicePrincipalType,
      }, app.linkedAppObjectId);
      this._state = { ...this._state!, selectedApp: { ...this._state!.selectedApp!, permissions, loading: false } };
    } catch (e) {
      this._state = { ...this._state!, selectedApp: { ...this._state!.selectedApp!, loading: false, error: errMsg(e) } };
    }
    this._render();
  }

  private async _fetchConfiguredPermissions(result: AppSearchResult, linkedAppObjectId?: string) {
    if (result.kind === 'servicePrincipal' && (!linkedAppObjectId || result.servicePrincipalType === 'ManagedIdentity')) {
      return this._fetchServicePrincipalAssignedPermissions(result.id);
    }

    // Use the app registration object ID (either direct selection or resolved from SP).
    const appObjId = result.kind === 'application' ? result.id : linkedAppObjectId;
    if (!appObjId) { return []; }
    const app = await this._azure.graphGetApplication(appObjId);
    return this._resolvePermissions(app.requiredResourceAccess);
  }

  private async _fetchServicePrincipalAssignedPermissions(
    servicePrincipalId: string
  ): Promise<import('./appPermissionsShared').ConfiguredPermission[]> {
    const results: import('./appPermissionsShared').ConfiguredPermission[] = [];
    const [roleAssignments, delegatedGrants] = await Promise.all([
      this._azure.graphListServicePrincipalAppRoleAssignments(servicePrincipalId),
      this._azure.graphListServicePrincipalOauth2PermissionGrants(servicePrincipalId),
    ]);

    const resourceCache = new Map<string, Awaited<ReturnType<AzureService['graphGetServicePrincipalPermissionsById']>>>();
    const loadResource = async (resourceId: string) => {
      const cached = resourceCache.get(resourceId);
      if (cached) { return cached; }
      const resource = await this._azure.graphGetServicePrincipalPermissionsById(resourceId);
      resourceCache.set(resourceId, resource);
      return resource;
    };

    for (const assignment of roleAssignments) {
      try {
        const resource = await loadResource(assignment.resourceId);
        const role = resource.application.find(entry => entry.id === assignment.appRoleId);
        if (!role) { continue; }
        results.push({
          id: role.id,
          value: role.value,
          displayName: role.displayName,
          description: role.description,
          type: 'Role',
          resourceAppId: resource.appId,
          resourceDisplayName: resource.displayName,
          adminConsentRequired: role.adminConsentRequired,
        });
      } catch (e) {
        this._output.appendLine(`[AppPermissions] app role resolution failed for ${assignment.resourceId}: ${errMsg(e)}`);
      }
    }

    for (const grant of delegatedGrants) {
      try {
        const resource = await loadResource(grant.resourceId);
        const grantedScopes = grant.scope.split(/\s+/).map(scope => scope.trim()).filter(Boolean);
        for (const scopeValue of grantedScopes) {
          const scope = resource.delegated.find(entry => entry.value === scopeValue);
          if (!scope) { continue; }
          results.push({
            id: scope.id,
            value: scope.value,
            displayName: scope.displayName,
            description: scope.description,
            type: 'Scope',
            resourceAppId: resource.appId,
            resourceDisplayName: resource.displayName,
            adminConsentRequired: scope.adminConsentRequired,
          });
        }
      } catch (e) {
        this._output.appendLine(`[AppPermissions] delegated grant resolution failed for ${grant.resourceId}: ${errMsg(e)}`);
      }
    }

    return results.sort((left, right) =>
      left.resourceDisplayName.localeCompare(right.resourceDisplayName)
      || left.type.localeCompare(right.type)
      || left.value.localeCompare(right.value)
    );
  }

  /**
   * Resolves permission IDs in requiredResourceAccess to display names
   * by looking up each resource's service principal from Graph.
   */
  private async _resolvePermissions(
    requiredResourceAccess: RequiredResourceAccess[]
  ): Promise<import('./appPermissionsShared').ConfiguredPermission[]> {
    const results: import('./appPermissionsShared').ConfiguredPermission[] = [];

    for (const resource of requiredResourceAccess) {
      try {
        const sp = await this._azure.graphGetServicePrincipalPermissions(resource.resourceAppId);
        const displayName = sp.displayName;
        const allScopes = sp.delegated;
        const allRoles  = sp.application;

        for (const access of resource.resourceAccess) {
          const isScope = access.type === 'Scope';
          const list = isScope ? allScopes : allRoles;
          const entry = list.find(e => e.id === access.id);
          if (entry) {
            results.push({
              id: entry.id,
              value: entry.value,
              displayName: entry.displayName,
              description: entry.description,
              type: isScope ? 'Scope' : 'Role',
              resourceAppId: resource.resourceAppId,
              resourceDisplayName: displayName,
              adminConsentRequired: entry.adminConsentRequired,
            });
          } else {
            // Unknown permission (possibly removed from API) — show ID
            results.push({
              id: access.id,
              value: access.id,
              displayName: access.id,
              description: '(unknown permission)',
              type: isScope ? 'Scope' : 'Role',
              resourceAppId: resource.resourceAppId,
              resourceDisplayName: displayName,
            });
          }
        }
      } catch (e) {
        this._output.appendLine(`[AppPermissions] resolvePermissions failed for ${resource.resourceAppId}: ${errMsg(e)}`);
      }
    }

    return results;
  }

  // ── Add panel ───────────────────────────────────────────────────────────────

  private async _openAddPanel(): Promise<void> {
    if (!this._state?.selectedApp) { return; }
    const selectedApp = this._state.selectedApp;
    const isManagedIdentity = selectedApp.kind === 'servicePrincipal' && selectedApp.servicePrincipalType === 'ManagedIdentity';

    const effectiveId = selectedApp.kind === 'application'
      ? selectedApp.id
      : selectedApp.linkedAppObjectId;
    if (!effectiveId && !isManagedIdentity) { return; }

    let currentRequiredAccess: RequiredResourceAccess[] = [];
    if (effectiveId) {
      try {
        const app = await this._azure.graphGetApplication(effectiveId);
        currentRequiredAccess = app.requiredResourceAccess;
      } catch { /* ignore */ }
    }

    const addPanel: AddPanelState = {
      appObjectId: effectiveId ?? '',
      servicePrincipalId: isManagedIdentity ? selectedApp.id : undefined,
      allowDelegated: !isManagedIdentity,
      currentRequiredAccess,
      currentPermissionIds: selectedApp.permissions.map(permission => permission.id),
      tab: 'graph',
      kind: isManagedIdentity ? 'application' : 'delegated',
      search: '',
      pendingSelections: {},
      cache: {},
      loading: true,
      saving: false,
    };
    this._state = { ...this._state, addPanel };
    this._render();
    await this._loadAddPanelPerms('graph');
  }

  private async _loadAddPanelPerms(tab: import('./appPermissionsShared').KnownApi): Promise<void> {
    if (!this._state?.addPanel) { return; }
    const cached = this._state.addPanel.cache[tab];
    if (cached) { return; } // already loaded

    this._state = { ...this._state, addPanel: { ...this._state.addPanel, loading: true, error: undefined } };
    this._render();

    try {
      const perms = await this._azure.graphGetServicePrincipalPermissions(KNOWN_API_APP_IDS[tab]);
      const addPanel = {
        ...this._state.addPanel!,
        loading: false,
        cache: { ...this._state.addPanel!.cache, [tab]: { delegated: perms.delegated, application: perms.application } },
      };
      this._state = { ...this._state, addPanel };
    } catch (e) {
      this._state = { ...this._state, addPanel: { ...this._state.addPanel!, loading: false, error: errMsg(e) } };
    }
    this._render();
  }

  // ── Add permissions ─────────────────────────────────────────────────────────

  private async _addPermissions(): Promise<void> {
    if (!this._state?.addPanel || !this._state.selectedApp) { return; }
    const { appObjectId, currentRequiredAccess, servicePrincipalId, pendingSelections } = this._state.addPanel;
    const isManagedIdentity = this._state.selectedApp.kind === 'servicePrincipal' && this._state.selectedApp.servicePrincipalType === 'ManagedIdentity';
    const selectedEntries = Object.entries(pendingSelections).flatMap(([tab, kinds]) =>
      Object.entries(kinds ?? {}).flatMap(([kind, ids]) =>
        (ids ?? []).map(id => ({
          tab: tab as import('./appPermissionsShared').KnownApi,
          kind: kind as import('./appPermissionsShared').PermissionKind,
          id,
        }))
      )
    );
    if (selectedEntries.length === 0) { return; }

    this._state = { ...this._state, addPanel: { ...this._state.addPanel, saving: true, saveError: undefined } };
    this._render();

    try {
      if (isManagedIdentity) {
        if (!servicePrincipalId) {
          throw new Error('Managed identity service principal id is missing.');
        }
        const groupedByTab = new Map<import('./appPermissionsShared').KnownApi, string[]>();
        for (const entry of selectedEntries) {
          if (entry.kind !== 'application') {
            throw new Error('Managed identities only support application permissions.');
          }
          const current = groupedByTab.get(entry.tab) ?? [];
          current.push(entry.id);
          groupedByTab.set(entry.tab, current);
        }
        for (const [tab, ids] of groupedByTab) {
          const resourceAppId = KNOWN_API_APP_IDS[tab];
          const resourceServicePrincipal = await this._azure.graphGetServicePrincipalByAppId(resourceAppId);
          if (!resourceServicePrincipal?.id) {
            throw new Error(`Resource service principal not found for ${resourceAppId}.`);
          }
          for (const id of ids) {
            await this._azure.graphGrantAdminConsent(servicePrincipalId, resourceServicePrincipal.id, id);
          }
        }
        this._state = { ...this._state, addPanel: null };
        await this._reloadSelectedApp();
        return;
      }

      // Merge into existing requiredResourceAccess
      const updated: RequiredResourceAccess[] = currentRequiredAccess.map(r => ({ ...r, resourceAccess: [...r.resourceAccess] }));
      for (const entry of selectedEntries) {
        const resourceAppId = KNOWN_API_APP_IDS[entry.tab];
        const permType = entry.kind === 'delegated' ? 'Scope' : 'Role';
        let resourceEntry = updated.find(resource => resource.resourceAppId === resourceAppId);
        if (!resourceEntry) {
          resourceEntry = { resourceAppId, resourceAccess: [] };
          updated.push(resourceEntry);
        }
        if (!resourceEntry.resourceAccess.find(access => access.id === entry.id)) {
          resourceEntry.resourceAccess.push({ id: entry.id, type: permType });
        }
      }

      await this._azure.graphPatchApplicationPermissions(appObjectId, updated);

      // Close panel and reload permissions
      this._state = { ...this._state, addPanel: null };
      await this._reloadSelectedApp();
    } catch (e) {
      this._state = { ...this._state, addPanel: { ...this._state.addPanel!, saving: false, saveError: errMsg(e) } };
      this._render();
    }
  }

  // ── Remove permission ───────────────────────────────────────────────────────

  private async _removePermission(resourceAppId: string, permissionId: string): Promise<void> {
    if (!this._state?.selectedApp) { return; }
    const selectedApp = this._state.selectedApp;
    const isManagedIdentity = selectedApp.kind === 'servicePrincipal' && selectedApp.servicePrincipalType === 'ManagedIdentity';
    const effectiveId = this._state.selectedApp.kind === 'application'
      ? this._state.selectedApp.id
      : this._state.selectedApp.linkedAppObjectId;
    if (!effectiveId && !isManagedIdentity) { return; }

    const app = this._state.selectedApp;
    this._state = { ...this._state, selectedApp: { ...app, saving: true, saveError: undefined } };
    this._render();

    try {
      if (isManagedIdentity) {
        const resourceServicePrincipal = await this._azure.graphGetServicePrincipalByAppId(resourceAppId);
        if (!resourceServicePrincipal?.id) {
          throw new Error(`Resource service principal not found for ${resourceAppId}.`);
        }
        // Use the full assignment list (includes id) and filter client-side — avoids unreliable $filter queries
        const allAssignments = await this._azure.graphListServicePrincipalAppRoleAssignments(app.id);
        const assignment = allAssignments.find(a => a.resourceId === resourceServicePrincipal.id && a.appRoleId === permissionId);
        if (!assignment) {
          throw new Error('Managed identity permission assignment was not found. Try refreshing the permissions list.');
        }
        await this._azure.graphDeleteAppRoleAssignment(app.id, assignment.id);
        await this._reloadSelectedApp();
        return;
      }

      if (!effectiveId) {
        throw new Error('Application object id is missing.');
      }
      const appData = await this._azure.graphGetApplication(effectiveId);
      const updated = appData.requiredResourceAccess.map(r => ({
        ...r,
        resourceAccess: r.resourceAccess.filter(a => !(r.resourceAppId === resourceAppId && a.id === permissionId)),
      })).filter(r => r.resourceAccess.length > 0);

      await this._azure.graphPatchApplicationPermissions(effectiveId, updated);
      await this._reloadSelectedApp();
    } catch (e) {
      this._state = { ...this._state, selectedApp: { ...this._state.selectedApp!, saving: false, saveError: errMsg(e) } };
      this._render();
    }
  }

  // ── Remove all permissions ──────────────────────────────────────────────────

  private async _removeAllPermissions(): Promise<void> {
    if (!this._state?.selectedApp) { return; }
    const selectedApp = this._state.selectedApp;
    if (selectedApp.permissions.length === 0) { return; }

    const confirm = await vscode.window.showWarningMessage(
      `Remove all ${selectedApp.permissions.length} configured permission(s) from "${selectedApp.displayName}"?`,
      { modal: true },
      'Remove all'
    );
    if (confirm !== 'Remove all') { return; }

    const isManagedIdentity = selectedApp.kind === 'servicePrincipal' && selectedApp.servicePrincipalType === 'ManagedIdentity';
    const effectiveId = selectedApp.kind === 'application'
      ? selectedApp.id
      : selectedApp.linkedAppObjectId;
    if (!effectiveId && !isManagedIdentity) { return; }

    this._state = { ...this._state, selectedApp: { ...selectedApp, saving: true, saveError: undefined } };
    this._render();

    try {
      if (isManagedIdentity) {
        // Fetch all assignments once (includes id), then delete each by id
        const allAssignments = await this._azure.graphListServicePrincipalAppRoleAssignments(selectedApp.id);
        for (const assignment of allAssignments) {
          await this._azure.graphDeleteAppRoleAssignment(selectedApp.id, assignment.id);
        }
      } else {
        await this._azure.graphPatchApplicationPermissions(effectiveId!, []);
      }
      await this._reloadSelectedApp();
    } catch (e) {
      this._state = { ...this._state, selectedApp: { ...this._state.selectedApp!, saving: false, saveError: errMsg(e) } };
      this._render();
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  private _render(): void {
    if (!this._panel || !this._state) { return; }
    this._panel.webview.html = this._buildHtml(this._state);
  }

  private _buildHtml(s: AppPermissionsPanelState): string {
    const bodyContent = s.selectedApp
      ? renderDetailView(s.selectedApp)
      : renderSearchView(s);

    const addPanelHtml = s.addPanel ? renderAddPanel(s.addPanel) : '';

    const script = `
      const vscode = acquireVsCodeApi();
      ${s.selectedApp ? DETAIL_SCRIPT : SEARCH_SCRIPT}
      ${s.addPanel ? ADD_PANEL_SCRIPT : ''}
    `;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>App Permissions</title>
<style>
${BASE_CSS}
${DETAIL_CSS}
${ADD_PANEL_CSS}
</style>
</head>
<body>
${bodyContent}
${addPanelHtml}
<script>${script}</script>
</body>
</html>`;
  }
}

// ── Search view rendering ─────────────────────────────────────────────────────

function renderSearchView(s: AppPermissionsPanelState): string {
  const prefill = s.identityAppId || s.identityPrincipalId;
  const bodyContent = s.searchLoading
    ? '<div class="loading-state">Searching…</div>'
    : s.searchError
      ? `<div class="error-state">Error: ${esc(s.searchError)}</div>`
      : s.searchResults.length === 0 && s.searchQuery
        ? '<div class="empty-state">No results found.</div>'
        : s.searchResults.length === 0
          ? '<div class="empty-state">Enter an app name or ID to search.</div>'
          : renderSearchResultsGrid(s.searchResults);

  return `
    <div class="panel-header">
      <div class="panel-title">Manage App Permissions</div>
    </div>
    <div class="search-toolbar">
      <input class="search-input search-main" id="main-search" type="text"
        value="${esc(prefill)}"
        placeholder="Search by name or app ID…"
        autocomplete="off" />
      <button class="btn btn-primary" id="btn-search">Search</button>
    </div>
    ${s.identityLoading ? '<div class="form-hint" style="padding:0 16px 8px">Loading managed identity…</div>' : ''}
    ${bodyContent}`;
}

function resultKindLabel(r: AppSearchResult): string {
  if (r.kind === 'application') { return 'App Registration'; }
  switch (r.servicePrincipalType) {
    case 'Application':     return 'Enterprise Application';
    case 'ManagedIdentity': return 'Managed Identity';
    case 'SocialIdp':       return 'Social Identity Provider';
    case 'Legacy':          return 'Legacy App';
    default:                return 'Service Principal';
  }
}

function resultKindCss(r: AppSearchResult): string {
  if (r.kind === 'application') { return 'badge-appreg'; }
  switch (r.servicePrincipalType) {
    case 'Application':     return 'badge-enterprise';
    case 'ManagedIdentity': return 'badge-managed';
    default:                return 'badge-sp';
  }
}

function renderSearchResultsGrid(results: AppSearchResult[]): string {
  const rows = results.map(r => {
    return `
      <div class="grid-row cols-apps" data-app-id="${esc(r.id)}" data-appid="${esc(r.appId)}" data-displayname="${esc(r.displayName)}" data-kind="${esc(r.kind)}" data-sptype="${esc(r.servicePrincipalType ?? '')}" style="cursor:pointer">
        <span class="cell cell-name">${esc(r.displayName)}</span>
        <span class="cell cell-muted">${esc(r.appId)}</span>
        <span class="cell"><span class="kind-badge ${resultKindCss(r)}">${esc(resultKindLabel(r))}</span></span>
      </div>`;
  }).join('');

  return `
    <div class="grid-container">
      <div class="grid-header cols-apps">
        <span class="cell">Display Name</span>
        <span class="cell">App ID</span>
        <span class="cell">Kind</span>
      </div>
      ${rows}
    </div>`;
}

// ── Search view JS ────────────────────────────────────────────────────────────

const SEARCH_SCRIPT = `
  function doSearch() {
    const q = document.getElementById('main-search')?.value || '';
    vscode.postMessage({ type: 'search', query: q });
  }

  document.getElementById('btn-search')?.addEventListener('click', doSearch);
  document.getElementById('main-search')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { doSearch(); }
  });

  document.querySelector('.grid-container')?.addEventListener('click', e => {
    const row = e.target.closest('[data-app-id]');
    if (row) {
      vscode.postMessage({
        type: 'selectApp',
        id:          row.getAttribute('data-app-id'),
        appId:       row.getAttribute('data-appid'),
        displayName: row.getAttribute('data-displayname'),
        kind:        row.getAttribute('data-kind'),
        servicePrincipalType: row.getAttribute('data-sptype') || undefined,
      });
    }
  });
`;

// ── Shared base CSS ───────────────────────────────────────────────────────────

const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    --fg:      var(--vscode-foreground);
    --surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --border:  var(--vscode-panel-border, var(--vscode-editorGroup-border));
    --muted:   var(--vscode-descriptionForeground);
    --accent:  var(--vscode-button-background);
    --hover:   var(--vscode-list-hoverBackground);
    --danger:  var(--vscode-errorForeground);
  }
  body { margin:0; padding:0; font-family: var(--vscode-font-family); font-size:13px; color:var(--fg); background:var(--surface); display:flex; flex-direction:column; height:100vh; overflow:hidden; }
  .panel-header { padding:12px 16px; border-bottom:1px solid var(--border); flex-shrink:0; }
  .panel-title { font-size:15px; font-weight:600; }
  .search-toolbar { display:flex; gap:8px; padding:10px 16px; flex-shrink:0; align-items:center; }
  .search-input { flex:1; padding:5px 8px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--border)); border-radius:3px; font-size:13px; }
  .search-main { max-width:480px; }
  .btn { padding:5px 12px; border:none; border-radius:3px; cursor:pointer; font-size:12px; font-family:inherit; }
  .btn-primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  .btn-primary:hover { background:var(--vscode-button-hoverBackground); }
  .btn-ghost { background:none; color:var(--fg); border:1px solid var(--border); }
  .btn-ghost:hover { background:var(--hover); }
  .btn:disabled { opacity:.5; cursor:default; }
  .loading-state, .empty-state, .error-state { padding:32px 16px; text-align:center; color:var(--muted); }
  .error-state { color:var(--danger); }
  .form-hint { font-size:11px; color:var(--muted); }
  .form-error { font-size:12px; color:var(--danger); }
  .grid-container { flex:1; overflow-y:auto; padding:0 16px 16px; }
  .grid-header { display:grid; position:sticky; top:0; background:var(--surface); border-bottom:1px solid var(--border); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); height:34px; align-items:center; margin:0 -16px; padding:0 16px; z-index:1; }
  .grid-row { display:grid; align-items:center; min-height:36px; border-bottom:1px solid var(--border); padding:0 2px; }
  .grid-row:hover { background:var(--hover); }
  .cols-apps { grid-template-columns: 2fr 2fr 120px; }
  .cell { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:0 4px; }
  .cell-name { font-weight:500; }
  .cell-muted { color:var(--muted); font-size:12px; }
  .kind-badge { font-size:11px; padding:2px 6px; border-radius:3px; }
  .kind-badge.badge-appreg     { background:color-mix(in srgb,#0078d4 15%,transparent); color:#0078d4; }
  .kind-badge.badge-enterprise { background:color-mix(in srgb,#107c10 15%,transparent); color:#107c10; }
  .kind-badge.badge-managed    { background:color-mix(in srgb,#8764b8 15%,transparent); color:#8764b8; }
  .kind-badge.badge-sp         { background:color-mix(in srgb,#d83b01 15%,transparent); color:#d83b01; }`;
