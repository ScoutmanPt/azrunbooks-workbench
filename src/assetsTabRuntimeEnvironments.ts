import type { AzureAutomationAccount, AzureService } from './azureService';
import type { TabState, RuntimeEnvironmentItem } from './assetsShared';
import { esc, renderTabToolbar } from './assetsShared';

export async function loadRuntimeEnvironments(
  azure: AzureService,
  account: AzureAutomationAccount
): Promise<TabState<RuntimeEnvironmentItem>> {
  try {
    const items = await azure.listRuntimeEnvironments(account.subscriptionId, account.resourceGroupName, account.name);
    return {
      items: items.map(item => ({
        name: item.name,
        language: item.language,
        version: item.version,
        description: item.description,
        provisioningState: item.provisioningState,
        defaultPackages: item.defaultPackages,
      })),
      loading: false,
    };
  } catch (e) {
    return { items: [], loading: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function renderRuntimeEnvironmentsPane(state: TabState<RuntimeEnvironmentItem>): string {
  if (state.loading) { return '<div class="loading-state">Loading runtime environments…</div>'; }
  if (state.error)   { return `<div class="error-state">${esc(state.error)}</div>`; }

  const intro = `
    <div class="asset-note">
      Runtime Environments define the execution runtime and default packages used by newer Azure Automation runbooks.
      Classic imported modules remain in the <strong>Classic Modules</strong> tab.
    </div>`;

  const rows = state.items.length === 0
    ? '<div class="empty-state">No runtime environments found. Use New to create one.</div>'
    : state.items.map(item => {
        const packages = item.defaultPackages && Object.keys(item.defaultPackages).length > 0
          ? Object.entries(item.defaultPackages).map(([name, version]) => `${name}@${version}`).join(', ')
          : '';
        return `
        <div class="grid-row cols-runtimes" data-tab="runtimeEnvironments" data-name="${esc(item.name)}" data-search="${esc([
          item.name,
          item.language,
          item.version,
          item.description,
          item.provisioningState,
          packages,
        ].filter(Boolean).join(' ').toLowerCase())}">
          <div class="cb-col"><input class="row-cb" type="checkbox" value="${esc(item.name)}" /></div>
          <div class="cell cell-name">${esc(item.name)}</div>
          <div class="cell cell-muted">${esc([item.language, item.version].filter(Boolean).join(' '))}</div>
          <div class="cell cell-muted">${esc(packages || item.description || '')}</div>
          <div class="cell">${item.provisioningState ? `<span class="cell-tag">${esc(item.provisioningState)}</span>` : ''}</div>
        </div>`;
      }).join('');

  return `
    ${renderTabToolbar('runtimeEnvironments')}
    ${intro}
    <div class="grid-container">
      <div class="grid-header cols-runtimes">
        <div class="cell"><input id="sel-all-runtimeEnvironments" type="checkbox" /></div>
        <div class="cell">Name</div>
        <div class="cell">Runtime</div>
        <div class="cell">Packages / Description</div>
        <div class="cell">State</div>
      </div>
      ${rows}
    </div>`;
}
