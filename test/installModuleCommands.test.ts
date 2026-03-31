import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { _testState } from 'vscode';
import { executeInstallModuleForLocalDebug } from '../src/installModuleCommands.js';

describe('executeInstallModuleForLocalDebug', () => {
  beforeEach(() => {
    _testState.ui = {};
    _testState.messages.info.length = 0;
    _testState.messages.warn.length = 0;
    _testState.messages.error.length = 0;
  });

  it('searches, picks, and installs a stable module version with no dependencies', async () => {
    _testState.ui.showInputBox = ['PnP'];
    _testState.ui.showQuickPick = [
      { label: 'PnP.PowerShell', value: 'PnP.PowerShell' },
      { label: 'Latest available version', value: '' },
    ];

    const calls: Array<{ module: string; version: string; deps: unknown[] }> = [];
    const runner = {
      searchPowerShellModules: async (term: string) => {
        assert.equal(term, 'PnP');
        return ['PnP.PowerShell'];
      },
      listPowerShellModuleVersions: async (module: string, includePrerelease: boolean) => {
        assert.equal(module, 'PnP.PowerShell');
        assert.equal(includePrerelease, false);
        return ['3.1.0', '3.0.0'];
      },
      resolveModuleDependencies: async (_module: string, _version: string) => [],
      installModuleWithDependencies: async (module: string, version: string, deps: unknown[]) => {
        calls.push({ module, version, deps });
      },
    } as any;

    await executeInstallModuleForLocalDebug(undefined, runner, { appendLine: () => undefined } as any);

    assert.deepEqual(calls, [{ module: 'PnP.PowerShell', version: '3.1.0', deps: [] }]);
    assert.ok(_testState.messages.info.some(message => message.includes('Saved "PnP.PowerShell"')));
  });

  it('falls back to prerelease versions when no stable versions are returned', async () => {
    _testState.ui.showInputBox = ['MyModule'];
    _testState.ui.showQuickPick = [
      { label: 'MyModule', value: 'MyModule' },
      { label: '1.0.0-nightly', value: '1.0.0-nightly' },
    ];

    const versionQueries: boolean[] = [];
    const calls: Array<{ module: string; version: string; deps: unknown[] }> = [];
    const runner = {
      searchPowerShellModules: async () => ['MyModule'],
      listPowerShellModuleVersions: async (_module: string, includePrerelease: boolean) => {
        versionQueries.push(includePrerelease);
        return includePrerelease ? ['1.0.0-nightly'] : [];
      },
      resolveModuleDependencies: async (_module: string, _version: string) => [],
      installModuleWithDependencies: async (module: string, version: string, deps: unknown[]) => {
        calls.push({ module, version, deps });
      },
    } as any;

    await executeInstallModuleForLocalDebug(undefined, runner, { appendLine: () => undefined } as any);

    assert.deepEqual(versionQueries, [false, true]);
    assert.deepEqual(calls, [{ module: 'MyModule', version: '1.0.0-nightly', deps: [] }]);
  });

  it('warns about dependencies and installs them when user confirms', async () => {
    _testState.ui.showInputBox = ['Az.Accounts'];
    _testState.ui.showQuickPick = [
      { label: 'Az.Accounts', value: 'Az.Accounts' },
      { label: '3.0.0', value: '3.0.0' },
    ];
    _testState.ui.showWarningMessage = ['Install All'];

    const installCalls: Array<{ module: string; version: string; deps: unknown[] }> = [];
    const runner = {
      searchPowerShellModules: async () => ['Az.Accounts'],
      listPowerShellModuleVersions: async () => ['3.0.0', '2.9.0'],
      resolveModuleDependencies: async (_module: string, _version: string) => [
        { name: 'Az.Core', version: '1.2.0' },
      ],
      installModuleWithDependencies: async (module: string, version: string, deps: unknown[]) => {
        installCalls.push({ module, version, deps });
      },
    } as any;

    await executeInstallModuleForLocalDebug(undefined, runner, { appendLine: () => undefined } as any);

    assert.deepEqual(installCalls, [{
      module: 'Az.Accounts',
      version: '3.0.0',
      deps: [{ name: 'Az.Core', version: '1.2.0' }],
    }]);
    assert.ok(_testState.messages.info.some(m => m.includes('1 dependency')));
  });
});
