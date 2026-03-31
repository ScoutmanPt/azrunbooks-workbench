/**
 * Renders the "Add a permission" slide-over panel —
 * matching the Azure portal slide-over (image 2).
 */
import type { AddPanelState, PermissionEntry } from './appPermissionsShared';
import { esc, KNOWN_API_LABELS } from './appPermissionsShared';

// ── Main render ───────────────────────────────────────────────────────────────

export function renderAddPanel(state: AddPanelState): string {
  const tabs = (['graph', 'sharepoint', 'azure'] as const).map(k => {
    const active = state.tab === k;
    return `<button class="add-tab${active ? ' active' : ''}" data-tab="${k}">${esc(KNOWN_API_LABELS[k])}</button>`;
  }).join('');

  const perms = getDisplayPerms(state);
  const listHtml = renderPermList(state, perms);
  const selectionCount = getPendingSelectionCount(state);

  return `
    <div class="slideover-overlay" id="slideover-overlay"></div>
    <div class="slideover" id="add-panel">
      <div class="slideover-header">
        <span class="slideover-title">Add a permission</span>
        <button class="btn btn-ghost" id="btn-close-add">&#10005;</button>
      </div>
      <div class="add-tabs">${tabs}</div>
      <div class="add-kind-row">
        <label class="add-kind-label${state.kind === 'delegated' ? ' selected' : ''}${state.allowDelegated ? '' : ' disabled'}" data-kind="delegated">
          <input type="radio" name="perm-kind" value="delegated"${state.kind === 'delegated' ? ' checked' : ''}${state.allowDelegated ? '' : ' disabled'}>
          <span class="add-kind-title">Delegated permissions</span>
          <span class="add-kind-desc">${state.allowDelegated
            ? 'Your application needs to access the API as the signed-in user.'
            : 'Managed identities do not support delegated permissions.'}</span>
        </label>
        <label class="add-kind-label${state.kind === 'application' ? ' selected' : ''}" data-kind="application">
          <input type="radio" name="perm-kind" value="application"${state.kind === 'application' ? ' checked' : ''}>
          <span class="add-kind-title">Application permissions</span>
          <span class="add-kind-desc">Your application runs as a background service without a signed-in user.</span>
        </label>
      </div>
      <div class="add-toolbar">
        <input class="search-input" id="add-perm-search" placeholder="Search permissions…" value="${esc(state.search)}" autocomplete="off">
        <div class="add-selection-summary">${selectionCount} selected</div>
      </div>
      ${state.loading ? '<div class="loading-state" style="flex:1">Loading permissions…</div>' :
        state.error  ? `<div class="error-state" style="flex:1">Error: ${esc(state.error)}</div>` :
        listHtml}
      ${state.saveError ? `<div class="form-error" style="margin:8px 16px">${esc(state.saveError)}</div>` : ''}
      <div class="slideover-footer">
        <button class="btn btn-primary" id="btn-add-permissions"${state.saving || selectionCount === 0 ? ' disabled' : ''}>
          ${state.saving ? 'Adding…' : 'Add permissions'}
        </button>
        <button class="btn btn-ghost" id="btn-cancel-add">Cancel</button>
      </div>
    </div>`;
}

// ── Permission list ───────────────────────────────────────────────────────────

function getDisplayPerms(state: AddPanelState): PermissionEntry[] {
  const cached = state.cache[state.tab];
  if (!cached) { return []; }
  const list = state.kind === 'delegated' ? cached.delegated : cached.application;
  if (!state.search) { return list; }
  const q = state.search.toLowerCase();
  return list.filter(p =>
    p.value.toLowerCase().includes(q) ||
    p.displayName.toLowerCase().includes(q) ||
    p.description.toLowerCase().includes(q)
  );
}

function isAlreadyGranted(state: AddPanelState, permId: string): boolean {
  if (state.currentPermissionIds.includes(permId)) { return true; }
  return Boolean(state.currentRequiredAccess?.find(r =>
    r.resourceAccess.some(a => a.id === permId)
  ));
}

function isPendingSelection(state: AddPanelState, permId: string): boolean {
  return getCurrentSelection(state).includes(permId);
}

function getCurrentSelection(state: AddPanelState): string[] {
  return state.pendingSelections[state.tab]?.[state.kind] ?? [];
}

function getPendingSelectionCount(state: AddPanelState): number {
  return Object.values(state.pendingSelections)
    .flatMap(kinds => Object.values(kinds ?? {}))
    .reduce((count, ids) => count + ids.length, 0);
}

function renderPermList(state: AddPanelState, perms: PermissionEntry[]): string {
  if (perms.length === 0) {
    return '<div class="empty-state" style="flex:1">No permissions found.</div>';
  }
  const rows = perms.map(p => {
    const granted = isAlreadyGranted(state, p.id);
    const pending = isPendingSelection(state, p.id);
    const adminBadge = p.adminConsentRequired
      ? '<span class="perm-admin-badge">Admin</span>' : '';
    return `
      <label class="add-perm-row${granted ? ' granted' : ''}">
        <input type="checkbox" class="add-perm-check" data-perm-id="${esc(p.id)}"${granted || pending ? ' checked' : ''}${granted ? ' disabled' : ''}>
        <span class="add-perm-info">
          <span class="add-perm-name">${esc(p.value)} ${adminBadge}</span>
          <span class="add-perm-desc">${esc(p.description)}</span>
        </span>
      </label>`;
  }).join('');
  return `<div class="add-perm-list">${rows}</div>`;
}

// ── Webview script snippet ────────────────────────────────────────────────────

