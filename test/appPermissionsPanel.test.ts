import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { _testState } from 'vscode';
import { AppPermissionsPanel } from '../src/appPermissionsPanel.js';

describe('AppPermissionsPanel', () => {
  it('resolves managed identity by object id and shows direct service principal permissions', async () => {
    _testState.webviewPanels.length = 0;
    const grantCalls: Array<{ principalId: string; resourceId: string; appRoleId: string }> = [];

    const azure = {
      getAutomationAccountIdentity: async () => ({
        principalId: 'sp-object-id-123',
        tenantId: 'tenant-1',
      }),
      graphGetServicePrincipalById: async (objectId: string) => ({
        id: objectId,
        appId: 'mi-app-id-456',
        displayName: 'aa-etension',
        servicePrincipalType: 'ManagedIdentity',
      }),
      graphSearchApplications: async (query: string) => query === 'mi-app-id-456'
        ? []
        : [],
      graphSearchServicePrincipals: async (query: string) => query === 'mi-app-id-456'
        ? [{
            id: 'sp-object-id-123',
            appId: 'mi-app-id-456',
            displayName: 'aa-etension',
            servicePrincipalType: 'ManagedIdentity',
          }]
        : [],
      graphListServicePrincipalAppRoleAssignments: async () => [{
        resourceId: 'graph-sp-id',
        appRoleId: 'role-1',
      }],
      graphListServicePrincipalOauth2PermissionGrants: async () => [{
        resourceId: 'graph-sp-id',
        scope: 'User.Read',
      }],
      graphGetServicePrincipalPermissionsById: async (resourceId: string) => ({
        id: resourceId,
        appId: '00000003-0000-0000-c000-000000000000',
        displayName: 'Microsoft Graph',
        delegated: [{
          id: 'scope-1',
          value: 'User.Read',
          displayName: 'Sign in and read user profile',
          description: 'Allows users to sign in and read their profile.',
          adminConsentRequired: false,
        }],
        application: [{
          id: 'role-1',
          value: 'Sites.Read.All',
          displayName: 'Read items in all site collections',
          description: 'Allows the app to read all site collections.',
          adminConsentRequired: true,
        }],
      }),
      graphGetServicePrincipalPermissions: async (appId: string) => ({
        id: `${appId}-sp`,
        displayName: appId === '00000003-0000-0ff1-ce00-000000000000' ? 'SharePoint Online' : 'Microsoft Graph',
        delegated: [],
        application: [{
          id: appId === '00000003-0000-0ff1-ce00-000000000000' ? 'sp-role-1' : 'role-2',
          value: appId === '00000003-0000-0ff1-ce00-000000000000' ? 'Sites.Read.All' : 'Directory.Read.All',
          displayName: 'Test application permission',
          description: 'Permission used for testing.',
          adminConsentRequired: true,
        }],
      }),
      graphGetServicePrincipalByAppId: async (appId: string) => ({
        id: `${appId}-sp`,
        appId,
        displayName: 'Microsoft Graph',
        servicePrincipalType: 'Application',
      }),
      graphGrantAdminConsent: async (principalId: string, resourceId: string, appRoleId: string) => {
        grantCalls.push({ principalId, resourceId, appRoleId });
      },
    } as any;

    const panel = new AppPermissionsPanel(
      vscode.Uri.file('/tmp'),
      azure,
      {} as any,
      { appendLine: () => undefined } as any
    );

    await panel.openForAccount({
      name: 'aa-etension',
      resourceGroupName: 'rg_runbooks',
      subscriptionId: 'sub-1',
      subscriptionName: 'Sub One',
      location: 'uksouth',
      id: '/subscriptions/sub-1/resourceGroups/rg_runbooks/providers/Microsoft.Automation/automationAccounts/aa-etension',
    });

    const webviewPanel = _testState.webviewPanels.at(-1);
    assert.ok(webviewPanel);
    assert.ok(webviewPanel?.webview.html.includes('mi-app-id-456'));

    await webviewPanel?.webview.__fireMessage({ type: 'search', query: 'mi-app-id-456' });
    assert.ok(webviewPanel?.webview.html.includes('Managed Identity'));

    await webviewPanel?.webview.__fireMessage({
      type: 'selectApp',
      id: 'sp-object-id-123',
      appId: 'mi-app-id-456',
      displayName: 'aa-etension',
      kind: 'servicePrincipal',
      servicePrincipalType: 'ManagedIdentity',
    });

    assert.ok(webviewPanel?.webview.html.includes('Object ID: sp-object-id-123'));
    assert.ok(webviewPanel?.webview.html.includes('Managed Identity'));
    assert.ok(webviewPanel?.webview.html.includes('Managed identity permissions are managed directly on the service principal.'));
    assert.ok(webviewPanel?.webview.html.includes('Microsoft Graph'));
    assert.ok(webviewPanel?.webview.html.includes('Sites.Read.All'));
    assert.ok(webviewPanel?.webview.html.includes('User.Read'));

    await webviewPanel?.webview.__fireMessage({ type: 'showAddPanel' });
    assert.ok(webviewPanel?.webview.html.includes('Managed identities do not support delegated permissions.'));
    assert.ok(webviewPanel?.webview.html.includes('value="delegated" disabled'));
    assert.ok(webviewPanel?.webview.html.includes('0 selected'));

    await webviewPanel?.webview.__fireMessage({ type: 'addPanelTogglePermission', permissionId: 'role-2', checked: true });
    assert.ok(webviewPanel?.webview.html.includes('1 selected'));
    await webviewPanel?.webview.__fireMessage({ type: 'addPanelSwitchTab', tab: 'sharepoint' });
    await webviewPanel?.webview.__fireMessage({ type: 'addPanelTogglePermission', permissionId: 'sp-role-1', checked: true });
    assert.ok(webviewPanel?.webview.html.includes('2 selected'));
    await webviewPanel?.webview.__fireMessage({ type: 'addPermissions' });
    assert.deepEqual(grantCalls, [{
      principalId: 'sp-object-id-123',
      resourceId: '00000003-0000-0000-c000-000000000000-sp',
      appRoleId: 'role-2',
    }, {
      principalId: 'sp-object-id-123',
      resourceId: '00000003-0000-0ff1-ce00-000000000000-sp',
      appRoleId: 'sp-role-1',
    }]);
  });
});
