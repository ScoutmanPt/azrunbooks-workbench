#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile


def main() -> int:
    account_name, resource_group, subscription_id, pipeline_root = sys.argv[1:5]
    manifest_path = os.path.join(pipeline_root, f"modules.{account_name}.json")
    if not os.path.exists(manifest_path):
        print(f"No module manifest found at {manifest_path}. Skipping module deployment.")
        return 0

    with open(manifest_path, "r", encoding="utf-8") as handle:
        modules = json.load(handle).get("modules", [])

    if not modules:
        print("Module manifest is empty. Skipping module deployment.")
        return 0

    payload = {
        "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
        "contentVersion": "1.0.0.0",
        "parameters": {
            "automationAccountName": {"value": account_name},
            "modules": {"value": modules},
        },
    }

    with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8", suffix=".json") as handle:
        json.dump(payload, handle, indent=2)
        params_path = handle.name

    try:
        subprocess.run(
            [
                "az",
                "deployment",
                "group",
                "create",
                "--resource-group",
                resource_group,
                "--template-file",
                os.path.join(pipeline_root, "automation-modules.bicep"),
                "--parameters",
                f"@{params_path}",
                "--subscription",
                subscription_id,
            ],
            check=True,
        )
    finally:
        try:
            os.remove(params_path)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
