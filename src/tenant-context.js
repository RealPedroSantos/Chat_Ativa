import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage()

export function runWithTenant(tenantId, callback) {
  const id = Number(tenantId)
  if (!Number.isInteger(id) || id < 1) throw new Error('Conta de empresa inválida.')
  return storage.run({ tenantId: id }, callback)
}

export function currentTenantId() {
  return storage.getStore()?.tenantId || 1
}
