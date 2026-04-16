/**
 * Renders the "Configured permissions" detail view for a selected app —
 * matching the Azure portal "API permissions" page (image 1).
 */
import type { SelectedAppState, ConfiguredPermission } from './appPermissionsShared';
import { esc } from './appPermissionsShared';

// ── Main render ───────────────────────────────────────────────────────────────

export function renderDetailView(app: SelectedAppState): string {
  if (app.loading) {
    return `
      <div class="detail-header">
        <button class="btn btn-ghost" id="btn-back">&#8592; Back</button>
        <span class="detail-app-name">${esc(app.displayName)}</span>
      </div>
      <div class="loading-state">Loading permissions…</div>`;
  }

  if (app.error) {
    return `
      <div class="detail-header">
        <button class="btn btn-ghost" id="btn-back">&#8592; Back</button>
        <span class="detail-app-name">${esc(app.displayName)}</span>
      </div>
      <div class="error-state">Error: ${esc(app.error)}</div>`;
  }

  const saveError = app.saveError
    ? `<div class="form-error" style="margin:8px 16px">${esc(app.saveError)}</div>` : '';

  const isManagedIdentity = app.kind === 'servicePrincipal' && app.servicePrincipalType === 'ManagedIdentity';
  const canAdd = app.kind === 'application' || Boolean(app.linkedAppObjectId) || isManagedIdentity;
  const canRemove = app.kind === 'application' || Boolean(app.linkedAppObjectId) || isManagedIdentity;
  const addBtn  = canAdd
    ? `<button class="btn btn-primary" id="btn-add-permission">+ Add a permission</button>`
    : `<span class="form-hint" style="padding:0 4px">Read-only: no app registration found in this tenant for this service principal.</span>`;
  const editHint = isManagedIdentity
    ? '<div class="form-hint" style="padding:0 16px 8px">Managed identity permissions are managed directly on the service principal. You can add application permissions from this screen.</div>'
    : '';
  const identityMeta = app.kind === 'servicePrincipal'
    ? `<div class="detail-app-meta">Object ID: ${esc(app.id)}${app.servicePrincipalType ? ` · ${esc(servicePrincipalTypeLabel(app.servicePrincipalType))}` : ''}</div>`
    : '';

  const permsByResource = groupByResource(app.permissions);
  const totalCount = app.permissions.length;
  const gridHtml = permsByResource.length === 0
    ? `<div class="empty-state">${isManagedIdentity ? 'No permissions are currently granted to this managed identity.' : 'No configured permissions.'}</div>`
    : permsByResource.map(g => renderResourceGroup(g, canRemove)).join('');

  const deleteAllBtn = canRemove && totalCount > 0
    ? `<button class="btn btn-danger" id="btn-delete-all-permissions">Delete all</button>`
    : '';

  return `
    <div class="detail-header">
      <button class="btn btn-ghost" id="btn-back">&#8592; Back</button>
      <div class="detail-app-name">${esc(app.displayName)}</div>
      <div class="detail-app-meta">App ID: ${esc(app.appId)}</div>
      ${identityMeta}
    </div>
    ${saveError}
    <div class="detail-toolbar">
      <div class="detail-toolbar-title">Configured permissions</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="search-input" id="perm-search" type="text" placeholder="Search permissions…" style="width:200px" />
        <button class="btn btn-ghost" id="btn-refresh-permissions">&#8635; Refresh</button>
        ${deleteAllBtn}
        ${addBtn}
      </div>
    </div>
    ${editHint}
    <div class="perm-description">
      Applications are authorized to call APIs when they are granted permissions.
      The list of configured permissions should include all the permissions the application needs.
    </div>
    <div class="perm-grid">
      <div class="perm-grid-header">
        <span class="cell cell-action"></span>
        <span class="cell cell-api">API / Permission name</span>
        <span class="cell cell-type">Type</span>
        <span class="cell cell-desc">Description</span>
        <span class="cell cell-admin">Admin consent req.</span>
      </div>
      ${gridHtml}
    </div>`;
}

// ── Resource group rendering ──────────────────────────────────────────────────

interface ResourceGroup {
  resourceAppId: string;
  resourceDisplayName: string;
  items: ConfiguredPermission[];
}

function servicePrincipalTypeLabel(type: string): string {
  switch (type) {
    case 'ManagedIdentity': return 'Managed Identity';
    case 'Application': return 'Enterprise Application';
    default: return type;
  }
}

function groupByResource(perms: ConfiguredPermission[]): ResourceGroup[] {
  const map = new Map<string, ResourceGroup>();
  for (const p of perms) {
    if (!map.has(p.resourceAppId)) {
      map.set(p.resourceAppId, { resourceAppId: p.resourceAppId, resourceDisplayName: p.resourceDisplayName, items: [] });
    }
    map.get(p.resourceAppId)!.items.push(p);
  }
  return [...map.values()];
}

