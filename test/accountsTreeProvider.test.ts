import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountsTreeProvider, AccountSectionItem, AutomationAccountItem, SignInItem } from '../src/accountsTreeProvider.js';
import { SubscriptionColorRegistry } from '../src/subscriptionColorRegistry.js';

describe('AccountsTreeProvider', () => {
  const account = {
    name: 'aa-demo',
    resourceGroupName: 'rg-demo',
    subscriptionId: 'sub-1',
    subscriptionName: 'Sub One',
    location: 'westeurope',
    id: '/subscriptions/sub-1/resourceGroups/rg-demo/providers/Microsoft.Automation/automationAccounts/aa-demo',
  };

  const auth = {
    isSignedIn: true,
    onDidSignInChange: () => ({ dispose: () => {} }),
    signIn: async () => true,
  } as any;

  it('loads schedules instead of placeholder items', async () => {
    const azure = {
      listSchedules: async () => [{ name: 'Daily', frequency: 'Day', interval: 1, nextRun: '2026-03-18T12:00:00Z', isEnabled: true }],
    } as any;
    const tree = new AccountsTreeProvider(auth, azure, new SubscriptionColorRegistry());
    const section = new AccountSectionItem(account as any, 'schedules', 'charts.blue');
    const children = await tree.getChildren(section);
    assert.equal(children.length, 1);
    assert.equal((children[0] as any).label, 'Daily');
    assert.equal((children[0] as any).description, 'Day');
  });

  it('loads assets from variables, credentials, connections, and certificates', async () => {
    const azure = {
      listVariables: async () => [{ name: 'PlainVar', value: 'abc', isEncrypted: false }],
      listCredentials: async () => [{ name: 'MyCred', userName: 'user@contoso.com', description: 'demo', _type: 'credential' }],
      listConnections: async () => [{ name: 'MyConn', connectionType: 'AzureServicePrincipal', description: 'sp', _type: 'connection' }],
      listCertificates: async () => [{ name: 'MyCert', thumbprint: 'ABC123', expiryTime: '2026-12-31T00:00:00Z', description: 'cert', isExportable: false, _type: 'certificate' }],
    } as any;
    const tree = new AccountsTreeProvider(auth, azure, new SubscriptionColorRegistry());
    const section = new AccountSectionItem(account as any, 'assets', 'charts.blue');
    const children = await tree.getChildren(section);
    assert.equal(children.length, 4);
    assert.ok(children.some((child: any) => child.label === 'PlainVar'));
    assert.ok(children.some((child: any) => child.label === 'MyCred'));
    assert.ok(children.some((child: any) => child.label === 'MyConn'));
    assert.ok(children.some((child: any) => child.label === 'MyCert'));
  });

  it('loads runtime environments instead of placeholder items', async () => {
    const azure = {
      listRuntimeEnvironments: async () => [{ name: 'Python-3.10', language: 'Python', version: '3.10', provisioningState: 'Succeeded' }],
    } as any;
    const tree = new AccountsTreeProvider(auth, azure, new SubscriptionColorRegistry());
    const section = new AccountSectionItem(account as any, 'runtimeEnvironments', 'charts.blue');
    const children = await tree.getChildren(section);
    assert.equal(children.length, 1);
    assert.equal((children[0] as any).label, 'Python-3.10');
    assert.equal((children[0] as any).description, 'Python 3.10');
  });

  it('shows all section nodes under an automation account', async () => {
    const tree = new AccountsTreeProvider(auth, {} as any, new SubscriptionColorRegistry());
    const children = await tree.getChildren(new AutomationAccountItem(account as any, 'charts.blue'));
    assert.equal(children.length, 8);
    assert.ok(children.some((child: any) => child.label === 'Runtime Environments'));
  });

  it('does not silently sign back in after an explicit sign-out', async () => {
    let signInCalls = 0;
    const signedOutAuth = {
      isSignedIn: false,
      shouldAttemptSilentSignIn: false,
      onDidSignInChange: () => ({ dispose: () => {} }),
      signIn: async () => {
        signInCalls++;
        return false;
      },
    } as any;

    const tree = new AccountsTreeProvider(signedOutAuth, {} as any, new SubscriptionColorRegistry());
    const children = await tree.getChildren();

    assert.equal(signInCalls, 0);
    assert.equal(children.length, 1);
    assert.ok(children[0] instanceof SignInItem);
  });
});
