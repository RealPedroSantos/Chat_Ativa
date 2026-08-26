import { integrationStatus } from '../../src/integration-core.js'

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  res.status(200).json({ ok: true, ...integrationStatus() })
}
