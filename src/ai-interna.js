import {
  getMessages, approvedKnowledge, bumpKnowledgeUsage,
  createKnowledge, listKnowledge, adjustKnowledgeConfidence,
} from './db.js'
import {
  changeAppointment, contactNameForCalendar,
  createAppointment, customerAppointments, getAvailableSlots,
} from './calendar.js'
import { bus } from './bus.js'
import {
  createCustomer, findCustomerByJid, normalizeCustomerPhone, parseCustomerExtraFields,
} from './customers.js'
import { hasMenuFlow, menuFlowReply } from './menu-flow.js'

// ============================================================================
// IA INTERNA — motor de inteligência própria, 100% local (sem API externa).
//
// Como funciona:
//   1. Entende o prompt do sistema e as informações do negócio: cada linha
//      vira um "fato" pesquisável; instruções condicionais ("se o cliente
//      pedir X, faça Y") viram comportamentos.
//   2. Responde por recuperação semântica (TF-IDF + sinônimos + radicais
//      pt-BR) sobre: base de conhecimento aprovada + fatos do prompt.
//   3. Aprende com os atendimentos: respostas dadas por atendentes humanos
//      viram conhecimento (pendente ou aprovado, conforme configuração), e o
//      feedback do cliente reforça ou enfraquece cada resposta aprendida.
//   4. Atendimento humanizado: saudação pelo horário, nome do cliente,
//      variação de frases (nunca repete a mesma resposta em sequência) e
//      confirmações naturais.
//   5. Agenda de verdade: consulta horários e cria/cancela agendamentos pelo
//      calendário inteligente — nunca confirma sem registrar.
// ============================================================================

const TIMEZONE = 'America/Sao_Paulo'

// ---------------------------------------------------------------------------
// Processamento de texto (pt-BR)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'o', 'e', 'de', 'da', 'do', 'das', 'dos', 'em', 'na', 'no', 'nas', 'nos',
  'um', 'uma', 'uns', 'umas', 'para', 'pra', 'pro', 'por', 'com', 'sem', 'que',
  'se', 'ou', 'ao', 'aos', 'as', 'os', 'eu', 'voce', 'voces', 'vc', 'vcs', 'me',
  'te', 'meu', 'minha', 'seu', 'sua', 'ele', 'ela', 'isso', 'isto', 'esse',
  'essa', 'este', 'esta', 'aqui', 'ai', 'la', 'ja', 'mas', 'mais', 'muito',
  'bem', 'so', 'tambem', 'tbm', 'como', 'qual', 'quais',
  'quem', 'porque', 'pq', 'sim', 'nao', 'ok', 'ola', 'oi', 'bom', 'boa', 'dia',
  'tarde', 'noite', 'por', 'favor', 'obrigado', 'obrigada', 'gostaria', 'queria',
  'quero', 'saber', 'sobre', 'ser', 'ter', 'tem', 'estou', 'esta', 'sao', 'foi',
])

const SYNONYMS = {
  valor: 'preco', valores: 'preco', custa: 'preco', custo: 'preco', custam: 'preco',
  tabela: 'preco', orcamento: 'preco', barato: 'preco', caro: 'preco', quanto: 'preco',
  funcionamento: 'horario', funciona: 'horario', abre: 'horario', abrem: 'horario',
  fecha: 'horario', fecham: 'horario', aberto: 'horario', expediente: 'horario',
  atendimento: 'horario', atendem: 'horario', hora: 'horario', horas: 'horario',
  local: 'endereco', localizacao: 'endereco', localizado: 'endereco', fica: 'endereco',
  rua: 'endereco', avenida: 'endereco', mapa: 'endereco', chegar: 'endereco', onde: 'endereco',
  frete: 'entrega', envio: 'entrega', enviam: 'entrega', entregam: 'entrega',
  mandar: 'entrega', despacho: 'entrega',
  pagar: 'pagamento', pix: 'pagamento', cartao: 'pagamento', dinheiro: 'pagamento',
  parcela: 'pagamento', parcelar: 'pagamento', parcelamento: 'pagamento', credito: 'pagamento',
  debito: 'pagamento',
  celular: 'telefone', whatsapp: 'telefone', contato: 'telefone', numero: 'telefone',
  ligar: 'telefone',
  marcar: 'agendar', reservar: 'agendar', reserva: 'agendar', agendamento: 'agendar',
  remarcar: 'agendar',
  treinos: 'treino', treinamento: 'treino', treinamentos: 'treino', treinar: 'treino',
  pratica: 'treino', praticar: 'treino',
  partida: 'jogo', partidas: 'jogo', jogos: 'jogo',
  quando: 'horario',
}

export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Radical simplificado: singulariza e remove sufixos comuns do português.
function stem(word) {
  let w = word
  if (w.length <= 3) return w
  if (w.endsWith('mente')) w = w.slice(0, -5)
  if (w.endsWith('coes') || w.endsWith('soes')) w = `${w.slice(0, -3)}ao`
  else if (w.endsWith('oes') || w.endsWith('aes')) w = `${w.slice(0, -3)}ao`
  else if (w.endsWith('eis') && w.length > 4) w = `${w.slice(0, -3)}el`
  else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  if (w.endsWith('inho') || w.endsWith('inha')) w = w.slice(0, -4)
  return w
}

export function tokenize(text) {
  const normalized = normalizeText(text)
  const tokens = []
  for (const raw of normalized.split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 2) continue
    if (STOPWORDS.has(raw)) continue
    const canonical = SYNONYMS[raw] || SYNONYMS[stem(raw)] || stem(raw)
    tokens.push(canonical)
  }
  if (/\b\d{1,2}(?::\d{2}|h\d{0,2})\b/.test(normalized)) tokens.push('horario')
  return tokens
}

// Escolha determinística de variação: mesma semente → mesma frase, sementes
// diferentes (contato, nº da mensagem) → frases diferentes. Evita repetição.
function hashCode(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0
  return Math.abs(h)
}

function pick(list, seed) {
  return list[hashCode(String(seed)) % list.length]
}

