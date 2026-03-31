# Getting Started

This guide walks through the first-time setup of Azure Runbook Workbench in a local repository.

## Goal

By the end of this guide you will have:

- signed in to Azure
- opened a workspace folder in VS Code
- initialized the workspace for one or more Automation Accounts
- fetched runbooks into local source files
- understood the folder layout created by the extension

## Prerequisites

- Visual Studio Code
- the Azure Runbook Workbench extension installed
- access to at least one Azure subscription with Azure Automation Accounts
- for some flows, Azure CLI signed in with `az login`

## Step 1. Open a Workspace Folder

1. Open Visual Studio Code.
2. Open the repository or folder where you want your runbooks to live.
3. Make sure the folder is writable and is the actual root of your project.

Why this matters:

The extension creates a predictable structure under the current workspace root. If you open the wrong folder level, your `aaccounts` structure and metadata will be created there.

## Step 2. Sign In to Azure

1. Open the Azure Runbook Workbench activity bar view.
2. Run `Sign in to Azure`.
3. Complete the Microsoft sign-in flow.
4. If needed, run `Select Azure Cloud` and choose the right cloud environment.

Expected result:

The `Automation Accounts` tree becomes available and starts listing subscriptions and accounts.

## Step 3. Browse Subscriptions and Automation Accounts

1. Expand your subscription in the `Automation Accounts` tree.
2. Expand one of the Azure Automation Accounts.
3. Review the available sections such as `Runbooks`, `Assets`, `PowerShell Modules`, `Runtime Environments`, and `Schedules`.

If sections are empty:

- expand them directly to query Azure live
- or use fetch actions to populate the workspace cache

## Step 4. Initialize the Workspace

There are several ways to initialize:

### Option A. Initialize from an Automation Account

1. Right-click an Automation Account.
2. Choose `Initialize Runbook Workspace`.

### Option B. Initialize all Accounts in a Subscription

1. Right-click a subscription.
2. Choose `Initialize All Accounts and Fetch All`.

This is useful when you want the local workspace prepared for every Automation Account under that subscription.

## Step 5. Review the Workspace Structure

After initialization, the workspace will contain a structure similar to this:

```text
<workspace>/
  aaccounts/
    .settings/
      aaccounts.json
      cache/
        workspace-cache/
        modules/
      mocks/
    <accountName>/
      Runbooks/
    mocks/
      generated/
  local.settings.json
```

### What These Areas Mean

`aaccounts/<accountName>/Runbooks/`

- the editable local runbook source files

`.settings/aaccounts.json`

- linked Automation Account metadata
- per-runbook type metadata
- deployment sync metadata

`.settings/cache/workspace-cache/`

- non-runbook fetched resource data

`.settings/cache/modules/`

- isolated PowerShell module sandbox used for local debug and run

`.settings/mocks/`

- editable mock templates

`aaccounts/mocks/generated/`

- rendered mock artifacts used by local execution

`local.settings.json`

- local values for variables, credentials, and connections used in mocked runs

## Step 6. Fetch Runbooks

1. Right-click an Automation Account and choose `Fetch All Runbooks`.
2. Or right-click a specific runbook in the extension tree and choose:
   - `Fetch Runbook(s) (Published)`
   - `Fetch Runbook(s) (Draft)`

Expected result:

Runbook files appear under:

```text
aaccounts/<accountName>/Runbooks/
```

File extensions are determined from runbook type metadata:

- PowerShell variants use `.ps1`
- Python variants use `.py`

## Step 7. Open and Edit a Runbook

1. Open a file under `aaccounts/<accountName>/Runbooks/`.
2. Make changes as you would in a normal project.
3. Save the file.

You can now:

- compare local vs deployed
- upload as draft
- publish
- run locally
- debug locally

## Step 8. Populate Local Settings for Local Runs

1. Right-click an Automation Account.
2. Choose `Manage Assets (Variables/Credentials/Connections)`.
3. Sync Azure assets into `local.settings.json` or create/edit values manually.

Note:

Encrypted variables and credential passwords cannot be read back from Azure. The extension can create placeholders locally, but you must fill in secret values yourself.

## Step 9. Save Required Modules for Local Debug

If your PowerShell runbook depends on modules not available locally:

1. Right-click an Automation Account or runbook.
2. Choose `Install Module for Local Debug`.
3. Enter the PowerShell module name.

The extension uses `Save-Module` and stores the module in:

```text
.settings/cache/modules/
```

This keeps your global PowerShell environment cleaner.

## Step 10. Run or Debug Locally

1. Right-click a runbook file.
2. Choose:
   - `Run Locally (with Asset Mocks)`
   - `Debug Locally (with Asset Mocks)`

For debugging:

- open the runbook file
- set breakpoints
- press `F5`

## Common First-Time Issues

### No Automation Accounts Are Visible

- confirm Azure sign-in completed
- confirm the right Azure cloud is selected
- verify your account has access to the subscription

### Publish or Upload Fails with Token Errors

- confirm you are signed in through the extension
- confirm `az login` is valid if CLI fallback is needed

### Local Run Fails Because a Module Is Missing

- use `Install Module for Local Debug`
- verify the module was saved into `.settings/cache/modules`

### Python Feels Less Mature Than PowerShell

That is expected right now. Python support exists, but it is still in testing compared with the PowerShell path.

## Next Guides

- [ManageAutomationAccounts.md](/home/scoutman/github/azrunbooks-workbench/docs/howto/ManageAutomationAccounts.md)
- [ManageRunbooks.md](/home/scoutman/github/azrunbooks-workbench/docs/howto/ManageRunbooks.md)
