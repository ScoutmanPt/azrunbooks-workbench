<#
.SYNOPSIS
  Deploys (or updates) an Azure Automation Account via Bicep.
  The Bicep template is idempotent — running it against an existing account is safe.

.PARAMETER AccountName     Name of the Automation Account.
.PARAMETER ResourceGroup   Resource group that will contain the account.
.PARAMETER SubscriptionId  Azure subscription ID.
.PARAMETER PipelineRoot    Root folder that contains automation-account.bicep.
.PARAMETER Location        Azure region (defaults to the resource group's location).
.PARAMETER Sku             Pricing tier: Free or Basic (default: Basic).
#>
param(
  [Parameter(Mandatory)] [string] $AccountName,
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [Parameter(Mandatory)] [string] $PipelineRoot,
  [string] $Location = '',
  [string] $Sku = 'Basic'
)

$template = Join-Path $PipelineRoot 'automation-account.bicep'
if (-not (Test-Path $template)) {
  throw "Bicep template not found: $template"
}

$params = @(
  "automationAccountName=$AccountName",
  "sku=$Sku"
)
if ($Location) { $params += "location=$Location" }

Write-Host "-> Deploying Automation Account: $AccountName (sku=$Sku)"
az deployment group create `
  --resource-group $ResourceGroup `
  --subscription $SubscriptionId `
  --template-file $template `
  --parameters @params

if ($LASTEXITCODE -ne 0) {
  throw "Infrastructure deployment failed (exit $LASTEXITCODE)"
}
Write-Host "Infrastructure deployment complete."
