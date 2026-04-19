<#
.SYNOPSIS
  Orchestrates a full Azure Automation Account deployment.
  Calls infrastructure, modules, runbooks, assets, and schedules scripts in sequence.

  Works both in CI/CD pipelines and locally. When run locally, pass -Login to
  authenticate interactively before deploying.

.PARAMETER AccountName       Name of the Automation Account.
.PARAMETER ResourceGroup     Resource group containing the account.
.PARAMETER SubscriptionId    Azure subscription ID.
.PARAMETER PipelineRoot      Root folder containing biceps/, jsons/, scripts/.
                             Defaults to the parent folder of this script.
.PARAMETER AccountPath       Folder containing runbook .ps1/.py files.
                             Defaults to the grandparent folder of this script.
.PARAMETER LocalSettingsPath Path to local.settings.json (assets).
                             Defaults to ./local.settings.json in the working directory.
.PARAMETER Location          Azure region override for the Bicep deployment (optional).
.PARAMETER Sku               Automation Account SKU: Free or Basic (default: Basic).
.PARAMETER StagingStorageAccount Azure Storage account used to stage local module zips.
                             Optional — auto-created and deleted when local modules exist.
                             Provide this to use a specific pre-existing account instead.
.PARAMETER StagingContainer  Blob container for staging (default: automation-modules).
.PARAMETER Login             Trigger an interactive az login before deploying.
                             Useful for local runs. Not needed in CI/CD (OIDC handles auth).

.EXAMPLE
  # CI/CD — paths are derived automatically from script location
  ./deploy.ps1 -AccountName "my-aa" -ResourceGroup "my-rg" -SubscriptionId "xxxxxxxx-..."

.EXAMPLE
  # Local run with a private module staged in blob storage
  ./deploy.ps1 -AccountName "my-aa" -ResourceGroup "my-rg" -SubscriptionId "xxxxxxxx-..." `
               -StagingStorageAccount "mystorageacct" -Login
#>
param(
  [Parameter(Mandatory)] [string] $AccountName,
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [string] $PipelineRoot           = '',
  [string] $AccountPath            = '',
  [string] $LocalSettingsPath      = './local.settings.json',
  [string] $Location               = '',
  [string] $Sku                    = 'Basic',
  [string] $StagingStorageAccount  = '',
  [string] $StagingContainer       = 'automation-modules',
  [switch] $Login
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Resolve defaults from script location ────────────────────────────────────
#   This script lives at:  <account>/pipelines/scripts/deploy.ps1
#   PipelineRoot  →        <account>/pipelines/
#   AccountPath   →        <account>/
if (-not $PipelineRoot) {
  $PipelineRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
if (-not $AccountPath) {
  $AccountPath = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
}

$scriptsDir = Join-Path $PipelineRoot 'scripts'

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Azure Automation Account Deployment"   -ForegroundColor Cyan
Write-Host "  Account  : $AccountName"
Write-Host "  Group    : $ResourceGroup"
Write-Host "  Scripts  : $scriptsDir"
Write-Host "  Runbooks : $AccountPath"
Write-Host "========================================" -ForegroundColor Cyan

# ── Azure login (local runs) ──────────────────────────────────────────────────
if ($Login) {
  Write-Host "`nLogging in to Azure..." -ForegroundColor Yellow
  az login --use-device-code
  if ($LASTEXITCODE -ne 0) { throw 'Azure login failed.' }
  az account set --subscription $SubscriptionId
  if ($LASTEXITCODE -ne 0) { throw 'Failed to set subscription.' }
  Write-Host "Logged in.`n" -ForegroundColor Green
}

# ── Step helper ───────────────────────────────────────────────────────────────
$stepIndex = 0
function Invoke-Step {
  param([string] $Label, [scriptblock] $Action)
  $script:stepIndex++
  Write-Host ""
  Write-Host "── Step $($script:stepIndex): $Label" -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "Step failed: $Label (exit $LASTEXITCODE)" }
  Write-Host "   done." -ForegroundColor Green
}

# ── Deployment ────────────────────────────────────────────────────────────────
Invoke-Step 'Infrastructure (Bicep)' {
  $infraArgs = @{
    AccountName    = $AccountName
    ResourceGroup  = $ResourceGroup
    SubscriptionId = $SubscriptionId
    PipelineRoot   = $PipelineRoot
    Sku            = $Sku
  }
  if ($Location) { $infraArgs.Location = $Location }
  & (Join-Path $scriptsDir 'deploy-infrastructure.ps1') @infraArgs
}

Invoke-Step 'Modules' {
  $modArgs = @{
    AccountName    = $AccountName
    ResourceGroup  = $ResourceGroup
    SubscriptionId = $SubscriptionId
    PipelineRoot   = $PipelineRoot
  }
  if ($StagingStorageAccount) {
    $modArgs.StagingStorageAccount = $StagingStorageAccount
    $modArgs.StagingContainer      = $StagingContainer
  }
  & (Join-Path $scriptsDir 'deploy-modules.ps1') @modArgs
}

Invoke-Step 'Runbooks' {
  & (Join-Path $scriptsDir 'deploy-runbooks.ps1') `
    -AccountName    $AccountName `
    -ResourceGroup  $ResourceGroup `
    -SubscriptionId $SubscriptionId `
    -AccountPath    $AccountPath
}

Invoke-Step 'Assets' {
  & (Join-Path $scriptsDir 'deploy-assets.ps1') `
    -AccountName        $AccountName `
    -ResourceGroup      $ResourceGroup `
    -SubscriptionId     $SubscriptionId `
    -LocalSettingsPath  $LocalSettingsPath `
    -PipelineRoot       $PipelineRoot
}

Invoke-Step 'Schedules' {
  & (Join-Path $scriptsDir 'deploy-schedules.ps1') `
    -AccountName    $AccountName `
    -ResourceGroup  $ResourceGroup `
    -SubscriptionId $SubscriptionId `
    -PipelineRoot   $PipelineRoot
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Deployment complete: $AccountName"      -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
