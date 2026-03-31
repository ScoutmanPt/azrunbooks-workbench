# Workspace Rules And Restrictions

This guide explains the protected workspace structure and the file explorer rules enforced by the extension.

## Why These Rules Exist

Azure Runbook Workbench depends on a predictable folder layout. If key folders are renamed, deleted, or moved arbitrarily, the extension can lose account metadata, cache links, or runbook resolution logic.

To reduce accidental breakage, the extension protects specific structural paths.

## Core Protected Areas

### `aaccounts/`

The root `aaccounts` folder is treated as a protected workspace structure folder.

It should not be:

- renamed
- moved
- deleted

### `.settings/`

The `.settings` folder is protected.

Everything inside `.settings` is also protected, including:

- `aaccounts.json`
- cache content
- module sandbox content
- mock template content

Temporary run/debug artifacts under `.settings/tmp/` are the exception. That folder is disposable scratch space and can be deleted when you want to clear generated local-run state.

These should not be manually moved, renamed, or deleted in normal use.

### Automation Account Folders

Folders like:

```text
aaccounts/<accountName>/
```

are protected because the extension uses them as the local root for each linked Automation Account.

### `Runbooks` Folders

Folders like:

```text
aaccounts/<accountName>/Runbooks/
```

are also protected.

The folder itself should not be:

- renamed
- moved
- deleted

## What Is Allowed Inside `Runbooks`

### Files

Files inside a `Runbooks` folder can be:

- renamed
- moved
- deleted

This is intentional so normal source-control and editor workflows still work for runbook files.

### Folders

Folders inside a `Runbooks` folder are not allowed.

If a folder is:

- created inside `Runbooks`
- moved into `Runbooks`

the extension removes or reverts it and shows a warning.

## What Happens When a Protected Action Is Attempted

### Rename or Move

For protected items, the extension:

1. shows a warning
2. attempts to restore the original name or location

### Delete

For protected items, the extension:

1. captures a temporary backup before deletion
2. shows a warning
3. restores the deleted item after the delete event

This is best-effort recovery designed to reduce accidental structural damage.

## What Is Not Meant To Be Edited Manually

These are part of extension-managed structure and state:

- `.settings/aaccounts.json`
- `.settings/cache/`
- `.settings/mocks/`
- `.settings/cache/modules/`
- `.settings/tmp/` is safe to delete when you want to clear temporary local-run artifacts

## What Is Meant To Be Worked On Normally

These are part of the normal developer workflow:

- runbook source files under `aaccounts/<account>/Runbooks`
- `local.settings.json`
- CI/CD YAML files you generate into the repo

## Recommended Team Rules

- do not manually restructure the `aaccounts` folder
- do not rename protected structural folders in Explorer
- treat `.settings` as extension-managed state
- treat runbook files as source code
- keep secrets out of committed files

## Summary

Use the extension to manage structure.

Use the editor and Git to manage source files.

That separation keeps the workspace stable while still letting runbooks behave like real source code.
