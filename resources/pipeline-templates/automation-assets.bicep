@description('Azure Automation account name.')
param automationAccountName string

@description('Automation variables from local.settings.json.')
param variables array = []

@description('Automation credentials from local.settings.json.')
param credentials array = []

@description('Automation connections from local.settings.json.')
param connections array = []

@description('Automation certificates from certificates.<account>.json.')
param certificates array = []

resource automationVariables 'Microsoft.Automation/automationAccounts/variables@2023-11-01' = [for variable in variables: {
  name: '${automationAccountName}/${variable.name}'
  properties: {
    value: string(variable.value)
    isEncrypted: bool(variable.isEncrypted)
    description: contains(variable, 'description') ? string(variable.description) : ''
  }
}]

resource automationCredentials 'Microsoft.Automation/automationAccounts/credentials@2023-11-01' = [for credential in credentials: {
  name: '${automationAccountName}/${credential.name}'
  properties: {
    userName: string(credential.userName)
    password: string(credential.password)
    description: contains(credential, 'description') ? string(credential.description) : ''
  }
}]

resource automationConnections 'Microsoft.Automation/automationAccounts/connections@2023-11-01' = [for connection in connections: {
  name: '${automationAccountName}/${connection.name}'
  properties: {
    connectionType: {
      name: string(connection.connectionType)
    }
    fieldDefinitionValues: connection.fieldDefinitionValues
    description: contains(connection, 'description') ? string(connection.description) : ''
  }
}]

resource automationCertificates 'Microsoft.Automation/automationAccounts/certificates@2023-11-01' = [for certificate in certificates: {
  name: '${automationAccountName}/${certificate.name}'
  properties: {
    base64Value: string(certificate.base64Value)
    description: contains(certificate, 'description') ? string(certificate.description) : ''
    isExportable: contains(certificate, 'isExportable') ? bool(certificate.isExportable) : false
    password: contains(certificate, 'password') ? string(certificate.password) : ''
  }
}]
