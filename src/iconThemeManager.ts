import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkspaceManager } from './workspaceManager';
import type { SubscriptionColorRegistry } from './subscriptionColorRegistry';

/** Maps runbookType → icon definition ID in the theme JSON. */
const LOCAL_RUNTIME_ICON: Record<string, string> = {
  'Script':                      '_file_ps72',
  'PowerShell':                  '_file_ps72',
  'PowerShellWorkflow':          '_file_pswf',
  'PowerShell7':                 '_file_ps71',
  'PowerShell72':                '_file_ps72',
  'Python2':                     '_file_py2',
  'Python3':                     '_file_py3',
  'Graph':                       '_file_graphical',
  'GraphPowerShell':             '_file_graphical',
  'GraphicalPowerShell':         '_file_graphical',
  'GraphPowerShellWorkflow':     '_file_graphical_wf',
  'GraphicalPowerShellWorkflow': '_file_graphical_wf',
};

const RUNTIME_ICON: Record<string, string> = {
  'Script':                      '_file_ps51_azure',
  'PowerShell':                  '_file_ps51_azure',
  'PowerShellWorkflow':          '_file_pswf_azure',
  'PowerShell7':                 '_file_ps71_azure',
  'PowerShell72':                '_file_ps72_azure',
  'Python2':                     '_file_py2_azure',
  'Python3':                     '_file_py3_azure',
  'Graph':                       '_file_graphical_azure',
  'GraphPowerShell':             '_file_graphical_azure',
  'GraphicalPowerShell':         '_file_graphical_azure',
  'GraphPowerShellWorkflow':     '_file_graphical_wf_azure',
  'GraphicalPowerShellWorkflow': '_file_graphical_wf_azure',
};

export class IconThemeManager {
  private readonly themePath: string;

  constructor(
    extensionPath: string,
    private readonly workspace: WorkspaceManager,
    private readonly colorRegistry: SubscriptionColorRegistry
  ) {
    this.themePath = path.join(extensionPath, 'resources', 'runbook-workbench-icons.json');
  }

  /**
   * Updates folderNames in the icon theme JSON so each automation account
   * folder gets the same colored server icon as in the tree view.
   * Also applies the theme to the current workspace (workspace-level only -
   * does not affect other VS Code projects).
   */
  update(): void {
    this.writeTheme();
    this.applyToWorkspace();
  }

