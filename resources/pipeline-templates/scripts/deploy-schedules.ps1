<#
.SYNOPSIS
  Deploys Automation schedules and their runbook links via the Azure REST API.
  Reads from <PipelineRoot>/schedules.<AccountName>.json.

  Schedule properties (startTime, expiryTime) are stored as UTC ISO-8601 strings.
  The script adjusts startTime to the nearest valid future occurrence so the API
  does not reject a start time that is already in the past.

.PARAMETER AccountName     Name of the Automation Account.
.PARAMETER ResourceGroup   Resource group containing the account.
.PARAMETER SubscriptionId  Azure subscription ID.
.PARAMETER PipelineRoot    Folder containing schedules.<AccountName>.json.
#>
param(
  [Parameter(Mandatory)] [string] $AccountName,
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [Parameter(Mandatory)] [string] $PipelineRoot
)

$manifest = Join-Path $PipelineRoot ("schedules.{0}.json" -f $AccountName)
if (-not (Test-Path $manifest)) {
  Write-Host "No schedule manifest at $manifest — skipping."
  exit 0
}

$data         = Get-Content $manifest -Raw | ConvertFrom-Json
$schedules    = @($data.schedules)
$jobSchedules = @($data.jobSchedules)

if ($schedules.Count -eq 0) {
  Write-Host "Schedule manifest is empty — skipping."
  exit 0
}

$baseUrl = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup" +
           "/providers/Microsoft.Automation/automationAccounts/$AccountName"
$apiVer  = 'api-version=2023-11-01'
$headers = 'Content-Type=application/json'

# ── Schedules ─────────────────────────────────────────────────────────────────
foreach ($sched in $schedules) {
  Write-Host "-> Schedule: $($sched.name) [$($sched.frequency)]"

  # Advance startTime into the future if it has already passed
  $startTime = [DateTimeOffset]::UtcNow.AddMinutes(10)
  if ($sched.startTime) {
    $parsed = [DateTimeOffset]::Parse($sched.startTime, [System.Globalization.CultureInfo]::InvariantCulture)
    if ($parsed -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) {
      $startTime = $parsed
    }
  }

  $props = [ordered]@{
    startTime   = $startTime.ToString('o')
    frequency   = $sched.frequency
    isEnabled   = if ($null -ne $sched.isEnabled) { [bool]$sched.isEnabled } else { $true }
    timeZone    = if ($sched.timeZone) { [string]$sched.timeZone } else { 'UTC' }
  }
  if ($sched.interval)    { $props.interval    = [int]$sched.interval }
  if ($sched.expiryTime)  { $props.expiryTime  = [string]$sched.expiryTime }
  if ($sched.description) { $props.description = [string]$sched.description }
  if ($sched.advancedSchedule) { $props.advancedSchedule = $sched.advancedSchedule }

  $body = @{ name = $sched.name; properties = $props } | ConvertTo-Json -Depth 10 -Compress

  az rest --method put `
    --url "$baseUrl/schedules/$([Uri]::EscapeDataString($sched.name))?$apiVer" `
    --body $body --headers $headers --subscription $SubscriptionId

  if ($LASTEXITCODE -ne 0) { Write-Error "Failed: schedule '$($sched.name)'" }
}

# ── Job schedules (runbook links) ─────────────────────────────────────────────
if ($jobSchedules.Count -gt 0) {
  # Fetch existing links so we don't create duplicates
  $existingRaw = az rest --method get `
    --url "$baseUrl/jobSchedules?$apiVer" `
    --subscription $SubscriptionId 2>$null | ConvertFrom-Json
  $existing = @($existingRaw.value) | ForEach-Object {
    "$($_.properties.schedule.name)|$($_.properties.runbook.name)"
  }

  foreach ($link in $jobSchedules) {
    $key = "$($link.scheduleName)|$($link.runbookName)"
    if ($existing -contains $key) {
      Write-Host "-> Job schedule already exists: $($link.runbookName) ← $($link.scheduleName) (skip)"
      continue
    }

    Write-Host "-> Job schedule: $($link.runbookName) ← $($link.scheduleName)"
    $linkProps = [ordered]@{
      schedule = @{ name = $link.scheduleName }
      runbook  = @{ name = $link.runbookName }
      runOn    = if ($link.runOn) { [string]$link.runOn } else { '' }
    }
    if ($link.parameters) { $linkProps.parameters = $link.parameters }

    $body = @{ properties = $linkProps } | ConvertTo-Json -Depth 10 -Compress
    $linkId = [System.Guid]::NewGuid().ToString()

    az rest --method put `
      --url "$baseUrl/jobSchedules/$($linkId)?$apiVer" `
      --body $body --headers $headers --subscription $SubscriptionId

    if ($LASTEXITCODE -ne 0) { Write-Error "Failed: job schedule '$($link.runbookName) ← $($link.scheduleName)'" }
  }
}

Write-Host "Schedule deployment complete."
