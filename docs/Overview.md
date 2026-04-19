![Overview Banner](assets/overview-banner.svg)

# Azure Runbooks Workbench - Overview

## What The Extension Does

Azure Runbooks Workbench turns Visual Studio Code into a workspace-first development environment for Azure Automation. It lets you browse Automation Accounts, fetch runbooks into a local project, edit them as normal files, compare local and deployed content, upload drafts, publish changes, run or debug scripts locally with mock assets, and generate starter CI/CD pipelines for deployment.

## Problem It Solves

Azure Automation runbook development is usually split between the Azure portal, local editors, ad hoc scripts, and manual deployment steps. This extension closes that gap by keeping the Azure view, the local workspace, and deployment actions in one place. It also adds local developer conveniences that the portal does not provide, such as asset mocking, local module sandboxing, workspace metadata, and runbook-focused tree views.

## Current State Of Python Support

Python runbook support exists for fetch, create, upload, publish, local run, and local debug, but it is still in testing. PowerShell is the more mature path today, especially around local execution and mock coverage.

## Key Features

- Browse subscriptions, Automation Accounts, runbooks, schedules, recent jobs, modules, runtime environments, assets, Python packages, and hybrid worker groups from the custom Azure Runbooks Workbench views.
- Initialize a workspace and link one or more Automation Accounts to a folder on disk.
- Fetch published or draft runbooks into `aaccounts/<account>/Runbooks/`.
- Keep runbook metadata and deploy state in `.settings/aaccounts.json`.
- Create new runbooks directly from VS Code, including prefilled creation flows when deployment detects a missing Azure runbook.
- Upload local content as draft or publish directly to Azure Automation.
- Compare local files against the deployed published or draft content.
- Run PowerShell or Python runbooks locally with mocked Automation assets.
- Debug local runbooks with `F5` or the dedicated debug command.
- Capture local run and debug output in the `Runbook Sessions` panel.
- Save PowerShell modules into a workspace-local sandbox at `.settings/cache/modules` for isolated local execution.
- Generate GitHub Actions or Azure DevOps YAML deployment pipelines with a single orchestrator script covering infrastructure (Bicep), modules, runbooks, assets, and schedules.
- Add local PowerShell modules that are automatically bundled into the pipeline and staged to Azure Blob Storage for import during deployment.
- Manage local mock values for Automation variables and inspect imported PowerShell modules.

## Typical Use Cases

- Link an Automation Account to a repo, fetch all runbooks, and begin editing them as normal source files.
- Fetch a published runbook, change it locally, upload it as draft, run a test job, then publish after validation.
- Create a new local `.ps1` or `.py` runbook and let upload or publish trigger the Azure runbook creation flow with prefilled values.
- Run a PowerShell runbook locally with mocked variables, credentials, connections, PnP, and Microsoft Graph sign-in helpers.
- Save required PowerShell modules into the workspace sandbox so local debugging does not pollute the machine-wide PowerShell environment.
- Include local private modules in the CI/CD pipeline — the extension bundles them as zips and the pipeline stages them via Azure Blob Storage during deployment.
