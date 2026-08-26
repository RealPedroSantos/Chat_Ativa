import { buildAutomationEvent, sendWhatsAppMessage } from './integration-core.js'
import { addMessage, getMessageByExternalId } from './db.js'
import { bus } from './bus.js'
import { handleIncoming, prepareIncomingConversation } from './pipeline.js'
import { runWithTenant } from './tenant-context.js'

function digits(value) {
  return String(value || '').replace(/\D/g, '')
}

export function cloudApiEnabled() {
  return process.env.WHATSAPP_CHANNEL === 'cloud_api'
    && Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
}

export function cloudApiState() {
  return {
    status: cloudApiEnabled() ? 'connected' : 'disconnected',
    provider: 'cloud_api',
    official: true,
    user: process.env.WHATSAPP_DISPLAY_PHONE_NUMBER || null,
    qr: null,
    sync: { status: 'unavailable', progress: 0 },
  }
}

function messageText(message) {
  if (message?.type === 'text') return String(message.text?.body || '')
  if (message?.type === 'button') return String(message.button?.text || '')
  if (message?.type === 'interactive') {
    return String(message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '')
  }
  return ''
}

export async function sendCloudMessage(jid, text, source = 'human', conversationJid = jid, {
  authorUserId = null,
  authorName = null,
  messageType = 'text',
} = {}) {
  const result = await sendWhatsAppMessage({ to: digits(jid), text })
  const stored = addMessage(conversationJid, 'out', text, source, {
    authorUserId,
    authorName,
    messageType,
    externalId: result?.messages?.[0]?.id || null,
    externalTimestamp: new Date().toISOString(),
  })
  bus.emit('message', stored)
  return stored
}

export async function processCloudWebhook(payload) {
  const event = buildAutomationEvent(payload)
  const tenantId = Number(process.env.WHATSAPP_TENANT_ID || 1)
  let processed = 0
  await runWithTenant(tenantId, async () => {
    const names = new Map(event.contacts.map((contact) => [String(contact.wa_id || ''), contact.profile?.name || '']))
    for (const message of event.messages) {
      if (!message?.id || getMessageByExternalId(message.id)) continue
      const from = digits(message.from)
      if (!from) continue
      const jid = `${from}@s.whatsapp.net`
      const text = messageText(message)
      const preparation = prepareIncomingConversation({ jid, replyJid: jid, name: names.get(from) || from })
      const stored = addMessage(jid, 'in', text || `[${message.type || 'mensagem'}]`, 'user', {
        messageType: message.type || 'text',
        externalId: message.id,
        externalTimestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(),
      })
      await handleIncoming({
        jid,
        replyJid: jid,
        name: names.get(from) || from,
        text,
        hasText: Boolean(text.trim()),
        storedMessage: stored,
        preparation,
      }, sendCloudMessage)
      processed++
    }
  })
  return { processed, eventId: event.eventId }
}
