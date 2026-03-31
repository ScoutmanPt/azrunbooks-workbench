import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { _testState } from 'vscode';
import { JobsPanel } from '../src/jobsPanel.js';

describe('JobsPanel', () => {
  it('renders jobs and loads details after selecting a job row', async () => {
    _testState.webviewPanels.length = 0;

    const azure = {
      listJobsForRunbook: async () => [
        {
          jobId: 'job-001',
          runbookName: 'Get-PnPSites',
          status: 'Completed',
          creationTime: '2026-03-19T21:00:26.000Z',
          lastModifiedTime: '2026-03-19T21:03:15.000Z',
        },
        {
          jobId: 'job-002',
          runbookName: 'Get-PnPSites',
          status: 'Running',
          creationTime: '2026-03-20T09:10:00.000Z',
          lastModifiedTime: '2026-03-20T09:12:00.000Z',
        },
      ],
      getJobDetails: async (_sub: string, _rg: string, _acct: string, jobId: string) => ({
        jobId,
        runbookName: 'Get-PnPSites',
        status: 'Completed',
        startedBy: 'user@contoso.com',
        runOn: '',
        provisioningState: 'Succeeded',
        creationTime: '2026-03-19T21:00:26.000Z',
        startTime: '2026-03-19T21:00:26.000Z',
        endTime: '2026-03-19T21:03:15.000Z',
        lastModifiedTime: '2026-03-19T21:03:15.000Z',
        lastStatusModifiedTime: '2026-03-19T21:03:15.000Z',
        exception: '',
        statusDetails: '',
        parameters: { SiteUrl: 'https://contoso.sharepoint.com' },
        streams: [
          {
            streamType: 'Output',
            summary: 'Fetched 8 sites',
            time: '2026-03-19T21:01:00.000Z',
          },
          {
            streamType: 'Warning',
            summary: 'Throttle observed',
            time: '2026-03-19T21:01:05.000Z',
          },
        ],
      }),
    } as any;

    const jobsPanel = new JobsPanel(
      vscode.Uri.file('/tmp'),
      azure,
      { appendLine: () => undefined } as any
    );

    await jobsPanel.openForRunbook({
      name: 'Get-PnPSites',
      runbookType: 'PowerShell72',
      state: 'Published',
      accountName: 'aa-extension',
      resourceGroupName: 'rg_runbooks',
      subscriptionId: 'sub-1',
      subscriptionName: 'Sub One',
    });

    const panel = _testState.webviewPanels.at(-1);
    assert.ok(panel);
    assert.ok(panel?.webview.html.includes('Search jobs'));
    assert.ok(panel?.webview.html.includes('Get-PnPSites'));
    assert.ok(panel?.webview.html.includes('job-001'));
    assert.ok(panel?.webview.html.includes('job-002'));

    await panel?.webview.__fireMessage({ type: 'selectJob', jobId: 'job-001' });

    assert.ok(panel?.webview.html.includes('Fetched 8 sites'));
    assert.ok(panel?.webview.html.includes('Throttle observed'));
    assert.ok(panel?.webview.html.includes('SiteUrl'));
    assert.ok(panel?.webview.html.includes('https://contoso.sharepoint.com'));
  });

  it('renders account-scoped jobs with mixed runbooks', async () => {
    _testState.webviewPanels.length = 0;

    const azure = {
      listJobsForAccount: async () => [
        {
          jobId: 'job-101',
          runbookName: 'Get-PnPSites',
          status: 'Completed',
          creationTime: '2026-03-19T21:00:26.000Z',
          lastModifiedTime: '2026-03-19T21:03:15.000Z',
        },
        {
          jobId: 'job-102',
          runbookName: 'Sync-Assets',
          status: 'Running',
          creationTime: '2026-03-20T09:10:00.000Z',
          lastModifiedTime: '2026-03-20T09:12:00.000Z',
        },
      ],
      getJobDetails: async (_sub: string, _rg: string, _acct: string, jobId: string) => ({
        jobId,
        runbookName: 'Sync-Assets',
        status: 'Running',
        startedBy: 'user@contoso.com',
        runOn: 'Azure',
        provisioningState: 'Processing',
        creationTime: '2026-03-20T09:10:00.000Z',
        startTime: '2026-03-20T09:10:30.000Z',
        endTime: '',
        lastModifiedTime: '2026-03-20T09:12:00.000Z',
        lastStatusModifiedTime: '2026-03-20T09:12:00.000Z',
        exception: '',
        statusDetails: '',
        parameters: {},
        streams: [
          {
            streamType: 'Output',
            summary: 'Asset sync in progress',
            time: '2026-03-20T09:11:00.000Z',
          },
        ],
      }),
    } as any;

    const jobsPanel = new JobsPanel(
      vscode.Uri.file('/tmp'),
      azure,
      { appendLine: () => undefined } as any
    );

    await jobsPanel.openForAccount({
      name: 'aa-extension',
      resourceGroupName: 'rg_runbooks',
      subscriptionId: 'sub-1',
      subscriptionName: 'Sub One',
      location: 'uksouth',
      id: '/subscriptions/sub-1/resourceGroups/rg_runbooks/providers/Microsoft.Automation/automationAccounts/aa-extension',
    });

    const panel = _testState.webviewPanels.at(-1);
    assert.ok(panel);
    assert.ok(panel?.webview.html.includes('aa-extension'));
    assert.ok(panel?.webview.html.includes('All runbooks'));
    assert.ok(panel?.webview.html.includes('Get-PnPSites'));
    assert.ok(panel?.webview.html.includes('Sync-Assets'));
    assert.ok(panel?.webview.html.includes('Mixed'));

    await panel?.webview.__fireMessage({ type: 'selectJob', jobId: 'job-102' });

    assert.ok(panel?.webview.html.includes('Asset sync in progress'));
    assert.ok(panel?.webview.html.includes('Sync-Assets'));
  });
});
