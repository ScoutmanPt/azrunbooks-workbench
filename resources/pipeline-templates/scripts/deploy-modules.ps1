<#
.SYNOPSIS
  Deploys PowerShell/Python modules to an Azure Automation Account via the REST API.
  Reads the module list from <PipelineRoot>/modules.<AccountName>.json.

.PARAMETER AccountName     Name of the Automation Account.
.PARAMETER ResourceGroup   Resource group containing the account.
.PARAMETER SubscriptionId  Azure subscription ID.
.PARAMETER PipelineRoot    Folder that contains the modules manifest.
#>
param(
  [Parameter(Mandatory)] [string] $AccountName,
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [Parameter(Mandatory)] [string] $PipelineRoot
)

$modulesManifest = Join-Path $PipelineRoot ("modules.{0}.json" -f $AccountName)

if (-not (Test-Path $modulesManifest)) {
  Write-Host "No module manifest at $modulesManifest — skipping."
  exit 0
}

$manifest = Get-Content $modulesManifest -Raw | ConvertFrom-Json
$modules  = @($manifest.modules)
if ($modules.Count -eq 0) {
  Write-Host "Module manifest is empty — skipping."
  exit 0
}

$baseUrl = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup" +
           "/providers/Microsoft.Automation/automationAccounts/$AccountName"
$apiVer  = 'api-version=2023-11-01'

foreach ($mod in $modules) {
  Write-Host "-> Module: $($mod.name)  ($($mod.uri))"

  $contentLink = @{ uri = [string]$mod.uri }
  if ($mod.version) { $contentLink.version = [string]$mod.version }

  $body = @{
    name       = $mod.name
    properties = @{ contentLink = $contentLink }
  } | ConvertTo-Json -Depth 5 -Compress

  az rest --method put `
    --url "$baseUrl/modules/$($mod.name)?$apiVer" `
    --body $body `
    --headers 'Content-Type=application/json' `
    --subscription $SubscriptionId

  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to deploy module '$($mod.name)'"
  }
}

Write-Host "Module deployment complete."
