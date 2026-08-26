import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const DEFAULT_GRAPH_VERSION = 'v26.0'
const DEFAULT_TIMEOUT_MS = 8_000
const BODY_LIMIT_BYTES = 2 * 1024 * 1024

export class IntegrationError extends Error {
  constructor(code, message, statusCode = 500, details) {
    super(message)
    this.name = 'IntegrationError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

function env(name) {
  return process.env[name]?.trim() || ''
}

function headerValue(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  return Array.isArray(value) ? (value[0] || '') : (value || '')
}

export function safeStringEqual(expected, provided) {
  const expectedBuffer = Buffer.from(String(expected || ''))
  const providedBuffer = Buffer.from(String(provided || ''))
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer)
}

export function isIntegrationRequestAuthorized(req) {
  const expected = env('CHAT_ATIVA_INTEGRATION_KEY')
  if (!expected) return false
  const bearer = headerValue(req, 'authorization').replace(/^Bearer\s+/i, '')
  return safeStringEqual(expected, headerValue(req, 'x-api-key') || bearer)
}

export function integrationStatus() {
  return {
    whatsapp: {
      configured: Boolean(env('WHATSAPP_ACCESS_TOKEN') && env('WHATSAPP_PHONE_NUMBER_ID')),
      webhookConfigured: Boolean(env('WHATSAPP_VERIFY_TOKEN') && env('WHATSAPP_APP_SECRET')),
      graphVersion: env('WHATSAPP_GRAPH_API_VERSION') || DEFAULT_GRAPH_VERSION,
      webhookPath: '/api/integrations/whatsapp/webhook',
    },
    n8n: {
      configured: Boolean(env('N8N_WEBHOOK_URL')),
      authenticated: Boolean(env('N8N_WEBHOOK_SECRET')),
      automationPath: '/api/integrations/n8n',
    },
    backend: {
      configured: Boolean(env('CHAT_ATIVA_BACKEND_URL') && env('CHAT_ATIVA_INTEGRATION_KEY')),
    },
  }
}

export async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody
  if (Buffer.isBuffer(req.body)) return req.body
  if (typeof req.body === 'string') return Buffer.from(req.body)
  if (req.body && typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body))
  if (!req.on) return Buffer.alloc(0)
  return await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > BODY_LIMIT_BYTES) {
        reject(new IntegrationError('payload_too_large', 'Payload acima do limite permitido.', 413))
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function parseJsonBody(rawBody) {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_object')
    return parsed
  } catch {
    throw new IntegrationError('invalid_json', 'O corpo da requisição não contém JSON válido.', 400)
  }
}

export function verifyWebhookChallenge(query = {}) {
  const expected = env('WHATSAPP_VERIFY_TOKEN')
  if (String(query['hub.mode'] || '') !== 'subscribe' || !expected) return null
  return safeStringEqual(expected, String(query['hub.verify_token'] || ''))
    ? String(query['hub.challenge'] || '')
    : null
}

