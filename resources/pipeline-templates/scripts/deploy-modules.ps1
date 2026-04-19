<#
.SYNOPSIS
  Deploys PowerShell modules to an Azure Automation Account.
  Supports both PowerShell Gallery modules (uri) and local zip files (localPath).

  When local modules are present the script automatically creates a temporary
  Azure Storage account, retrieves its access key (control-plane — no data-plane
  RBAC needed), stages each zip, imports it via a short-lived SAS URL, waits for
  Azure Automation to finish the async import, then deletes the storage account.

  Pass -StagingStorageAccount to use a specific (pre-existing) account instead
  of the auto-created one.  In that case the account is NOT deleted afterwards.

.PARAMETER AccountName          Name of the Automation Account.
.PARAMETER ResourceGroup        Resource group containing the account.
.PARAMETER SubscriptionId       Azure subscription ID.
.PARAMETER PipelineRoot         Folder that contains the jsons/ subfolder with the modules manifest.
.PARAMETER StagingStorageAccount Azure Storage account name used to stage local modules.
                                 Optional — auto-derived and created when local modules exist.
.PARAMETER StagingContainer     Blob container name for staging (default: automation-modules).
#>
param(
  [Parameter(Mandatory)] [string] $AccountName,
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [Parameter(Mandatory)] [string] $PipelineRoot,
  [string] $StagingStorageAccount = '',
  [string] $StagingContainer      = 'automation-modules'
)

$modulesManifest = Join-Path $PipelineRoot 'jsons' ("modules.{0}.json" -f $AccountName)

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

# ── Auto-create staging storage account when local modules are present ─────────
$autoCreatedStorage = $false
$storageKey         = $null
$localModuleCount   = @($modules | Where-Object { $_.PSObject.Properties['localPath'] -and [string]$_.localPath }).Count

if ($localModuleCount -gt 0) {
  if (-not $StagingStorageAccount) {
    # Derive a valid storage account name: lowercase alphanumeric, max 24 chars
    $sanitized = ($AccountName -replace '[^a-z0-9]', '').ToLower()
    if ($sanitized.Length -gt 20) { $sanitized = $sanitized.Substring(0, 20) }
    $StagingStorageAccount = "${sanitized}stg"
    Write-Host "  Auto-derived staging storage account name: $StagingStorageAccount"
  }

  Write-Host "  Checking staging storage account '$StagingStorageAccount'..."
  az storage account show `
    --name $StagingStorageAccount `
    --resource-group $ResourceGroup `
    --output none 2>$null

  if ($LASTEXITCODE -ne 0) {
    Write-Host "  Creating staging storage account '$StagingStorageAccount'..."
    $location = az group show --name $ResourceGroup --query location --output tsv
    az storage account create `
      --name $StagingStorageAccount `
      --resource-group $ResourceGroup `
      --location $location `
      --sku Standard_LRS `
      --kind StorageV2 `
      --allow-blob-public-access false `
      --min-tls-version TLS1_2 `
      --output none
    if ($LASTEXITCODE -ne 0) { throw "Failed to create staging storage account '$StagingStorageAccount'" }
    $autoCreatedStorage = $true
    Write-Host "  Staging storage account created."
  } else {
    Write-Host "  Staging storage account already exists — will not delete after use."
  }

  # Retrieve the account key (control-plane — requires only Contributor, no data-plane RBAC)
  Write-Host "  Retrieving storage account key..."
  $storageKey = az storage account keys list `
    --account-name $StagingStorageAccount `
    --resource-group $ResourceGroup `
    --query '[0].value' `
    --output tsv
  if ($LASTEXITCODE -ne 0) { throw "Failed to retrieve key for '$StagingStorageAccount'" }
}

# ── Staging container (created once on first local module) ────────────────────
$containerReady = $false
function Initialize-StagingContainer {
  if ($script:containerReady) { return }
  Write-Host "  Ensuring staging container '$StagingContainer' in '$StagingStorageAccount'..."
  az storage container create `
    --account-name $StagingStorageAccount `
    --account-key  $script:storageKey `
    --name $StagingContainer `
    --output none 2>$null
  $script:containerReady = $true
}

# ── Zip a module folder into a temp zip and return its path ──────────────────
function Get-ModuleZip {
  param([string] $FolderPath)
  $zipPath = Join-Path ([System.IO.Path]::GetTempPath()) "$([System.IO.Path]::GetFileName($FolderPath))-$([System.Guid]::NewGuid().ToString('N')).zip"
  Write-Host "  Zipping '$FolderPath' → '$zipPath'..."
  Compress-Archive -Path "$FolderPath\*" -DestinationPath $zipPath -Force
  return $zipPath
}

# ── Stage a local file and return a 1-hour SAS URL ────────────────────────────
function Get-StagingUrl {
  param([string] $LocalFile, [string] $BlobName)
  Initialize-StagingContainer
  Write-Host "  Uploading '$LocalFile' → blob '$BlobName'..."
  az storage blob upload `
    --account-name $StagingStorageAccount `
    --account-key  $script:storageKey `
    --container-name $StagingContainer `
    --name $BlobName `
    --file $LocalFile `
    --overwrite `
    --output none
  if ($LASTEXITCODE -ne 0) { throw "Blob upload failed for '$LocalFile'" }

  $expiry = (Get-Date).ToUniversalTime().AddHours(1).ToString('yyyy-MM-ddTHH:mm:ssZ')
  $sas = az storage blob generate-sas `
    --account-name $StagingStorageAccount `
    --account-key  $script:storageKey `
    --container-name $StagingContainer `
    --name $BlobName `
    --permissions r `
    --expiry $expiry `
    --output tsv
  if ($LASTEXITCODE -ne 0) { throw "SAS generation failed for '$BlobName'" }

  return "https://$StagingStorageAccount.blob.core.windows.net/$StagingContainer/$BlobName`?$sas"
}

