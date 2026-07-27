import {
  appendSmartNote,
  createSmartNote,
  findOpenSmartNote,
  findRecentOpenSmartNote,
} from './db.js'
import { bus } from './bus.js'

const CATEGORIES = [
  {
    key: 'appointment',
    title: 'Agendamento',
    intro: 'Cliente solicitou um agendamento ou reserva.',
    patterns: [
      /\bagend\w*/,
      /\bmarc\w*.{0,25}\b(horario|consulta|reuniao|visita)/,
      /\b(reservar|reserva|reservem)\b/,
      /\b(quero|gostaria|preciso|pode).{0,30}\b(horario|consulta|reuniao|visita)\b/,
    ],
  },
  {
    key: 'registration',
    title: 'Cadastro ou inscrição',
    intro: 'Cliente solicitou cadastro, inscrição ou matrícula.',
    patterns: [/\bcadastr\w*/, /\binscri\w*/, /\bmatricul\w*/, /\bfazer (meu |o )?registro\b/, /\bpreencher.{0,15}\bficha\b/],
  },
  {
    key: 'order',
    title: 'Pedido ou orçamento',
    intro: 'Cliente demonstrou interesse em pedido, encomenda ou orçamento.',
    patterns: [/\b(fazer|fechar|acompanhar).{0,20}\bpedido\b/, /\bencomend\w*/, /\borcamento\b/, /\bcotacao\b/],
  },
  {
    key: 'callback',
    title: 'Retorno ao cliente',
    intro: 'Cliente pediu contato ou retorno da equipe.',
    patterns: [/\bretorn\w*/, /\bme lig\w*/, /\bligar para mim\b/, /\bentrar em contato\b/, /\bme cham\w*/, /\bme avis\w*/],
  },
  {
    key: 'handoff',
    title: 'Atendimento humano',
    intro: 'Cliente pediu atendimento de uma pessoa da equipe.',
    patterns: [
      /\bfalar com.{0,20}\b(atendente|pessoa|humano)\b/,
      /\bquero.{0,20}\b(atendente|humano)\b/,
      /\b(atendente humano|atendimento humano)\b/,
      /^(atendente|humano)$/,
    ],
  },
  {
    key: 'other',
    title: 'Anotação solicitada',
    intro: 'Cliente pediu que esta informação fosse anotada.',
    patterns: [
      /\b(anota|anote|anotar|anotem|deixa anotado|pode registrar)\b/,
      /\b(deixa|guarda|salva).{0,20}\b(meu|minha|nome|numero|informacao|dados)\b/,
    ],
  },
]

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function detectNoteCategory(text) {
  const normalized = normalize(text)
  if (!normalized) return null
  return CATEGORIES.find((category) => category.patterns.some((pattern) => pattern.test(normalized))) || null
}

function isUsefulFollowUp(text) {
  const normalized = normalize(text).replace(/[!?.,]/g, '').trim()
  if (normalized.length < 2) return false
  return !/^(oi+|ola|bom dia|boa tarde|boa noite|obrigad[oa]|valeu|tchau)$/.test(normalized)
}

export function captureSmartNote({ jid, text, messageId }) {
  const cleanText = String(text || '').trim()
  if (!cleanText) return null

  const category = detectNoteCategory(cleanText)
  let note = null
  let action = null

  if (category) {
    const existing = findOpenSmartNote(jid, category.key, 120)
    if (existing) {
      note = appendSmartNote(existing.id, messageId, cleanText)
      action = 'updated'
    } else {
      note = createSmartNote({
        jid,
        category: category.key,
        title: category.title,
        content: `${category.intro}\n• ${cleanText}`,
        messageId,
      })
      action = 'created'
    }
  } else if (isUsefulFollowUp(cleanText)) {
    const recent = findRecentOpenSmartNote(jid, 30)
    if (recent) {
      note = appendSmartNote(recent.id, messageId, cleanText)
      action = 'updated'
    }
  }

  if (note) bus.emit('note_update', { id: note.id, jid, action })
  return note
}

const HUMAN_REPLY_PATTERNS = [
  /\b(?:vou|vamos|irei)\s+(?:verificar|confirmar|consultar|encaminhar)\b/,
  /\b(?:estou|estamos|continuo|ainda estou)\s+(?:verificando|confirmando|consultando)\b/,
  /\bpreciso\s+(?:verificar|confirmar|consultar)\b/,
  /\bj[aá]\s+te confirmo\b/,
  /\bte avis[oa]\b.{0,100}\b(?:responder|resposta|confirmar)\b/,
  /\bassim que\s+(?:ele|ela|a equipe|o atendente)\s+(?:responder|confirmar)\b/,
]

function isShortAcknowledgement(text) {
  const value = normalize(text).replace(/[!?.,]/g, '').trim()
  return /^(ok|okay|certo|entendi|beleza|ta bom|tudo bem|obrigad[oa]|valeu)$/.test(value)
}

export function aiNeedsHumanReply(text) {
  const normalized = normalize(text)
  if (!normalized) return false
  return HUMAN_REPLY_PATTERNS.some((pattern) => pattern.test(normalized))
}

function pendingAction(customerText, aiText) {
  const reply = String(aiText || '').replace(/\s+/g, ' ').trim()
  const subject = reply.match(/\b(?:verificar|verificando|confirmar|confirmando|consultar|consultando)\s+(.+?)(?=[.!?](?:\s|$)|$)/iu)?.[1]
  if (subject && !/^(?:isso|com (?:a )?equipe|com [\p{L}]+)$/iu.test(subject.trim())) {
    return `Verificar ${subject.trim()} e responder ao cliente.`
  }

  const customerRequest = String(customerText || '').replace(/\s+/g, ' ').trim()
  if (customerRequest && !isShortAcknowledgement(customerRequest)) {
    return `Verificar e responder ao cliente sobre: ${customerRequest}`
  }

  return 'Verificar a solicitação e enviar a confirmação que a IA prometeu ao cliente.'
}

/** Creates a visible operator task whenever the AI promises a human answer. */
export function captureAiPendingNote({ jid, customerText, aiText, messageId }) {
  if (!aiNeedsHumanReply(aiText)) return null

  const existing = findOpenSmartNote(jid, 'ai_pending', 1440)
  if (existing && isShortAcknowledgement(customerText)) return existing

  const actionText = pendingAction(customerText, aiText)
  let note
  let action
  if (existing) {
    note = appendSmartNote(existing.id, messageId, `Nova informação: ${actionText}`)
    action = 'updated'
  } else {
    note = createSmartNote({
      jid,
      category: 'ai_pending',
      title: 'Resposta da equipe necessária',
      content: `A IA informou ao cliente que aguardaria uma confirmação humana.\n\nRESPOSTA NECESSÁRIA:\n• ${actionText}`,
      messageId,
    })
    action = 'created'
  }

  if (note) bus.emit('note_update', { id: note.id, jid, action, urgent: true })
  return note
}
