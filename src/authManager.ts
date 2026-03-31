import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import type { TokenCredential, AccessToken } from '@azure/core-auth';
import { AzureCloudName, CLOUD_CONFIG } from './cloudConfig';


/**
 * TokenCredential implementation backed by vscode.authentication.getSession.
 * No dependency on @azure/identity or any Azure extension.
 */
class VsCodeSessionCredential implements TokenCredential {
  constructor(private readonly getTokenValue: (scopes: string | string[]) => Promise<string | undefined>) {}

  async getToken(scopes: string | string[]): Promise<AccessToken | null> {
    const token = await this.getTokenValue(scopes);
    if (!token) { return null; }
    return {
      token,
      expiresOnTimestamp: Date.now() + 55 * 60 * 1000,
    };
  }
}

/**
 * AuthManager handles Azure authentication via VS Code's native auth API
 * (MSAL under the hood). No dependency on the deprecated Azure Account extension.
 *
 * Uses vscode.authentication.getSession which leverages the built-in
 * Microsoft auth provider - the same mechanism used by the Bicep, Functions,
 * and Azure Resources extensions.
 */
export class AuthManager {
  private _session: vscode.AuthenticationSession | undefined;
  private _suppressSilentSignIn = false;
  private readonly _onDidSignInChange = new vscode.EventEmitter<boolean>();
  readonly onDidSignInChange = this._onDidSignInChange.event;

  constructor(_context: vscode.ExtensionContext) {}

  get isSignedIn(): boolean {
    return this._session !== undefined;
  }

  get accountName(): string {
    return this._session?.account.label ?? '';
  }

  get scopes(): readonly string[] {
    return this._session?.scopes ?? [];
  }

  get shouldAttemptSilentSignIn(): boolean {
    return !this._suppressSilentSignIn;
  }

  /**
   * Returns a TokenCredential backed by the current VS Code auth session.
   * Compatible with both Track 1 (@azure/ms-rest-js) and Track 2 SDK clients.
   */
  getCredential(): TokenCredential {
    return new VsCodeSessionCredential((scopes) => this.acquireAccessToken(scopes, true));
  }

  async signIn(silent = false): Promise<boolean> {
    try {
      this._session = await this.getSessionForScopes(this.defaultScopes, silent);

      if (this._session) {
        this._suppressSilentSignIn = false;
        this._onDidSignInChange.fire(true);
        return true;
      }
      return false;
    } catch (err) {
      if (!silent) {
        void vscode.window.showErrorMessage(`Sign-in failed: ${String(err)}`);
      }
      return false;
    }
  }

  async signOut(): Promise<void> {
    this._session = undefined;
    this._suppressSilentSignIn = true;
    this._onDidSignInChange.fire(false);
    void vscode.window.showInformationMessage('Signed out of Azure Runbook Workbench.');
  }

  async selectCloud(): Promise<void> {
    const items = Object.values(CLOUD_CONFIG).map(c => ({
      label: c.displayName,
      description: c.name,
      cloud: c.name as AzureCloudName,
    }));

    const current = this.getCloudName();
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Select Azure Cloud Environment',
      placeHolder: `Current: ${CLOUD_CONFIG[current].displayName}`,
    });

    if (picked && picked.cloud !== current) {
      const config = vscode.workspace.getConfiguration('runbookWorkbench');
      await config.update('cloud', picked.cloud, vscode.ConfigurationTarget.Global);
      // Force a new sign-in after cloud change
      this._session = undefined;
      this._suppressSilentSignIn = true;
      this._onDidSignInChange.fire(false);
      void vscode.window.showInformationMessage(
        `Cloud changed to ${picked.label}. Please sign in again.`
      );
    }
  }

  getCloudName(): AzureCloudName {
    const config = vscode.workspace.getConfiguration('runbookWorkbench');
    return (config.get<AzureCloudName>('cloud') ?? 'AzureCloud');
  }

  getResourceManagerEndpoint(): string {
    return CLOUD_CONFIG[this.getCloudName()].resourceManagerEndpoint;
  }

  getGraphEndpoint(): string {
    return CLOUD_CONFIG[this.getCloudName()].graphEndpoint;
  }

  getBlobEndpointBase(storageAccountName: string): string {
    const suffix = CLOUD_CONFIG[this.getCloudName()].blobEndpointSuffix;
    return `https://${storageAccountName}${suffix}`;
  }

  /** Returns a Bearer token scoped to Microsoft Graph.
   *
   * VS Code's Microsoft auth provider uses a Microsoft first-party app ID which
   * cannot request explicit Graph delegated scopes (AADSTS65002). We therefore
   * only request /.default through VS Code auth and rely on the Azure CLI
   * fallback (az account get-access-token --resource graph) for tenants that
   * need Application.ReadWrite.All or Directory.Read.All.
   */
  async getGraphToken(): Promise<string> {
    const base = CLOUD_CONFIG[this.getCloudName()].graphEndpoint;
    // Try Azure CLI first — it uses its own app registration and is more likely
    // to have Graph permissions pre-consented for elevated operations.
    const cliToken = this.getAzureCliAccessToken(base);
    if (cliToken) { return cliToken; }
    // Fall back to VS Code auth with .default (pre-consented permissions only).
    const token = await this.acquireAccessToken([`${base}/.default`], false);
    if (token) { return token; }
    throw new Error(
      'Unable to acquire a Microsoft Graph access token. ' +
      'Run "az login" or ensure your account has the required Graph permissions.'
    );
  }

  /** Returns the raw Bearer token for direct REST calls. */
  async getAccessToken(): Promise<string> {
    const token = await this.acquireAccessToken(this.defaultScopes, false);
    if (token) { return token; }
    throw new Error('Unable to acquire an Azure Resource Manager access token. Sign in with Azure in VS Code or run "az login".');
  }

  dispose(): void {
    this._onDidSignInChange.dispose();
  }

  private get defaultScopes(): string[] {
    const cloud = this.getCloudName();
    const endpoints = CLOUD_CONFIG[cloud];
    return [endpoints.audience, 'offline_access'];
  }

  private async acquireAccessToken(scopes: string | string[], silent: boolean): Promise<string | undefined> {
    const normalizedScopes = Array.isArray(scopes) ? scopes : [scopes];

    const session = await this.getSessionForScopes(normalizedScopes, silent);
    if (session?.accessToken) {
      this._session = session;
      this._suppressSilentSignIn = false;
      return session.accessToken;
    }

    const cliToken = this.getAzureCliAccessToken(this.scopeToResource(normalizedScopes));
    if (cliToken) { return cliToken; }

    return undefined;
  }

  private async getSessionForScopes(scopes: string[], silent: boolean): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession(
        'microsoft',
        scopes,
        { createIfNone: !silent, silent }
      );
    } catch (err) {
      const message = String(err);
      // The built-in Microsoft auth provider does not always issue ARM tokens
      // for arbitrary scopes; fall back to Azure CLI in that case.
      if (message.includes('token for scope')) {
        return undefined;
      }
      if (!silent) {
        throw err;
      }
      return undefined;
    }
  }

  private scopeToResource(scopes: string[]): string {
    const first = scopes[0] ?? CLOUD_CONFIG[this.getCloudName()].resourceManagerEndpoint;
    return first.replace(/\/\.default$/, '').replace(/\/$/, '');
  }

  private getAzureCliAccessToken(resource: string): string | undefined {
    try {
      const token = execFileSync(
        'az',
        ['account', 'get-access-token', '--resource', resource, '--query', 'accessToken', '-o', 'tsv'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      return token || undefined;
    } catch {
      return undefined;
    }
  }
}
