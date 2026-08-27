import { getSetting } from './db.js'

const N8N_TIMEOUT_MS = 8_000

function webhookUrl(value) {
  const url = new URL(String(value || '').trim())
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('A URL do webhook n8n deve usar HTTP ou HTTPS.')
  return url
}

export function buildTenantN8nPayload({ jid, name, text, storedMessage }) {
  const phone = String(jid || '').split('@')[0].replace(/\D/g, '')
  const timestamp = storedMessage?.external_timestamp
    ? Math.floor(new Date(storedMessage.external_timestamp).getTime() / 1000)
    : Math.floor(Date.now() / 1000)
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'chat-ativa',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: null, phone_number_id: null },
          contacts: [{ wa_id: phone, profile: { name: String(name || phone) } }],
          messages: [{
            from: phone,
            id: String(storedMessage?.external_id || `chat-ativa:${storedMessage?.id || Date.now()}`),
            timestamp: String(Number.isFinite(timestamp) ? timestamp : Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: String(text || '') },
          }],
        },
      }],
    }],
  }
}

export async function forwardIncomingToTenantN8n(message) {
  if (getSetting('n8n_enabled') !== 'true') return { delivered: false, skipped: true }
  const rawUrl = getSetting('n8n_webhook_url')
  if (!rawUrl) return { delivered: false, skipped: true }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), N8N_TIMEOUT_MS)
  try {
    const response = await fetch(webhookUrl(rawUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Chat-Ativa-n8n/1.0' },
      body: JSON.stringify(buildTenantN8nPayload(message)),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`n8n respondeu HTTP ${response.status}.`)
    return { delivered: true }
  } finally {
    clearTimeout(timer)
  }
}
