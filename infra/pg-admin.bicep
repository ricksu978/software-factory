// The Postgres server's Entra admin (main.bicep). Its resource name is the principal's object id.
param server string
param objectId string
param principalName string

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: server
}

resource admin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: pg
  name: objectId
  properties: {
    principalName: principalName
    principalType: 'ServicePrincipal'
    tenantId: tenant().tenantId
  }
}
