# Azure Runbook Workbench - Manual Test Plan

Run these in the Extension Development Host (`F5` in VS Code).

---

## 1. Authentication

| # | Action | Expected |
|---|--------|----------|
| 1.1 | Open extension with no prior sign-in | Accounts tree shows "Sign in to Azure…" item |
| 1.2 | Click "Sign in to Azure…" or run `Sign in to Azure` command | Microsoft auth popup appears; after login, subscriptions load |
| 1.3 | Run `Sign out of Azure` command | Tree resets to sign-in prompt; no credentials cached |
| 1.4 | Run `Select Azure Cloud` command | QuickPick shows Public / Government / China / Germany |
| 1.5 | Select a different cloud, then sign in | Auth uses the selected cloud endpoint |
| 1.6 | Re-open VS Code (session already cached) | Extension silently restores session; subscriptions load without prompt |

---

## 2. Accounts Tree View

| # | Action | Expected |
|---|--------|----------|
| 2.1 | Expand a subscription node | Lists all Automation Accounts in that subscription |
| 2.2 | Expand an Automation Account | Shows 7 section nodes: Runbooks, Recent Jobs, Schedules, PowerShell Modules, Assets, Python Packages, Hybrid Worker Groups |
| 2.3 | Expand "Runbooks" section | Lists all runbooks with state (Published/Draft/New) and type icon |
| 2.4 | Expand any other section (e.g. Schedules) | Shows "Fetch all resources to populate…" hint item |
| 2.5 | Click `Refresh` toolbar button | Tree re-fetches from Azure |
| 2.6 | Account with no runbooks | Shows "No runbooks in this account." placeholder |
| 2.7 | Subscription with no Automation Accounts | Shows "No Automation Accounts in this subscription." |

---

## 3. Workspace Initialization

| # | Action | Expected |
|---|--------|----------|
| 3.1 | Open a folder, right-click Automation Account → `Initialize Runbook Workspace` | Creates `.settings/aaccounts.json`, `local.settings.json`, `.gitignore` |
| 3.2 | Check `.gitignore` | Contains `local.settings.json` and `.env` |
| 3.3 | `local.settings.json` auto-opens | Contains account entry with `IsEncrypted: false` |
| 3.4 | Re-initialize same account | Updates entry without duplicating; no error |
| 3.5 | Initialize with no folder open | Error: "Open a folder in VS Code before initializing" |
| 3.6 | Right-click Subscription → `Initialize All Accounts and Fetch All` | All accounts in subscription are initialized and runbooks fetched |

---

## 4. Workspace Tree View (always visible)

| # | Action | Expected |
|---|--------|----------|
| 4.1 | Open with no account linked | 7 sections visible, each shows "No account linked - initialize workspace first" |
| 4.2 | After init - expand Runbooks | Shows "No runbooks fetched yet" (before any fetch) |
| 4.3 | After fetching runbooks - expand Runbooks | Lists all local `.ps1` / `.py` files |
| 4.4 | Click a runbook in Workspace tree | Opens the file in editor |
| 4.5 | Two accounts linked | Root shows account nodes; expand each to see 7 sections |
| 4.6 | Published + Draft of same runbook with identical content | Both show `↔` badge ("linked twin") |
| 4.7 | Runbook with local changes not yet published | Shows `AHEAD` description + red arrow icon |
| 4.8 | Click `Refresh Workspace` toolbar button | Workspace tree re-reads disk |

---

## 5. Fetch Operations

| # | Action | Expected |
|---|--------|----------|
| 5.1 | Right-click runbook → `Fetch Runbook (Published)` | Opens `.ps1`/`.py` in editor; file appears under account Runbooks folder |
| 5.2 | Fetch Draft for a runbook in Draft state | File saved with draft content |
| 5.3 | Fetch runbook when workspace not initialized | Auto-initializes workspace first, then fetches |
| 5.4 | Fetch a runbook in `New` state (no content) | Error: "Runbook not found" |
| 5.5 | Right-click account → `Fetch All Runbooks` | Progress notification; all runbooks saved; summary message |
| 5.6 | Fetch all on account with no runbooks | "No runbooks found in…" info message |

---

## 6. Create Runbook

