import { forwardToN8n, integrationErrorResponse, isIntegrationRequestAuthorized, parseJsonBody, readRawBody } from '../../src/integration-core.js'

export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  if (!isIntegrationRequestAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const payload = parseJsonBody(await readRawBody(req))
    const delivery = await forwardToN8n({
      ...payload,
      event: typeof payload.event === 'string' ? payload.event : 'chat_ativa.automation.requested',
      eventId: typeof payload.eventId === 'string' ? payload.eventId : `${Date.now()}`,
      occurredAt: new Date().toISOString(),
      source: 'chat-ativa',
    })
    res.status(200).json({ ok: true, ...delivery })
  } catch (error) {
    const response = integrationErrorResponse(error)
    res.status(response.statusCode).json(response.body)
  }
}
