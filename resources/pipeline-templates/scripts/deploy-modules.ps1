param(
  [Parameter(Mandatory = $true)]
  [string]$AccountName,

  [Parameter(Mandatory = $true)]
  [string]$ResourceGroup,

  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $true)]
  [string]$PipelineRoot
)

$modulesTemplate = Join-Path $PipelineRoot 'automation-modules.bicep'
$modulesManifest = Join-Path $PipelineRoot ("modules.{0}.json" -f $AccountName)
$tempRoot = $env:RUNNER_TEMP
if (-not $tempRoot) {
  $tempRoot = $env:AGENT_TEMPDIRECTORY
}
if (-not $tempRoot) {
  $tempRoot = [System.IO.Path]::GetTempPath()
}

if (-not (Test-Path $modulesManifest)) {
  Write-Host "No module manifest found at $modulesManifest. Skipping module deployment."
  exit 0
}

$moduleManifest = Get-Content $modulesManifest -Raw | ConvertFrom-Json
$modules = @($moduleManifest.modules)
if ($modules.Count -eq 0) {
  Write-Host "Module manifest is empty. Skipping module deployment."
  exit 0
}

$modulesParamsPath = Join-Path $tempRoot ("automation-modules.{0}.parameters.json" -f $AccountName)
$modulesParameters = @{
  '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
  contentVersion = '1.0.0.0'
  parameters = @{
    automationAccountName = @{ value = $AccountName }
    modules = @{ value = $modules }
  }
}

$modulesParameters | ConvertTo-Json -Depth 20 | Set-Content -Path $modulesParamsPath -Encoding utf8
az deployment group create `
  --resource-group $ResourceGroup `
  --template-file $modulesTemplate `
  --parameters "@$modulesParamsPath" `
  --subscription $SubscriptionId
