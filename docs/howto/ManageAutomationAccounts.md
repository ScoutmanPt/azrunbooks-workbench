# Manage Automation Accounts

This guide covers the account-level workflows in the extension.

## What You Can Do

- browse subscriptions and Automation Accounts
- create a new Automation Account
- initialize one account or all accounts in a subscription
- fetch account-level resources into the workspace cache
- manage assets for an account
- generate CI/CD scaffolding for an account

## Step 1. Browse Existing Accounts

1. Open the `Automation Accounts` tree in the extension.
2. Expand a subscription.
3. Review the Automation Accounts listed there.

The account tooltip includes:

- account name
- resource group
- location
- subscription name

## Step 2. Create a New Automation Account

You can create an account from:

- the subscription node in the extension tree
- the `aaccounts` root in the file explorer

### Subscription Tree Method

1. Right-click a subscription.
2. Choose `Create Automation Account`.
3. Choose an existing resource group or create a new one.
4. Enter the new Automation Account name.
5. Confirm the flow.

Behavior notes:

- new accounts default to a system-assigned managed identity
- the extension refreshes the tree and the local workspace after creation

## Step 3. Initialize One Account

1. Right-click an Automation Account.
2. Choose `Initialize Runbook Workspace`.

This creates the local folder structure and links the account into `.settings/aaccounts.json`.

## Step 4. Initialize All Accounts in a Subscription

1. Right-click a subscription.
2. Choose `Initialize All Accounts and Fetch All`.

Use this when you want to onboard a whole subscription quickly.

This flow:

- links each Automation Account locally
- creates the expected account folders
- fetches runbooks and account resource information

## Step 5. Fetch Account-Level Resources

Beyond runbooks, the extension can fetch account resources such as:

- assets
- schedules
- PowerShell modules
- Python packages
- runtime environments
- recent jobs
- hybrid worker groups

Where they go:

- runbooks go to editable files under `aaccounts/<account>/Runbooks/`
- non-runbook resources go into `.settings/cache/workspace-cache/`

## Step 6. Manage Assets for an Account

1. Right-click an Automation Account.
2. Choose `Manage Assets (Variables/Credentials/Connections)`.

From there you can:

- review Azure Automation assets
- create, edit, and delete supported asset types
- sync Azure assets into `local.settings.json`
- push local settings back to Azure for supported asset types

Important note:

Azure does not return secret values for encrypted variables or credential passwords. The extension can seed placeholders locally, but you must fill in secret values yourself.

## Step 7. Generate CI/CD for an Account

1. Right-click an Automation Account.
2. Choose `Generate CI/CD Pipeline`.
3. Choose the target style when prompted.

Generated file names include the Automation Account name as a suffix, so multiple accounts can coexist more cleanly in one repo.

## Step 8. Understand the Account Folder Layout

For each initialized account, the workspace typically looks like:

```text
aaccounts/
  <accountName>/
    Runbooks/
```

What is stored elsewhere:

- account metadata lives under `.settings`
- cache data lives under `.settings/cache`
- generated mocks live under `aaccounts/mocks/generated`

## Step 9. Know the Account-Level Restrictions

Protected structure rules include:

- `aaccounts/` is protected
- `.settings/` is protected
- each Automation Account folder is protected
- each `Runbooks/` folder is protected

That means the extension may warn and restore those items if you try to move, rename, or delete them through the file explorer.

## Recommended Team Practice

- treat `aaccounts/<account>/Runbooks` as source
- treat `.settings` as workspace metadata
- avoid manually reorganizing the account folder structure
- let the extension create and maintain the protected layout

## Next Guide

- [ManageRunbooks.md](/home/scoutman/github/azrunbooks-workbench/docs/howto/ManageRunbooks.md)