// ---------------------------------------------------------------------------
// Estado de conversa (memória de curto prazo, por contato)
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 2 * 60 * 60 * 1000
const conversationState = new Map()

function getState(jid) {
  const now = Date.now()
  for (const [key, value] of conversationState) {
    if (now - value.ts > STATE_TTL_MS) conversationState.delete(key)
  }
  let state = conversationState.get(jid)
  if (!state) {
    state = {
      ts: now,
      turns: 0,
      pending: null,
      lastKnowledgeIds: [],
      lastReply: '',
      lastUserText: '',
      lastTopic: '',
    }
    conversationState.set(jid, state)
  }
  state.ts = now
  return state
}

// ---------------------------------------------------------------------------
// Compreensão do prompt do sistema ("o que fazer" vem de lá)
// ---------------------------------------------------------------------------

const INSTRUCTION_STARTERS = /^(?:seja|nunca|nao |jamais|sempre|responda|ignore|evite|use |utilize|mantenha|fale|aja|atenda|voce (?:e|deve)|caso nao|regras|restricoes|comportamento|importante|quando|escolha|apresente|envie|confirme|proibido|substitua|repita|reapresente|mostre|verifique|antes de|depois que|depois disso|somente|nunca (?:tente|invente|pressione|prometa)|essas? (?:perguntas|respostas))/

const TOPIC_KEYWORDS = {
  preco: ['preco'],
  horario: ['horario'],
  endereco: ['endereco'],
  entrega: ['entrega'],
  pagamento: ['pagamento'],
  telefone: ['telefone'],
}

function factTopic(tokens) {
  const set = new Set(tokens)
  for (const [topic, keys] of Object.entries(TOPIC_KEYWORDS)) {
    if (keys.some((k) => set.has(k))) return topic
  }
  return 'geral'
}

// Extrai fatos citáveis e comportamentos condicionais do prompt + informações
// do negócio. Fatos podem ser ditos ao cliente; instruções orientam o robô.
function parsePrompt(settings) {
  const facts = []
  const behaviors = []
  const sources = [
    { text: settings.business_info, quotable: true },
    { text: settings.system_prompt, quotable: false },
  ]
  for (const { text, quotable } of sources) {
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = rawLine.replace(/^[-•*•]+\s*|^\d+[.)]\s*/, '').trim()
      if (line.length < 8) continue
      const norm = normalizeText(line)

      // Comportamento condicional: "se o cliente pedir X, faça/diga Y"
      const conditional = norm.match(/^(?:se|quando) (?:o |a )?cliente (.{3,80}?)[,:] ?(.+)$/)
      if (conditional) {
        const sepIdx = line.search(/[,:]/)
        behaviors.push({
          triggerTokens: tokenize(conditional[1]),
          action: (sepIdx > -1 ? line.slice(sepIdx + 1) : conditional[2]).trim(),
          raw: line,
        })
        continue
      }

      if (INSTRUCTION_STARTERS.test(norm)) continue // regra de comportamento pura, não citável

      // Linha factual: tem números, preços, horários, ou veio das informações
      // do negócio. É o único material que a IA interna pode afirmar.
      //
      // A checagem por palavra-chave de tópico (abaixo) só vale para
      // informações do negócio (quotable=true), que são sempre factuais por
      // definição. Para linhas do prompt de comportamento (quotable=false),
      // usar os tokens já expandidos por sinônimo é perigoso: palavras comuns
      // de instrução como "quando" e "número" mapeiam para "horario" e
      // "telefone" (ver SYNONYMS), fazendo frases de regra (ex.: "Quando a
      // intenção estiver clara, não obrigue o cliente a responder com o
      // número.") passarem como se fossem um fato sobre horário/telefone e
      // serem citadas de volta ao cliente. Por isso, para o prompt exigimos
      // um sinal inequívoco (preço em R$ ou horário HH:MM) em vez de
      // depender de sinônimos.
      const looksFactual = quotable
        || /r\$\s?\d/.test(norm)
        || /\d{1,2}[:h]\d{0,2}/.test(norm)
      if (!looksFactual) continue

      const tokens = tokenize(line)
      if (tokens.length === 0) continue
      facts.push({ kind: 'fact', question: line, answer: line, tokens, topic: factTopic(tokens), confidence: 1 })
    }
  }
  return { facts, behaviors }
}

// Nome do atendente virtual definido no prompt: "Você é o Léo, ..."
function personaName(settings) {
  const match = String(settings.system_prompt || '').match(/voc[eê]\s+(?:e|é)\s+(?:o|a)\s+([A-ZÀ-Ü][a-zà-ü]+)/iu)
  const name = match?.[1]?.trim()
  if (!name || /atendente|assistente|robo|virtual|responsavel/i.test(normalizeText(name))) return null
  return name
}

// ---------------------------------------------------------------------------
// Recuperação — TF-IDF + cosseno sobre conhecimento aprovado + fatos do prompt
// ---------------------------------------------------------------------------

function buildCorpus(settings) {
  const entries = []
  for (const k of approvedKnowledge()) {
    // Diretrizes originadas do prompt orientam o motor pelo parsePrompt;
    // não devem ser recitadas literalmente para o cliente como se fossem fatos.
    if (k.source === 'prompt' && /^(?:diretriz|regras?|fluxo|comportamento|tom de voz|atendimento|dica|orientacao|instrucao|limite)\b/iu.test(k.question)) {
      continue
    }
    const tokens = tokenize(`${k.question} ${k.answer}`)
    if (tokens.length === 0) continue
    entries.push({
      kind: 'kb', id: k.id, question: k.question, answer: k.answer,
      tokens, confidence: Number(k.confidence ?? 0.8),
    })
  }
  const { facts, behaviors } = parsePrompt(settings)
  entries.push(...facts)
  return { entries, behaviors }
}

function termFrequencies(tokens) {
  const tf = new Map()
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
  return tf
}

