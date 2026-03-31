param(
  [Parameter(Mandatory = $true)]
  [string]$AccountName,

  [Parameter(Mandatory = $true)]
  [string]$ResourceGroup,

  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $true)]
  [string]$PipelineRoot,

  [Parameter(Mandatory = $true)]
  [string]$LocalSettingsPath
)

$assetTemplate = Join-Path $PipelineRoot 'automation-assets.bicep'
$certificatesManifest = Join-Path $PipelineRoot ("certificates.{0}.json" -f $AccountName)
$tempRoot = $env:RUNNER_TEMP
if (-not $tempRoot) {
  $tempRoot = $env:AGENT_TEMPDIRECTORY
}
if (-not $tempRoot) {
  $tempRoot = [System.IO.Path]::GetTempPath()
}

$settings = @()
if (Test-Path $LocalSettingsPath) {
  $settings = @(Get-Content $LocalSettingsPath -Raw | ConvertFrom-Json)
}

$accountSettings = $settings | Where-Object { $_.accountName -eq $AccountName } | Select-Object -First 1
$variables = @()
$credentials = @()
$connections = @()
$certificates = @()

if ($accountSettings) {
  foreach ($entry in $accountSettings.Assets.Variables.PSObject.Properties) {
    $variables += @{ name = $entry.Name; value = [string]$entry.Value; isEncrypted = $false }
  }

  foreach ($entry in $accountSettings.Assets.Credentials.PSObject.Properties) {
    $credentials += @{
      name = $entry.Name
      userName = [string]$entry.Value.Username
      password = [string]$entry.Value.Password
    }
  }

  foreach ($entry in $accountSettings.Assets.Connections.PSObject.Properties) {
    $fieldValues = @{}
    $connectionType = ''
    $description = ''
    foreach ($field in $entry.Value.PSObject.Properties) {
      if ($field.Name -eq '__connectionType') { $connectionType = [string]$field.Value; continue }
      if ($field.Name -eq '__description') { $description = [string]$field.Value; continue }
      $fieldValues[$field.Name] = [string]$field.Value
    }
    $connections += @{
      name = $entry.Name
      connectionType = $connectionType
      description = $description
      fieldDefinitionValues = $fieldValues
    }
  }
}

if (Test-Path $certificatesManifest) {
  $certificateManifest = Get-Content $certificatesManifest -Raw | ConvertFrom-Json
  $certificates = @($certificateManifest.certificates)
}

$assetParamsPath = Join-Path $tempRoot ("automation-assets.{0}.parameters.json" -f $AccountName)
$assetParameters = @{
  '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
  contentVersion = '1.0.0.0'
  parameters = @{
    automationAccountName = @{ value = $AccountName }
    variables = @{ value = $variables }
    credentials = @{ value = $credentials }
    connections = @{ value = $connections }
    certificates = @{ value = $certificates }
  }
}

$assetParameters | ConvertTo-Json -Depth 20 | Set-Content -Path $assetParamsPath -Encoding utf8
az deployment group create `
  --resource-group $ResourceGroup `
  --template-file $assetTemplate `
  --parameters "@$assetParamsPath" `
  --subscription $SubscriptionId
