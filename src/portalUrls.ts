import { CLOUD_CONFIG, type AzureCloudName } from './cloudConfig';

export interface PortalAccountTarget {
  subscriptionId: string;
  resourceGroupName: string;
  name: string;
}

export interface PortalRunbookTarget extends PortalAccountTarget {
  runbookName: string;
}

function automationAccountResourceId(account: PortalAccountTarget): string {
  return `/subscriptions/${account.subscriptionId}/resourceGroups/${account.resourceGroupName}/providers/Microsoft.Automation/automationAccounts/${account.name}`;
}

export function portalUrlForAccount(account: PortalAccountTarget, cloudName: AzureCloudName): string {
  return `${CLOUD_CONFIG[cloudName].portalEndpoint}#resource${automationAccountResourceId(account)}/overview`;
}

export function portalUrlForRunbook(runbook: PortalRunbookTarget, cloudName: AzureCloudName): string {
  return `${CLOUD_CONFIG[cloudName].portalEndpoint}#resource${automationAccountResourceId(runbook)}/runbooks/${runbook.runbookName}/overview`;
}