  private writeTheme(): void {
    let theme: Record<string, unknown>;
    try {
      theme = JSON.parse(fs.readFileSync(this.themePath, 'utf8'));
    } catch {
      return;
    }

    // Static folder name mappings (always preserved) - all use plain SVG folder
    const staticFolders: Record<string, string> = {
      '.vscode':            '_folder_default',
      '.rb-workb':          '_account_orange',
      '.settings':          '_folder_settings',
      cache:                '_folder_muted',
      mocks:                '_folder_templates',
      templates:            '_folder_templates',
      'workspace-cache':   '_folder_muted',
      generated:           '_folder_muted',
      modules:             '_folder_muted',
      tmp:                 '_folder_muted',
      aaccounts:            '_folder_accounts',
      Assets:               '_folder_assets',
      HybridWorkerGroups:   '_folder_hybrid',
      PowerShellModules:    '_folder_powershell',
      PythonPackages:       '_folder_python',
      RecentJobs:           '_folder_recentjobs',
      Schedules:            '_folder_schedules',
      Published:            '_folder_published',
      Draft:                '_folder_draft',
    };
    const OPEN_VARIANT: Record<string, string> = {
      '_folder_default':  '_folder_default_open',
      '_folder_muted':    '_folder_muted_open',
      '_folder_settings': '_folder_settings_open',
      '_folder_templates':'_folder_templates_open',
      '_account_orange':    '_account_orange_open',
      '_folder_accounts':   '_folder_accounts_open',
      '_folder_recentjobs': '_folder_recentjobs_open',
      '_folder_schedules':  '_folder_schedules_open',
      '_folder_python':      '_folder_python_open',
      '_folder_powershell':  '_folder_powershell_open',
      '_folder_assets':      '_folder_assets_open',
      '_folder_hybrid':      '_folder_hybrid_open',
      '_account_blue':       '_account_blue_open',
      '_folder_published':   '_folder_published_open',
      '_folder_draft':       '_folder_draft_open',
    };
    const staticFoldersExpanded: Record<string, string> = Object.fromEntries(
      Object.entries(staticFolders).map(([k, v]) => [k, OPEN_VARIANT[v] ?? v])
    );
    const folderNames: Record<string, string> = { ...staticFolders };
    const folderNamesExpanded: Record<string, string> = { ...staticFoldersExpanded };
    for (const account of this.workspace.getLinkedAccounts()) {
      folderNames[account.accountName] = '_account_bright_blue';
      folderNamesExpanded[account.accountName] = '_account_bright_blue_open';
    }

    theme.folder = '_folder_default';
    theme.folderExpanded = '_folder_default_open';
    theme.folderNames = folderNames;
    theme.folderNamesExpanded = folderNamesExpanded;
    // Always preserve these extension mappings (fallback for unrecognised files)
    theme.fileExtensions = { ps1: '_file_ps72', psm1: '_file_psm1', json: '_file_json', py: '_file_py3', template: '_file_template' };

    // Build fileNames: static entries + per-runbook runtime icons from meta.
    // fileNames takes precedence over fileExtensions in VS Code icon themes,
    // so named runbooks get their specific runtime icon instead of the generic PS/Py icon.
    const fileNames: Record<string, string> = {
      '.gitignore': '_file_gitignore',
      '.env': '_file_env_muted',
      'aaccounts.json': '_file_aaccounts',
      'local.settings.json': '_file_json_muted',
      'AutomationAssetsMock.psm1.template': '_file_template',
      'PnPPowerShellMock.psm1.template': '_file_template',
      'MicrosoftGraphMock.psm1.template': '_file_template',
      'automationstubs.py.template': '_file_template',
    };
    for (const account of this.workspace.getLinkedAccounts()) {
      for (const runbook of this.workspace.listWorkspaceRunbooks().filter(item => item.accountName === account.accountName)) {
        const ext = path.extname(runbook.filePath).toLowerCase();
        const fallbackType = runbook.runbookType || (ext === '.py' ? 'Python3' : 'PowerShell');
        const localIconId = LOCAL_RUNTIME_ICON[fallbackType];
        if (localIconId) {
          fileNames[path.basename(runbook.filePath)] = localIconId;
        }
      }
      const meta = this.workspace.getRunbookMeta(account.accountName);
      for (const [runbookName, runbookMeta] of Object.entries(meta)) {
        const runbookType: string = runbookMeta.runbookType;
        const iconId = RUNTIME_ICON[runbookType];
        if (!iconId) { continue; }
        const ext = runbookType.toLowerCase().startsWith('python') ? '.py' : '.ps1';
        fileNames[`${runbookName}${ext}`] = iconId;
      }
    }
    theme.fileNames = fileNames;

    fs.writeFileSync(this.themePath, JSON.stringify(theme, null, 2), 'utf8');
  }

  private applyToWorkspace(): void {
    if (!this.workspace.isWorkspaceOpen) { return; }
    const cfg = vscode.workspace.getConfiguration();
    const current = cfg.inspect<string>('workbench.iconTheme');
    if (current?.workspaceValue !== 'runbook-workbench-icons') {
      void cfg.update('workbench.iconTheme', 'runbook-workbench-icons', vscode.ConfigurationTarget.Workspace);
    }
    const explorerDecorationColors = cfg.inspect<boolean>('explorer.decorations.colors');
    if (explorerDecorationColors?.workspaceValue !== false) {
      void cfg.update('explorer.decorations.colors', false, vscode.ConfigurationTarget.Workspace);
    }
  }
}
