# Manage Runbooks

This guide explains the main runbook lifecycle inside the extension.

## What You Can Do

- create runbooks
- fetch published or draft content
- edit locally
- compare local and deployed content
- upload as draft
- publish
- start jobs and test jobs
- delete runbooks

## Step 1. Create a New Runbook

You can create a runbook from:

- an Automation Account
- the `Runbooks` folder in the file explorer
- command-triggered create flows with prefilled values

### Create from an Automation Account

1. Right-click an Automation Account.
2. Choose `Create New Runbook`.
3. Enter the runbook name.
4. Choose the runbook type.
5. Enter a description if needed.

The extension then:

- creates the runbook in Azure
- writes local metadata for the runbook type
- updates the workspace

## Step 2. Fetch an Existing Runbook

### Fetch Published

1. Right-click a runbook in the tree or a runbook file in Explorer.
2. Choose `Fetch Runbook(s) (Published)`.

### Fetch Draft

1. Right-click the runbook.
2. Choose `Fetch Runbook(s) (Draft)`.

### Fetch All Runbooks

1. Right-click an Automation Account.
2. Choose `Fetch All Runbooks`.

Special case:

If Azure returns a runbook with no content stream yet, the extension still creates an empty local file and warns you rather than skipping it.

## Step 3. Edit Runbooks Locally

Runbook files are stored as normal source files:

```text
aaccounts/<account>/Runbooks/<runbook>.ps1
aaccounts/<account>/Runbooks/<runbook>.py
```

You can use the file explorer, editor tabs, Git, diff tools, and your usual development flow.

## Step 4. Compare Local vs Deployed

1. Right-click a runbook file or runbook item.
2. Choose `Compare Local vs Deployed`.

Use this before publishing when you want to validate exactly what changed.

## Step 5. Upload a Draft

1. Right-click the local runbook file.
2. Choose `Upload as Draft(s)`.

If the runbook does not exist remotely yet:

- the extension can route you through the create flow
- it pre-fills the runbook name and inferred type

## Step 6. Publish a Runbook

1. Right-click the local runbook file.
2. Choose `Publish Runbook(s)`.

The extension uploads the content and publishes it in Azure.

If the remote runbook is missing, the create flow can be triggered first.

## Step 7. Start an Automation Job

1. Right-click the runbook.
2. Choose `Start Automation Job`.

This starts a normal Azure Automation job against the deployed runbook.

## Step 8. Start a Test Job

1. Right-click the runbook.
2. Choose `Start Test Job`.

Use this for test execution when supported by the runbook/runtime path.

## Step 9. Delete a Runbook

You can delete from:

- the extension tree
- the file explorer

Bulk delete supports multi-select.

The current flow is designed to be clearer than before:

- one confirmation for delete intent
- Azure deletion is handled before local deletion where applicable
- failures are summarized instead of silently disappearing into logs

## Step 10. Understand File Explorer Rules Under Runbooks

Current workspace behavior:

- files inside `xyz/Runbooks` can be renamed, deleted, and moved
- the `Runbooks` folder itself is protected
- folders inside `xyz/Runbooks` are not allowed

If a folder is created or moved into `Runbooks`, the extension removes or reverts it and warns you.

## Good Runbook Workflow

1. Fetch the current version.
2. Edit locally.
3. Run or debug locally if needed.
4. Compare local vs deployed.
5. Upload as draft.
6. Publish when ready.

## Next Guide

- [LocalRunAndDebug.md](LocalRunAndDebug.md)
