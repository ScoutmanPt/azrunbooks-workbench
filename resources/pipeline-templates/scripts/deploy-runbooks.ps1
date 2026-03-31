param(
  [Parameter(Mandatory = $true)]
  [string]$AccountName,

  [Parameter(Mandatory = $true)]
  [string]$ResourceGroup,

  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $true)]
  [string]$AccountPath
)

if (-not (Test-Path $AccountPath)) {
  throw "Runbook folder not found: $AccountPath"
}

Get-ChildItem -Path $AccountPath -File | Where-Object { $_.Extension -in '.ps1', '.py' } | ForEach-Object {
  $runbookName = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
  Write-Host "-> Deploying $runbookName"
  az automation runbook replace-content `
    --automation-account-name $AccountName `
    --resource-group $ResourceGroup `
    --name $runbookName `
    --content $_.FullName `
    --subscription $SubscriptionId
  az automation runbook publish `
    --automation-account-name $AccountName `
    --resource-group $ResourceGroup `
    --name $runbookName `
    --subscription $SubscriptionId
}
