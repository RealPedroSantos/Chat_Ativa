import {
  getSettings, setSetting, getMessagesSince, listKnowledge, createKnowledge,
  listTenants,
} from './db.js'
import { aiConfigured, extractQA } from './ai.js'
import { extractQAHeuristic } from './ai-interna.js'
import { bus } from './bus.js'
import { runWithTenant } from './tenant-context.js'

const LEARN_INTERVAL_MS = 60 * 60 * 1000 // hourly
const MAX_TRANSCRIPT_CHARS = 60_000

function normalizeQ(q) {
  return q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').trim()
}

/**
 * Reads conversations since the last learning run, asks the AI to extract
 * generalizable Q&A pairs, and stores them as *pending* knowledge for the
 * operator to approve in the dashboard.
 */
export async function learnFromConversations({ force = false } = {}) {
  const settings = getSettings()
  const internalAi = settings.ai_provider === 'interna'
  if (!internalAi && !aiConfigured()) return { ok: false, reason: 'chave da API xAI não configurada' }
  if (!force && settings.learning_enabled !== 'true') return { ok: false, reason: 'aprendizado desativado' }

  const since = settings.last_learn_at || new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const rows = getMessagesSince(since)
  if (rows.length < 4) return { ok: true, added: 0, reason: 'poucas mensagens novas' }

  // IA interna: extração heurística local (pergunta do cliente + resposta do
  // atendente humano), sem chamadas de API e sem custo.
  if (internalAi) {
    const entries = extractQAHeuristic(rows)
    const added = storeEntries(entries, settings)
    setSetting('last_learn_at', new Date().toISOString().slice(0, 19).replace('T', ' '))
    if (added > 0) bus.emit('knowledge_update', { added })
    return { ok: true, added, engine: 'interna' }
  }

  // Group by conversation and format transcripts
  const byJid = new Map()
  for (const m of rows) {
    if (!byJid.has(m.jid)) byJid.set(m.jid, [])
    byJid.get(m.jid).push(m)
  }
  let transcript = ''
  let convIndex = 0
  for (const [, msgs] of byJid) {
    convIndex++
    let block = `\n## Conversa ${convIndex}\n`
    for (const m of msgs) {
      const who = m.direction === 'in' ? 'CLIENTE' : 'ATENDENTE'
      block += `${who}: ${m.text}\n`
    }
    if (transcript.length + block.length > MAX_TRANSCRIPT_CHARS) break
    transcript += block
  }
  if (!transcript.trim()) return { ok: true, added: 0 }

  const entries = await extractQA(transcript, settings)
  const added = storeEntries(entries, settings)

  setSetting('last_learn_at', new Date().toISOString().slice(0, 19).replace('T', ' '))
  if (added > 0) bus.emit('knowledge_update', { added })
  return { ok: true, added }
}

function storeEntries(entries, settings) {
  const status = settings.ai_provider === 'interna' && settings.internal_learning_autoapprove === 'true'
    ? 'approved'
    : 'pending'
  const existing = new Set(listKnowledge().map((k) => normalizeQ(k.question)))
  let added = 0
  for (const e of entries) {
    if (!e.question?.trim() || !e.answer?.trim()) continue
    if (typeof e.confidence === 'number' && e.confidence < 0.6) continue
    const key = normalizeQ(e.question)
    if (existing.has(key)) continue
    existing.add(key)
    createKnowledge({ question: e.question.trim(), answer: e.answer.trim(), source: 'learned', status })
    added++
  }
  return added
}

export function startLearningScheduler() {
  setInterval(() => {
    for (const tenant of listTenants().filter((item) => item.active)) {
      runWithTenant(tenant.id, () => learnFromConversations())
        .catch((err) => console.error(`[learning:${tenant.id}] erro:`, err.message))
    }
  }, LEARN_INTERVAL_MS)
}
