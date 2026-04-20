import * as fs from 'fs';
import * as path from 'path';
import type { AzureAutomationAccount, AzureService } from './azureService';
import type { TabState, ModuleItem } from './assetsShared';
import { esc } from './assetsShared';

// ── Data loading ──────────────────────────────────────────────────────────────

export async function loadModules(
  azure: AzureService,
  account: AzureAutomationAccount,
  localModulesDir: string
): Promise<TabState<ModuleItem>> {
  try {
    const [azureModules, localModules] = await Promise.all([
      azure.listImportedModules(account.subscriptionId, account.resourceGroupName, account.name),
      Promise.resolve(readLocalModules(localModulesDir)),
    ]);

    const azureNames = new Set(azureModules.map(m => m.name.toLowerCase()));
    const localNames = new Set(localModules.map(m => m.name.toLowerCase()));

    const items: ModuleItem[] = [
      // Local-only modules first
      ...localModules
        .filter(m => !azureNames.has(m.name.toLowerCase()))
        .map(m => ({ name: m.name, version: m.version, source: 'local' as const })),
      // Azure modules — mark if also present locally
      ...azureModules.map(m => ({
        name: m.name,
        version: m.version,
        source: localNames.has(m.name.toLowerCase()) ? 'local' as const : 'azure' as const,
        provisioningState: m.provisioningState,
      })),
    ];

    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return { items, loading: false };
  } catch (e) {
    return { items: [], loading: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function readLocalModules(localModulesDir: string): Array<{ name: string; version: string }> {
  if (!fs.existsSync(localModulesDir)) { return []; }
  const results: Array<{ name: string; version: string }> = [];
  for (const entry of fs.readdirSync(localModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) { continue; }
    const moduleRoot = path.join(localModulesDir, entry.name);
    const versions = fs.readdirSync(moduleRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
    if (versions.length) {
      results.push({ name: entry.name, version: versions[0] });
    }
  }
  return results;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

export function renderModulesPane(state: TabState<ModuleItem>): string {
  if (state.loading) { return '<div class="loading-state">Loading modules…</div>'; }
  if (state.error)   { return `<div class="error-state">${esc(state.error)}</div>`; }

  const intro = `
    <div class="asset-note">
      Classic Automation Account modules plus workspace-local debug modules from <code>.settings/cache/modules</code>.
      Runtime Environment packages are managed in the <strong>Runtime Environments</strong> tab.
    </div>`;

  const rows = state.items.length === 0
    ? '<div class="empty-state">No modules found. Use the buttons above to install or import one.</div>'
    : state.items.map(m => {
        const sourceBadge = m.source === 'local'
          ? `<span class="cell-tag mod-local">local sandbox</span>`
          : `<span class="cell-tag mod-azure">Azure</span>`;
        const provState = m.provisioningState && m.provisioningState.toLowerCase() !== 'succeeded'
          ? `<span class="cell-muted"> · ${esc(m.provisioningState)}</span>`
          : '';
        const search = [m.name, m.version, m.source, m.provisioningState].filter(Boolean).join(' ').toLowerCase();
        return `
        <div class="grid-row cols-mods mod-row" data-name="${esc(m.name)}" data-source="${m.source}" data-search="${esc(search)}">
          <div class="cell cell-name">${esc(m.name)}</div>
          <div class="cell cell-muted">${esc(m.version)}</div>
          <div class="cell">${sourceBadge}${provState}</div>
          <div class="cell mod-actions">
            ${m.source === 'local'
              ? `<button class="btn btn-secondary btn-xs mod-deploy-btn" data-name="${esc(m.name)}" title="Deploy to Azure Automation">&#8679; Deploy to Azure</button>`
              : ''}
          </div>
        </div>`;
      }).join('');

  return `
    <div class="pane-toolbar mod-toolbar">
      <input class="search-box" id="search-modules" type="text" placeholder="Search modules…" />
      <button class="btn btn-primary" id="btn-install-gallery">&#8659; From Gallery</button>
      <button class="btn btn-secondary" id="btn-import-local">&#8625; Import Local</button>
    </div>
    ${intro}
    <div class="grid-container">
      <div class="grid-header cols-mods">
        <div class="cell">Module</div>
        <div class="cell">Version</div>
        <div class="cell">Source</div>
        <div class="cell"></div>
      </div>
      ${rows}
    </div>`;
}

export const MODULES_CSS = `
  .cols-mods { grid-template-columns: 2.5fr 1fr 1.8fr 1.5fr; }
  .mod-toolbar { flex-wrap: wrap; gap: 8px; }
  .asset-note { margin: 0 16px 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); background: color-mix(in srgb, var(--surface) 78%, transparent); line-height: 1.45; }
  .asset-note code { color: var(--fg); }
  .mod-actions { display: flex; gap: 6px; justify-content: flex-end; }
  .btn-xs { font-size: 12px; padding: 3px 9px; }
  .mod-local { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .mod-azure { background: color-mix(in srgb, #4ec9b0 22%, transparent); color: #4ec9b0; border-color: color-mix(in srgb, #4ec9b0 40%, transparent); }
`;

export const MODULES_SCRIPT = `
  document.getElementById('btn-install-gallery')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'moduleAction', action: 'installGallery' });
  });
  document.getElementById('btn-import-local')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'moduleAction', action: 'importLocal' });
  });
  document.querySelectorAll('.mod-deploy-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const name = btn.getAttribute('data-name');
      vscode.postMessage({ type: 'moduleAction', action: 'deployToAzure', moduleName: name });
    });
  });
`;
