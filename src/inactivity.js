import { listPausedInactiveContacts, setContactPaused } from './db.js'
import { runWithTenant } from './tenant-context.js'
import { bus } from './bus.js'

export function checkInactivityTimeouts() {
  try {
    const inactiveContacts = listPausedInactiveContacts()
    for (const item of inactiveContacts) {
      runWithTenant(item.tenant_id, () => {
        setContactPaused(item.jid, false)
        bus.emit('contact_update', { jid: item.jid, reason: 'inactivity_timeout' })
      })
    }
  } catch (err) {
    console.error('[inactivity] erro ao verificar inatividade:', err.message)
  }
}

export function startInactivityScheduler(intervalMs = 30000) {
  checkInactivityTimeouts()
  setInterval(checkInactivityTimeouts, intervalMs)
}