function renderResourceGroup(group: ResourceGroup, canEdit: boolean): string {
  const count = group.items.length;
  const rows = group.items.map(p => renderPermRow(p, canEdit)).join('');
  return `
    <div class="perm-resource-header">
      <span class="perm-resource-name">${esc(group.resourceDisplayName)} (${count})</span>
    </div>
    ${rows}`;
}

function renderPermRow(p: ConfiguredPermission, canEdit: boolean): string {
  const typeLabel = p.type === 'Scope' ? 'Delegated' : 'Application';
  const adminLabel = p.adminConsentRequired ? 'Yes' : 'No';
  const deleteBtn = canEdit
    ? `<button class="btn-icon-danger" data-remove-resource="${esc(p.resourceAppId)}" data-remove-id="${esc(p.id)}" title="Remove permission">&#128465;</button>`
    : '';
  return `
    <div class="perm-row">
      <span class="cell cell-action">${deleteBtn}</span>
      <span class="cell cell-api perm-name">${esc(p.value)}</span>
      <span class="cell cell-type perm-type">${typeLabel}</span>
      <span class="cell cell-desc perm-desc">${esc(p.description)}</span>
      <span class="cell cell-admin">${adminLabel}</span>
    </div>`;
}

// ── Webview script snippet ────────────────────────────────────────────────────

export const DETAIL_SCRIPT = `
  document.getElementById('btn-back')?.addEventListener('click', () =>
    vscode.postMessage({ type: 'backToSearch' })
  );

  document.getElementById('btn-add-permission')?.addEventListener('click', () =>
    vscode.postMessage({ type: 'showAddPanel' })
  );

  document.getElementById('btn-refresh-permissions')?.addEventListener('click', () =>
    vscode.postMessage({ type: 'refresh' })
  );

  document.getElementById('btn-delete-all-permissions')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'removeAllPermissions' });
  });

  // Search / filter
  document.getElementById('perm-search')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.perm-row').forEach(row => {
      const text = row.textContent?.toLowerCase() ?? '';
      row.style.display = q === '' || text.includes(q) ? '' : 'none';
    });
    // Hide resource headers when all their rows are hidden
    document.querySelectorAll('.perm-resource-header').forEach(header => {
      let next = header.nextElementSibling;
      let anyVisible = false;
      while (next && next.classList.contains('perm-row')) {
        if (next.style.display !== 'none') { anyVisible = true; break; }
        next = next.nextElementSibling;
      }
      header.style.display = anyVisible ? '' : 'none';
    });
  });

  document.body.addEventListener('click', e => {
    const btn = e.target.closest('[data-remove-resource]');
    if (btn) {
      vscode.postMessage({
        type: 'removePermission',
        resourceAppId: btn.getAttribute('data-remove-resource'),
        permissionId:  btn.getAttribute('data-remove-id'),
      });
    }
  });`;

// ── CSS specific to detail view ───────────────────────────────────────────────

export const DETAIL_CSS = `
  .detail-header { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--border); flex-shrink:0; flex-wrap:wrap; }
  .detail-app-name { font-size:15px; font-weight:600; flex:1; }
  .detail-app-meta { font-size:11px; color:var(--muted); width:100%; margin-top:-6px; padding-left:0; }
  .detail-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 16px 10px; flex-shrink:0; flex-wrap:wrap; }
  .detail-toolbar-title { font-size:14px; font-weight:600; }
  .perm-description { font-size:12px; color:var(--muted); padding:0 16px 12px; line-height:1.5; max-width:1100px; }
  .perm-grid { flex:1; overflow-y:auto; padding:0 16px 16px; }
  .perm-grid-header { display:grid; grid-template-columns:44px minmax(240px, 2fr) 120px minmax(320px, 3fr) 150px; position:sticky; top:0; background:var(--surface); border-bottom:1px solid var(--border); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); min-height:40px; align-items:center; margin:0 -16px; padding:0 16px; z-index:1; column-gap:16px; }
  .perm-resource-header { padding:14px 0 6px; font-weight:600; font-size:13px; color:var(--accent); border-bottom:1px solid var(--border); display:flex; align-items:center; gap:6px; }
  .perm-resource-name {}
  .perm-row { display:grid; grid-template-columns:44px minmax(240px, 2fr) 120px minmax(320px, 3fr) 150px; align-items:start; min-height:48px; border-bottom:1px solid var(--border); padding:10px 0; column-gap:16px; }
  .perm-row:hover { background:var(--hover); }
  .perm-name { font-weight:600; padding-left:0; }
  .perm-desc { font-size:12px; color:var(--muted); line-height:1.45; white-space:normal; }
  .perm-type { font-size:12px; }
  .cell-api   { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .cell-type  { }
  .cell-desc  { overflow:hidden; }
  .cell-admin { font-size:12px; color:var(--muted); padding-top:1px; }
  .cell-action { display:flex; justify-content:flex-end; }
  .btn-icon-danger { background:none; border:none; cursor:pointer; color:var(--muted); font-size:15px; padding:2px 6px; border-radius:3px; }
  .btn-icon-danger:hover { color:var(--danger); }`;
