<#
.SYNOPSIS
  Builds and publishes the Azure Runbooks Workbench VS Code extension to the
  Visual Studio Code Marketplace.

  The script exposes three phases that can be called individually so the GitHub
  Actions workflow can surface each one as a separate step:

    -Phase install   → npm ci
    -Phase build     → version bump (optional) + esbuild bundle
    -Phase publish   → vsce publish to the VS Code Marketplace

.PARAMETER Phase
  Which phase to run: install | build | publish

.PARAMETER PatToken
  Personal Access Token for the VS Code Marketplace publisher.
  Required only for the publish phase.
  In CI, pass this from a secret ($env:VSCE_PAT).

.PARAMETER SkipBump
  Skip the automatic version bump during the build phase.

.EXAMPLE
  # Run all three phases locally
  ./scripts/publish-extension.ps1 -Phase install
  ./scripts/publish-extension.ps1 -Phase build
  ./scripts/publish-extension.ps1 -Phase publish -PatToken $env:VSCE_PAT
#>
param(
  [Parameter(Mandatory)]
  [ValidateSet('install', 'build', 'publish')]
  [string] $Phase,

  [string] $PatToken = '',
  [switch] $SkipBump
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

switch ($Phase) {

  'install' {
    Write-Host "── Install dependencies" -ForegroundColor Cyan
    npm ci --prefer-offline
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    Write-Host "Dependencies installed." -ForegroundColor Green
  }

  'build' {
    Write-Host "── Build extension" -ForegroundColor Cyan
    if ($SkipBump) {
      Write-Host "  Skipping version bump."
      node esbuild.config.mjs
    } else {
      # npm run build triggers the prebuild version bump then esbuild
      npm run build
    }
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }

    $pkg     = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    $version = $pkg.version
    Write-Host "Build complete — version: $version" -ForegroundColor Green
  }

  'publish' {
    if (-not $PatToken) { throw "-PatToken is required for the publish phase" }

    $pkg     = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    $version = $pkg.version
    Write-Host "── Publish v$version to VS Code Marketplace" -ForegroundColor Cyan

    npx vsce publish --no-dependencies --pat $PatToken
    if ($LASTEXITCODE -ne 0) { throw "vsce publish failed" }

    Write-Host "Published v$version successfully." -ForegroundColor Green
  }
}
