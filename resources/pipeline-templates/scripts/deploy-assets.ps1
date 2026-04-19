<#
.SYNOPSIS
  Deploys Automation assets (variables, credentials, connections, certificates)
  via the Azure REST API.  Values are read from local.settings.json.
  Certificates are read from <PipelineRoot>/jsons/certificates.<AccountName>.json (optional).

.PARAMETER AccountName        Name of the Automation Account.
.PARAMETER ResourceGroup      Resource group containing the account.
.PARAMETER SubscriptionId     Azure subscription ID.
.PARAMETER LocalSettingsPath  Path to local.settings.json.
.PARAMETER PipelineRoot       Folder whose jsons/ subfolder may contain certificates.<AccountName>.json (optional).
#>
param(
  [Parameter(Mandatory)] [string] $AccountName,
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [Parameter(Mandatory)] [string] $LocalSettingsPath,
  [string] $PipelineRoot = ''
)

# ── Load settings ──────────────────────────────────────────────────────────────
if (-not (Test-Path $LocalSettingsPath)) {
  Write-Host "Settings file not found: $LocalSettingsPath — skipping assets."
  exit 0
}

$allSettings     = Get-Content $LocalSettingsPath -Raw | ConvertFrom-Json
$accountSettings = @($allSettings) |
                   Where-Object { $_.accountName -eq $AccountName } |
                   Select-Object -First 1

if (-not $accountSettings) {
  Write-Host "No settings for '$AccountName' in $LocalSettingsPath — skipping assets."
  exit 0
}

$baseUrl = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup" +
           "/providers/Microsoft.Automation/automationAccounts/$AccountName"
$apiVer  = 'api-version=2023-11-01'
$headers = 'Content-Type=application/json'

# ── Variables ─────────────────────────────────────────────────────────────────
if ($accountSettings.Assets.Variables) {
  foreach ($entry in $accountSettings.Assets.Variables.PSObject.Properties) {
    Write-Host "-> Variable: $($entry.Name)"
    $body = @{
      name       = $entry.Name
      properties = @{
        value       = (ConvertTo-Json $entry.Value -Compress)
        isEncrypted = $false
      }
    } | ConvertTo-Json -Depth 5 -Compress

    az rest --method put `
      --url "$baseUrl/variables/$($entry.Name)?$apiVer" `
      --body $body --headers $headers --subscription $SubscriptionId

    if ($LASTEXITCODE -ne 0) { Write-Error "Failed: variable '$($entry.Name)'" }
  }
}

# ── Credentials ───────────────────────────────────────────────────────────────
if ($accountSettings.Assets.Credentials) {
  foreach ($entry in $accountSettings.Assets.Credentials.PSObject.Properties) {
    Write-Host "-> Credential: $($entry.Name)"
    $body = @{
      name       = $entry.Name
      properties = @{
        userName = [string]$entry.Value.Username
        password = [string]$entry.Value.Password
      }
    } | ConvertTo-Json -Depth 5 -Compress

    az rest --method put `
      --url "$baseUrl/credentials/$($entry.Name)?$apiVer" `
      --body $body --headers $headers --subscription $SubscriptionId

    if ($LASTEXITCODE -ne 0) { Write-Error "Failed: credential '$($entry.Name)'" }
  }
}

# ── Connections ───────────────────────────────────────────────────────────────
if ($accountSettings.Assets.Connections) {
  foreach ($entry in $accountSettings.Assets.Connections.PSObject.Properties) {
    $connectionType = ''
    $description    = ''
    $fieldValues    = @{}
    foreach ($field in $entry.Value.PSObject.Properties) {
      switch ($field.Name) {
        '__connectionType' { $connectionType = [string]$field.Value }
        '__description'    { $description    = [string]$field.Value }
        default            { $fieldValues[$field.Name] = [string]$field.Value }
      }
    }
    Write-Host "-> Connection: $($entry.Name) [$connectionType]"
    $body = @{
      name       = $entry.Name
      properties = @{
        connectionType        = @{ name = $connectionType }
        fieldDefinitionValues = $fieldValues
        description           = $description
      }
    } | ConvertTo-Json -Depth 10 -Compress

    az rest --method put `
      --url "$baseUrl/connections/$($entry.Name)?$apiVer" `
      --body $body --headers $headers --subscription $SubscriptionId

    if ($LASTEXITCODE -ne 0) { Write-Error "Failed: connection '$($entry.Name)'" }
  }
}

# ── Certificates ──────────────────────────────────────────────────────────────
if ($PipelineRoot) {
  $certsManifest = Join-Path $PipelineRoot 'jsons' ("certificates.{0}.json" -f $AccountName)
  if (Test-Path $certsManifest) {
    $certData     = Get-Content $certsManifest -Raw | ConvertFrom-Json
    $certificates = @($certData.certificates)

    foreach ($cert in $certificates) {
      Write-Host "-> Certificate: $($cert.name)"
      $certProps = @{
        base64Value  = [string]$cert.base64Value
        isExportable = if ($null -ne $cert.isExportable) { [bool]$cert.isExportable } else { $false }
        description  = if ($cert.description) { [string]$cert.description } else { '' }
      }
      if ($cert.thumbprint) { $certProps.thumbprint = [string]$cert.thumbprint }

      $body = @{
        name       = $cert.name
        properties = $certProps
      } | ConvertTo-Json -Depth 5 -Compress

      az rest --method put `
        --url "$baseUrl/certificates/$($cert.name)?$apiVer" `
        --body $body --headers $headers --subscription $SubscriptionId

      if ($LASTEXITCODE -ne 0) { Write-Error "Failed: certificate '$($cert.name)'" }
    }
  }
}

Write-Host "Asset deployment complete."
