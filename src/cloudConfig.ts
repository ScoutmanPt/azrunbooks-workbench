/**
 * Cloud endpoint configuration for all supported Azure environments.
 * Used to construct the correct management URLs and auth audiences
 * based on the user's selected cloud in settings.
 */

export type AzureCloudName = 'AzureCloud' | 'AzureUSGovernment' | 'AzureChinaCloud';

export interface CloudEndpoints {
  name: AzureCloudName;
  displayName: string;
  managementEndpoint: string;
  resourceManagerEndpoint: string;
  activeDirectoryEndpoint: string;
  audience: string;
  portalEndpoint: string;
  graphEndpoint: string;
  graphAudience: string;
  blobEndpointSuffix: string;
}

export const CLOUD_CONFIG: Record<AzureCloudName, CloudEndpoints> = {
  AzureCloud: {
    name: 'AzureCloud',
    displayName: 'Azure Commercial',
    managementEndpoint: 'https://management.core.windows.net/',
    resourceManagerEndpoint: 'https://management.azure.com/',
    activeDirectoryEndpoint: 'https://login.microsoftonline.com/',
    audience: 'https://management.azure.com/.default',
    portalEndpoint: 'https://portal.azure.com/',
    graphEndpoint: 'https://graph.microsoft.com',
    graphAudience: 'https://graph.microsoft.com/.default',
    blobEndpointSuffix: '.blob.core.windows.net',
  },
  AzureUSGovernment: {
    name: 'AzureUSGovernment',
    displayName: 'Azure US Government',
    managementEndpoint: 'https://management.core.usgovcloudapi.net/',
    resourceManagerEndpoint: 'https://management.usgovcloudapi.net/',
    activeDirectoryEndpoint: 'https://login.microsoftonline.us/',
    audience: 'https://management.usgovcloudapi.net/.default',
    portalEndpoint: 'https://portal.azure.us/',
    graphEndpoint: 'https://graph.microsoft.us',
    graphAudience: 'https://graph.microsoft.us/.default',
    blobEndpointSuffix: '.blob.core.usgovcloudapi.net',
  },
  AzureChinaCloud: {
    name: 'AzureChinaCloud',
    displayName: 'Azure China (21Vianet)',
    managementEndpoint: 'https://management.core.chinacloudapi.cn/',
    resourceManagerEndpoint: 'https://management.chinacloudapi.cn/',
    activeDirectoryEndpoint: 'https://login.chinacloudapi.cn/',
    audience: 'https://management.chinacloudapi.cn/.default',
    portalEndpoint: 'https://portal.azure.cn/',
    graphEndpoint: 'https://microsoftgraph.chinacloudapi.cn',
    graphAudience: 'https://microsoftgraph.chinacloudapi.cn/.default',
    blobEndpointSuffix: '.blob.core.chinacloudapi.cn',
  },
};
