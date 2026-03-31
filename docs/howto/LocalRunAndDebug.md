# Local Run And Debug

This guide explains how to test runbooks locally without constantly going back to the Azure portal.

## What This Covers

- local mock templates
- generated mocks
- local settings
- PowerShell module sandboxing
- `Run Locally`
- `Debug Locally`
- `F5` debugging

## Step 1. Prepare Local Asset Values

The extension uses `local.settings.json` for local variable, credential, and connection values.

You can populate it by:

1. Right-clicking an Automation Account.
2. Choosing `Manage Assets (Variables/Credentials/Connections)`.
3. Syncing Azure assets into the local settings file.

Remember:

- encrypted variable values are not readable from Azure
- credential passwords are not readable from Azure
- you must fill in secret placeholders yourself

## Step 2. Review Mock Template Files

Editable mock templates live in:

```text
.settings/mocks/
```

These templates define the mock code used during local execution.

Typical examples include:

- Automation asset helper mocks
- PnP PowerShell connection mocks
- Microsoft Graph PowerShell connection mocks
- Python stub templates

## Step 3. Review Generated Mock Files

Generated runtime mocks are placed under:

```text
aaccounts/mocks/generated/
```

These are rendered from templates for the specific account and runbook execution context.

You generally do not edit generated mocks directly.

## Step 4. Install Required PowerShell Modules Locally

If your runbook imports real modules:

1. Right-click an Automation Account or runbook.
2. Choose `Install Module for Local Debug`.
3. Enter the module name.

The extension uses `Save-Module` and stores the module under:

```text
.settings/cache/modules/
```

This gives you a workspace-local PowerShell module sandbox instead of polluting your main PowerShell environment.

## Step 5. Run a Runbook Locally

1. Right-click a runbook file.
2. Choose `Run Locally (with Asset Mocks)`.

Output is shown in the `Runbook Sessions` panel.

What happens behind the scenes:

- the extension renders required mocks
- the local PowerShell or Python process is launched
- output is streamed into the session view

## Step 6. Debug a Runbook Locally

1. Open the runbook file in the editor.
2. Set breakpoints.
3. Press `F5`.

Or:

1. Right-click the file.
2. Choose `Debug Locally (with Asset Mocks)`.

### PowerShell

The extension launches the PowerShell debugger with the mock environment prepared first.

### Python

Python local debug exists and works through the extension flow, but it is still in testing compared to PowerShell.

## Step 7. Understand When Azure Is Not Required

Local run and debug can work even if the runbook does not exist in Azure yet, as long as:

- the local file exists
- the workspace can resolve the account context

This is useful when you are authoring a new runbook before publishing it for the first time.

## Step 8. Common Troubleshooting

### Missing Module Errors

- install the missing module using `Install Module for Local Debug`
- verify it was stored in `.settings/cache/modules`

### Mock Values Seem Wrong

- review `local.settings.json`
- review the templates under `.settings/mocks`

### PowerShell Output Looks Strange

The extension already strips ANSI clutter when needed, and local sessions are routed into the dedicated panel. If the output still looks odd, confirm the script itself is valid PowerShell syntax.

### Managed Identity Commands Do Not Work Locally

That is expected for many Azure-only flows. The extension provides local mocks for several connection patterns, but not every cloud-only behavior can be reproduced locally.

## Good Practice

- keep real secrets out of source control
- use local placeholders when Azure cannot return secret values
- save modules into the workspace sandbox instead of installing globally
- treat generated mocks as disposable runtime artifacts

## Next Guide

- [WorkspaceRulesAndRestrictions.md](/home/scoutman/github/azrunbooks-workbench/docs/howto/WorkspaceRulesAndRestrictions.md)
