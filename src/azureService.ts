import { AutomationClient } from '@azure/arm-automation';
import type { AuthManager } from './authManager';

export interface AzureSubscription {
  id: string;
  name: string;
  tenantId: string;
}

export interface AzureResourceGroup {
  name: string;
  location: string;
  subscriptionId: string;
}

export interface AzureAutomationAccount {
  name: string;
  resourceGroupName: string;
  subscriptionId: string;
  subscriptionName: string;
  location: string;
  id: string;
}

export interface RunbookSummary {
  name: string;
  runbookType: string; // PowerShell, PowerShell72, Python3, Python2, etc.
  state: string;       // Published, Draft, New
  lastModifiedTime?: Date;
  description?: string;
  runtimeEnvironment?: string;
  accountName: string;
  resourceGroupName: string;
  subscriptionId: string;
  subscriptionName: string;
  accountLocation?: string;
}

export interface RuntimeEnvironmentSummary extends Record<string, unknown> {
  name: string;
  description?: string;
  language?: string;
  version?: string;
  provisioningState?: string;
  defaultPackages?: Record<string, string>;
}

export interface RuntimeEnvironmentCreateRequest {
  name: string;
  location: string;
  language: string;
  version: string;
  description?: string;
  defaultPackages?: Record<string, string>;
}

export interface JobScheduleLink {
  jobScheduleId: string;
  scheduleName: string;
  runbookName: string;
  runOn?: string;
  parameters?: Record<string, string>;
}

export interface AutomationSchedule {
  name: string;
  description?: string;
  startTime?: string;
  expiryTime?: string;
  nextRun?: string;
  frequency: string;
  interval?: number;
  timeZone?: string;
  isEnabled: boolean;
  advancedSchedule?: {
    weekDays?: string[];
    monthDays?: number[];
    monthlyOccurrences?: Array<{ day: string; occurrence: number }>;
  };
  creationTime?: string;
  lastModifiedTime?: string;
}

export interface AutomationJobSummary {
  jobId: string;
  runbookName?: string;
  status?: string;
  creationTime?: string;
  startTime?: string;
  endTime?: string;
  lastModifiedTime?: string;
  runOn?: string;
  provisioningState?: string;
  runtimeEnvironment?: string;
}

export interface AutomationJobStream {
  jobStreamId?: string;
  streamType: string;
  summary: string;
  streamText?: string;
  value?: string;
  time?: string;
}

export interface AutomationJobDetail {
  jobId: string;
  runbookName?: string;
  status?: string;
  statusDetails?: string;
  startedBy?: string;
  runOn?: string;
  provisioningState?: string;
  creationTime?: string;
  startTime?: string;
  endTime?: string;
  lastModifiedTime?: string;
  lastStatusModifiedTime?: string;
  exception?: string;
  parameters: Record<string, string>;
  streams: AutomationJobStream[];
}

/**
 * AzureService wraps the Azure ARM SDK clients.
 * All methods are lazy - clients are constructed on first use
 * so auth is not required at activation time.
 */
export class AzureService {
  private readonly _clients = new Map<string, AutomationClient>();

  constructor(private readonly auth: AuthManager) {
    // Invalidate cached clients when auth state changes (sign in/out or cloud switch)
    auth.onDidSignInChange(() => this._clients.clear());
  }

  private automationClient(subscriptionId: string): AutomationClient {
    let client = this._clients.get(subscriptionId);
    if (!client) {
      client = new AutomationClient(
        this.auth.getCredential(),
        subscriptionId,
        'status',
        { baseUri: this.auth.getResourceManagerEndpoint() }
      );
      this._clients.set(subscriptionId, client);
    }
    return client;
  }