| # | Action | Expected |
|---|--------|----------|
| 6.1 | Right-click Automation Account → `Create New Runbook` | Prompts: name, type (PS72/PS51/Py3/Py2), description |
| 6.2 | Enter valid name → select type → add description | Runbook created in Azure; draft fetched to workspace; file opens |
| 6.3 | Enter invalid name (starts with number) | Validation error shown in input box |
| 6.4 | Cancel at name prompt | Nothing happens |
| 6.5 | Right-click `.ps1` file in Explorer (inside aaccounts/) → `Create New Runbook` | Same flow, account inferred from path |
| 6.6 | Right-click account folder in Explorer → `Create New Runbook` | Same flow |
| 6.7 | Account missing location (old workspace) | Error: "Account missing location data. Re-run Initialize Runbook Workspace" |

---

## 7. Publish / Upload as Draft

| # | Action | Expected |
|---|--------|----------|
| 7.1 | Right-click runbook → `Publish Runbook` | Confirmation modal; uploads content + publishes; state → Published |
| 7.2 | Cancel publish confirmation | No action taken |
| 7.3 | Publish runbook with no local file | Error: "No local copy found. Fetch it first." |
| 7.4 | Right-click runbook → `Upload as Draft` | Uploads without publishing; no confirmation needed |
| 7.5 | After publish, workspace runbook shows deploy hash as current | `AHEAD` badge disappears |

---

## 8. Delete Runbook

| # | Action | Expected |
|---|--------|----------|
| 8.1 | Right-click in Accounts tree → `Delete Runbook` | Confirmation modal; runbook deleted from Azure; tree refreshes |
| 8.2 | Right-click workspace runbook / `.ps1` file → `Delete Runbook` | Confirmation: "Delete local workspace copy?" |
| 8.3 | Confirm local delete - user is signed in | Local file deleted; second prompt: "Also delete from Azure?" |
| 8.4 | Second prompt: choose "Delete from Azure" | Remote runbook also deleted |
| 8.5 | Second prompt: choose "Keep in Azure" | Only local file deleted |
| 8.6 | Confirm local delete - user NOT signed in | Local file deleted; info message: "Sign in to also delete from Azure" with Sign In button |
| 8.7 | Press Delete key on file in Explorer | Same flow as right-click delete (file system watcher not implemented - manual delete only) |

---

## 9. Diff (Compare Local vs Deployed)

| # | Action | Expected |
|---|--------|----------|
| 9.1 | Right-click runbook → `Compare Local vs Deployed` | QuickPick: "Published" or "Draft" |
| 9.2 | Select Published | Diff editor opens: remote published (left) vs local file (right) |
| 9.3 | Select Draft | Diff editor opens: remote draft (left) vs local file (right) |
| 9.4 | No local file | Error: "No local copy found. Fetch it first." |

---

## 10. Test Job

| # | Action | Expected |
|---|--------|----------|
| 10.1 | Right-click runbook → `Start Test Job` | Prompts for parameters (JSON); uploads local as draft; starts job |
| 10.2 | Empty `{}` parameters | Job starts without parameters |
| 10.3 | Invalid JSON in parameters | Error: "Invalid JSON for parameters" |
| 10.4 | While job is running → `Stop Test Job` | Job stopped; output channel shows "stopped" |
| 10.5 | Job completes | Output channel shows all stream output + "Final status: Completed" |
| 10.6 | Job fails | Output channel shows "Final status: Failed" |
| 10.7 | Job runs >5 minutes (60 polls) | "Polling timeout - check Azure portal" logged |

---

## 11. Local Run (with Asset Mocks)

| # | Action | Expected |
|---|--------|----------|
| 11.1 | Right-click PowerShell runbook → `Run Locally` | Spawns `pwsh` with AutomationAssetsMock.psm1 injected |
| 11.2 | Output channel shows script output | All Write-Host / Write-Output printed to output channel |
| 11.3 | Script calls `Get-AutomationVariable "SomeVar"` with mock in local.settings.json | Returns mock value |
| 11.4 | Missing variable | Mock warns "[Mock] Variable not found" |
| 11.5 | Right-click Python runbook → `Run Locally` | Spawns `python3` with `automationstubs.py` on PYTHONPATH |
| 11.6 | `pwsh` not installed | Error: "PowerShell (pwsh) not found. Install PowerShell 7+" |
| 11.7 | Python not installed | Error: "Python 3 not found." |
| 11.8 | Runbook not fetched locally | Error: "No local file for … Fetch it first." |

