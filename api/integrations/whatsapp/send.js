import { integrationErrorResponse, isIntegrationRequestAuthorized, parseJsonBody, readRawBody, sendWhatsAppMessage } from '../../../src/integration-core.js'

export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  if (!isIntegrationRequestAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' })
  try {
    const data = await sendWhatsAppMessage(parseJsonBody(await readRawBody(req)))
    res.status(200).json({ ok: true, data })
  } catch (error) {
    const response = integrationErrorResponse(error)
    res.status(response.statusCode).json(response.body)
  }
}
