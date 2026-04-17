![Architecture Banner](assets/architecture-banner.svg)

# Azure Runbooks Workbench - Architecture

## Project Structure

```text
azrunbooks-workbench/
- src/
  - extension.ts - activation entry point and service composition
  - authManager.ts - VS Code auth and Azure CLI token fallback
  - azureService.ts - Azure Automation SDK and ARM REST operations
  - accountsTreeProvider.ts - Azure-side tree for subscriptions, accounts, runbooks, and account resources
  - workspaceRunbooksTreeProvider.ts - workspace-side tree backed by local files and cached JSON
  - workspaceManager.ts - file I/O, metadata, local settings, cache, mocks, and module sandbox paths
  - runbookCommands.ts - high-level runbook lifecycle actions
  - rbCommands.ts - command registration, argument resolution, and UI routing
  - localRunner.ts - local execution, debug launch, mocks, and module sandbox injection
  - runbookSessionsViewProvider.ts - webview used for live local run output
  - cicdGenerator.ts - GitHub Actions and Azure DevOps pipeline generation
  - folderDecorationProvider.ts - folder and runtime decorations
  - iconThemeManager.ts - generated icon theme and account folder coloring
  - cloudConfig.ts - Azure cloud endpoint definitions
  - subscriptionColorRegistry.ts - stable subscription color assignment
- resources/
  - mock-templates/ - PowerShell and Python local mock templates
  - icons/ - custom icon assets
  - runbook-workbench-icons.json - generated icon theme payload
- test/
  - mock-vscode.ts - VS Code API test double
  - *.test.ts - unit and integration coverage
  - run-tests.cjs - unit test bootstrap
  - run-e2e.cjs - e2e bootstrap
- dist/
  - extension.js - bundled extension output
- .settings/aaccounts.json - linked accounts, runbook metadata, and deploy sync state
- .settings/cache/ - cached resources and local module sandbox
- .settings/mocks/ - seeded mock templates
- aaccounts/mocks/generated/ - generated mock content
- aaccounts/ - linked account runbook files created at runtime
- package.json - extension manifest, commands, views, settings, menus
- esbuild.config.mjs - build pipeline
```

## Key Modules

| File | Class Or Module | Responsibility |
| --- | --- | --- |
| [`src/extension.ts`](/home/scoutman/github/azrunbooks-workbench/src/extension.ts) | `activate` | Composes services, registers providers and commands, reveals the sessions panel, and applies workflow read-only protection. |
| [`src/authManager.ts`](/home/scoutman/github/azrunbooks-workbench/src/authManager.ts) | `AuthManager` | Acquires ARM tokens from VS Code auth first and Azure CLI second, manages cloud selection, and exposes a credential for the Azure SDK. |
| [`src/azureService.ts`](/home/scoutman/github/azrunbooks-workbench/src/azureService.ts) | `AzureService` | Wraps Azure Automation list operations and lifecycle operations such as create, draft upload, publish, fetch content, delete, and test jobs. |
| [`src/accountsTreeProvider.ts`](/home/scoutman/github/azrunbooks-workbench/src/accountsTreeProvider.ts) | `AccountsTreeProvider` | Builds the Azure-side explorer tree for subscriptions, Automation Accounts, runbooks, jobs, schedules, assets, modules, packages, runtime environments, and hybrid workers. |
| [`src/workspaceManager.ts`](/home/scoutman/github/azrunbooks-workbench/src/workspaceManager.ts) | `WorkspaceManager` | Owns local workspace structure, metadata files, mock template seeding, generated mock paths, cache paths, and deploy tracking. |
| [`src/workspaceRunbooksTreeProvider.ts`](/home/scoutman/github/azrunbooks-workbench/src/workspaceRunbooksTreeProvider.ts) | `WorkspaceRunbooksTreeProvider` | Displays the workspace view from local runbook files and cached section JSON. |
| [`src/runbookCommands.ts`](/home/scoutman/github/azrunbooks-workbench/src/runbookCommands.ts) | `RunbookCommands` | Implements fetch, publish, diff, test job, create, delete, and fetch-all orchestration. |
| [`src/rbCommands.ts`](/home/scoutman/github/azrunbooks-workbench/src/rbCommands.ts) | `registerRbCommands` | Connects command IDs to command handlers, resolves selected items, and coordinates view refreshes and user prompts. |
| [`src/localRunner.ts`](/home/scoutman/github/azrunbooks-workbench/src/localRunner.ts) | `LocalRunner` | Runs and debugs PowerShell and Python runbooks locally, writes rendered mocks, and injects local module paths. |
| [`src/runbookSessionsViewProvider.ts`](/home/scoutman/github/azrunbooks-workbench/src/runbookSessionsViewProvider.ts) | `RunbookSessionsViewProvider` | Hosts the bottom-panel live output UI for local run sessions. |
| [`src/cicdGenerator.ts`](/home/scoutman/github/azrunbooks-workbench/src/cicdGenerator.ts) | `CiCdGenerator` | Writes starter deployment YAML for GitHub Actions and Azure DevOps. |

