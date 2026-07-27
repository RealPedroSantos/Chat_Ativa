import { bus } from './bus.js'
import { listUnansweredConversations, markUnansweredAlert } from './db.js'

let timer = null

function scan() {
  // Keep the alert pending while no dashboard is connected; otherwise a
  // server restart could consume it before anybody has a chance to hear it.
  if (bus.listenerCount('unanswered_alert') === 0) return
  for (const item of listUnansweredConversations(5)) {
    if (!markUnansweredAlert(item.jid, item.message_id, item.tenant_id)) continue
    bus.emit('unanswered_alert', {
      tenantId: item.tenant_id,
      jid: item.jid,
      name: item.name || item.jid.split('@')[0],
      messageId: item.message_id,
      createdAt: item.created_at,
    })
  }
}

export function startUnansweredAlertScheduler() {
  if (timer) return
  scan()
  timer = setInterval(scan, 15000)
  timer.unref?.()
}
