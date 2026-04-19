@description('Azure Automation account name.')
param automationAccountName string

@description('Azure region. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Pricing tier.')
@allowed(['Free', 'Basic'])
param sku string = 'Basic'

resource automationAccount 'Microsoft.Automation/automationAccounts@2023-11-01' = {
  name: automationAccountName
  location: location
  properties: {
    sku: {
      name: sku
    }
  }
}

output automationAccountId string = automationAccount.id
output automationAccountName string = automationAccount.name