---

## 12. Assets Panel

| # | Action | Expected |
|---|--------|----------|
| 12.1 | Right-click account → `Manage Assets` | QuickPick: Variables, Modules |
| 12.2 | Select Variables | Lists all variables; encrypted ones show 🔒 |
| 12.3 | Variables with no local mock | Prompt: "Add them to local.settings.json?" |
| 12.4 | Accept "Add All" | Variables added to `local.settings.json`; output channel logs count |
| 12.5 | Select Modules | Lists all imported PS modules with version |

---

## 13. CI/CD Pipeline Generation

| # | Action | Expected |
|---|--------|----------|
| 13.1 | Run `Generate CI/CD Pipeline` | QuickPick: GitHub Actions / Azure DevOps / Both |
| 13.2 | Select GitHub Actions | Creates `.github/workflows/deploy-runbooks-<account>.yml`; opens in editor |
| 13.3 | Select Azure DevOps | Creates `azure-pipelines-<account>.yml`; opens in editor |
| 13.4 | Select Both | Both files created; both open in editor |
| 13.5 | GitHub YAML contains account name, resource group, subscription ID | Values match linked account |
| 13.6 | Azure DevOps YAML contains service connection placeholder | `YOUR_SERVICE_CONNECTION_NAME` present |
| 13.7 | No linked account | Error: "No linked account. Run Initialize Runbook Workspace first." |

---

## 14. Open local.settings.json

| # | Action | Expected |
|---|--------|----------|
| 14.1 | Run `Open local.settings.json` command | File opens in editor |
| 14.2 | Edit a variable value then run locally | Mock uses the new value |

---

## 15. Icon Theme & Folder Decorations

| # | Action | Expected |
|---|--------|----------|
| 15.1 | After init, workspace icon theme switches | Folder icons: colored for account, section-specific for Runbooks/Schedules/etc. |
| 15.2 | First account → blue folder; second account → green | Colors match subscription colors in tree view |
| 15.3 | `.ps1` files have blue PowerShell icon | Applies in File Explorer |
| 15.4 | `.py` files have yellow Python icon | Applies in File Explorer |
| 15.5 | `.settings/aaccounts.json` has the key icon | Applies in the workspace |
| 15.6 | `.gitignore` has git icon | Applies in workspace root |

---

## 16. Explorer Context Menus

| # | Action | Expected |
|---|--------|----------|
| 16.1 | Right-click `aaccounts/` folder in Explorer | Shows `Create New Runbook` |
| 16.2 | Right-click account subfolder in Explorer | Shows `Create New Runbook` |
| 16.3 | Right-click `.ps1` file in `Runbooks/` | Shows `Fetch Runbook`, `Publish`, `Upload as Draft`, `Compare`, `Start Test Job`, `Run Locally`, `Delete`, `Create New Runbook` |
| 16.4 | Right-click file outside workspace | No extension menu items |

---

## 17. Settings

| # | Action | Expected |
|---|--------|----------|
| 17.1 | Set `runbookWorkbench.cloud` to `AzureUSGovernment` | Auth uses Government cloud endpoints |
| 17.2 | Set `runbookWorkbench.workspacePath` to a custom path | Extension uses that path instead of workspace root |

---

## 18. Edge Cases & Error Handling

| # | Action | Expected |
|---|--------|----------|
| 18.1 | No VS Code workspace folder open → any workspace command | Error: "No workspace folder is open. Open a folder…" with "Open Folder" button |
| 18.2 | Azure API returns 401 / auth expired | Token refreshed transparently; retry succeeds |
| 18.3 | Azure API returns 404 on fetch | Friendly error: "Runbook not found in Azure Automation account." |
| 18.4 | `.settings/aaccounts.json` is corrupt JSON | Logged to console; getLinkedAccounts returns [] gracefully |
| 18.5 | `local.settings.json` is corrupt JSON | Logged to console; returns default settings gracefully |
| 18.6 | Network disconnected during fetch | Error message shown; output channel logs details |
| 18.7 | Delete file path traversal attempt (e.g. `../../etc/passwd`) | Throws "Refusing to delete file outside workspace accounts directory" |
