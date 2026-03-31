import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { _testState } from 'vscode';
import { AuthManager } from '../src/authManager.js';

describe('AuthManager', () => {
  beforeEach(() => {
    _testState.config = {};
    _testState.ui = {};
    _testState.messages.info.length = 0;
    _testState.messages.warn.length = 0;
    _testState.messages.error.length = 0;
  });

  it('suppresses silent sign-in after explicit sign-out until sign-in succeeds again', async () => {
    (vscode.authentication as any).getSession = async () => ({
      accessToken: 'token-1',
      account: { label: 'Rodrigo' },
      scopes: ['https://management.azure.com/.default'],
    });

    const auth = new AuthManager({} as vscode.ExtensionContext);

    assert.equal(auth.shouldAttemptSilentSignIn, true);
    assert.equal(await auth.signIn(true), true);
    assert.equal(auth.isSignedIn, true);
    assert.equal(auth.shouldAttemptSilentSignIn, true);

    await auth.signOut();
    assert.equal(auth.isSignedIn, false);
    assert.equal(auth.shouldAttemptSilentSignIn, false);

    assert.equal(await auth.signIn(true), true);
    assert.equal(auth.isSignedIn, true);
    assert.equal(auth.shouldAttemptSilentSignIn, true);
  });

  it('keeps silent sign-in enabled when silent sign-in simply returns no session', async () => {
    (vscode.authentication as any).getSession = async () => undefined;

    const auth = new AuthManager({} as vscode.ExtensionContext);

    assert.equal(await auth.signIn(true), false);
    assert.equal(auth.isSignedIn, false);
    assert.equal(auth.shouldAttemptSilentSignIn, true);
  });
});
