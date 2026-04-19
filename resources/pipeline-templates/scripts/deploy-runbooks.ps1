<#
.SYNOPSIS
  Creates or updates runbooks in an Azure Automation Account.
  Handles both new accounts (runbook does not yet exist) and updates.

.PARAMETER AccountName     Name of the Automation Account.
.PARAMETER ResourceGroup   Resource group containing the account.
.PARAMETER SubscriptionId  Azure subscription ID.
.PARAMETER AccountPath     Folder that contains the runbook .ps1 / .py files.
#>
param(
  [Parameter(Mandatory)] [string] $AccountName,
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [Parameter(Mandatory)] [string] $AccountPath
)

if (-not (Test-Path $AccountPath)) {
  throw "Runbook folder not found: $AccountPath"
}

$files = Get-ChildItem -Path $AccountPath -File |
         Where-Object { $_.Extension -in '.ps1', '.py' }

if ($files.Count -eq 0) {
  Write-Host "No runbook files found in $AccountPath — skipping."
  exit 0
}

foreach ($file in $files) {
  $runbookName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
  $runbookType = if ($file.Extension -eq '.py') { 'Python3' } else { 'PowerShell' }

  Write-Host "-> Deploying $runbookName ($runbookType)"

  # Check whether the runbook already exists
  $existing = az automation runbook show `
    --automation-account-name $AccountName `
    --resource-group $ResourceGroup `
    --name $runbookName `
    --subscription $SubscriptionId 2>$null

  if (-not $existing) {
    Write-Host "   Creating runbook '$runbookName'..."
    az automation runbook create `
      --automation-account-name $AccountName `
      --resource-group $ResourceGroup `
      --name $runbookName `
      --type $runbookType `
      --subscription $SubscriptionId

    if ($LASTEXITCODE -ne 0) {
      Write-Error "Failed to create runbook '$runbookName'"
      continue
    }
  }

  # Upload draft content
  az automation runbook replace-content `
    --automation-account-name $AccountName `
    --resource-group $ResourceGroup `
    --name $runbookName `
    --content "@$($file.FullName)" `
    --subscription $SubscriptionId

  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to upload content for '$runbookName'"
    continue
  }

  # Publish
  az automation runbook publish `
    --automation-account-name $AccountName `
    --resource-group $ResourceGroup `
    --name $runbookName `
    --subscription $SubscriptionId

  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to publish '$runbookName'"
  }
}

Write-Host "Runbook deployment complete."