## Data Flow

The extension follows a layered flow:

1. The user signs in through `AuthManager`.
2. `AzureService` uses that auth state to call the Azure Automation SDK or direct ARM REST endpoints.
3. Tree providers request data from `AzureService` or `WorkspaceManager`.
4. Commands route through `rbCommands.ts`, then call `RunbookCommands`, `LocalRunner`, or `CiCdGenerator`.
5. `WorkspaceManager` persists local state such as runbook files, per-account `runbooks` metadata in `.settings/aaccounts.json`, deploy hashes, mock templates, generated mocks, local settings, and cached non-runbook section data.
6. VS Code UI surfaces the results through tree items, editors, notifications, decorations, and the `Runbook Sessions` webview.

## Activation Lifecycle

1. VS Code activates the extension when one of its contributed commands, views, menus, or keybindings is used.
2. [`src/extension.ts`](/home/scoutman/github/azrunbooks-workbench/src/extension.ts) constructs the core services:
   - `AuthManager`
   - `AzureService`
   - `WorkspaceManager`
   - `AccountsTreeProvider`
   - `WorkspaceRunbooksTreeProvider`
   - `RunbookCommands`
   - `LocalRunner`
   - `CiCdGenerator`
   - `RunbookSessionsViewProvider`
3. Tree views are registered for:
   - `Automation Accounts`
   - `Workspace`
   - `Runbook Sessions`
4. File decoration providers and the generated icon theme are applied.
5. Command handlers are registered through `registerRbCommands`.
6. The extension attempts to reveal the bottom `Runbook Sessions` panel once on first activation.
7. When a PowerShell Workflow file is opened, the workflow guard marks it read-only and warns that workflows are not supported in PowerShell 6+.

## Workspace Layout

The extension creates and uses this runtime structure inside the user workspace:

```text
<workspace>/
- aaccounts/
  - <accountName>/
    - Runbooks/
      - Published/
      - Draft/
- local.settings.json
- .settings/aaccounts.json
- .settings/cache/
  - workspace-cache/
  - modules/
-   - mocks/
    - generated/
```

## Key Design Decisions

- The extension is workspace-first. Local files are treated as the primary editing surface, not a temporary cache of portal content.
- Authentication prefers VS Code native auth, but falls back to `az account get-access-token` when VS Code cannot provide the needed ARM-scoped token.
- Create, upload, and publish use direct REST calls for some paths because the Azure SDK long-running operation handling does not fit these Automation endpoints cleanly.
- Non-runbook account resources are cached as JSON in `.settings/cache/workspace-cache/` so they do not clutter the File Explorer.
- Local PowerShell module isolation uses `.settings/cache/modules` and `Save-Module`, not `Install-Module`, to avoid polluting the host PowerShell environment.
- Local mock code is template-driven from `resources/mock-templates/` and rendered into workspace-local generated files rather than being hardcoded in TypeScript.
- Python support is implemented but still considered in testing, so the local runner and docs call that out explicitly.