# ── Remove a staged blob ───────────────────────────────────────────────────────
function Remove-StagedBlob {
  param([string] $BlobName)
  az storage blob delete `
    --account-name $StagingStorageAccount `
    --account-key  $script:storageKey `
    --container-name $StagingContainer `
    --name $BlobName `
    --output none 2>$null
}

# ── Deploy each module ────────────────────────────────────────────────────────
# Local modules that were successfully queued: @{ name; blob }
# Blobs are kept alive until the async import completes — see polling loop below.
$pendingLocalImports = [System.Collections.Generic.List[hashtable]]::new()

foreach ($mod in $modules) {
  $stagedBlob = $null

  try {
    $modLocalPath = if ($mod.PSObject.Properties['localPath']) { [string]$mod.localPath } else { $null }
    $modUri       = if ($mod.PSObject.Properties['uri'])       { [string]$mod.uri }       else { $null }
    $modVersion   = if ($mod.PSObject.Properties['version'])   { [string]$mod.version }   else { $null }

    if ($modLocalPath) {
      # ── Local module ──────────────────────────────────────────────────────
      $localPath = $mod.localPath
      if (-not [System.IO.Path]::IsPathRooted($localPath)) {
        $localPath = Join-Path (Get-Location) $localPath
      }
      if (-not (Test-Path $localPath)) {
        Write-Error "Local module path not found: $localPath — skipping '$($mod.name)'"
        continue
      }

      $tempZip = $null
      try {
        if ((Get-Item $localPath).PSIsContainer) {
          Write-Host "-> Module (local folder): $($mod.name)  ($localPath)"
          $tempZip   = Get-ModuleZip -FolderPath $localPath
          $localFile = $tempZip
        } else {
          Write-Host "-> Module (local zip): $($mod.name)  ($localPath)"
          $localFile = $localPath
        }

        $stagedBlob  = "$($mod.name)-$([System.Guid]::NewGuid().ToString('N')).zip"
        $uri         = Get-StagingUrl -LocalFile $localFile -BlobName $stagedBlob
        $contentLink = @{ uri = $uri }
      } finally {
        if ($tempZip -and (Test-Path $tempZip)) { Remove-Item $tempZip -Force }
      }
    }
    elseif ($modUri) {
      # ── Gallery / remote module ───────────────────────────────────────────
      Write-Host "-> Module (gallery): $($mod.name)  ($modUri)"
      $contentLink = @{ uri = $modUri }
      if ($modVersion) { $contentLink.version = $modVersion }
    }
    else {
      Write-Warning "Module '$($mod.name)' has neither 'uri' nor 'localPath' — skipping."
      continue
    }

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
      Write-Error "Failed to import module '$($mod.name)'"
    } elseif ($stagedBlob) {
      # Import queued — keep blob alive until async download completes
      $pendingLocalImports.Add(@{ name = $mod.name; blob = $stagedBlob })
      $stagedBlob = $null   # Prevent premature deletion in finally
    }
  }
  finally {
    # Only reached when import was NOT successfully queued (error path)
    if ($stagedBlob) { Remove-StagedBlob -BlobName $stagedBlob }
  }
}

# ── Wait for local module imports to complete, then clean up blobs ─────────────
if ($pendingLocalImports.Count -gt 0) {
  Write-Host "  Waiting for local module imports to complete (Azure Automation downloads asynchronously)..."
  $remaining  = [System.Collections.Generic.List[hashtable]]($pendingLocalImports)
  $maxSeconds = 600   # 10-minute ceiling
  $elapsed    = 0
  $pollEvery  = 15

  while ($remaining.Count -gt 0 -and $elapsed -lt $maxSeconds) {
    Start-Sleep -Seconds $pollEvery
    $elapsed += $pollEvery

    $done = @()
    foreach ($entry in $remaining) {
      $state = az rest --method get `
        --url "$baseUrl/modules/$($entry.name)?$apiVer" `
        --subscription $SubscriptionId `
        --query 'properties.provisioningState' `
        --output tsv 2>$null

      if ($state -in 'Succeeded', 'Failed') {
        if ($state -eq 'Failed') {
          $errMsg = az rest --method get `
            --url "$baseUrl/modules/$($entry.name)?$apiVer" `
            --subscription $SubscriptionId `
            --query 'properties.error.message' `
            --output tsv 2>$null
          Write-Error "Module '$($entry.name)' import failed: $errMsg"
        } else {
          Write-Host "  Module '$($entry.name)' imported successfully."
        }
        Remove-StagedBlob -BlobName $entry.blob
        $done += $entry
      } else {
        Write-Host "  Module '$($entry.name)': $state — waiting..."
      }
    }
    foreach ($d in $done) { $remaining.Remove($d) | Out-Null }
  }

  if ($remaining.Count -gt 0) {
    Write-Warning "Timed out waiting for: $($remaining.name -join ', ') — blobs left in staging account."
  }
}

# ── Delete auto-created staging storage account ───────────────────────────────
if ($autoCreatedStorage) {
  Write-Host "  Deleting temporary staging storage account '$StagingStorageAccount'..."
  az storage account delete `
    --name $StagingStorageAccount `
    --resource-group $ResourceGroup `
    --yes `
    --output none 2>$null
  Write-Host "  Staging storage account deleted."
}

Write-Host "Module deployment complete."
