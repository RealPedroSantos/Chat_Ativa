import {
  buildAutomationEvent, firstWebhookSender, forwardToBackend, forwardToN8n,
  integrationErrorResponse, integrationStatus, parseJsonBody, readRawBody, sendN8nReplyIfPresent,
  verifyWebhookChallenge, verifyWhatsAppSignature,
} from '../../../src/integration-core.js'

export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const challenge = verifyWebhookChallenge(req.query || {})
    return challenge === null ? res.status(403).send('Webhook verification failed') : res.status(200).send(challenge)
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  try {
    const rawBody = await readRawBody(req)
    if (!verifyWhatsAppSignature(rawBody, String(req.headers?.['x-hub-signature-256'] || ''))) {
      return res.status(401).json({ ok: false, error: 'invalid_signature' })
    }
    const payload = parseJsonBody(rawBody)
    const event = buildAutomationEvent(payload)
    const [backend, n8n] = await Promise.allSettled([forwardToBackend(payload), forwardToN8n(event)])
    const configured = integrationStatus()
    if (configured.backend.configured && backend.status === 'rejected') throw backend.reason
    if (configured.n8n.configured && n8n.status === 'rejected') throw n8n.reason
    let replied = false
    if (n8n.status === 'fulfilled' && n8n.value.delivered) {
      try { replied = Boolean(await sendN8nReplyIfPresent(n8n.value.data, firstWebhookSender(event))) } catch { /* Meta retries must not duplicate workflow execution. */ }
    }
    const backendOk = backend.status === 'fulfilled' && backend.value.delivered
    const n8nOk = n8n.status === 'fulfilled' && n8n.value.delivered
    res.status(200).json({ ok: true, eventId: event.eventId, backend: backendOk, n8n: n8nOk, replied })
  } catch (error) {
    const response = integrationErrorResponse(error)
    res.status(response.statusCode).json(response.body)
  }
}
