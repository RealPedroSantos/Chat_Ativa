import { integrationErrorResponse, parseJsonBody, readRawBody } from '../../../src/integration-core.js'

export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  try {
    const rawBody = await readRawBody(req)
    parseJsonBody(rawBody)
    const base = String(process.env.CHAT_ATIVA_BACKEND_URL || 'https://163-176-79-85.sslip.io').replace(/\/+$/, '')
    const response = await fetch(`${base}/api/integrations/whatsapp/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        ...(req.headers['x-api-key'] ? { 'X-API-Key': req.headers['x-api-key'] } : {}),
      },
      body: rawBody,
      signal: AbortSignal.timeout(15_000),
    })
    const responseBody = await response.text()
    res.status(response.status)
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json; charset=utf-8')
    res.send(responseBody)
  } catch (error) {
    const response = integrationErrorResponse(error)
    res.status(response.statusCode).json(response.body)
  }
}