function retrieve(userText, corpus, limit = 3) {
  const queryTokens = tokenize(userText)
  if (queryTokens.length === 0) return []
  const { entries } = corpus

  const df = new Map()
  for (const e of entries) {
    for (const t of new Set(e.tokens)) df.set(t, (df.get(t) || 0) + 1)
  }
  const n = Math.max(entries.length, 1)
  const idf = (t) => Math.log(1 + n / (df.get(t) || 0.5))

  const queryTf = termFrequencies(queryTokens)
  let queryNorm = 0
  for (const [t, f] of queryTf) queryNorm += (f * idf(t)) ** 2
  queryNorm = Math.sqrt(queryNorm) || 1

  const normQuery = normalizeText(userText)
  const scored = []
  for (const e of entries) {
    const entryTf = termFrequencies(e.tokens)
    let dot = 0
    let entryNorm = 0
    for (const [t, f] of entryTf) entryNorm += (f * idf(t)) ** 2
    entryNorm = Math.sqrt(entryNorm) || 1
    for (const [t, f] of queryTf) {
      if (entryTf.has(t)) dot += f * entryTf.get(t) * idf(t) ** 2
    }
    if (dot === 0) continue
    const cosine = dot / (queryNorm * entryNorm)
    const queryTerms = [...queryTf.keys()]
    const matchedTerms = queryTerms.filter((term) => entryTf.has(term)).length
    const queryCoverage = matchedTerms / Math.max(queryTerms.length, 1)
    let score = cosine * 0.7 + queryCoverage * 0.3
    const domainTerms = new Set(['treino', 'jogo', 'futebol', 'preco', 'horario', 'endereco', 'pagamento', 'entrega', 'telefone', 'agendar'])
    if (queryTerms.some((term) => domainTerms.has(term) && entryTf.has(term))) score += 0.12
    // Bônus quando a pergunta aprendida aparece quase literal na mensagem.
    const normQuestion = normalizeText(e.question)
    if (normQuestion.length > 10 && (normQuery.includes(normQuestion) || normQuestion.includes(normQuery))) score += 0.25
    // Confiança aprendida modula o resultado (feedback dos clientes).
    score *= 0.5 + Math.min(Math.max(e.confidence, 0), 1) / 2
    scored.push({ entry: e, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Intenções
// ---------------------------------------------------------------------------

const INTENTS = [
  { name: 'feedback_negativo', re: /(?:nao (?:era|e|foi) isso|resposta errada|informacao errada|(?:esta|ta) errado|nada a ver|nao respondeu|nao me ajudou|nao entendi sua resposta)/ },
  { name: 'saudacao', re: /^(?:oi+|ola+|opa|eai|e ai|hey|hello|alo|bom dia|boa tarde|boa noite|tudo bem\??|td bem\??)[\s!,.?]*$/ },
  { name: 'agradecimento', re: /^(?:muito )?(?:obrigad[oa]s?|obg|brigad[oa]o?|valeu+|vlw|show|perfeito|otimo|top|maravilha)[\s!,.?]*$/ },
  { name: 'despedida', re: /^(?:tchau+|ate (?:mais|logo|amanha)|falou|flw|adeus|boa noite pra voce|ate a proxima)[\s!,.?]*$/ },
  { name: 'quem_e_voce', re: /(?:quem (?:e|eh) voce|voce e (?:um )?robo|e um robo\??|falando com (?:um )?robo|(?:e|eh) humano|atendente de verdade|pessoa de verdade|maquina\??$)/ },
  { name: 'confirmar', re: /^(?:sim+|s|pode(?: ser| sim)?|confirmo|confirmado|ok+|okay|beleza|blz|isso(?: mesmo| ai)?|claro|com certeza|fechado|fechou|bora|vamos|aceito|quero(?: sim)?|uhum|aham|positivo|top|perfeito|show|dale|manda ver)[\s!,.?]*$/ },
  { name: 'negar', re: /^(?:nao+|n|melhor nao|deixa(?: pra la)?|cancela|nao precisa|nao quero|negativo|depois eu vejo|agora nao)[\s!,.?]*$/ },
  { name: 'cancelar_agendamento', re: /(?:cancelar|desmarcar|remover) (?:o |meu |a )?(?:horario|agendamento|reserva|consulta|atendimento)|quero cancelar|preciso desmarcar/ },
  { name: 'meus_agendamentos', re: /(?:meus? (?:horarios?|agendamentos?)|tenho (?:algum )?(?:horario|agendamento) marcado|o que (?:eu )?tenho marcado|quando (?:e|eh) meu horario)/ },
  { name: 'agendar', re: /(?:\b(?:agendar|marcar|remarcar|reservar|reagendar)\b|marca (?:um |uma )?(?:horario|hora)|quero (?:um )?horario|tem (?:horario|vaga|agenda|disponibilidade)|horarios? (?:livres?|disponiveis?|vagos?)|encaixe|agenda (?:de )?(?:hoje|amanha)|qual horario (?:tem|voce tem))/ },
]

function detectIntent(text) {
  const norm = normalizeText(text)
  for (const intent of INTENTS) {
    if (intent.re.test(norm)) return intent.name
  }
  return null
}

// ---------------------------------------------------------------------------
// Fluxo de cadastro definido pelo prompt + banco local de clientes
// ---------------------------------------------------------------------------

function cleanQuotedReply(value) {
  return String(value || '').trim().replace(/^[“"]|[”"]$/g, '').trim()
}

function findPromptSection(lines, pattern) {
  return lines.findIndex((line) => pattern.test(normalizeText(line)))
}

function promptSingleReply(lines, sectionPattern, triggerPattern, fallback) {
  const section = findPromptSection(lines, sectionPattern)
  if (section < 0) return fallback
  const trigger = lines.findIndex((line, index) => index > section && triggerPattern.test(normalizeText(line)))
  if (trigger < 0) return fallback
  const reply = lines.slice(trigger + 1).find((line) => line.trim())
  return cleanQuotedReply(reply) || fallback
}

function promptReplyBlock(lines, sectionPattern, triggerPattern, fallback) {
  const section = findPromptSection(lines, sectionPattern)
  if (section < 0) return fallback
  const trigger = lines.findIndex((line, index) => index > section && triggerPattern.test(normalizeText(line)))
  if (trigger < 0) return fallback
  const output = []
  for (const rawLine of lines.slice(trigger + 1)) {
    const line = rawLine.trim()
    const norm = normalizeText(line)
    if (output.length && /^(?:nao pergunte|e proibido|---|#{2,})/.test(norm)) break
    if (!line && output.length === 0) continue
    output.push(line)
  }
  while (output.at(-1) === '') output.pop()
  return output.join('\n').trim() || fallback
}

function customerRegistrationPolicy(settings) {
  const prompt = String(settings.system_prompt || '')
  const norm = normalizeText(prompt)
  const enabled = /consult(?:e|ar|a).*telefone.*banco/.test(norm)
    && /cadastro/.test(norm)
  if (!enabled) return { enabled: false, fields: [] }
  const lines = prompt.split(/\r?\n/)
  return {
    enabled: true,
    fields: parseCustomerExtraFields(settings),
    knownGreeting: promptSingleReply(
      lines,
      /telefone encontrado no banco/,
      /saudacao.*responda/,
      'Fala, jogador! Como posso ajudar?'
    ),
    newCustomerReply: promptReplyBlock(
      lines,
      /telefone nao encontrado no banco/,
      /envie imediatamente/,
      'Vamos fazer seu cadastro. Envie seu nome e os dados solicitados.'
    ),
  }
}

function registrationPhone(jid) {
  try {
    return normalizeCustomerPhone(String(jid || '').split('@')[0])
  } catch {
    return null
  }
}

function registrationValues(text, policy) {
  const values = { extras: {} }
  const extraLabels = new Map()
  for (const field of policy.fields) {
    extraLabels.set(normalizeText(field.label).replace(/[^a-z0-9]+/g, ' ').trim(), field.key)
    extraLabels.set(field.key.replace(/_/g, ' '), field.key)
  }
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const match = rawLine.trim().match(/^([^:]{2,80}):\s*(.+)$/u)
    if (!match) continue
    const label = normalizeText(match[1]).replace(/[^a-z0-9]+/g, ' ').trim()
    const value = match[2].trim()
    if (!value) continue
    if (/^(?:nome|nome completo|nome do jogador)$/.test(label)) values.fullName = value
    else if (/(?:telefone|celular|whatsapp)/.test(label)) values.phone = value
    else if (extraLabels.has(label)) values.extras[extraLabels.get(label)] = value
  }
  return values
}

function customerRegistrationReply(jid, userText, state, settings, intent) {
  const policy = customerRegistrationPolicy(settings)
  if (!policy.enabled) return null
  const customer = findCustomerByJid(jid)
  if (customer) {
    if (state.pending?.type === 'customer_registration') state.pending = null
    return intent === 'saudacao' ? policy.knownGreeting : null
  }

  const phone = registrationPhone(jid)
  if (!phone) return null
  const pending = state.pending?.type === 'customer_registration'
    ? state.pending
    : { type: 'customer_registration', fullName: '', extras: {} }
  state.pending = pending

  const received = registrationValues(userText, policy)
  if (received.fullName) pending.fullName = received.fullName
  Object.assign(pending.extras, received.extras)

  const nameParts = String(pending.fullName || '').trim().split(/\s+/).filter(Boolean)
  const missing = []
  if (String(pending.fullName || '').trim().length < 2) missing.push('Nome')
  for (const field of policy.fields) {
    if (!pending.extras[field.key]) missing.push(field.label)
  }

  const receivedSomething = Boolean(received.fullName || Object.keys(received.extras).length)
  if (missing.length > 0) {
    if (!receivedSomething) return policy.newCustomerReply
    return `Para concluir o cadastro, envie também: ${missing.join('; ')}.`
  }

  try {
    const customerCreated = createCustomer({
      firstName: nameParts[0],
      lastName: nameParts.slice(1).join(' '),
      phone,
      extras: pending.extras,
    })
    state.pending = null
    return `Cadastro confirmado, ${customerCreated.first_name}. Como posso ajudar?`
  } catch (err) {
    const existing = findCustomerByJid(jid)
    if (existing) {
      state.pending = null
      return policy.knownGreeting
    }
    return `Não consegui salvar o cadastro: ${err.message}`
  }
}

export function shouldPrioritizeInternalFlow(jid, userText, settings) {
  const policy = customerRegistrationPolicy(settings)
  if (!policy.enabled || !registrationPhone(jid)) return false
  const state = getState(jid)
  if (state.pending?.type === 'customer_registration') return true
  const customer = findCustomerByJid(jid)
  return !customer || detectIntent(userText) === 'saudacao'
}

// ---------------------------------------------------------------------------
// Datas e horários em português
// ---------------------------------------------------------------------------

const WEEKDAYS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']

function nowInSaoPaulo() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }))
}

function toISODate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function formatDateBr(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const weekday = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'][date.getDay()]
  return `${weekday}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`
}

export function parseDateBr(text, base = nowInSaoPaulo()) {
  const norm = normalizeText(text)
  const today = new Date(base.getFullYear(), base.getMonth(), base.getDate())

  if (/\bdepois de amanha\b/.test(norm)) return toISODate(new Date(today.getTime() + 2 * 86400000))
  if (/\bamanha\b/.test(norm)) return toISODate(new Date(today.getTime() + 86400000))
  if (/\bhoje\b/.test(norm)) return toISODate(today)

  const weekdayMatch = norm.match(/\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:[- ]feira)?\b/)
  if (weekdayMatch) {
    const target = WEEKDAYS.indexOf(weekdayMatch[1])
    let delta = (target - today.getDay() + 7) % 7
    if (delta === 0 && !/\b(?:hoje|nesta|essa)\b/.test(norm)) delta = 7
    return toISODate(new Date(today.getTime() + delta * 86400000))
  }

  const full = norm.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
  if (full) {
    const d = Number(full[1])
    const m = Number(full[2])
    let y = full[3] ? Number(full[3]) : today.getFullYear()
    if (y < 100) y += 2000
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      let candidate = new Date(y, m - 1, d)
      if (!full[3] && candidate < today) candidate = new Date(y + 1, m - 1, d)
      return toISODate(candidate)
    }
  }

  const dayOnly = norm.match(/\bdia (\d{1,2})\b/)
  if (dayOnly) {
    const d = Number(dayOnly[1])
    if (d >= 1 && d <= 31) {
      let candidate = new Date(today.getFullYear(), today.getMonth(), d)
      if (candidate < today) candidate = new Date(today.getFullYear(), today.getMonth() + 1, d)
      return toISODate(candidate)
    }
  }
  return null
}

