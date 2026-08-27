import {
  getSettings, getContact, upsertContact, addMessage,
  setContactPaused, listRules, listCanned,
  completeAiPendingNotes, createExternalRequest,
  findPendingExternalRequestByTarget, findRecentPendingExternalRequest,
  listExternalResponses, listPendingExternalRequests, resolveExternalRequest,
  ensureOpenConversationCycle,
  setMessageCycle,
} from './db.js'
import { aiConfigured, generateReply } from './ai.js'
import { generateInternalReply, shouldPrioritizeInternalFlow } from './ai-interna.js'
import { captureAiPendingNote, captureSmartNote } from './notes.js'
import { bus } from './bus.js'
import { forwardIncomingToTenantN8n } from './n8n-tenant.js'

function normalize(text) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
}

export function matches(text, pattern, matchType) {
  const t = normalize(text)
  const p = normalize(pattern)
  switch (matchType) {
    case 'exact':
      return t === p
    case 'starts_with':
      return t.startsWith(p)
    case 'regex':
      try {
        return new RegExp(pattern, 'iu').test(text)
      } catch {
        return false
      }
    case 'contains':
    default:
      return t.includes(p)
  }
}

function matchesAnyTrigger(text, triggers, matchType) {
  return triggers
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((trigger) => matches(text, trigger, matchType))
}

function externalDecision(text) {
  const value = normalize(String(text || ''))
  if (/^(?:sim|s|pode|autorizado|confirmado|tenho disponibilidade)\b/.test(value)) return 'approved'
  if (/^(?:nao|n|nao posso|sem disponibilidade|indisponivel)\b/.test(value)) return 'declined'
  return null
}

function customerDecisionMessage(status, responseText) {
  const text = String(responseText || '').trim()
  const shortAnswer = /^(?:sim|s|pode|autorizado|confirmado|não|nao|n)[\s.!]*$/iu.test(text)
  if (status === 'approved') {
    return [
      'O Alex confirmou que poderá atender a emergência no local informado.',
      shortAnswer ? '' : `\nInformação enviada pelo Alex: ${text}`,
      '\nMantenha o telefone disponível para contato e permaneça em um local seguro.',
    ].filter(Boolean).join('\n')
  }
  return [
    'No momento, o Alex informou que não possui disponibilidade para realizar o atendimento no local.',
    shortAnswer ? '' : `\nInformação enviada pelo Alex: ${text}`,
    '\nComo o veículo está em uma situação de emergência, o mais seguro é solicitar um serviço de reboque ou assistência 24 horas.',
  ].filter(Boolean).join('\n')
}

async function deliverExternalDecision(request, response, send) {
  const status = externalDecision(response.text)
  if (!status) return false
  const customerMessage = customerDecisionMessage(status, response.text)
  const sourceContact = getContact(request.source_jid)
  await send(sourceContact?.transport_jid || request.source_jid, customerMessage, 'system', request.source_jid)
  resolveExternalRequest(request.id, status, response.id, response.text)
  completeAiPendingNotes(
    request.source_jid,
    status === 'approved' ? 'Alex autorizou o atendimento emergencial.' : 'Alex informou que não possui disponibilidade.'
  )
  bus.emit('contact_update', { jid: request.source_jid })
  return true
}

async function processExternalResponse({ jid, text, messageId }, send) {
  const request = findPendingExternalRequestByTarget(jid)
  if (!request) return false
  return deliverExternalDecision(request, { id: messageId, text }, send)
}

export async function reconcileExternalAuthorizations(send) {
  for (const request of listPendingExternalRequests()) {
    for (const response of listExternalResponses(request)) {
      if (await deliverExternalDecision(request, response, send)) break
    }
  }
}

/**
 * Handles one inbound WhatsApp message.
 * Order: rules -> canned responses -> AI. `send(jid, text, source)` delivers the reply.
 */
export function prepareIncomingConversation({ jid, replyJid = jid, name }) {
  const previousContact = getContact(jid)
  const isNewContact = upsertContact(jid, name, replyJid)
  const reopened = previousContact?.service_status === 'resolved'
  const cycle = ensureOpenConversationCycle(jid)
  if (reopened) {
    const event = addMessage(
      jid,
      'out',
      'Novo atendimento iniciado após a conclusão do atendimento anterior.',
      'system',
      { messageType: 'system_event' }
    )
    bus.emit('message', event)
  }
  return { isNewContact, cycle }
}