  async listSubscriptions(): Promise<AzureSubscription[]> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions?api-version=2022-12-01`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { throw new Error(`Subscriptions list failed: ${res.status} ${res.statusText}`); }
    const body = await res.json() as { value: Array<{ subscriptionId: string; displayName: string; tenantId: string }> };
    return (body.value ?? [])
      .filter(s => s.subscriptionId && s.displayName)
      .map(s => ({ id: s.subscriptionId, name: s.displayName, tenantId: s.tenantId ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listResourceGroups(subscriptionId: string): Promise<AzureResourceGroup[]> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourcegroups?api-version=2021-04-01`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { throw new Error(`Resource groups list failed: ${res.status} ${res.statusText}`); }
    const body = await res.json() as {
      value?: Array<{ name?: string; location?: string; id?: string }>;
    };
    return (body.value ?? [])
      .filter(rg => rg.name)
      .map(rg => ({
        name: rg.name ?? '',
        location: rg.location ?? '',
        subscriptionId,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createOrUpdateResourceGroup(
    subscriptionId: string,
    resourceGroupName: string,
    location: string
  ): Promise<void> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(resourceGroupName)}?api-version=2021-04-01`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ location }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Create resource group failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
    }
  }

  async listAutomationAccounts(subscriptionId: string, subscriptionName: string): Promise<AzureAutomationAccount[]> {
    const client = this.automationClient(subscriptionId);
    const results: AzureAutomationAccount[] = [];

    let response = await client.automationAccount.list();
    for (const account of response) {
      if (!account.name || !account.id) { continue; }
      const rgMatch = account.id.match(/resourceGroups\/([^/]+)\//i);
      const resourceGroupName = rgMatch ? rgMatch[1] : 'unknown';
      results.push({
        name: account.name,
        resourceGroupName,
        subscriptionId,
        subscriptionName,
        location: account.location ?? '',
        id: account.id,
      });
    }
    while (response.nextLink) {
      response = await client.automationAccount.listNext(response.nextLink);
      for (const account of response) {
        if (!account.name || !account.id) { continue; }
        const rgMatch = account.id.match(/resourceGroups\/([^/]+)\//i);
        const resourceGroupName = rgMatch ? rgMatch[1] : 'unknown';
        results.push({
          name: account.name,
          resourceGroupName,
          subscriptionId,
          subscriptionName,
          location: account.location ?? '',
          id: account.id,
        });
      }
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  async createAutomationAccount(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    location: string
  ): Promise<void> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroupName)}/providers/Microsoft.Automation/automationAccounts/${encodeURIComponent(accountName)}?api-version=2023-11-01`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        location,
        identity: {
          type: 'SystemAssigned',
        },
        properties: {
          encryption: {
            keySource: 'Microsoft.Automation',
          },
          publicNetworkAccess: true,
          sku: {
            name: 'Basic',
          },
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Create automation account failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
    }
  }

  async listRunbooks(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    subscriptionName: string
  ): Promise<RunbookSummary[]> {
    const client = this.automationClient(subscriptionId);
    const results: RunbookSummary[] = [];

    let response = await client.runbook.listByAutomationAccount(resourceGroupName, accountName);
    for (const rb of response) {
      if (!rb.name) { continue; }
      results.push({
        name: rb.name,
        runbookType: rb.runbookType ?? 'Unknown',
        state: rb.state ?? 'Unknown',
        lastModifiedTime: rb.lastModifiedTime,
        description: rb.description,
        runtimeEnvironment: (rb as { runtimeEnvironment?: string }).runtimeEnvironment,
        accountName,
        resourceGroupName,
        subscriptionId,
        subscriptionName,
        accountLocation: rb.location,
      });
    }
    while (response.nextLink) {
      response = await client.runbook.listByAutomationAccountNext(response.nextLink);
      for (const rb of response) {
        if (!rb.name) { continue; }
        results.push({
          name: rb.name,
          runbookType: rb.runbookType ?? 'Unknown',
          state: rb.state ?? 'Unknown',
          lastModifiedTime: rb.lastModifiedTime,
          description: rb.description,
          runtimeEnvironment: (rb as { runtimeEnvironment?: string }).runtimeEnvironment,
          accountName,
          resourceGroupName,
          subscriptionId,
          subscriptionName,
        });
      }
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getRunbookContent(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runbookName: string,
    type: 'published' | 'draft' = 'published'
  ): Promise<string> {
    const client = this.automationClient(subscriptionId);

    // The SDK returns a ReadableStream; we collect it to a string
    if (type === 'draft') {
      const resp = await client.runbookDraft.getContent(resourceGroupName, accountName, runbookName);
      if (!resp.readableStreamBody) { throw new Error('No content stream returned for draft runbook.'); }
      return streamToString(resp.readableStreamBody);
    } else {
      const resp = await client.runbook.getContent(resourceGroupName, accountName, runbookName);
      if (!resp.readableStreamBody) { throw new Error('No content stream returned for published runbook.'); }
      return streamToString(resp.readableStreamBody);
    }
  }

  async publishRunbook(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runbookName: string
  ): Promise<void> {
    // The ARM SDK's runbook.publish() is an LRO that tries to parse the 202
    // response body as JSON, but Azure returns the runbook script text - causing
    // a SyntaxError. Call the REST endpoint directly instead.
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Automation/automationAccounts/${accountName}/runbooks/${runbookName}/publish?api-version=2023-11-01`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    // Both 200 (sync) and 202 (async accepted) are success - res.ok covers both
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Publish failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
    }
  }

  async uploadDraftContent(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runbookName: string,
    content: string
  ): Promise<void> {
    // Use direct REST - the SDK's replaceContent is an LRO that tries to parse
    // the PowerShell/Python script body as JSON response, causing a SyntaxError.
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Automation/automationAccounts/${accountName}/runbooks/${runbookName}/draft/content?api-version=2023-11-01`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/powershell',
      },
      body: content,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Upload draft failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
    }
  }

  async createRunbook(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    accountLocation: string,
    runbookName: string,
    runbookType: string,
    description: string,
    runtimeEnvironment?: string
  ): Promise<void> {
    // Use direct REST - the SDK's createOrUpdate is an LRO that causes credential
    // lookup failures the same way as publishRunbook / uploadDraftContent.
    // API version 2023-11-01 is required for PowerShell72 support.
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Automation/automationAccounts/${accountName}/runbooks/${runbookName}?api-version=2023-11-01`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: accountLocation,
        properties: {
          runbookType,
          description,
          ...(runtimeEnvironment ? { runtimeEnvironment } : {}),
          logProgress: false,
          logVerbose: false,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Create runbook failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
    }
  }

  async updateRunbookRuntimeEnvironment(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runbookName: string,
    runbookType: string,
    runtimeEnvironment: string
  ): Promise<void> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Automation/automationAccounts/${accountName}/runbooks/${runbookName}?api-version=2024-10-23`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: {
          runbookType: normalizeRunbookTypeForRuntimeEnvironment(runbookType),
          runtimeEnvironment,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Update runbook runtime environment failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
    }
  }

  async deleteRunbook(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runbookName: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.runbook.deleteMethod(resourceGroupName, accountName, runbookName);
  }

  async startTestJob(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runbookName: string,
    parameters: Record<string, string> = {}
  ): Promise<string> {
    const client = this.automationClient(subscriptionId);
    const job = await client.testJob.create(
      resourceGroupName,
      accountName,
      runbookName,
      { parameters, runOn: '' }
    );
    return job.status ?? 'Queued';
  }

  async startJob(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runbookName: string,
    parameters: Record<string, string> = {}
  ): Promise<{ jobId: string; status: string }> {
    const client = this.automationClient(subscriptionId);
    const jobId = createAutomationJobId(runbookName);
    const job = await client.job.create(
      resourceGroupName,
      accountName,
      jobId,
      {
        runbook: { name: runbookName },
        parameters,
        runOn: '',
      }
    );
    return {
      jobId: job.jobId ?? jobId,
      status: job.status ?? 'Queued',
    };
  }

  async stopTestJob(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runbookName: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.testJob.stop(resourceGroupName, accountName, runbookName);
  }

  async getTestJobOutput(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runbookName: string
  ): Promise<{ summary: string; streams: Array<{ streamType: string; value: string; time: Date }> }> {
    const client = this.automationClient(subscriptionId);
    const job = await client.testJob.get(resourceGroupName, accountName, runbookName);
    const streams: Array<{ streamType: string; value: string; time: Date }> = [];

    let streamsPage = await client.testJobStreams.listByTestJob(resourceGroupName, accountName, runbookName);
    for (const stream of streamsPage) {
      streams.push({
        streamType: stream.streamType ?? 'Output',
        value: typeof stream.value === 'string' ? stream.value : JSON.stringify(stream.value ?? ''),
        time: stream.time ?? new Date(),
      });
    }
    while (streamsPage.nextLink) {
      streamsPage = await client.testJobStreams.listByTestJobNext(streamsPage.nextLink);
      for (const stream of streamsPage) {
        streams.push({
          streamType: stream.streamType ?? 'Output',
          value: typeof stream.value === 'string' ? stream.value : JSON.stringify(stream.value ?? ''),
          time: stream.time ?? new Date(),
        });
      }
    }

    return { summary: job.status ?? '', streams };
  }

  async getJobOutput(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    jobId: string
  ): Promise<{ summary: string; streams: Array<{ streamType: string; value: string; time: Date }> }> {
    const client = this.automationClient(subscriptionId);
    const job = await client.job.get(resourceGroupName, accountName, jobId);
    const streams: Array<{ streamType: string; value: string; time: Date }> = [];

    let streamsPage = await client.jobStream.listByJob(resourceGroupName, accountName, jobId);
    for (const stream of streamsPage) {
      streams.push({
        streamType: stream.streamType ?? 'Output',
        value: typeof stream.summary === 'string'
          ? stream.summary
          : typeof stream.value === 'string'
            ? stream.value
            : JSON.stringify(stream.value ?? ''),
        time: stream.time ?? new Date(),
      });
    }
    while (streamsPage.nextLink) {
      streamsPage = await client.jobStream.listByJobNext(streamsPage.nextLink);
      for (const stream of streamsPage) {
        streams.push({
          streamType: stream.streamType ?? 'Output',
          value: typeof stream.summary === 'string'
            ? stream.summary
            : typeof stream.value === 'string'
              ? stream.value
              : JSON.stringify(stream.value ?? ''),
          time: stream.time ?? new Date(),
        });
      }
    }

    return { summary: job.status ?? '', streams };
  }

  async listVariables(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<Array<{ name: string; value: string | undefined; type: string; isEncrypted: boolean; description?: string }>> {
    const client = this.automationClient(subscriptionId);
    const results = [];
    let varPage = await client.variable.listByAutomationAccount(resourceGroupName, accountName);
    for (const v of varPage) {
      const rawValue = typeof v.value === 'string' ? v.value : undefined;
      results.push({
        name: v.name ?? '',
        value: rawValue,
        type: inferVariableType(rawValue, v.isEncrypted ?? false),
        isEncrypted: v.isEncrypted ?? false,
        description: v.description,
      });
    }
    while (varPage.nextLink) {
      varPage = await client.variable.listByAutomationAccountNext(varPage.nextLink);
      for (const v of varPage) {
        const rawValue = typeof v.value === 'string' ? v.value : undefined;
        results.push({
          name: v.name ?? '',
          value: rawValue,
          type: inferVariableType(rawValue, v.isEncrypted ?? false),
          isEncrypted: v.isEncrypted ?? false,
          description: v.description,
        });
      }
    }
    return results;
  }

  async getVariable(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    variableName: string
  ): Promise<{ name: string; value: string | undefined; type: string; isEncrypted: boolean; description?: string }> {
    const client = this.automationClient(subscriptionId);
    const variable = await client.variable.get(resourceGroupName, accountName, variableName);
    const rawValue = typeof variable.value === 'string' ? variable.value : undefined;
    return {
      name: variable.name ?? variableName,
      value: rawValue,
      type: inferVariableType(rawValue, variable.isEncrypted ?? false),
      isEncrypted: variable.isEncrypted ?? false,
      description: variable.description,
    };
  }

  async createOrUpdateVariable(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    variableName: string,
    value: string,
    isEncrypted: boolean,
    description?: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.variable.createOrUpdate(resourceGroupName, accountName, variableName, {
      name: variableName,
      value,
      isEncrypted,
      description,
    });
  }

  async deleteVariable(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    variableName: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.variable.deleteMethod(resourceGroupName, accountName, variableName);
  }

  async listImportedModules(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<Array<{ name: string; version: string; provisioningState: string }>> {
    const client = this.automationClient(subscriptionId);
    const results = [];
    let modPage = await client.module.listByAutomationAccount(resourceGroupName, accountName);
    for (const mod of modPage) {
      results.push({ name: mod.name ?? '', version: mod.version ?? 'unknown', provisioningState: mod.provisioningState ?? 'Unknown' });
    }
    while (modPage.nextLink) {
      modPage = await client.module.listByAutomationAccountNext(modPage.nextLink);
      for (const mod of modPage) {
        results.push({ name: mod.name ?? '', version: mod.version ?? 'unknown', provisioningState: mod.provisioningState ?? 'Unknown' });
      }
    }
    return results;
  }

  async listSchedules(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<AutomationSchedule[]> {
    const client = this.automationClient(subscriptionId);
    const results: AutomationSchedule[] = [];
    const mapSchedule = (s: {
      name?: string; description?: string; startTime?: Date; expiryTime?: Date;
      nextRun?: Date; frequency?: string; interval?: unknown; timeZone?: string;
      isEnabled?: boolean; creationTime?: Date; lastModifiedTime?: Date;
      advancedSchedule?: { weekDays?: string[]; monthDays?: number[]; monthlyOccurrences?: Array<{ day?: string; occurrence?: number }> };
    }): AutomationSchedule => ({
      name: s.name ?? '',
      description: s.description,
      startTime: s.startTime?.toISOString(),
      expiryTime: s.expiryTime?.toISOString(),
      nextRun: s.nextRun?.toISOString(),
      frequency: s.frequency ?? 'Unknown',
      interval: typeof s.interval === 'number' ? s.interval : undefined,
      timeZone: s.timeZone,
      isEnabled: s.isEnabled ?? false,
      advancedSchedule: s.advancedSchedule ? {
        weekDays: s.advancedSchedule.weekDays,
        monthDays: s.advancedSchedule.monthDays,
        monthlyOccurrences: s.advancedSchedule.monthlyOccurrences?.map(o => ({ day: o.day ?? '', occurrence: o.occurrence ?? 0 })),
      } : undefined,
      creationTime: s.creationTime?.toISOString(),
      lastModifiedTime: s.lastModifiedTime?.toISOString(),
    });
    let page = await client.schedule.listByAutomationAccount(resourceGroupName, accountName);
    for (const s of page) { results.push(mapSchedule(s)); }
    while (page.nextLink) {
      page = await client.schedule.listByAutomationAccountNext(page.nextLink);
      for (const s of page) { results.push(mapSchedule(s)); }
    }
    return results;
  }

  async createSchedule(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    params: {
      name: string;
      description?: string;
      startTime: Date;
      frequency: string;
      interval?: number;
      timeZone?: string;
    }
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.schedule.createOrUpdate(resourceGroupName, accountName, params.name, {
      name: params.name,
      description: params.description,
      startTime: params.startTime,
      frequency: params.frequency as Parameters<typeof client.schedule.createOrUpdate>[3]['frequency'],
      interval: params.interval,
      timeZone: params.timeZone ?? 'UTC',
    });
  }

  async deleteSchedule(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    scheduleName: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.schedule.deleteMethod(resourceGroupName, accountName, scheduleName);
  }

  async listJobSchedules(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<JobScheduleLink[]> {
    const client = this.automationClient(subscriptionId);
    const results: JobScheduleLink[] = [];
    const mapJobSchedule = (js: { jobScheduleId?: string; schedule?: { name?: string }; runbook?: { name?: string }; runOn?: string; parameters?: Record<string, string> }): JobScheduleLink => ({
      jobScheduleId: js.jobScheduleId ?? '',
      scheduleName: js.schedule?.name ?? '',
      runbookName: js.runbook?.name ?? '',
      runOn: js.runOn,
      parameters: js.parameters && Object.keys(js.parameters).length > 0 ? js.parameters : undefined,
    });
    let page = await client.jobSchedule.listByAutomationAccount(resourceGroupName, accountName);
    for (const js of page) { results.push(mapJobSchedule(js)); }
    while (page.nextLink) {
      page = await client.jobSchedule.listByAutomationAccountNext(page.nextLink);
      for (const js of page) { results.push(mapJobSchedule(js)); }
    }
    return results;
  }

  async createJobSchedule(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    jobScheduleId: string,
    scheduleName: string,
    runbookName: string,
    runOn?: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.jobSchedule.create(resourceGroupName, accountName, jobScheduleId, {
      schedule: { name: scheduleName },
      runbook: { name: runbookName },
      runOn,
    });
  }

  async deleteJobSchedule(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    jobScheduleId: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.jobSchedule.deleteMethod(resourceGroupName, accountName, jobScheduleId);
  }

  async listCredentials(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<Array<{ name: string; userName: string | undefined; description: string | undefined; _type: 'credential' }>> {
    const client = this.automationClient(subscriptionId);
    const results = [];
    let page = await client.credential.listByAutomationAccount(resourceGroupName, accountName);
    for (const c of page) {
      results.push({ name: c.name ?? '', userName: c.userName, description: c.description, _type: 'credential' as const });
    }
    while (page.nextLink) {
      page = await client.credential.listByAutomationAccountNext(page.nextLink);
      for (const c of page) {
        results.push({ name: c.name ?? '', userName: c.userName, description: c.description, _type: 'credential' as const });
      }
    }
    return results;
  }

  async listCertificates(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<Array<{ name: string; thumbprint: string | undefined; expiryTime: string | undefined; description: string | undefined; isExportable: boolean; _type: 'certificate' }>> {
    const client = this.automationClient(subscriptionId);
    const results = [];
    let page = await client.certificate.listByAutomationAccount(resourceGroupName, accountName);
    for (const certificate of page) {
      results.push({
        name: certificate.name ?? '',
        thumbprint: certificate.thumbprint,
        expiryTime: certificate.expiryTime?.toISOString(),
        description: certificate.description,
        isExportable: certificate.isExportable ?? false,
        _type: 'certificate' as const,
      });
    }
    while (page.nextLink) {
      page = await client.certificate.listByAutomationAccountNext(page.nextLink);
      for (const certificate of page) {
        results.push({
          name: certificate.name ?? '',
          thumbprint: certificate.thumbprint,
          expiryTime: certificate.expiryTime?.toISOString(),
          description: certificate.description,
          isExportable: certificate.isExportable ?? false,
          _type: 'certificate' as const,
        });
      }
    }
    return results;
  }

  async getCredential(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    credentialName: string
  ): Promise<{ name: string; userName: string | undefined; description: string | undefined }> {
    const client = this.automationClient(subscriptionId);
    const credential = await client.credential.get(resourceGroupName, accountName, credentialName);
    return {
      name: credential.name ?? credentialName,
      userName: credential.userName,
      description: credential.description,
    };
  }

  async createOrUpdateCredential(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    credentialName: string,
    userName: string,
    password: string,
    description?: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.credential.createOrUpdate(resourceGroupName, accountName, credentialName, {
      name: credentialName,
      userName,
      password,
      description,
    });
  }

  async updateCredential(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    credentialName: string,
    userName: string,
    password?: string,
    description?: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.credential.update(resourceGroupName, accountName, credentialName, {
      userName,
      ...(password ? { password } : {}),
      description,
    });
  }

  async deleteCredential(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    credentialName: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.credential.deleteMethod(resourceGroupName, accountName, credentialName);
  }

  async listConnections(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<Array<{ name: string; connectionType: string | undefined; description: string | undefined; _type: 'connection' }>> {
    const client = this.automationClient(subscriptionId);
    const results = [];
    let page = await client.connection.listByAutomationAccount(resourceGroupName, accountName);
    for (const c of page) {
      results.push({ name: c.name ?? '', connectionType: c.connectionType?.name, description: c.description, _type: 'connection' as const });
    }
    while (page.nextLink) {
      page = await client.connection.listByAutomationAccountNext(page.nextLink);
      for (const c of page) {
        results.push({ name: c.name ?? '', connectionType: c.connectionType?.name, description: c.description, _type: 'connection' as const });
      }
    }
    return results;
  }

  async getConnection(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    connectionName: string
  ): Promise<{
    name: string;
    connectionType: string | undefined;
    description: string | undefined;
    fieldValues: Record<string, string>;
  }> {
    const client = this.automationClient(subscriptionId);
    const connection = await client.connection.get(resourceGroupName, accountName, connectionName);
    return {
      name: connection.name ?? connectionName,
      connectionType: connection.connectionType?.name,
      description: connection.description,
      fieldValues: connection.fieldDefinitionValues ?? {},
    };
  }

  async createOrUpdateConnection(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    connectionName: string,
    connectionType: string,
    fieldValues: Record<string, string>,
    description?: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.connection.createOrUpdate(resourceGroupName, accountName, connectionName, {
      name: connectionName,
      connectionType: { name: connectionType },
      fieldDefinitionValues: fieldValues,
      description,
    });
  }

  async updateConnection(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    connectionName: string,
    fieldValues: Record<string, string>,
    description?: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.connection.update(resourceGroupName, accountName, connectionName, {
      fieldDefinitionValues: fieldValues,
      description,
    });
  }

  async deleteConnection(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    connectionName: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.connection.deleteMethod(resourceGroupName, accountName, connectionName);
  }

  async getCertificate(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    certName: string
  ): Promise<{ name: string; thumbprint: string | undefined; expiryTime: string | undefined; description: string | undefined; isExportable: boolean }> {
    const client = this.automationClient(subscriptionId);
    const cert = await client.certificate.get(resourceGroupName, accountName, certName);
    return {
      name: cert.name ?? certName,
      thumbprint: cert.thumbprint,
      expiryTime: cert.expiryTime?.toISOString(),
      description: cert.description,
      isExportable: cert.isExportable ?? false,
    };
  }

  async createOrUpdateCertificate(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    certName: string,
    base64Value: string,
    isExportable: boolean,
    description?: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.certificate.createOrUpdate(resourceGroupName, accountName, certName, {
      name: certName,
      base64Value,
      isExportable,
      description,
    });
  }

  async deleteCertificate(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    certName: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.certificate.deleteMethod(resourceGroupName, accountName, certName);
  }

  async listPythonPackages(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<Array<{ name: string; version: string; provisioningState: string; pythonVersion: string }>> {
    const client = this.automationClient(subscriptionId);
    const results = [];
    let page = await client.python2Package.listByAutomationAccount(resourceGroupName, accountName);
    for (const p of page) {
      results.push({ name: p.name ?? '', version: p.version ?? 'unknown', provisioningState: p.provisioningState ?? 'Unknown', pythonVersion: '2' });
    }
    while (page.nextLink) {
      page = await client.python2Package.listByAutomationAccountNext(page.nextLink);
      for (const p of page) {
        results.push({ name: p.name ?? '', version: p.version ?? 'unknown', provisioningState: p.provisioningState ?? 'Unknown', pythonVersion: '2' });
      }
    }
    return results;
  }

  async listHybridWorkerGroups(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<Array<{ name: string; groupType: string | undefined }>> {
    const client = this.automationClient(subscriptionId);
    const results = [];
    let page = await client.hybridRunbookWorkerGroup.listByAutomationAccount(resourceGroupName, accountName);
    for (const g of page) {
      results.push({ name: g.name ?? '', groupType: g.groupType });
    }
    while (page.nextLink) {
      page = await client.hybridRunbookWorkerGroup.listByAutomationAccountNext(page.nextLink);
      for (const g of page) {
        results.push({ name: g.name ?? '', groupType: g.groupType });
      }
    }
    return results;
  }

  async listRuntimeEnvironments(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<RuntimeEnvironmentSummary[]> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Automation/automationAccounts/${accountName}/runtimeEnvironments?api-version=2024-10-23`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      // 404 = feature not available on this account; 400 = unsupported API version in this cloud.
      // Treat both as "no runtime environments" rather than a hard failure.
      if (res.status === 404 || res.status === 400) { return []; }
      const body = await res.text().catch(() => '');
      throw new Error(`Runtime environments list failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
    }

    const body = await res.json() as {
      value?: Array<{
        name?: string;
        properties?: {
          description?: string;
          provisioningState?: string;
          runtime?: { language?: string; version?: string };
          defaultPackages?: Record<string, string>;
        };
      }>;
    };

    return (body.value ?? [])
      .filter(item => item.name)
      .map(item => ({
        name: item.name ?? '',
        description: item.properties?.description,
        language: item.properties?.runtime?.language,
        version: item.properties?.runtime?.version,
        provisioningState: item.properties?.provisioningState,
        defaultPackages: item.properties?.defaultPackages,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getRuntimeEnvironment(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runtimeEnvironmentName: string
  ): Promise<RuntimeEnvironmentSummary> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Automation/automationAccounts/${accountName}/runtimeEnvironments/${encodeURIComponent(runtimeEnvironmentName)}?api-version=2024-10-23`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Runtime environment get failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
    }

    const item = await res.json() as {
      name?: string;
      properties?: {
        description?: string;
        provisioningState?: string;
        runtime?: { language?: string; version?: string };
        defaultPackages?: Record<string, string>;
      };
    };

    return {
      name: item.name ?? runtimeEnvironmentName,
      description: item.properties?.description,
      language: item.properties?.runtime?.language,
      version: item.properties?.runtime?.version,
      provisioningState: item.properties?.provisioningState,
      defaultPackages: item.properties?.defaultPackages,
    };
  }

  async createRuntimeEnvironment(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    request: RuntimeEnvironmentCreateRequest
  ): Promise<void> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Automation/automationAccounts/${accountName}/runtimeEnvironments/${encodeURIComponent(request.name)}?api-version=2024-10-23`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: request.location,
        properties: {
          runtime: {
            language: request.language,
            version: request.version,
          },
          ...(request.description ? { description: request.description } : {}),
          ...(request.defaultPackages ? { defaultPackages: request.defaultPackages } : {}),
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Create runtime environment failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
    }
  }

  async updateRuntimeEnvironmentDefaultPackages(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runtimeEnvironmentName: string,
    defaultPackages: Record<string, string>
  ): Promise<void> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Automation/automationAccounts/${accountName}/runtimeEnvironments/${encodeURIComponent(runtimeEnvironmentName)}?api-version=2024-10-23`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: {
          defaultPackages,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Update runtime environment failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
    }
  }

  async deleteRuntimeEnvironment(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runtimeEnvironmentName: string
  ): Promise<void> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Automation/automationAccounts/${accountName}/runtimeEnvironments/${encodeURIComponent(runtimeEnvironmentName)}?api-version=2024-10-23`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 204) {
      const body = await res.text().catch(() => '');
      throw new Error(`Delete runtime environment failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
    }
  }

  async listRecentJobs(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<Array<{ jobId: string; runbookName: string | undefined; status: string | undefined; startTime: string | undefined; endTime: string | undefined }>> {
    const client = this.automationClient(subscriptionId);
    const results = [];
    let page = await client.job.listByAutomationAccount(resourceGroupName, accountName);
    for (const j of page) {
      results.push({
        jobId: j.jobId ?? '',
        runbookName: j.runbook?.name,
        status: j.status,
        startTime: j.startTime?.toISOString(),
        endTime: j.endTime?.toISOString(),
      });
    }
    while (page.nextLink) {
      page = await client.job.listByAutomationAccountNext(page.nextLink);
      for (const j of page) {
        results.push({
          jobId: j.jobId ?? '',
          runbookName: j.runbook?.name,
          status: j.status,
          startTime: j.startTime?.toISOString(),
          endTime: j.endTime?.toISOString(),
        });
      }
    }
    return results;
  }

  async listJobsForRunbook(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runbookName: string
  ): Promise<AutomationJobSummary[]> {
    const jobs = await this.listJobsForAccount(subscriptionId, resourceGroupName, accountName);
    return jobs.filter(job => job.runbookName === runbookName);
  }

  async listJobsForAccount(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<AutomationJobSummary[]> {
    const client = this.automationClient(subscriptionId);
    const results: AutomationJobSummary[] = [];
    let page = await client.job.listByAutomationAccount(resourceGroupName, accountName);

    const pushJob = (job: {
      jobId?: string;
      runbook?: { name?: string };
      status?: string;
      creationTime?: Date;
      startTime?: Date;
      endTime?: Date;
      lastModifiedTime?: Date;
      runOn?: string;
      provisioningState?: string;
      runtimeEnvironment?: string;
    }): void => {
      results.push({
        jobId: job.jobId ?? '',
        runbookName: job.runbook?.name,
        status: job.status,
        creationTime: job.creationTime?.toISOString(),
        startTime: job.startTime?.toISOString(),
        endTime: job.endTime?.toISOString(),
        lastModifiedTime: job.lastModifiedTime?.toISOString(),
        runOn: job.runOn,
        provisioningState: job.provisioningState,
        runtimeEnvironment: job.runtimeEnvironment,
      });
    };

    for (const job of page) {
      pushJob(job);
    }
    while (page.nextLink) {
      page = await client.job.listByAutomationAccountNext(page.nextLink);
      for (const job of page) {
        pushJob(job);
      }
    }

    return results.sort((left, right) => {
      const a = Date.parse(right.creationTime ?? right.startTime ?? '') || 0;
      const b = Date.parse(left.creationTime ?? left.startTime ?? '') || 0;
      return a - b;
    });
  }

  async getJobDetails(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    jobId: string
  ): Promise<AutomationJobDetail> {
    const client = this.automationClient(subscriptionId);
    const job = await client.job.get(resourceGroupName, accountName, jobId);
    const streams: AutomationJobStream[] = [];

    const pushStream = (stream: {
      jobStreamId?: string;
      streamType?: string;
      summary?: string;
      streamText?: string;
      value?: Record<string, unknown>;
      time?: Date;
    }): void => {
      const serializedValue = typeof stream.value === 'object' && stream.value
        ? JSON.stringify(stream.value, null, 2)
        : undefined;
      streams.push({
        jobStreamId: stream.jobStreamId,
        streamType: stream.streamType ?? 'Output',
        summary: stream.summary?.trim() || stream.streamText?.trim() || serializedValue || '',
        streamText: stream.streamText,
        value: serializedValue,
        time: stream.time?.toISOString(),
      });
    };

    // Collect all stream summaries first, then fetch full content for Error/Warning streams.
    const summaryList: Array<{
      jobStreamId?: string; streamType?: string; summary?: string;
      streamText?: string; value?: Record<string, unknown>; time?: Date;
    }> = [];
    let streamsPage = await client.jobStream.listByJob(resourceGroupName, accountName, jobId);
    for (const stream of streamsPage) { summaryList.push(stream); }
    while (streamsPage.nextLink) {
      streamsPage = await client.jobStream.listByJobNext(streamsPage.nextLink);
      for (const stream of streamsPage) { summaryList.push(stream); }
    }

    // Fetch full content for Error and Warning streams (usually few, avoids N+1 for verbose output).
    const detailedIds = new Set(
      summaryList
        .filter(s => s.streamType === 'Error' || s.streamType === 'Warning')
        .map(s => s.jobStreamId)
        .filter((id): id is string => !!id)
    );
    const detailedMap = new Map<string, typeof summaryList[0]>();
    await Promise.all(
      Array.from(detailedIds).map(async id => {
        try {
          const full = await client.jobStream.get(resourceGroupName, accountName, jobId, id);
          detailedMap.set(id, full);
        } catch { /* fall back to summary */ }
      })
    );

    for (const stream of summaryList) {
      const full = stream.jobStreamId ? detailedMap.get(stream.jobStreamId) : undefined;
      pushStream(full ?? stream);
    }

    streams.sort((left, right) => {
      const a = Date.parse(left.time ?? '') || 0;
      const b = Date.parse(right.time ?? '') || 0;
      return a - b;
    });

    return {
      jobId: job.jobId ?? jobId,
      runbookName: job.runbook?.name,
      status: job.status,
      statusDetails: job.statusDetails,
      startedBy: job.startedBy,
      runOn: job.runOn,
      provisioningState: job.provisioningState,
      creationTime: job.creationTime?.toISOString(),
      startTime: job.startTime?.toISOString(),
      endTime: job.endTime?.toISOString(),
      lastModifiedTime: job.lastModifiedTime?.toISOString(),
      lastStatusModifiedTime: job.lastStatusModifiedTime?.toISOString(),
      exception: job.exception,
      parameters: job.parameters ?? {},
      streams,
    };
  }

  // ── Microsoft Graph API ───────────────────────────────────────────────────

  private async graphFetch<T>(path: string, advanced = false): Promise<T> {
    const base = this.auth.getGraphEndpoint();
    const token = await this.auth.getGraphToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (advanced) { headers['ConsistencyLevel'] = 'eventual'; }
    const res = await fetch(`${base}/v1.0${path}`, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Try to extract the client/app id from the JWT access token to aid debugging.
      let clientAppId: string | undefined;
      try {
        const parts = token.split('.');
        if (parts.length >= 2) {
          const payload = parts[1];
          const pad = payload.length % 4 === 0 ? '' : '='.repeat(4 - (payload.length % 4));
          const decoded = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
          const obj = JSON.parse(decoded);
          clientAppId = obj.appid ?? obj.azp ?? obj.client_id ?? obj.app_id ?? obj.oid;
        }
      } catch {}
      throw new Error(`Graph API ${path} failed: ${res.status} ${res.statusText}${body ? ` – ${body.substring(0, 300)}` : ''}${clientAppId ? ` (clientAppId: ${clientAppId})` : ''}`);
    }
    return res.json() as Promise<T>;
  }

  private async graphPatch(path: string, body: unknown): Promise<void> {
    const base = this.auth.getGraphEndpoint();
    const token = await this.auth.getGraphToken();
    const res = await fetch(`${base}/v1.0${path}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Graph PATCH ${path} failed: ${res.status} ${res.statusText}${text ? ` – ${text.substring(0, 300)}` : ''}`);
    }
  }

  private async graphPost<T>(path: string, body: unknown): Promise<T> {
    const base = this.auth.getGraphEndpoint();
    const token = await this.auth.getGraphToken();
    const res = await fetch(`${base}/v1.0${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Graph POST ${path} failed: ${res.status} ${res.statusText}${text ? ` – ${text.substring(0, 300)}` : ''}`);
    }
    return res.json() as Promise<T>;
  }

  async graphSearchApplications(query: string): Promise<Array<{ id: string; appId: string; displayName: string }>> {
    const q = query.trim();
    const filter = q
      ? encodeURIComponent(buildDirectoryObjectSearchFilter(q))
      : encodeURIComponent(`displayName ne null`);
    const data = await this.graphFetch<{ value?: Array<{ id?: string; appId?: string; displayName?: string }> }>(
      `/applications?$filter=${filter}&$count=true&$top=20&$select=id,appId,displayName`, true
    );
    return (data.value ?? []).map(a => ({ id: a.id ?? '', appId: a.appId ?? '', displayName: a.displayName ?? '' }));
  }

  async graphSearchServicePrincipals(query: string): Promise<Array<{ id: string; appId: string; displayName: string; servicePrincipalType: string }>> {
    const q = query.trim();
    const filter = q
      ? encodeURIComponent(buildDirectoryObjectSearchFilter(q))
      : encodeURIComponent(`displayName ne null`);
    const data = await this.graphFetch<{ value?: Array<{ id?: string; appId?: string; displayName?: string; servicePrincipalType?: string }> }>(
      `/servicePrincipals?$filter=${filter}&$count=true&$top=20&$select=id,appId,displayName,servicePrincipalType`, true
    );
    return (data.value ?? []).map(s => ({ id: s.id ?? '', appId: s.appId ?? '', displayName: s.displayName ?? '', servicePrincipalType: s.servicePrincipalType ?? '' }));
  }

  async graphGetServicePrincipalByAppId(appId: string): Promise<{ id: string; appId: string; displayName: string; servicePrincipalType: string } | undefined> {
    const filter = encodeURIComponent(`appId eq '${appId}'`);
    const data = await this.graphFetch<{ value?: Array<{ id?: string; appId?: string; displayName?: string; servicePrincipalType?: string }> }>(
      `/servicePrincipals?$filter=${filter}&$select=id,appId,displayName,servicePrincipalType`
    ).catch(() => ({ value: [] }));
    const sp = data.value?.[0];
    return sp ? { id: sp.id ?? '', appId: sp.appId ?? '', displayName: sp.displayName ?? '', servicePrincipalType: sp.servicePrincipalType ?? '' } : undefined;
  }

  async graphGetServicePrincipalById(objectId: string): Promise<{ id: string; appId: string; displayName: string; servicePrincipalType: string } | undefined> {
    const data = await this.graphFetch<{ id?: string; appId?: string; displayName?: string; servicePrincipalType?: string }>(
      `/servicePrincipals/${objectId}?$select=id,appId,displayName,servicePrincipalType`
    ).catch(() => undefined);
    return data ? {
      id: data.id ?? objectId,
      appId: data.appId ?? '',
      displayName: data.displayName ?? '',
      servicePrincipalType: data.servicePrincipalType ?? '',
    } : undefined;
  }

  async graphGetApplication(objectId: string): Promise<{
    id: string; appId: string; displayName: string;
    requiredResourceAccess: Array<{
      resourceAppId: string;
      resourceAccess: Array<{ id: string; type: string }>;
    }>;
  }> {
    const data = await this.graphFetch<{
      id?: string; appId?: string; displayName?: string;
      requiredResourceAccess?: Array<{ resourceAppId?: string; resourceAccess?: Array<{ id?: string; type?: string }> }>;
    }>(`/applications/${objectId}?$select=id,appId,displayName,requiredResourceAccess`);
    return {
      id: data.id ?? objectId,
      appId: data.appId ?? '',
      displayName: data.displayName ?? '',
      requiredResourceAccess: (data.requiredResourceAccess ?? []).map(r => ({
        resourceAppId: r.resourceAppId ?? '',
        resourceAccess: (r.resourceAccess ?? []).map(ra => ({ id: ra.id ?? '', type: ra.type ?? '' })),
      })),
    };
  }

  async graphGetServicePrincipalPermissions(appId: string): Promise<{
    id: string; displayName: string;
    delegated: Array<{ id: string; value: string; displayName: string; description: string; adminConsentRequired: boolean }>;
    application: Array<{ id: string; value: string; displayName: string; description: string; adminConsentRequired: boolean }>;
  }> {
    const filter = encodeURIComponent(`appId eq '${appId}'`);
    const data = await this.graphFetch<{
      value?: Array<{
        id?: string; displayName?: string;
        oauth2PermissionScopes?: Array<{ id?: string; value?: string; adminConsentDisplayName?: string; adminConsentDescription?: string; type?: string; isEnabled?: boolean }>;
        appRoles?: Array<{ id?: string; value?: string; displayName?: string; description?: string; isEnabled?: boolean; allowedMemberTypes?: string[] }>;
      }>;
    }>(`/servicePrincipals?$filter=${filter}&$select=id,displayName,oauth2PermissionScopes,appRoles`);
    const sp = data.value?.[0];
    if (!sp) { throw new Error(`Service principal with appId '${appId}' not found`); }
    return {
      id: sp.id ?? '',
      displayName: sp.displayName ?? '',
      delegated: (sp.oauth2PermissionScopes ?? [])
        .filter(s => s.isEnabled !== false)
        .map(s => ({ id: s.id ?? '', value: s.value ?? '', displayName: s.adminConsentDisplayName ?? '', description: s.adminConsentDescription ?? '', adminConsentRequired: s.type === 'Admin' })),
      application: (sp.appRoles ?? [])
        .filter(r => r.isEnabled !== false && r.allowedMemberTypes?.includes('Application'))
        .map(r => ({ id: r.id ?? '', value: r.value ?? '', displayName: r.displayName ?? '', description: r.description ?? '', adminConsentRequired: true })),
    };
  }

  async graphGetServicePrincipalPermissionsById(objectId: string): Promise<{
    id: string; appId: string; displayName: string;
    delegated: Array<{ id: string; value: string; displayName: string; description: string; adminConsentRequired: boolean }>;
    application: Array<{ id: string; value: string; displayName: string; description: string; adminConsentRequired: boolean }>;
  }> {
    const sp = await this.graphFetch<{
      id?: string; appId?: string; displayName?: string;
      oauth2PermissionScopes?: Array<{ id?: string; value?: string; adminConsentDisplayName?: string; adminConsentDescription?: string; type?: string; isEnabled?: boolean }>;
      appRoles?: Array<{ id?: string; value?: string; displayName?: string; description?: string; isEnabled?: boolean; allowedMemberTypes?: string[] }>;
    }>(`/servicePrincipals/${objectId}?$select=id,appId,displayName,oauth2PermissionScopes,appRoles`);
    return {
      id: sp.id ?? objectId,
      appId: sp.appId ?? '',
      displayName: sp.displayName ?? '',
      delegated: (sp.oauth2PermissionScopes ?? [])
        .filter(scope => scope.isEnabled !== false)
        .map(scope => ({
          id: scope.id ?? '',
          value: scope.value ?? '',
          displayName: scope.adminConsentDisplayName ?? '',
          description: scope.adminConsentDescription ?? '',
          adminConsentRequired: scope.type === 'Admin',
        })),
      application: (sp.appRoles ?? [])
        .filter(role => role.isEnabled !== false && role.allowedMemberTypes?.includes('Application'))
        .map(role => ({
          id: role.id ?? '',
          value: role.value ?? '',
          displayName: role.displayName ?? '',
          description: role.description ?? '',
          adminConsentRequired: true,
        })),
    };
  }

  async graphListServicePrincipalAppRoleAssignments(
    servicePrincipalId: string
  ): Promise<Array<{ id: string; resourceId: string; appRoleId: string }>> {
    const data = await this.graphFetch<{ value?: Array<{ id?: string; resourceId?: string; appRoleId?: string }> }>(
      `/servicePrincipals/${servicePrincipalId}/appRoleAssignments?$select=id,resourceId,appRoleId`
    );
    return (data.value ?? [])
      .filter(assignment => assignment.id && assignment.resourceId && assignment.appRoleId)
      .map(assignment => ({
        id: assignment.id ?? '',
        resourceId: assignment.resourceId ?? '',
        appRoleId: assignment.appRoleId ?? '',
      }));
  }

  async graphGetServicePrincipalAppRoleAssignments(
    servicePrincipalId: string,
    resourceServicePrincipalId: string
  ): Promise<Array<{ id: string; appRoleId: string }>> {
    const filter = encodeURIComponent(`resourceId eq '${resourceServicePrincipalId}'`);
    const data = await this.graphFetch<{ value?: Array<{ id?: string; appRoleId?: string }> }>(
      `/servicePrincipals/${servicePrincipalId}/appRoleAssignments?$filter=${filter}&$select=id,appRoleId`
    ).catch(() => ({ value: [] }));
    return (data.value ?? [])
      .filter(assignment => assignment.id && assignment.appRoleId)
      .map(assignment => ({
        id: assignment.id ?? '',
        appRoleId: assignment.appRoleId ?? '',
      }));
  }

  async graphListServicePrincipalOauth2PermissionGrants(
    servicePrincipalId: string
  ): Promise<Array<{ resourceId: string; scope: string }>> {
    const filter = encodeURIComponent(`clientId eq '${servicePrincipalId}' and consentType eq 'AllPrincipals'`);
    const data = await this.graphFetch<{ value?: Array<{ resourceId?: string; scope?: string }> }>(
      `/oauth2PermissionGrants?$filter=${filter}&$select=resourceId,scope`
    ).catch(() => ({ value: [] }));
    return (data.value ?? [])
      .filter(grant => grant.resourceId)
      .map(grant => ({
        resourceId: grant.resourceId ?? '',
        scope: grant.scope ?? '',
      }));
  }

  async graphDelete(path: string): Promise<void> {
    const endpoint = this.auth.getGraphEndpoint().replace(/\/$/, '');
    const token = await this.auth.getGraphToken();
    const res = await fetch(`${endpoint}/v1.0${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Graph DELETE ${path} failed: ${res.status} ${res.statusText}${text ? ` – ${text.substring(0, 300)}` : ''}`);
    }
  }

  async graphPatchApplicationPermissions(
    objectId: string,
    requiredResourceAccess: Array<{ resourceAppId: string; resourceAccess: Array<{ id: string; type: string }> }>
  ): Promise<void> {
    await this.graphPatch(`/applications/${objectId}`, { requiredResourceAccess });
  }

  async graphGrantAdminConsent(
    servicePrincipalId: string,
    resourceServicePrincipalId: string,
    appRoleId: string
  ): Promise<void> {
    await this.graphPost(`/servicePrincipals/${servicePrincipalId}/appRoleAssignments`, {
      principalId: servicePrincipalId,
      resourceId: resourceServicePrincipalId,
      appRoleId,
    });
  }

  async graphCreateOauth2PermissionGrant(
    clientId: string,
    resourceId: string,
    scope: string
  ): Promise<void> {
    await this.graphPost(`/oauth2PermissionGrants`, {
      clientId,
      resourceId,
      scope,
      consentType: 'AllPrincipals',
    });
  }

  async graphDeleteAppRoleAssignment(
    servicePrincipalId: string,
    assignmentId: string
  ): Promise<void> {
    await this.graphDelete(`/servicePrincipals/${servicePrincipalId}/appRoleAssignments/${assignmentId}`);
  }

  /** Returns the system-assigned managed identity principalId for an Automation Account (undefined if none). */
  async getAutomationAccountIdentity(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<{ principalId: string | undefined; tenantId: string | undefined }> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Automation/automationAccounts/${accountName}?api-version=2023-11-01`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { return { principalId: undefined, tenantId: undefined }; }
    const data = await res.json() as { identity?: { principalId?: string; tenantId?: string } };
    return { principalId: data.identity?.principalId, tenantId: data.identity?.tenantId };
  }

  // ── Storage account operations ──────────────────────────────────────────────

  async listStorageAccounts(subscriptionId: string): Promise<Array<{ name: string; resourceGroup: string }>> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/providers/Microsoft.Storage/storageAccounts?api-version=2023-01-01`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { throw new Error(`List storage accounts failed: ${res.status} ${res.statusText}`); }
    const body = await res.json() as { value?: Array<{ name?: string; id?: string }> };
    return (body.value ?? [])
      .filter(a => a.name)
      .map(a => {
        const rgMatch = a.id?.match(/resourceGroups\/([^/]+)\//i);
        return { name: a.name!, resourceGroup: rgMatch?.[1] ?? '' };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createStorageAccount(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    location: string
  ): Promise<void> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroupName)}/providers/Microsoft.Storage/storageAccounts/${encodeURIComponent(accountName)}?api-version=2023-01-01`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku: { name: 'Standard_LRS' },
        kind: 'StorageV2',
        location,
        properties: { minimumTlsVersion: 'TLS1_2', allowBlobPublicAccess: false },
      }),
    });
    if (!res.ok && res.status !== 202 && res.status !== 201) {
      const text = await res.text().catch(() => '');
      throw new Error(`Create storage account failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
    }
    const asyncOpUrl = res.headers.get('Azure-AsyncOperation');
    const locationUrl = res.headers.get('Location');
    if (asyncOpUrl) {
      await pollArmAsyncOperation(asyncOpUrl, token);
    } else if (locationUrl) {
      await pollArmLocation(locationUrl, token);
    }
  }

  async getStorageAccountKey(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string
  ): Promise<string> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroupName)}/providers/Microsoft.Storage/storageAccounts/${encodeURIComponent(accountName)}/listKeys?api-version=2023-01-01`;
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Get storage account key failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
    }
    const json = await res.json() as { keys?: Array<{ keyName?: string; value?: string; permissions?: string }> };
    const key = json.keys?.find(k => k.permissions?.toLowerCase() === 'full')?.value ?? json.keys?.[0]?.value;
    if (!key) { throw new Error('No storage account keys returned'); }
    return key;
  }

  async importModuleToAutomation(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    moduleName: string,
    contentUri: string
  ): Promise<void> {
    const client = this.automationClient(subscriptionId);
    await client.module.createOrUpdate(resourceGroupName, accountName, moduleName, {
      contentLink: { uri: contentUri },
    });

    // Poll until Azure finishes importing (provisioningState leaves "Creating"/"Running")
    const maxAttempts = 72; // up to ~6 minutes (72 × 5 s)
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const mod = await client.module.get(resourceGroupName, accountName, moduleName);
      const state = (mod.provisioningState ?? '').toLowerCase();
      if (state === 'succeeded' || state === 'succeeded (content validated)') { return; }
      if (state === 'failed' || state === 'canceled') {
        throw new Error(`Module import ${state}: check the Automation Account modules panel for details.`);
      }
    }
    throw new Error('Module import timed out after 6 minutes — check Azure Portal for status.');
  }

  async importPackageToRuntimeEnvironment(
    subscriptionId: string,
    resourceGroupName: string,
    accountName: string,
    runtimeEnvironmentName: string,
    packageName: string,
    contentUri: string
  ): Promise<void> {
    const endpoint = this.auth.getResourceManagerEndpoint().replace(/\/$/, '');
    const token = await this.auth.getAccessToken();
    const url = `${endpoint}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Automation/automationAccounts/${accountName}/runtimeEnvironments/${encodeURIComponent(runtimeEnvironmentName)}/packages/${encodeURIComponent(packageName)}?api-version=2024-10-23`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { contentLink: { uri: contentUri } } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Package import failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
    }

    // Poll until provisioning completes
    const maxAttempts = 72;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const pollRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!pollRes.ok) { continue; }
      const data = await pollRes.json() as { properties?: { provisioningState?: string } };
      const state = (data.properties?.provisioningState ?? '').toLowerCase();
      if (state === 'succeeded') { return; }
      if (state === 'failed' || state === 'canceled') {
        throw new Error(`Package import ${state} in runtime environment "${runtimeEnvironmentName}".`);
      }
    }
    throw new Error('Package import timed out after 6 minutes — check Azure Portal for status.');
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createAutomationJobId(_runbookName: string): string {
  // Azure Automation Jobs API requires a valid UUID as the job name.
  return crypto.randomUUID();
}

function normalizeRunbookTypeForRuntimeEnvironment(runbookType: string): string {
  const normalized = runbookType.toLowerCase();
  if (normalized.startsWith('powershell')) { return 'PowerShell'; }
  if (normalized.startsWith('python')) { return 'Python3'; }
  return runbookType;
}


/** Infers the Azure Automation variable type from its stored JSON string value. */
function inferVariableType(value: string | undefined, isEncrypted: boolean): string {
  if (isEncrypted || value === undefined) { return 'String'; }
  if (value === 'true' || value === 'false') { return 'Boolean'; }
  if (!isNaN(Number(value)) && value.trim() !== '') { return 'Integer'; }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) { return 'DateTime'; }
  return 'String';
}

function buildDirectoryObjectSearchFilter(query: string): string {
  const escaped = query.replace(/'/g, "''");
  const clauses = [`startswith(displayName,'${escaped}')`];
  if (isGuidLike(query)) {
    clauses.push(`appId eq '${escaped}'`);
    clauses.push(`id eq '${escaped}'`);
  }
  return clauses.join(' or ');
}

function isGuidLike(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(value);
}

/**
 * Polls an Azure-AsyncOperation URL until the operation reaches a terminal state.
 * The response body is always {"status":"InProgress|Succeeded|Failed|Canceled",...}.
 */
async function pollArmAsyncOperation(asyncOpUrl: string, token: string): Promise<void> {
  const maxAttempts = 72; // up to 6 minutes (72 × 5 s)
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const res = await fetch(asyncOpUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { throw new Error(`Async operation poll failed: ${res.status} ${res.statusText}`); }
    const text = await res.text();
    if (!text.trim()) { continue; } // Azure sometimes returns empty body while still running
    let body: { status?: string; error?: { message?: string; code?: string } };
    try { body = JSON.parse(text); } catch { continue; }
    const status = (body.status ?? '').toLowerCase();
    if (status === 'succeeded') { return; }
    if (status === 'failed' || status === 'canceled') {
      throw new Error(`Operation ${status}: ${body.error?.message ?? body.error?.code ?? 'Unknown error'}`);
    }
  }
  throw new Error('Azure async operation timed out after 6 minutes');
}

/**
 * Polls a Location URL until the operation completes.
 * A 200/201 response means success (the body is the created resource, not a status object).
 * A 202 response means still in progress.
 */
async function pollArmLocation(locationUrl: string, token: string): Promise<void> {
  const maxAttempts = 72; // up to 6 minutes (72 × 5 s)
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const res = await fetch(locationUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 202) { continue; } // still in progress
    if (res.ok) { return; } // 200/201 = done
    const text = await res.text().catch(() => '');
    throw new Error(`Location poll failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
  }
  throw new Error('Azure async operation timed out after 6 minutes');
}
