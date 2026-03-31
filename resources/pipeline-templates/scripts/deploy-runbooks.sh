#!/usr/bin/env bash
set -euo pipefail

account_name="$1"
resource_group="$2"
subscription_id="$3"
account_path="$4"

if [ ! -d "$account_path" ]; then
  echo "Runbook folder not found: $account_path" >&2
  exit 1
fi

find "$account_path" -maxdepth 1 -type f \( -name "*.ps1" -o -name "*.py" \) | while read -r runbook_file; do
  runbook_name="$(basename "$runbook_file")"
  runbook_name="${runbook_name%.*}"
  echo "-> Deploying ${runbook_name}"
  az automation runbook replace-content --automation-account-name "$account_name" --resource-group "$resource_group" --name "$runbook_name" --content "$runbook_file" --subscription "$subscription_id"
  az automation runbook publish --automation-account-name "$account_name" --resource-group "$resource_group" --name "$runbook_name" --subscription "$subscription_id"
done
