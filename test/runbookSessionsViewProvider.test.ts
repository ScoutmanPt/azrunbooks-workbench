import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { RunbookSessionsViewProvider } from '../src/runbookSessionsViewProvider.js';

describe('RunbookSessionsViewProvider', () => {
  it('renders sessions, output, selection, and clear interactions', () => {
    const provider = new RunbookSessionsViewProvider(vscode.Uri.file('/tmp'));
    const view = new vscode.WebviewView();

    provider.resolveWebviewView(view);
    assert.ok(view.webview.html.includes('No runbook sessions yet.'));

    const sessionA = provider.startSession('RunbookA', 'PowerShell');
    provider.appendOutput(sessionA, 'Hello from A', 'stdout');
    provider.completeSession(sessionA, true, 'Completed A');

    const sessionB = provider.startSession('RunbookB', 'Python');
    provider.appendOutput(sessionB, 'Problem on B', 'stderr');
    provider.completeSession(sessionB, false, 'Failed B');

    assert.ok(view.webview.html.includes('RunbookB'));
    assert.ok(view.webview.html.includes('Problem on B'));
    assert.ok(view.webview.html.includes('Failed'));

    view.webview.__fireMessage({ type: 'select', sessionId: sessionA });
    assert.ok(view.webview.html.includes('RunbookA'));
    assert.ok(view.webview.html.includes('Hello from A'));

    view.webview.__fireMessage({ type: 'clear' });
    assert.ok(view.webview.html.includes('No runbook sessions yet.'));
    assert.ok(view.webview.html.includes('Run a script locally to see live output here.'));
  });

  it('trims retained sessions to the most recent 15', () => {
    const provider = new RunbookSessionsViewProvider(vscode.Uri.file('/tmp'));
    const view = new vscode.WebviewView();
    provider.resolveWebviewView(view);

    for (let index = 0; index < 17; index++) {
      provider.startSession(`Runbook-${index.toString().padStart(2, '0')}`, 'PowerShell');
    }

    assert.ok(view.webview.html.includes('Runbook-16'));
    assert.ok(!view.webview.html.includes('Runbook-00'));
    assert.ok(!view.webview.html.includes('Runbook-01'));
  });
});