export async function handleIncoming({
  jid,
  replyJid = jid,
  name,
  text,
  hasText,
  storedMessage = null,
  preparation = null,
}, send) {
  const { isNewContact, cycle } = preparation || prepareIncomingConversation({ jid, replyJid, name })
  let stored = storedMessage
  if (stored) {
    if (cycle?.id && Number(stored.cycle_id) !== Number(cycle.id)) {
      setMessageCycle(stored.id, cycle.id)
      stored.cycle_id = cycle.id
    }
    if (hasText) captureSmartNote({ jid, text, messageId: stored.id })
    bus.emit('message', stored)
  } else if (hasText) {
    stored = addMessage(jid, 'in', text, 'user')
    captureSmartNote({ jid, text, messageId: stored.id })
    bus.emit('message', stored)
  }
  bus.emit('contact_update', { jid })
  if (stored) {
    forwardIncomingToTenantN8n({ jid, name, text, storedMessage: stored })
      .catch((error) => console.error('[n8n] erro ao entregar mensagem:', error.message))
  }

  // Replies from an internal recipient (for example, Alex responding SIM/NÃO)
  // must continue the original customer's flow before normal bot rules run.
  if (hasText && stored && await processExternalResponse({ jid, text, messageId: stored.id }, send)) return

  const settings = getSettings()
  if (settings.bot_enabled !== 'true') return

  const contact = getContact(jid)
  if (contact?.bot_paused) return

  if (isNewContact && settings.welcome_message?.trim()) {
    await send(replyJid, settings.welcome_message.trim(), 'system', jid)
  }

  if (!hasText) {
    if (settings.non_text_reply?.trim()) await send(replyJid, settings.non_text_reply.trim(), 'system', jid)
    return
  }

  // 1) Custom rules (highest priority first)
  for (const rule of listRules()) {
    if (!rule.enabled) continue
    if (!matches(text, rule.pattern, rule.match_type)) continue
    if (rule.action === 'pause_bot') {
      setContactPaused(jid, true)
      if (rule.response?.trim()) await send(replyJid, rule.response.trim(), 'rule', jid)
      bus.emit('handoff', { jid, rule: rule.name })
      bus.emit('contact_update', { jid })
      return
    }
    if (rule.action === 'reply' && rule.response?.trim()) {
      await send(replyJid, rule.response.trim(), 'rule', jid)
      return
    }
  }

  // Fluxos obrigatórios descritos no prompt (como consultar/cadastrar o
  // cliente) precisam rodar antes das respostas prontas, que podem estar
  // desatualizadas em relação ao prompt atual.
  const useInternalAi = settings.ai_provider === 'interna'
  if (settings.ai_enabled === 'true' && useInternalAi && shouldPrioritizeInternalFlow(jid, text, settings)) {
    try {
      const reply = await generateInternalReply(jid, text, settings)
      if (reply) {
        const sent = await send(replyJid, reply, 'ai', jid)
        try {
          captureAiPendingNote({ jid, customerText: text, aiText: reply, messageId: sent?.id })
        } catch (err) {
          console.error('[notes] erro ao registrar pendência da IA:', err.message)
        }
        return
      }
    } catch (err) {
      console.error('[ia-interna] mandatory flow failed:', err.message)
    }
  }

  // 2) Canned responses
  for (const canned of listCanned()) {
    if (!canned.enabled) continue
    if (matchesAnyTrigger(text, canned.triggers, canned.match_type)) {
      await send(replyJid, canned.response, 'canned', jid)
      return
    }
  }

  // 3) AI reply — "interna" runs locally; external providers use their APIs.
  if (settings.ai_enabled === 'true' && (useInternalAi || aiConfigured())) {
    try {
      const reply = useInternalAi ? await generateInternalReply(jid, text, settings) : await generateReply(jid, text, settings, {
        sendWhatsAppMessage: async ({ phone, contactName, message }) => {
          const targetJid = `${phone}@s.whatsapp.net`
          const existing = findRecentPendingExternalRequest(jid, targetJid)
          if (existing) return { id: existing.request_message_id, requestId: existing.id, duplicatePrevented: true }
          upsertContact(targetJid, contactName || phone, targetJid)
          // This is an internal recipient authorized by the master prompt.
          // Keep the bot from treating their SIM/NÃO reply as a new customer request.
          setContactPaused(targetJid, true)
          const sent = await send(targetJid, message, 'ai_action', targetJid)
          const request = createExternalRequest({
            sourceJid: jid,
            targetJid,
            requestMessageId: sent.id,
            requestText: message,
          })
          bus.emit('contact_update', { jid: targetJid })
          return { id: sent?.id || null, requestId: request.id }
        },
      })
      if (reply) {
        const sent = await send(replyJid, reply, 'ai', jid)
        try {
          captureAiPendingNote({ jid, customerText: text, aiText: reply, messageId: sent?.id })
        } catch (err) {
          // The customer already received the reply; a note failure must never
          // trigger a second/fallback WhatsApp message.
          console.error('[notes] erro ao registrar pendência da IA:', err.message)
        }
        return
      }
    } catch (err) {
      console.error('[ai] reply failed:', err.message)
    }
  }

  if (settings.fallback_message?.trim()) {
    await send(replyJid, settings.fallback_message.trim(), 'system', jid)
  }
}
