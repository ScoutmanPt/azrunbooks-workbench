#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile


def main() -> int:
    account_name, resource_group, subscription_id, pipeline_root, settings_path = sys.argv[1:6]
    certificates_manifest = os.path.join(pipeline_root, f"certificates.{account_name}.json")

    settings_entries = []
    if os.path.exists(settings_path):
        with open(settings_path, "r", encoding="utf-8") as handle:
            settings_entries = json.load(handle)
    if isinstance(settings_entries, dict):
        settings_entries = [settings_entries]

    account_settings = next((item for item in settings_entries if item.get("accountName") == account_name), {})
    assets = account_settings.get("Assets", {})

    variables = [
        {"name": name, "value": str(value), "isEncrypted": False}
        for name, value in assets.get("Variables", {}).items()
    ]
    credentials = [
        {"name": name, "userName": str(value.get("Username", "")), "password": str(value.get("Password", ""))}
        for name, value in assets.get("Credentials", {}).items()
    ]

    connections = []
    for name, value in assets.get("Connections", {}).items():
        field_values = {k: str(v) for k, v in value.items() if k not in ("__connectionType", "__description")}
        connections.append(
            {
                "name": name,
                "connectionType": str(value.get("__connectionType", "")),
                "description": str(value.get("__description", "")),
                "fieldDefinitionValues": field_values,
            }
        )

    certificates = []
    if os.path.exists(certificates_manifest):
        with open(certificates_manifest, "r", encoding="utf-8") as handle:
            certificates = json.load(handle).get("certificates", [])

    payload = {
        "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
        "contentVersion": "1.0.0.0",
        "parameters": {
            "automationAccountName": {"value": account_name},
            "variables": {"value": variables},
            "credentials": {"value": credentials},
            "connections": {"value": connections},
            "certificates": {"value": certificates},
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
                os.path.join(pipeline_root, "automation-assets.bicep"),
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