export const ADD_PANEL_SCRIPT = `
  const addPanelState = vscode.getState?.() || {};
  const restoreAddSearchFocus = () => {
    const input = document.getElementById('add-perm-search');
    if (!input) { return; }
    if (!addPanelState.searchFocused) { return; }
    const start = typeof addPanelState.searchSelectionStart === 'number'
      ? addPanelState.searchSelectionStart
      : input.value.length;
    const end = typeof addPanelState.searchSelectionEnd === 'number'
      ? addPanelState.searchSelectionEnd
      : input.value.length;
    requestAnimationFrame(() => {
      input.focus();
      try {
        input.setSelectionRange(start, end);
      } catch {}
    });
  };
  restoreAddSearchFocus();

  document.getElementById('btn-close-add')?.addEventListener('click', () =>
    vscode.postMessage({ type: 'closeAddPanel' })
  );
  document.getElementById('btn-cancel-add')?.addEventListener('click', () =>
    vscode.postMessage({ type: 'closeAddPanel' })
  );
  document.getElementById('slideover-overlay')?.addEventListener('click', () =>
    vscode.postMessage({ type: 'closeAddPanel' })
  );

  // Tab switching
  document.querySelector('.add-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-tab]');
    if (btn) {
      vscode.postMessage({ type: 'addPanelSwitchTab', tab: btn.getAttribute('data-tab') });
    }
  });

  // Kind (delegated / application) switching
  document.querySelectorAll('input[name="perm-kind"]').forEach(radio => {
    radio.addEventListener('change', e => {
      if (e.target.checked) {
        vscode.postMessage({ type: 'addPanelSwitchKind', kind: e.target.value });
      }
    });
  });

  // Search debounce
  let _searchTimer = null;
  document.getElementById('add-perm-search')?.addEventListener('input', e => {
    const input = e.target;
    vscode.setState?.({
      ...addPanelState,
      searchFocused: true,
      searchSelectionStart: input.selectionStart,
      searchSelectionEnd: input.selectionEnd,
    });
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      vscode.postMessage({ type: 'addPanelSearch', query: e.target.value });
    }, 200);
  });
  document.getElementById('add-perm-search')?.addEventListener('focus', e => {
    const input = e.target;
    vscode.setState?.({
      ...addPanelState,
      searchFocused: true,
      searchSelectionStart: input.selectionStart,
      searchSelectionEnd: input.selectionEnd,
    });
  });
  document.getElementById('add-perm-search')?.addEventListener('blur', () => {
    vscode.setState?.({
      ...addPanelState,
      searchFocused: false,
    });
  });

  document.querySelectorAll('.add-perm-check:not(:disabled)').forEach(box => {
    box.addEventListener('change', e => {
      const input = e.target;
      vscode.postMessage({
        type: 'addPanelTogglePermission',
        permissionId: input.getAttribute('data-perm-id'),
        checked: input.checked,
      });
    });
  });

  // Add permissions
  document.getElementById('btn-add-permissions')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'addPermissions' });
  });
`;

// ── CSS specific to add panel ─────────────────────────────────────────────────

export const ADD_PANEL_CSS = `
  .slideover-overlay { position:fixed; inset:0; background:rgba(0,0,0,.35); z-index:100; }
  .slideover { position:fixed; top:0; right:0; bottom:0; width:560px; max-width:100vw; background:var(--surface); border-left:1px solid var(--border); display:flex; flex-direction:column; z-index:101; box-shadow:-4px 0 16px rgba(0,0,0,.2); }
  .slideover-header { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--border); flex-shrink:0; }
  .slideover-title { font-size:15px; font-weight:600; }
  .slideover-footer { display:flex; gap:8px; padding:12px 16px; border-top:1px solid var(--border); flex-shrink:0; }
  .add-tabs { display:flex; gap:0; border-bottom:1px solid var(--border); flex-shrink:0; overflow-x:auto; }
  .add-tab { background:none; border:none; border-bottom:2px solid transparent; padding:8px 14px; cursor:pointer; font-size:12px; color:var(--muted); white-space:nowrap; }
  .add-tab.active { border-bottom-color:var(--accent); color:var(--fg); font-weight:600; }
  .add-tab:hover:not(.active) { color:var(--fg); }
  .add-kind-row { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px; padding:12px 16px; flex-shrink:0; }
  .add-kind-label { display:flex; flex-direction:column; gap:3px; flex:1; border:1px solid var(--border); border-radius:4px; padding:10px; cursor:pointer; }
  .add-kind-label.selected { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 8%, transparent); }
  .add-kind-label.disabled { opacity:.55; cursor:default; }
  .add-kind-label input[type="radio"] { margin:0 0 4px; }
  .add-kind-title { font-size:13px; font-weight:600; }
  .add-kind-desc { font-size:11px; color:var(--muted); line-height:1.4; }
  .add-toolbar { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:12px; align-items:center; padding:8px 16px 12px; flex-shrink:0; }
  .add-selection-summary { font-size:12px; color:var(--muted); white-space:nowrap; }
  .add-perm-list { flex:1; overflow-y:auto; padding:0 16px; }
  .add-perm-row { display:flex; align-items:flex-start; gap:10px; padding:8px 0; border-bottom:1px solid var(--border); cursor:pointer; }
  .add-perm-row.granted { opacity:.6; }
  .add-perm-row input[type="checkbox"] { margin-top:3px; flex-shrink:0; }
  .add-perm-info { display:flex; flex-direction:column; gap:2px; min-width:0; }
  .add-perm-name { font-size:13px; font-weight:500; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .add-perm-desc { font-size:11px; color:var(--muted); line-height:1.4; }
  .perm-admin-badge { font-size:10px; background:color-mix(in srgb, var(--accent) 15%, transparent); color:var(--accent); border-radius:3px; padding:1px 5px; font-weight:600; }`;
