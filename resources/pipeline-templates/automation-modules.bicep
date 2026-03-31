@description('Azure Automation account name.')
param automationAccountName string

@description('Module import definitions from modules.<account>.json.')
param modules array = []

resource automationModules 'Microsoft.Automation/automationAccounts/modules@2023-11-01' = [for module in modules: {
  name: '${automationAccountName}/${module.name}'
  properties: {
    contentLink: {
      uri: string(module.uri)
      version: contains(module, 'version') ? string(module.version) : ''
    }
  }
}]
