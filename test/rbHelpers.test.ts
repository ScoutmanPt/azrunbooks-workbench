/**
 * Unit tests for pure helper functions in rbCommands:
 *   - extractRunbookRef (Uri path parsing)
 *   - RunbookDiffContentProvider
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractRunbookRef, resolveRunbookForLocalRun, RunbookDiffContentProvider } from '../src/rbCommands.js';
import { WorkspaceRunbookItem } from '../src/workspaceRunbooksTreeProvider.js';
import * as vscode from 'vscode';

// ── extractRunbookRef ─────────────────────────────────────────────────────────

describe('extractRunbookRef - from WorkspaceRunbookItem', () => {
  it('extracts accountName, runbookName, filePath', () => {
    const item = new WorkspaceRunbookItem({
      accountName: 'my-account',
      runbookName: 'MyRunbook',
      filePath: '/workspace/aaccounts/my-account/MyRunbook.ps1',
      runbookType: 'PowerShell',
      localHash: 'abc',
    });
    const ref = extractRunbookRef(item);
    assert.ok(ref);
    assert.equal(ref.accountName, 'my-account');
    assert.equal(ref.runbookName, 'MyRunbook');
  });
});

describe('extractRunbookRef - from vscode.Uri (file explorer right-click)', () => {
  it('parses accountName from path containing aaccounts segment', () => {
    const uri = vscode.Uri.file('/workspace/aaccounts/prod-account/Deploy.ps1');
    const ref = extractRunbookRef(uri);
    assert.ok(ref);
    assert.equal(ref.accountName, 'prod-account');
    assert.equal(ref.runbookName, 'Deploy');
  });

  it('strips extension correctly for .py files', () => {
    const uri = vscode.Uri.file('/workspace/aaccounts/dev-account/Cleanup.py');
    const ref = extractRunbookRef(uri);
    assert.ok(ref);
    assert.equal(ref.runbookName, 'Cleanup');
  });

  it('works with Windows-style backslash paths', () => {
    const uri = vscode.Uri.file('C:\\workspace\\aaccounts\\my-acct\\MyRb.ps1');
    const ref = extractRunbookRef(uri);
    assert.ok(ref);
    assert.equal(ref.accountName, 'my-acct');
  });

  it('returns undefined when aaccounts segment is not in path', () => {
    const uri = vscode.Uri.file('/some/other/path/file.ps1');
    assert.equal(extractRunbookRef(uri), undefined);
  });

  it('returns undefined for non-Uri, non-WorkspaceRunbookItem values', () => {
    assert.equal(extractRunbookRef(null), undefined);
    assert.equal(extractRunbookRef(undefined), undefined);
    assert.equal(extractRunbookRef(42), undefined);
    assert.equal(extractRunbookRef('string'), undefined);
  });
});

// ── RunbookDiffContentProvider ────────────────────────────────────────────────

describe('RunbookDiffContentProvider', () => {
  const provider = new RunbookDiffContentProvider();

  it('decodes URI query as runbook content', () => {
    const content = 'Write-Host "hello world"';
    const uri = { query: encodeURIComponent(content) } as any;
    assert.equal(provider.provideTextDocumentContent(uri), content);
  });

  it('returns empty string for malformed query', () => {
    const uri = { query: '%GG' } as any; // invalid URI encoding
    assert.equal(provider.provideTextDocumentContent(uri), '');
  });

  it('returns empty string for empty query', () => {
    const uri = { query: '' } as any;
    assert.equal(provider.provideTextDocumentContent(uri), '');
  });

  it('preserves multi-line content', () => {
    const content = 'line1\nline2\nline3';
    const uri = { query: encodeURIComponent(content) } as any;
    assert.equal(provider.provideTextDocumentContent(uri), content);
  });
});

describe('resolveRunbookForLocalRun', () => {
  it('falls back to the local file when the runbook does not exist in Azure', async () => {
    const uri = vscode.Uri.file('/tmp/rb-local-run/aaccounts/aa-test/LocalOnly.py');
    const azure = {
      listRunbooks: async () => [],
    } as any;
    const workspace = {
      getLinkedAccount: () => ({
        accountName: 'aa-test',
        resourceGroup: 'rg-test',
        subscriptionId: 'sub-test',
        subscriptionName: 'Sub Test',
        location: 'westeurope',
      }),
    } as any;

    const resolved = await resolveRunbookForLocalRun(uri, azure, workspace);
    assert.ok(resolved);
    assert.equal(resolved.name, 'LocalOnly');
    assert.equal(resolved.runbookType, 'Python3');
    assert.equal(resolved.accountName, 'aa-test');
  });
});
