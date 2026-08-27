import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
  buildAutomationEvent, createIntegrationKey, hashIntegrationKey, integrationKeyFromRequest,
  safeStringEqual, verifyWebhookChallenge, verifyWhatsAppSignature,
} from '../src/integration-core.js'

function withEnv(patch, callback) {
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(patch)) process.env[key] = value
  try { callback() } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('segredos exigem conteúdo e tamanho iguais', () => {
  assert.equal(safeStringEqual('segredo-123', 'segredo-123'), true)
  assert.equal(safeStringEqual('segredo-123', 'segredo'), false)
})

test('chave gerada usa prefixo próprio e somente o hash precisa ser armazenado', () => {
  const key = createIntegrationKey()
  assert.match(key, /^cta_[A-Za-z0-9_-]{40,}$/)
  assert.equal(hashIntegrationKey(key).length, 64)
  assert.notEqual(hashIntegrationKey(key), key)
})

test('autenticação aceita Bearer ou x-api-key', () => {
  assert.equal(integrationKeyFromRequest({ headers: { authorization: 'Bearer cta_abc' } }), 'cta_abc')
  assert.equal(integrationKeyFromRequest({ headers: { 'x-api-key': 'cta_xyz' } }), 'cta_xyz')
})

test('desafio de verificação da Meta valida o token', () => {
  withEnv({ WHATSAPP_VERIFY_TOKEN: 'token-teste' }, () => {
    assert.equal(verifyWebhookChallenge({
      'hub.mode': 'subscribe', 'hub.verify_token': 'token-teste', 'hub.challenge': '987654',
    }), '987654')
    assert.equal(verifyWebhookChallenge({
      'hub.mode': 'subscribe', 'hub.verify_token': 'incorreto', 'hub.challenge': '987654',
    }), null)
  })
})

test('assinatura do webhook usa HMAC SHA-256 sobre o corpo bruto', () => {
  withEnv({ WHATSAPP_APP_SECRET: 'app-secret-teste' }, () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}')
    const signature = `sha256=${createHmac('sha256', 'app-secret-teste').update(body).digest('hex')}`
    assert.equal(verifyWhatsAppSignature(body, signature), true)
    assert.equal(verifyWhatsAppSignature(body, 'sha256=0000'), false)
  })
})

test('payload oficial vira evento idempotente do n8n', () => {
  const event = buildAutomationEvent({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: '123' },
      contacts: [{ wa_id: '5511999999999', profile: { name: 'Cliente' } }],
      messages: [{ id: 'wamid.abc', from: '5511999999999', type: 'text', text: { body: 'Olá' } }],
    } }] }],
  })
  assert.equal(event.event, 'whatsapp.message.received')
  assert.equal(event.eventId, 'wamid.abc')
  assert.equal(event.messages.length, 1)
  assert.equal(event.source, 'chat-ativa')
})