export function parseTimeBr(text) {
  const norm = normalizeText(text)
  const match = norm.match(/\b(?:as |às |a partir das? )?(\d{1,2})(?:[:h](\d{2})?)?\s*(da manha|da tarde|da noite|hrs?|horas?)?\b/)
  if (!match) return null
  const hasTimeSignal = match[2] !== undefined || /[h:]/.test(match[0]) || match[3] || /\b(?:as|às)\s*\d/.test(norm)
  if (!hasTimeSignal) return null
  let hour = Number(match[1])
  const minute = Number(match[2] || 0)
  const period = match[3] || ''
  if ((period.includes('tarde') || period.includes('noite')) && hour < 12) hour += 12
  if (hour > 23 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

// Motivo do agendamento: "quero marcar um corte" → "corte"
function parseAppointmentTitle(text) {
  const norm = normalizeText(text)
  const match = norm.match(/(?:agendar|marcar|reservar)\s+(?:um[a]?\s+)?([a-z ]{3,40}?)(?:\s+(?:para|pra|no|na|dia|hoje|amanha|as|às|com)\b|[,.!?]|$)/)
  const title = match?.[1]?.trim()
  if (!title || /^(?:horario|hora|vaga|atendimento|agendamento)$/.test(title)) return null
  return title.charAt(0).toUpperCase() + title.slice(1)
}

// ---------------------------------------------------------------------------
// Humanização
// ---------------------------------------------------------------------------

function timeGreeting() {
  const hour = nowInSaoPaulo().getHours()
  if (hour >= 5 && hour < 12) return 'Bom dia'
  if (hour >= 12 && hour < 18) return 'Boa tarde'
  return 'Boa noite'
}

function customerFirstName(jid) {
  const name = String(contactNameForCalendar(jid) || '').trim()
  const first = name.split(/\s+/)[0] || ''
  if (!first || first.length < 2 || /\d/.test(first)) return null
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
}

const OPENERS = ['Claro! ', 'Com certeza! ', 'Boa pergunta! ', 'Deixa comigo 🙂 ', '']
const FOLLOWUPS = [
  ' Posso ajudar com mais alguma coisa?',
  ' Se precisar de mais alguma informação, é só chamar!',
  ' Qualquer outra dúvida, estou por aqui 🙂',
  '',
  '',
]

// Monta a resposta com toque humano: abertura variada, nome do cliente de vez
// em quando e fechamento leve — sem nunca repetir a mesma frase em sequência.
function humanize(core, { jid, state, withOpener = true, withFollowup = true }) {
  const seedBase = `${jid}:${state.turns}`
  let opener = withOpener ? pick(OPENERS, `${seedBase}:o`) : ''
  const name = customerFirstName(jid)
  if (opener.endsWith('! ') && name && hashCode(`${seedBase}:n`) % 3 === 0) {
    opener = opener.replace(/! $/, `, ${name}! `)
  }
  const followup = withFollowup && core.length < 400 ? pick(FOLLOWUPS, `${seedBase}:f`) : ''
  let reply = `${opener}${core}${followup}`.trim()
  if (reply === state.lastReply) reply = core.trim()
  return reply
}

// ---------------------------------------------------------------------------
// Fluxo de agendamento (usa o calendário inteligente de verdade)
// ---------------------------------------------------------------------------

function formatSlots(slots) {
  return slots.slice(0, 6).join(', ')
}

function scheduleReply(jid, text, state, settings) {
  const pending = state.pending?.type === 'schedule' ? state.pending : { type: 'schedule' }
  state.pending = pending

  const date = parseDateBr(text) || pending.date || null
  const time = parseTimeBr(text) || pending.time || null
  const title = parseAppointmentTitle(text) || pending.title || null
  pending.date = date
  pending.time = time
  pending.title = title

  if (!date) {
    return humanize(pick([
      'Para qual dia você gostaria de agendar? Pode dizer, por exemplo, "amanhã" ou "sexta-feira".',
      'Me diz o dia que fica melhor para você — pode ser "hoje", "amanhã" ou uma data como 25/07.',
    ], `${jid}:${state.turns}:sd`), { jid, state, withOpener: true, withFollowup: false })
  }

  let agenda
  try {
    agenda = getAvailableSlots(date, 60)
  } catch (err) {
    state.pending = null
    return `Não consegui consultar a agenda agora (${err.message}). Pode tentar novamente em instantes?`
  }

  if (!agenda.open) {
    pending.date = null
    return humanize(`Nesse dia (${formatDateBr(date)}) não temos atendimento. Quer tentar outro dia?`, { jid, state, withOpener: false, withFollowup: false })
  }
  const available = agenda.slots || []
  if (available.length === 0) {
    pending.date = null
    return humanize(`Para ${formatDateBr(date)} os horários já estão todos preenchidos 😕 Quer que eu veja outro dia?`, { jid, state, withOpener: false, withFollowup: false })
  }

  if (!time) {
    return humanize(
      `Para ${formatDateBr(date)} tenho estes horários livres: ${formatSlots(available)}. Qual fica melhor para você?`,
      { jid, state, withOpener: true, withFollowup: false }
    )
  }

  if (!available.includes(time)) {
    pending.time = null
    return humanize(
      `O horário das ${time} não está disponível em ${formatDateBr(date)}. Os horários livres são: ${formatSlots(available)}. Algum deles serve?`,
      { jid, state, withOpener: false, withFollowup: false }
    )
  }

  pending.awaitingConfirm = true
  return humanize(
    `Perfeito! Posso confirmar seu agendamento${title ? ` de ${title.toLowerCase()}` : ''} para ${formatDateBr(date)} às ${time}?`,
    { jid, state, withOpener: false, withFollowup: false }
  )
}

function confirmSchedule(jid, state) {
  const pending = state.pending
  state.pending = null
  try {
    const appointment = createAppointment({
      date: pending.date,
      time: pending.time,
      title: pending.title || 'Atendimento',
      jid,
      customerName: contactNameForCalendar(jid),
      duration: 60,
    }, { source: 'ai' })
    const confirmedDate = appointment.start_at.slice(0, 10)
    const confirmedTime = appointment.start_at.slice(11, 16)
    const name = customerFirstName(jid)
    return pick([
      `Prontinho${name ? `, ${name}` : ''}! ✅ Seu horário está confirmado para ${formatDateBr(confirmedDate)} às ${confirmedTime}. Te esperamos!`,
      `Agendamento confirmado ✅ ${formatDateBr(confirmedDate)} às ${confirmedTime}. Qualquer imprevisto, é só me avisar por aqui!`,
    ], `${jid}:${state.turns}:cf`)
  } catch (err) {
    return `Não consegui registrar o agendamento (${err.message}). Podemos tentar outro horário?`
  }
}

function listAppointmentsReply(jid, state) {
  const appointments = customerAppointments(jid).filter((a) => a.status === 'scheduled')
  if (appointments.length === 0) {
    return humanize('Você não tem nenhum horário marcado no momento. Quer agendar um?', { jid, state, withOpener: false, withFollowup: false })
  }
  const lines = appointments.map((a) => `• ${formatDateBr(a.date)} às ${a.time}${a.title ? ` — ${a.title}` : ''}`)
  return `Encontrei ${appointments.length === 1 ? 'este agendamento' : 'estes agendamentos'} no seu nome:\n${lines.join('\n')}`
}

function cancelReply(jid, text, state) {
  const appointments = customerAppointments(jid).filter((a) => a.status === 'scheduled')
  if (appointments.length === 0) {
    return humanize('Não encontrei nenhum agendamento ativo no seu número. Se quiser, posso marcar um novo horário!', { jid, state, withOpener: false, withFollowup: false })
  }
  const date = parseDateBr(text)
  const time = parseTimeBr(text)
  let target = appointments.length === 1 ? appointments[0] : null
  if (!target && date) target = appointments.find((a) => a.date === date && (!time || a.time === time)) || null
  if (!target) {
    const lines = appointments.map((a) => `• ${formatDateBr(a.date)} às ${a.time}${a.title ? ` — ${a.title}` : ''}`)
    return `Você tem mais de um agendamento:\n${lines.join('\n')}\nQual deles quer cancelar? Me diga o dia e o horário.`
  }
  state.pending = { type: 'cancel', id: target.id, label: `${formatDateBr(target.date)} às ${target.time}`, awaitingConfirm: true }
  return `Só para confirmar: quer cancelar o agendamento de ${state.pending.label}?`
}

function confirmCancel(jid, state) {
  const pending = state.pending
  state.pending = null
  try {
    changeAppointment(pending.id, { status: 'cancelled' }, { jidScope: jid, source: 'ai' })
    return pick([
      `Feito! O agendamento de ${pending.label} foi cancelado. Quando quiser remarcar, é só me chamar 🙂`,
      `Cancelado ✅ (${pending.label}). Espero te ver em uma próxima oportunidade!`,
    ], `${jid}:${state.turns}:cc`)
  } catch (err) {
    return `Não consegui cancelar (${err.message}). Pode tentar de novo, por favor?`
  }
}

// ---------------------------------------------------------------------------
// Resposta principal
// ---------------------------------------------------------------------------

const CONFIDENCE_DIRECT = 0.28
const CONFIDENCE_HEDGED = 0.16

function contextualScheduleAnswer(fact, userText) {
  const query = normalizeText(userText)
  const answer = normalizeText(fact)
  if (!/\b(?:treino|treinamento|futebol|jogo|partida)\b/.test(query)) return null
  const relativeDay = /\bamanha\b/.test(query) ? 1 : /\bhoje\b/.test(query) ? 0 : null
  if (relativeDay === null) return null

  const mentionedDays = WEEKDAYS
    .map((day, index) => ({ day, index }))
    .filter(({ day }) => new RegExp(`\\b${day}(?:-feira)?s?\\b`).test(answer))
    .map(({ index }) => index)
  if (mentionedDays.length === 0) return null

  const today = nowInSaoPaulo().getDay()
  const target = (today + relativeDay) % 7
  const label = relativeDay === 0 ? 'hoje' : 'amanhã'
  return mentionedDays.includes(target)
    ? `Sim, há treino ${label}. ${fact}`
    : `Não há treino ${label}, conforme os dias cadastrados. ${fact}`
}

function answerFromEntry(entry, { userText }) {
  // Conhecimento aprendido tem resposta própria; fatos do prompt são citados
  // com um conector natural — a IA interna nunca inventa dados.
  const fact = entry.answer.trim()
  const scheduleAnswer = contextualScheduleAnswer(fact, userText)
  if (scheduleAnswer) return scheduleAnswer
  if (entry.kind === 'kb') return fact
  const prefix = {
    preco: 'Sobre valores: ',
    horario: 'Sobre nosso horário: ',
    endereco: 'Nosso endereço: ',
    entrega: 'Sobre entrega: ',
    pagamento: 'Sobre pagamento: ',
    telefone: 'Nosso contato: ',
    geral: '',
  }[entry.topic || 'geral']
  return `${prefix}${fact}`
}

function fallbackReply(jid, state, settings, userText) {
  const norm = normalizeText(userText)
  if (/\b(?:treino|treinamento|futebol|jogo|partida)\b/.test(norm)) {
    return 'Os dias e horários dos treinos ainda não estão cadastrados.'
  }
  if (state.lastTopic) {
    return `Quero entender direitinho: sua dúvida ainda é sobre ${state.lastTopic} ou você quer tratar de outro assunto?`
  }
  return 'Pode me contar um pouco mais do que você precisa? Se preferir, diga o assunto em uma frase curta.'
}

function contextualQuery(userText, state) {
  const clean = String(userText || '').trim()
  const tokens = tokenize(clean)
  const dependsOnContext = tokens.length === 0
    || /^(?:nesse caso|qual deles|como assim|e esse|e essa|e isso|por que|porque)\b/iu.test(clean)
  return dependsOnContext && state.lastUserText
    ? `${state.lastUserText}. Continuação do cliente: ${clean}`
    : clean
}

function shouldCombineAnswers(userText) {
  const normalized = normalizeText(userText)
  return (normalized.match(/\?/g) || []).length > 1
    || /\b(?:e tambem|e também|alem disso|além disso| e (?:o|a|os|as|sobre|quanto))\b/.test(normalized)
}

function empatheticPrefix(userText) {
  const normalized = normalizeText(userText)
  if (/\b(?:urgente|emergencia|emergência|socorro|agora)\b/.test(normalized)) {
    return 'Entendi que é urgente. '
  }
  if (/\b(?:chatead|decepcionad|irritad|absurdo|reclam|problema|nao funciona|não funciona)\b/.test(normalized)) {
    return 'Sinto muito por essa situação. '
  }
  return ''
}

/**
 * Gera a resposta da IA interna para uma mensagem do cliente.
 * Mesma assinatura de uso do provedor externo: retorna texto ou null.
 */
export async function generateInternalReply(jid, userText, settings) {
  const state = getState(jid)
  state.turns++

  // Prompts que definem um menu numerado obrigatório ("Escolha uma opção:")
  // são conduzidos por esse motor de estados, sem passar pela busca por
  // palavra-chave/intenção abaixo — o cliente só avança escolhendo opções.
  if (hasMenuFlow(settings)) {
    const menuReply = menuFlowReply(jid, userText, settings, state)
    if (menuReply) {
      const reply = String(menuReply).slice(0, 3500)
      state.lastReply = reply
      state.lastUserText = String(userText || '').trim().slice(0, 500)
      return reply
    }
    if (state.menu?.screen === 'TRANSFERINDO') return null
  }

  const corpus = buildCorpus(settings)
  const intent = detectIntent(userText)
  const businessName = settings.business_name?.trim() || 'nossa empresa'
  const seed = `${jid}:${state.turns}`

  let reply = null

  // O cadastro obrigatório do prompt tem precedência sobre saudações,
  // respostas prontas e fallbacks genéricos.
  reply = customerRegistrationReply(jid, userText, state, settings, intent)
  if (reply) {
    reply = String(reply).slice(0, 3500)
    state.lastReply = reply
    return reply
  }

  // Confirmações de fluxos pendentes têm prioridade (agendar/cancelar).
  if (state.pending?.awaitingConfirm && intent === 'confirmar') {
    reply = state.pending.type === 'cancel' ? confirmCancel(jid, state) : confirmSchedule(jid, state)
  } else if (state.pending?.awaitingConfirm && intent === 'negar') {
    const wasCancel = state.pending.type === 'cancel'
    state.pending = null
    reply = wasCancel
      ? 'Sem problemas, mantive seu agendamento como estava 🙂'
      : pick(['Tudo bem! Se quiser, posso ver outro dia ou horário para você.', 'Sem problemas! Me avisa se quiser tentar outro horário.'], `${seed}:ng`)
  } else if (intent === 'feedback_negativo') {
    // Cliente sinalizou que a última resposta não ajudou: a IA interna
    // aprende reduzindo a confiança do conhecimento usado.
    for (const id of state.lastKnowledgeIds) adjustKnowledgeConfidence(id, -0.2)
    state.lastKnowledgeIds = []
    reply = pick([
      'Me desculpe, entendi errado! 🙏 Vou verificar essa informação com a equipe e já te retorno, tudo bem?',
      'Perdão pela confusão! Vou confirmar direitinho com o pessoal e te respondo em seguida.',
    ], `${seed}:neg`)
  } else if (intent === 'saudacao') {
    const name = customerFirstName(jid)
    reply = pick([
      `${timeGreeting()}${name ? `, ${name}` : ''}! 😊 Bem-vindo(a) ao atendimento da ${businessName}. Como posso ajudar?`,
      `${timeGreeting()}${name ? `, ${name}` : ''}! Que bom te ver por aqui. Em que posso ajudar hoje?`,
      `Olá${name ? `, ${name}` : ''}! ${timeGreeting()} 🙂 Como posso te ajudar?`,
    ], seed)
  } else if (intent === 'agradecimento') {
    for (const id of state.lastKnowledgeIds) adjustKnowledgeConfidence(id, 0.05)
    reply = pick([
      'Imagina, é um prazer ajudar! 😊 Precisa de mais alguma coisa?',
      'Por nada! Qualquer coisa é só chamar 🙂',
      'Nós que agradecemos! Se surgir mais alguma dúvida, estou por aqui.',
    ], seed)
  } else if (intent === 'despedida') {
    reply = pick([
      `Até mais! 👋 A ${businessName} agradece o contato.`,
      'Tchau, tchau! Qualquer coisa, é só mandar mensagem 🙂',
      'Até a próxima! Tenha um ótimo dia 😊',
    ], seed)
  } else if (intent === 'quem_e_voce') {
    const persona = personaName(settings)
    reply = persona
      ? `Eu sou ${persona}, o assistente virtual da ${businessName} 🤖 Estou aqui para tirar dúvidas e agilizar seu atendimento — e, quando precisar, chamo um atendente humano para você.`
      : `Eu sou o assistente virtual da ${businessName} 🤖 Respondo suas dúvidas na hora e, se precisar, encaminho você para um atendente humano.`
  } else if (intent === 'cancelar_agendamento') {
    reply = cancelReply(jid, userText, state)
  } else if (intent === 'meus_agendamentos') {
    reply = listAppointmentsReply(jid, state)
  } else if (intent === 'agendar' || (state.pending?.type === 'schedule' && !state.pending.awaitingConfirm)) {
    reply = scheduleReply(jid, userText, state, settings)
  } else {
    // Comportamentos condicionais do prompt: "se o cliente pedir X, faça Y".
    const behavior = corpus.behaviors.find((b) => {
      if (b.triggerTokens.length === 0) return false
      const queryTokens = new Set(tokenize(userText))
      const hits = b.triggerTokens.filter((t) => queryTokens.has(t)).length
      return hits >= Math.max(1, Math.ceil(b.triggerTokens.length * 0.6))
    })
    if (behavior) {
      reply = humanize(behavior.action, { jid, state, withOpener: true, withFollowup: true })
    } else {
      const query = contextualQuery(userText, state)
      const results = retrieve(query, corpus)
      const best = results[0]
      state.lastKnowledgeIds = []
      if (best && best.score >= CONFIDENCE_DIRECT) {
        const selected = [best]
        if (shouldCombineAnswers(userText)) {
          const second = results.find((candidate) => candidate.entry.answer !== best.entry.answer
            && candidate.score >= Math.max(CONFIDENCE_DIRECT, best.score * 0.72))
          if (second) selected.push(second)
        }
        reply = selected.length === 1
          ? answerFromEntry(best.entry, { userText })
          : selected.map((result) => `• ${answerFromEntry(result.entry, { userText })}`).join('\n')
        state.lastKnowledgeIds = selected
          .filter((result) => result.entry.kind === 'kb')
          .map((result) => result.entry.id)
        if (state.lastKnowledgeIds.length) {
          bumpKnowledgeUsage(state.lastKnowledgeIds)
        }
      } else if (best && best.score >= CONFIDENCE_HEDGED) {
        const core = answerFromEntry(best.entry, { userText })
        reply = `Pelo que está cadastrado: ${core}`
        if (best.entry.kind === 'kb') {
          state.lastKnowledgeIds = [best.entry.id]
          bumpKnowledgeUsage([best.entry.id])
        }
      } else {
        reply = fallbackReply(jid, state, settings, userText)
      }
    }
  }

  if (reply) {
    const empathy = empatheticPrefix(userText)
    if (empathy && !reply.startsWith(empathy)) reply = `${empathy}${reply.charAt(0).toLowerCase()}${reply.slice(1)}`
    reply = String(reply).slice(0, 3500)
    state.lastReply = reply
    state.lastUserText = String(userText || '').trim().slice(0, 500)
    const topicTokens = tokenize(userText).filter((token) => !['agendar'].includes(token))
    if (topicTokens.length) state.lastTopic = topicTokens.slice(0, 3).join(' ')
  }
  return reply || null
}

// ---------------------------------------------------------------------------
// Aprendizado com os atendimentos
// ---------------------------------------------------------------------------

function normalizeQ(q) {
  return normalizeText(q).replace(/[^a-z0-9 ]/g, '').trim()
}

const QUESTION_STARTERS = /^(?:qual|quais|quanto|quanta|como|onde|quando|quem|que |tem |teria |voces|vcs|pode|posso|aceita|faz |fazem|vende|trabalha|atende|entrega|existe|sera que)/

function looksLikeQuestion(text) {
  const norm = normalizeText(text)
  if (norm.length < 8) return false
  return norm.includes('?') || QUESTION_STARTERS.test(norm)
}

function usefulAnswer(text) {
  const norm = normalizeText(text)
  if (norm.length < 8) return false
  if (/^(?:oi|ola|bom dia|boa tarde|boa noite|sim|nao|ok|obrigad)/.test(norm)) return false
  return true
}

function knowledgeStatus(settings) {
  return settings.internal_learning_autoapprove === 'true' ? 'approved' : 'pending'
}

/**
 * Aprendizado em tempo real: quando um atendente humano responde pelo painel,
 * a pergunta do cliente + resposta do atendente viram conhecimento da IA.
 */
export function learnFromHumanReply({ jid, answerText, settings }) {
  if (!usefulAnswer(answerText)) return null
  const recent = getMessages(jid, 10)
  const question = [...recent].reverse().find((m) => m.direction === 'in' && looksLikeQuestion(m.text))?.text
  if (!question) return null

  const existing = new Set(listKnowledge().map((k) => normalizeQ(k.question)))
  if (existing.has(normalizeQ(question))) return null

  createKnowledge({
    question: question.trim(),
    answer: answerText.trim(),
    source: 'atendimento',
    status: knowledgeStatus(settings),
  })
  bus.emit('knowledge_update', { added: 1 })
  return { question: question.trim(), answer: answerText.trim() }
}

/**
 * Extração heurística de pares P/R de transcrições — usada pelo agendador de
 * aprendizado quando o provedor é a IA interna (sem custo de API, sem LLM).
 * Aprende apenas com respostas de humanos, nunca com as da própria IA.
 */
export function extractQAHeuristic(rows) {
  const byJid = new Map()
  for (const m of rows) {
    if (!byJid.has(m.jid)) byJid.set(m.jid, [])
    byJid.get(m.jid).push(m)
  }
  const entries = []
  for (const [, msgs] of byJid) {
    for (let i = 0; i < msgs.length; i++) {
      const q = msgs[i]
      if (q.direction !== 'in' || !looksLikeQuestion(q.text)) continue
      for (let j = i + 1; j < Math.min(i + 3, msgs.length); j++) {
        const a = msgs[j]
        if (a.direction !== 'out') continue
        if (!['human', 'manual'].includes(a.source)) break
        if (!usefulAnswer(a.text)) break
        entries.push({ question: q.text.trim(), answer: a.text.trim(), confidence: 0.7 })
        break
      }
    }
  }
  return entries
}
