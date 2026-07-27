import { db, getSettings } from './db.js'
import { currentTenantId } from './tenant-context.js'

function normalize(value) {
  return String(value || '')
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim()
}

function cleanLine(value) {
  return String(value || '').replace(/^[-*•]\s+|^\d+[.)]\s+/, '').replace(/^[“"]|[”"]$/g, '').trim()
}

function isInstruction(line) {
  const norm = normalize(line)
  return /^(?:nao|nunca|sempre|quando|caso|se |antes|depois|responda|pergunte|solicite|envie|considere|ignore|evite|use |utilize|identifique|consulte|confirme|informe|registre|o fluxo|a resposta|e proibido|é proibido)/.test(norm)
}

function looksFactual(line) {
  const norm = normalize(line)
  if (!norm || isInstruction(line)) return false
  const subject = /\b(?:treinos?|treinamentos?|jogos?|partidas?|futebol|horarios?|atendimento|endereco|local|campo|quadra|mensalidade|preco|valor|telefone|whatsapp|email|site|inscricao|prazo|idade|categoria|pagamento)\b/.test(norm)
  const detail = /\b(?:segunda|terca|quarta|quinta|sexta|sabado|domingo|hoje|amanha)\b/.test(norm)
    || /\d/.test(norm)
    || /\b(?:acontece|acontecem|fica|ficam|funciona|funcionam|e|sao|sera|das|as)\b/.test(norm)
  return subject && detail
}

function looksFactualLabel(label) {
  return /\b(?:treinos?|treinamentos?|jogos?|partidas?|futebol|horarios?|atendimento|endereco|local|campo|quadra|mensalidade|preco|valor|telefone|whatsapp|email|site|inscricao|prazo|idade|categoria|pagamento)\b/.test(normalize(label))
}

function addEntry(entries, question, answer) {
  const cleanQuestion = cleanLine(question).replace(/:\s*$/, '').trim()
  const cleanAnswer = cleanLine(answer)
  if (cleanQuestion.length < 2 || cleanAnswer.length < 3) return
  const key = `${normalize(cleanQuestion)}|${normalize(cleanAnswer)}`
  if (entries.some((entry) => entry.key === key)) return
  entries.push({ key, question: cleanQuestion.slice(0, 500), answer: cleanAnswer.slice(0, 4000) })
}

function extractFromText(text, { allLinesAreFacts = false } = {}) {
  const lines = String(text || '').split(/\r?\n/)
  const entries = []
  let knowledgeSection = false

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim()
    const norm = normalize(raw)
    if (!raw) continue

    if (/^#{1,4}\s*/.test(raw)) {
      knowledgeSection = /(?:base de conhecimento|informacoes do negocio|dados do negocio|informacoes factuais)/.test(norm)
      continue
    }

    const questionMatch = raw.match(/^(?:p|pergunta)\s*:\s*(.+)$/iu)
    if (questionMatch) {
      const next = lines.slice(index + 1).find((line) => line.trim()) || ''
      const answerMatch = next.trim().match(/^(?:r|resposta)\s*:\s*(.+)$/iu)
      if (answerMatch) addEntry(entries, questionMatch[1], answerMatch[1])
      continue
    }
    if (/^(?:r|resposta)\s*:/iu.test(raw)) continue

    const labelValue = cleanLine(raw).match(/^([^:]{2,100}):\s*(.+)$/u)
    if (labelValue && !/^(?:pessoa|cliente|exemplo)$/iu.test(labelValue[1].trim())
      && !isInstruction(labelValue[1])
      && (allLinesAreFacts || knowledgeSection || looksFactualLabel(labelValue[1]) || looksFactual(raw))) {
      addEntry(entries, labelValue[1], `${cleanLine(labelValue[1])}: ${labelValue[2].trim()}`)
      continue
    }

    const line = cleanLine(raw)
    if ((allLinesAreFacts || knowledgeSection || looksFactual(line)) && !isInstruction(line)) {
      addEntry(entries, line, line)
    }
  }
  return entries
}

function extractGuidelines(text) {
  const entries = []
  let section = ''
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const raw = rawLine.trim()
    if (!raw) continue
    const heading = raw.match(/^#{1,4}\s*(.+)$/u)
    if (heading) {
      section = cleanLine(heading[1])
      continue
    }
    const line = cleanLine(raw)
    if (line.length < 5) continue
    const norm = normalize(line)
    const inGuidelineSection = /(?:regra|diretriz|comportamento|tom de voz|atendimento|dica|orientacao|instrucao|limite|fluxo)/.test(normalize(section))
    const directive = isInstruction(line)
      || /^(?:seja|fale|aja|trate|mantenha|priorize|prefira|ofereca|acolha|demonstre|explique|confirme|encaminhe)/.test(norm)
    const conditional = /^(?:se|quando|caso)\b/.test(norm)
    if (!inGuidelineSection && !directive && !conditional) continue
    const label = section || (conditional ? 'Fluxo condicional' : 'Diretriz de atendimento')
    addEntry(entries, `${label}: ${line.slice(0, 120)}`, line)
  }
  return entries
}

export function extractPromptKnowledge(settings = {}) {
  const entries = [
    ...extractFromText(settings.business_info, { allLinesAreFacts: true }),
    ...extractFromText(settings.system_prompt),
    ...extractGuidelines(settings.system_prompt),
    ...extractGuidelines(settings.business_info),
  ]
  const unique = new Map()
  for (const entry of entries) unique.set(entry.key, entry)
  return [...unique.values()]
}

/** Mantém os conhecimentos de origem "prompt" iguais aos fatos atuais. */
export function syncPromptKnowledge(settings = getSettings()) {
  const tenantId = currentTenantId()
  const desired = extractPromptKnowledge(settings)
  const desiredByKey = new Map(desired.map((entry) => [entry.key, entry]))
  const promptRows = db.prepare("SELECT * FROM knowledge WHERE tenant_id = ? AND source = 'prompt'").all(tenantId)
  const otherRows = db.prepare("SELECT question, answer FROM knowledge WHERE tenant_id = ? AND source <> 'prompt'").all(tenantId)
  const otherKeys = new Set(otherRows.map((row) => `${normalize(row.question)}|${normalize(row.answer)}`))

  let added = 0
  let removed = 0
  const transaction = db.transaction(() => {
    for (const row of promptRows) {
      const key = `${normalize(row.question)}|${normalize(row.answer)}`
      if (!desiredByKey.has(key) || otherKeys.has(key)) {
        db.prepare('DELETE FROM knowledge WHERE tenant_id = ? AND id = ?').run(tenantId, row.id)
        removed++
      } else {
        db.prepare("UPDATE knowledge SET status = 'approved', confidence = 1 WHERE tenant_id = ? AND id = ?").run(tenantId, row.id)
        desiredByKey.delete(key)
      }
    }
    const insert = db.prepare(`
      INSERT INTO knowledge (tenant_id, question, answer, source, status, confidence)
      VALUES (?, ?, ?, 'prompt', 'approved', 1)
    `)
    for (const [key, entry] of desiredByKey) {
      if (otherKeys.has(key)) continue
      insert.run(tenantId, entry.question, entry.answer)
      added++
    }
  })
  transaction()
  return { added, removed, total: desired.length }
}
