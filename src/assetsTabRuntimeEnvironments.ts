import type { AzureAutomationAccount, AzureService } from './azureService';
import type { TabState, RuntimeEnvironmentItem } from './assetsShared';
import { esc, renderTabToolbar, SUPPORTED_RUNTIME_VERSIONS } from './assetsShared';

const RUNTIME_VERSIONS = SUPPORTED_RUNTIME_VERSIONS;

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

// ── Form rendering ────────────────────────────────────────────────────────────

export function renderRuntimeEnvironmentsFormBody(prefill: Record<string, unknown>): string {
  const name     = esc(String(prefill['name']        ?? ''));
  const language = esc(String(prefill['language']    ?? ''));
  const version  = esc(String(prefill['version']     ?? ''));
  const desc     = esc(String(prefill['description'] ?? ''));

  // Normalise package map from either source (prefill arrays on error-restore, or Record on edit)
  let pkgMap: Record<string, string> = {};
  if (prefill['defaultPackages'] && !Array.isArray(prefill['defaultPackages'])) {
    pkgMap = prefill['defaultPackages'] as Record<string, string>;
  } else if (Array.isArray(prefill['packageKeys'])) {
    const keys = prefill['packageKeys'] as string[];
    const vers = Array.isArray(prefill['packageVersions']) ? prefill['packageVersions'] as string[] : [];
    keys.forEach((k, i) => { if (k) { pkgMap[k] = vers[i] ?? ''; } });
  }

  const allLanguages = Object.keys(RUNTIME_VERSIONS);

  // Render version options for the currently selected language (or all, hidden)
  const versionSections = allLanguages.map(lang => {
    const versions = RUNTIME_VERSIONS[lang];
    return `<div id="ver-opts-${lang}" class="ver-opts"${language !== lang ? ' style="display:none"' : ''}>
      <select class="form-input" id="f-version">
        <option value="" disabled ${version === '' ? 'selected' : ''}>Select version…</option>
        ${versions.map(v => `<option value="${esc(v)}"${version === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}
      </select>
    </div>`;
  }).join('');

  const pkgRows = Object.entries(pkgMap).map(([k, v]) => `
    <div class="field-row">
      <input class="form-input pkg-name" value="${esc(k)}" placeholder="Package name" />
      <input class="form-input pkg-ver"  value="${esc(v)}" placeholder="Version" />
      <button class="field-row-btn" type="button" title="Remove">&times;</button>
    </div>`).join('');

  const emptyPkgRow = `
    <div class="field-row">
      <input class="form-input pkg-name" placeholder="Package name" />
      <input class="form-input pkg-ver"  placeholder="Version" />
      <button class="field-row-btn" type="button" title="Remove">&times;</button>
    </div>`;

  return `
    <div class="form-field">
      <label class="form-label required">Name</label>
      <input class="form-input" id="f-name" type="text" value="${name}" placeholder="RuntimeEnvironmentName" />
    </div>
    <div class="form-field">
      <label class="form-label required">Language</label>
      <select class="form-input" id="f-language">
        <option value="" disabled ${language === '' ? 'selected' : ''}>Select language…</option>
        ${allLanguages.map(l => `<option value="${esc(l)}"${language === l ? ' selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
    </div>
    <div class="form-field">
      <label class="form-label required">Runtime Version</label>
      <div id="version-container">${versionSections}</div>
    </div>
    <div class="form-field">
      <label class="form-label">Description</label>
      <input class="form-input" id="f-description" type="text" value="${desc}" placeholder="Optional description" />
    </div>
    <div class="form-field">
      <label class="form-label">Default Packages</label>
      <div class="field-rows" id="pkg-rows-container">${Object.keys(pkgMap).length > 0 ? pkgRows : emptyPkgRow}</div>
      <button class="add-field-btn" id="add-pkg-row" type="button">+ Add package</button>
    </div>`;
}

export function renderRuntimeEnvironmentsSubmitButton(): string {
  return `<button class="btn btn-primary" id="f-submit-runtime">Create</button>`;
}

export const RUNTIME_ENVIRONMENTS_FORM_SCRIPT = `
  (function() {
    const RUNTIME_VERSIONS = ${JSON.stringify(RUNTIME_VERSIONS)};

    // ── Language → version sections ──────────────────────────────────────────
    const langSelect = document.getElementById('f-language');
    if (langSelect) {
      langSelect.addEventListener('change', () => {
        const lang = langSelect.value;
        document.querySelectorAll('.ver-opts').forEach(el => { el.style.display = 'none'; });
        const section = document.getElementById('ver-opts-' + lang);
        if (section) { section.style.display = ''; }
      });
    }

    // ── Add / remove package rows ────────────────────────────────────────────
    const addPkgBtn = document.getElementById('add-pkg-row');
    if (addPkgBtn) {
      addPkgBtn.addEventListener('click', () => {
        const container = document.getElementById('pkg-rows-container');
        if (!container) return;
        const row = document.createElement('div');
        row.className = 'field-row';
        row.innerHTML = '<input class="form-input pkg-name" placeholder="Package name" />'
          + '<input class="form-input pkg-ver" placeholder="Version" />'
          + '<button class="field-row-btn" type="button" title="Remove">&times;</button>';
        row.querySelector('.field-row-btn')?.addEventListener('click', () => row.remove());
        container.appendChild(row);
      });
      document.querySelectorAll('#pkg-rows-container .field-row-btn').forEach(btn => {
        btn.addEventListener('click', () => btn.closest('.field-row')?.remove());
      });
    }

    // ── Submit ───────────────────────────────────────────────────────────────
    document.getElementById('f-submit-runtime')?.addEventListener('click', () => {
      const versionEl = document.querySelector('#version-container .ver-opts:not([style*="none"]) #f-version')
        || document.getElementById('f-version');
      const pkgNames = Array.from(document.querySelectorAll('#pkg-rows-container .pkg-name')).map(el => el.value);
      const pkgVers  = Array.from(document.querySelectorAll('#pkg-rows-container .pkg-ver')).map(el => el.value);
      vscode.postMessage({ type: 'submitRuntimeEnvironmentForm', formData: {
        name:            document.getElementById('f-name')?.value        || '',
        language:        langSelect?.value                               || '',
        version:         versionEl?.value                                || '',
        description:     document.getElementById('f-description')?.value || '',
        packageKeys:     pkgNames,
        packageVersions: pkgVers,
      }});
    });
  })();`;