export function verifyWhatsAppSignature(rawBody, signature) {
  const appSecret = env('WHATSAPP_APP_SECRET')
  if (!appSecret || !String(signature).startsWith('sha256=')) return false
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`
  return safeStringEqual(expected, signature)
}

function phone(value) {
  const normalized = String(value || '').replace(/\D/g, '')
  if (normalized.length < 8 || normalized.length > 15) {
    throw new IntegrationError('invalid_recipient', 'Informe o telefone com DDI, somente números.', 400)
  }
  return normalized
}

function graphEndpoint() {
  const version = (env('WHATSAPP_GRAPH_API_VERSION') || DEFAULT_GRAPH_VERSION).replace(/^\/+|\/+$/g, '')
  const phoneNumberId = env('WHATSAPP_PHONE_NUMBER_ID')
  if (!phoneNumberId) throw new IntegrationError('whatsapp_not_configured', 'WHATSAPP_PHONE_NUMBER_ID não configurado.', 503)
  return `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`
}

function whatsappPayload(input) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone(input.to) }
  if (input.message && typeof input.message === 'object' && !Array.isArray(input.message)) {
    return { ...base, ...input.message, messaging_product: 'whatsapp', to: base.to }
  }
  if (input.template?.name) {
    return {
      ...base,
      type: 'template',
      template: {
        name: input.template.name,
        language: { code: input.template.language || 'pt_BR' },
        ...(input.template.components ? { components: input.template.components } : {}),
      },
    }
  }
  const text = String(input.text || '').trim()
  if (!text) throw new IntegrationError('invalid_message', 'Informe text, template ou message.', 400)
  return { ...base, type: 'text', text: { preview_url: input.previewUrl === true, body: text } }
}

async function fetchWithTimeout(url, init, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw new IntegrationError('integration_timeout', 'A integração excedeu o tempo limite.', 504)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function responseData(response) {
  const raw = await response.text()
  try { return raw ? JSON.parse(raw) : {} } catch { return raw }
}

export async function sendWhatsAppMessage(input) {
  const accessToken = env('WHATSAPP_ACCESS_TOKEN')
  if (!accessToken) throw new IntegrationError('whatsapp_not_configured', 'WHATSAPP_ACCESS_TOKEN não configurado.', 503)
  const response = await fetchWithTimeout(graphEndpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(whatsappPayload(input)),
  })
  const data = await responseData(response)
  if (!response.ok) throw new IntegrationError('whatsapp_api_error', `WhatsApp Cloud API respondeu HTTP ${response.status}.`, 502, data)
  return data
}

export function buildAutomationEvent(payload) {
  const entries = Array.isArray(payload.entry) ? payload.entry : []
  const changes = entries.flatMap((entry) => Array.isArray(entry?.changes) ? entry.changes : [])
  const values = changes.flatMap((change) => change?.value && typeof change.value === 'object' ? [change.value] : [])
  const messages = values.flatMap((value) => Array.isArray(value.messages) ? value.messages : [])
  const statuses = values.flatMap((value) => Array.isArray(value.statuses) ? value.statuses : [])
  const contacts = values.flatMap((value) => Array.isArray(value.contacts) ? value.contacts : [])
  const metadata = values.find((value) => value.metadata)?.metadata || null
  const firstMessage = messages[0]
  const firstStatus = statuses[0]
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24)
  return {
    event: messages.length ? 'whatsapp.message.received' : statuses.length ? 'whatsapp.message.status' : 'whatsapp.webhook',
    eventId: String(firstMessage?.id || (firstStatus?.id ? `${firstStatus.id}:${firstStatus.status || 'status'}` : `webhook:${hash}`)),
    occurredAt: new Date().toISOString(),
    source: 'chat-ativa',
    channel: 'whatsapp',
    messages,
    statuses,
    contacts,
    metadata,
    payload,
  }
}

function checkedUrl(raw, name) {
  try {
    const url = new URL(raw)
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('protocol')
    return url
  } catch {
    throw new IntegrationError('invalid_integration_url', `${name} inválida.`, 503)
  }
}

export async function forwardToN8n(event) {
  const rawUrl = env('N8N_WEBHOOK_URL')
  if (!rawUrl) return { delivered: false, skipped: true }
  const secret = env('N8N_WEBHOOK_SECRET')
  const body = JSON.stringify(event)
  const signature = secret ? createHmac('sha256', secret).update(body).digest('hex') : ''
  const response = await fetchWithTimeout(checkedUrl(rawUrl, 'N8N_WEBHOOK_URL'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Chat-Ativa-Integrations/1.1',
      ...(secret ? { Authorization: `Bearer ${secret}`, 'X-Chat-Ativa-Signature': `sha256=${signature}` } : {}),
    },
    body,
  }, Number.parseInt(env('N8N_TIMEOUT_MS') || String(DEFAULT_TIMEOUT_MS), 10))
  const data = await responseData(response)
  if (!response.ok) throw new IntegrationError('n8n_webhook_error', `n8n respondeu HTTP ${response.status}.`, 502, data)
  return { delivered: true, data }
}

export async function forwardToBackend(payload) {
  const rawUrl = env('CHAT_ATIVA_BACKEND_URL')
  const key = env('CHAT_ATIVA_INTEGRATION_KEY')
  if (!rawUrl || !key) return { delivered: false, skipped: true }
  const base = checkedUrl(rawUrl, 'CHAT_ATIVA_BACKEND_URL')
  const endpoint = new URL('/api/integrations/whatsapp/inbound', base)
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    body: JSON.stringify(payload),
  })
  const data = await responseData(response)
  if (!response.ok) throw new IntegrationError('backend_delivery_error', `Backend respondeu HTTP ${response.status}.`, 502, data)
  return { delivered: true, data }
}

export async function sendN8nReplyIfPresent(data, fallbackRecipient) {
  const rawReply = data && typeof data === 'object' ? data.reply : null
  if (!rawReply) return null
  if (typeof rawReply === 'string') return fallbackRecipient ? sendWhatsAppMessage({ to: fallbackRecipient, text: rawReply }) : null
  if (typeof rawReply !== 'object' || Array.isArray(rawReply)) return null
  return sendWhatsAppMessage({ ...rawReply, to: rawReply.to || fallbackRecipient })
}

export function firstWebhookSender(event) {
  return typeof event.messages?.[0]?.from === 'string' ? event.messages[0].from : undefined
}

export function integrationErrorResponse(error) {
  if (error instanceof IntegrationError) {
    return { statusCode: error.statusCode, body: { ok: false, error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }
  }
  console.error('[integrations]', error)
  return { statusCode: 500, body: { ok: false, error: 'internal_error', message: 'Erro interno na integração.' } }
}
