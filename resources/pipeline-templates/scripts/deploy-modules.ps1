<#
.SYNOPSIS
  Deploys PowerShell modules to an Azure Automation Account.
  Supports both PowerShell Gallery modules (uri) and local zip files (localPath).

  Local modules are staged in Azure Blob Storage, imported via a short-lived SAS
  URL, then the blob is deleted. The storage account must already exist and the
  pipeline identity needs Storage Blob Data Contributor on it.

.PARAMETER AccountName          Name of the Automation Account.
.PARAMETER ResourceGroup        Resource group containing the account.
.PARAMETER SubscriptionId       Azure subscription ID.
.PARAMETER PipelineRoot         Folder that contains the jsons/ subfolder with the modules manifest.
.PARAMETER StagingStorageAccount Azure Storage account name used to stage local modules.
                                 Required only when the manifest contains localPath entries.
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

# ── Staging container (created once if needed for local modules) ───────────────
$containerReady = $false
function Ensure-StagingContainer {
  if ($script:containerReady) { return }
  if (-not $StagingStorageAccount) {
    throw "StagingStorageAccount is required to deploy local modules. " +
          "Add -StagingStorageAccount <name> to the deploy.ps1 call."
  }
  Write-Host "  Ensuring staging container '$StagingContainer' in '$StagingStorageAccount'..."
  az storage container create `
    --account-name $StagingStorageAccount `
    --name $StagingContainer `
    --auth-mode login `
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
  Ensure-StagingContainer
  Write-Host "  Uploading '$LocalFile' → blob '$BlobName'..."
  az storage blob upload `
    --account-name $StagingStorageAccount `
    --container-name $StagingContainer `
    --name $BlobName `
    --file $LocalFile `
    --auth-mode login `
    --overwrite `
    --output none
  if ($LASTEXITCODE -ne 0) { throw "Blob upload failed for '$LocalFile'" }

  $expiry = (Get-Date).ToUniversalTime().AddHours(1).ToString('yyyy-MM-ddTHH:mm:ssZ')
  $sas = az storage blob generate-sas `
    --account-name $StagingStorageAccount `
    --container-name $StagingContainer `
    --name $BlobName `
    --permissions r `
    --expiry $expiry `
    --auth-mode login `
    --as-user `
    --output tsv
  if ($LASTEXITCODE -ne 0) { throw "SAS generation failed for '$BlobName'" }

  return "https://$StagingStorageAccount.blob.core.windows.net/$StagingContainer/$BlobName`?$sas"
}

# ── Remove a staged blob after import is triggered ────────────────────────────
function Remove-StagedBlob {
  param([string] $BlobName)
  az storage blob delete `
    --account-name $StagingStorageAccount `
    --container-name $StagingContainer `
    --name $BlobName `
    --auth-mode login `
    --output none 2>$null
}

# ── Deploy each module ────────────────────────────────────────────────────────
foreach ($mod in $modules) {
  $stagedBlob = $null

  try {
    if ($mod.localPath) {
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
          # Folder → zip it on the fly
          Write-Host "-> Module (local folder): $($mod.name)  ($localPath)"
          $tempZip   = Get-ModuleZip -FolderPath $localPath
          $localFile = $tempZip
        } else {
          # Pre-zipped file
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
    elseif ($mod.uri) {
      # ── Gallery / remote module ───────────────────────────────────────────
      Write-Host "-> Module (gallery): $($mod.name)  ($($mod.uri))"
      $contentLink = @{ uri = [string]$mod.uri }
      if ($mod.version) { $contentLink.version = [string]$mod.version }
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
    }
  }
  finally {
    # Clean up the staging blob regardless of success/failure
    if ($stagedBlob) { Remove-StagedBlob -BlobName $stagedBlob }
  }
}

Write-Host "Module deployment complete."
