import { changeAppointment, contactNameForCalendar, createAppointment, customerAppointments, getAvailableSlots } from './calendar.js'
import { findCustomerByJid } from './customers.js'
import { setContactPaused } from './db.js'
import { normalizeText, parseDateBr, parseTimeBr, formatDateBr } from './ai-interna.js'

// ============================================================================
// MOTOR DE MENU GUIADO — lê o prompt de comportamento como uma árvore de
// telas (menus numerados entre aspas “…”) e conduz a conversa por elas, sem
// depender de um LLM. Só entra em ação quando o prompt define uma tela de
// "início obrigatório" com opções numeradas; caso contrário, ai-interna.js
// segue usando a busca por palavra-chave/intenção normal.
//
// Toda função de tela recebe (flow, state, jid, text) na mesma ordem, mesmo
// quando não usa todos os parâmetros — evita bugs de "esqueci de passar o
// jid" no meio da cadeia de telas.
// ============================================================================

const CONFIRM_WORDS = /^(?:1|ok+|s|sim+|ss|confirmo|confirmado|pode confirmar|pode marcar|fechou|blz|beleza)$/

const SECTION_PATTERNS = {
  mainMenu: /inicio obrigatorio/,
  interpretation: /interpretacao do menu principal/,
  services: /menu de servicos e valores/,
  bookingStart: /inicio do agendamento/,
  dateScreen: /escolha da data/,
  periodScreen: /escolha do periodo/,
  timeScreen: /escolha do horario/,
  barberScreen: /escolha do barbeiro/,
  registration: /cadastro do cliente/,
  confirmScreen: /confirmacao final do agendamento/,
  confirmedScreen: /^agendamento confirmado$/,
  alterScreen: /alteracao de agendamento/,
  cancelScreen: /cancelamento de agendamento/,
  addressScreen: /endereco e funcionamento/,
  handoffScreen: /transferencia para atendimento humano/,
  ambiguous: /mensagens ambiguas/,
}

const PERIOD_RANGES = { madrugada: [0, 6], manha: [6, 12], tarde: [12, 18], noite: [18, 24] }

// Mapeamento por posição/número: respaldo para quando a frase de ação do
// item não repete uma palavra-chave óbvia (ver parseMainMenuRouting).
const NUMBER_TARGETS = { 1: 'booking', 2: 'services', 3: 'alter', 4: 'cancel', 5: 'address', 6: 'handoff' }
const FALLBACK_TARGETS = ['booking', 'services', 'alter', 'cancel', 'address', 'handoff']

// ---------------------------------------------------------------------------
// Extração: prompt em texto livre -> seções -> blocos entre aspas -> opções
// ---------------------------------------------------------------------------

function isHeaderLine(line) {
  const t = line.trim()
  if (t.length < 4 || t.length > 90) return false
  if (/^[-•*\d“"]/.test(t)) return false
  const letters = t.replace(/[^a-zA-ZÀ-ÿ]/g, '')
  if (letters.length < 4) return false
  return t === t.toUpperCase() && /[A-ZÀ-Ý]/.test(t)
}

function splitSections(promptText) {
  const lines = String(promptText || '').split(/\r?\n/)
  const sections = []
  let current = { header: '', lines: [] }
  for (const line of lines) {
    if (isHeaderLine(line)) {
      if (current.header || current.lines.some((l) => l.trim())) sections.push(current)
      current = { header: line.trim(), lines: [] }
    } else {
      current.lines.push(line)
    }
  }
  if (current.header || current.lines.some((l) => l.trim())) sections.push(current)
  return sections.map((s) => ({ header: s.header, headerNorm: normalizeText(s.header), body: s.lines.join('\n') }))
}

// Alguns prompts citam, entre aspas, exemplos do que NUNCA enviar (ex.:
// "Nunca envie: 'Qual horário você deseja?'") ou citam um número de opção
// no meio de uma frase (ex.: 'Se o cliente escolher "3", envie:'). Esses
// blocos não são telas de verdade — se entrassem na extração, o motor
// acabaria mandando ao cliente exatamente a pergunta solta que o prompt
// pediu para nunca mandar. Por isso são descartados aqui, na origem, em vez
// de cada tela ter que se proteger individualmente.
const FORBIDDEN_EXAMPLE_CONTEXT = /nunca (?:envie|diga|pergunte|escreva)|nao (?:pergunte|envie|diga|escreva)/

function extractQuotedBlocks(body) {
  const blocks = []
  const re = /[“"]([\s\S]*?)[”"]/g
  let match
  while ((match = re.exec(body))) {
    const text = match[1].trim()
    if (!text) continue
    if (/^\d{1,2}$/.test(text)) continue
    const before = normalizeText(body.slice(Math.max(0, match.index - 60), match.index))
    if (FORBIDDEN_EXAMPLE_CONTEXT.test(before)) continue
    blocks.push(text)
  }
  return blocks
}

function parseOptions(blockText) {
  const options = []
  const re = /^\s*(\d{1,2})[.)]\s+(.+)$/gm
  let match
  while ((match = re.exec(blockText))) {
    options.push({ number: Number(match[1]), label: match[2].trim() })
  }
  return options
}

function findSection(sections, re) {
  return sections.find((s) => re.test(s.headerNorm))
}

function allQuotedMenus(section) {
  if (!section) return []
  return extractQuotedBlocks(section.body).map((text) => ({ text, options: parseOptions(text) }))
}

function firstQuotedMenu(section, { withOptions = true } = {}) {
  if (!section) return null
  for (const menu of allQuotedMenus(section)) {
    if (!withOptions || menu.options.length > 0) return menu
  }
  return null
}

function renderTemplate(text, values) {
  return text.replace(/\[([^\]]{1,40})\]/g, (full, key) => {
    const k = normalizeText(key)
    for (const [vk, vv] of Object.entries(values)) {
      if (normalizeText(vk) === k && vv != null) return String(vv)
    }
    return full
  })
}

function buildFlow(settings) {
  const sections = splitSections(settings.system_prompt)
  const byKey = {}
  for (const [key, re] of Object.entries(SECTION_PATTERNS)) byKey[key] = findSection(sections, re)
  const mainMenu = firstQuotedMenu(byKey.mainMenu)
  if (!mainMenu || mainMenu.options.length < 2) return null
  return { sections: byKey, mainMenu }
}

export function hasMenuFlow(settings) {
  return Boolean(buildFlow(settings))
}

// ---------------------------------------------------------------------------
// Roteamento do menu principal a partir de "INTERPRETAÇÃO DO MENU PRINCIPAL"
// ---------------------------------------------------------------------------

function parseMainMenuRouting(flow) {
  const routes = []
  const section = flow.sections.interpretation
  if (section) {
    const bulletRe = /[-•]\s*((?:[“"][^”"]+[”"]\s*,?\s*)+)ou equivalente:\s*\n?\s*([^\n]+)/gi
    let match
    while ((match = bulletRe.exec(section.body))) {
      const aliases = [...match[1].matchAll(/[“"]([^”"]+)[”"]/g)].map((mm) => normalizeText(mm[1]))
      const action = normalizeText(match[2])
      let target = null
      if (/agendament/.test(action)) target = 'booking'
      else if (/servi[cç]o/.test(action)) target = 'services'
      else if (/alterac/.test(action)) target = 'alter'
      else if (/cancelament/.test(action)) target = 'cancel'
      else if (/endereco/.test(action)) target = 'address'
      else if (/humano/.test(action)) target = 'handoff'
      if (!target) {
        // A frase da ação nem sempre repete uma palavra-chave óbvia (ex.:
        // "apresentar as informações cadastradas" para o item de endereço).
        // Nesse caso, usa o número do item como respaldo — o prompt garante
        // explicitamente que a ordem das 6 opções do menu principal é fixa.
        const numAlias = aliases.find((a) => /^\d{1,2}$/.test(a))
        if (numAlias) target = NUMBER_TARGETS[Number(numAlias)] || null
      }
      if (target) routes.push({ aliases, target })
    }
  }
  if (flow.mainMenu) {
    flow.mainMenu.options.forEach((o, idx) => {
      const num = String(o.number)
      if (!routes.some((r) => r.aliases.includes(num))) {
        routes.push({ aliases: [num, normalizeText(o.label)], target: NUMBER_TARGETS[o.number] || FALLBACK_TARGETS[idx] || null })
      }
    })
  }
  return routes.filter((r) => r.target)
}

// Casamento tolerante a abreviação ("ond" ~ "onde") e variação de forma
// verbal/nominal em português ("cancelar" ~ "cancelamento"): aceita quando
// uma palavra é prefixo inteiro da outra, ou quando compartilham um prefixo
// longo o bastante em relação ao tamanho da maior palavra.
function commonPrefixLen(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

function wordsFuzzyMatch(a, b) {
  if (a === b) return true
  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  if (shorter.length < 3) return false
  if (longer.startsWith(shorter)) return true
  const cp = commonPrefixLen(a, b)
  return cp >= 4 && cp / longer.length >= 0.55
}

function fuzzyPhraseIncludes(haystackWords, needlePhrase) {
  const needleWords = needlePhrase.split(' ').filter(Boolean)
  if (needleWords.length === 0) return false
  return needleWords.every((nw) => haystackWords.some((hw) => wordsFuzzyMatch(hw, nw)))
}

function matchMainMenuRoute(text, routes) {
  const norm = normalizeText(text)
  if (/^\d{1,2}$/.test(norm)) {
    const byNumber = routes.find((r) => r.aliases.includes(norm))
    if (byNumber) return byNumber.target
  }
  const textWords = norm.split(' ').filter(Boolean)
  const exact = routes
    .filter((r) => r.aliases.some((a) => a.length > 1 && !/^\d+$/.test(a) && norm.includes(a)))
    .sort((a, b) => Math.max(...b.aliases.map((x) => x.length)) - Math.max(...a.aliases.map((x) => x.length)))[0]
  if (exact) return exact.target
  const fuzzy = routes
    .filter((r) => r.aliases.some((a) => a.length > 1 && !/^\d+$/.test(a) && fuzzyPhraseIncludes(textWords, a)))
    .sort((a, b) => Math.max(...b.aliases.map((x) => x.length)) - Math.max(...a.aliases.map((x) => x.length)))[0]
  return fuzzy ? fuzzy.target : null
}

// ---------------------------------------------------------------------------
// Utilitários de tela
// ---------------------------------------------------------------------------

function goto(state, screen, text) {
  state.menu.screen = screen
  state.menu.lastText = text
  return text
}

function resetBooking(state) {
  state.menu.data = {}
}

function ambiguous(flow, state) {
  const block = firstQuotedMenu(flow.sections.ambiguous, { withOptions: false })
  const body = state.menu.lastText || (flow.mainMenu ? flow.mainMenu.text : '')
  if (block && /\[repetir[^\]]*\]/i.test(block.text)) return block.text.replace(/\[repetir[^\]]*\]/i, body)
  return `Não consegui identificar sua escolha.\n\nResponda com o número de uma das opções abaixo:\n\n${body}`
}

function matchOption(text, options) {
  const norm = normalizeText(text)
  if (/^\d{1,2}$/.test(norm)) {
    const n = Number(norm)
    return options.find((o) => o.number === n) || null
  }
  const textWords = norm.split(' ').filter(Boolean)
  const candidates = options
    .map((o) => ({ o, label: normalizeText(o.label).replace(/[—–-].*$/, '').trim() }))
    .filter(({ label }) => label.length > 1 && (norm.includes(label) || label.includes(norm) || fuzzyPhraseIncludes(textWords, label)))
    .sort((a, b) => b.label.length - a.label.length)
  return candidates[0]?.o || null
}

function renderMainMenu(flow, state) {
  resetBooking(state)
  return goto(state, 'MENU_PRINCIPAL', flow.mainMenu.text)
}

// ---------------------------------------------------------------------------
// Catálogo de serviços — lido diretamente das opções do prompt (com preço)
// ---------------------------------------------------------------------------

function parseServiceCatalog(flow) {
  const menu = firstQuotedMenu(flow.sections.services) || firstQuotedMenu(flow.sections.bookingStart)
  if (!menu) return { text: null, options: [] }
  const options = menu.options.map((o) => {
    const m = o.label.match(/^(.*?)\s*[—–-]\s*(R\$\s?[\d.,]+)\s*$/)
    return m
      ? { number: o.number, name: m[1].trim(), price: m[2].trim(), label: o.label, isNav: false }
      : { number: o.number, name: o.label, price: null, label: o.label, isNav: /voltar/i.test(o.label) }
  })
  return { text: menu.text, options }
}

// ---------------------------------------------------------------------------
// Menu principal
// ---------------------------------------------------------------------------

function handleMainMenu(flow, state, jid, text) {
  const routes = parseMainMenuRouting(flow)
  const target = matchMainMenuRoute(text, routes)
  if (target === 'booking') return startBooking(flow, state, jid)
  if (target === 'services') return showServicesInfo(flow, state, jid)
  if (target === 'alter') return startAlter(flow, state, jid)
  if (target === 'cancel') return startCancel(flow, state, jid)
  if (target === 'address') return showAddress(flow, state, jid)
  if (target === 'handoff') return showHandoffReasons(flow, state, jid)
  const combined = tryCombinedBooking(flow, state, jid, text)
  if (combined) return combined
  return ambiguous(flow, state)
}

function tryCombinedBooking(flow, state, jid, text) {
  const norm = normalizeText(text)
  const date = parseDateBr(text)
  const time = parseTimeBr(text)
  const looksLikeBooking = /\b(agend|marca|corte|horario)\b/.test(norm) || date || time
  if (!looksLikeBooking) return null
  const catalog = parseServiceCatalog(flow)
  const serviceMatch = catalog.options.find(
    (o) => !o.isNav && normalizeText(o.name).split(' ').some((w) => w.length > 3 && norm.includes(w))
  )
  state.menu.data.serviceOrigin = 'booking'
  if (serviceMatch) {
    state.menu.data.serviceName = serviceMatch.name
    state.menu.data.servicePrice = serviceMatch.price || 'a combinar'
  }
  if (date) state.menu.data.date = date
  if (time) state.menu.data.hintedTime = time
  if (/qualquer/.test(norm)) state.menu.data.barber = null
  const periodKey = Object.keys(PERIOD_RANGES).find((k) => norm.includes(k))
  if (periodKey && !time) state.menu.data.period = periodKey
  if (!state.menu.data.serviceName) return startBooking(flow, state, jid)
  if (!state.menu.data.date) return startDateStep(flow, state, jid)
  if (state.menu.data.hintedTime) return startTimeStep(flow, state, jid)
  if (state.menu.data.period) return startTimeStep(flow, state, jid)
  return startPeriodStep(flow, state, jid)
}

// ---------------------------------------------------------------------------
// Serviços
// ---------------------------------------------------------------------------

function showServicesInfo(flow, state) {
  const catalog = parseServiceCatalog(flow)
  if (!catalog.text) return ambiguous(flow, state)
  state.menu.data.serviceOrigin = 'info'
  return goto(state, 'ESCOLHENDO_SERVICO', catalog.text)
}

function startBooking(flow, state) {
  const catalog = parseServiceCatalog(flow)
  if (!catalog.text) return ambiguous(flow, state)
  state.menu.data.serviceOrigin = 'booking'
  return goto(state, 'ESCOLHENDO_SERVICO', catalog.text)
}

function handleServiceChoice(flow, state, jid, text) {
  const catalog = parseServiceCatalog(flow)
  if (!catalog.text) return ambiguous(flow, state)
  const norm = normalizeText(text)
  let picked = null
  if (/^\d{1,2}$/.test(norm)) picked = catalog.options.find((o) => o.number === Number(norm)) || null
  else {
    picked = catalog.options
      .filter((o) => !o.isNav && normalizeText(o.name).length > 2 && norm.includes(normalizeText(o.name).split(' ')[0]))
      .sort((a, b) => normalizeText(b.name).length - normalizeText(a.name).length)[0] || null
  }
  if (!picked) return ambiguous(flow, state)
  if (picked.isNav) return renderMainMenu(flow, state)
  state.menu.data.serviceName = picked.name
  state.menu.data.servicePrice = picked.price || 'a combinar'
  if (state.menu.data.serviceOrigin === 'info') return showServiceInfoConfirm(flow, state)
  return startDateStep(flow, state, jid)
}

function showServiceInfoConfirm(flow, state) {
  const block = allQuotedMenus(flow.sections.services)[1]
  const text = block
    ? renderTemplate(block.text, { servico: state.menu.data.serviceName, valor: state.menu.data.servicePrice, duracao: '60 minutos (aprox.)' })
    : [
        `Você escolheu: ${state.menu.data.serviceName}`,
        `Valor: ${state.menu.data.servicePrice}`,
        '',
        'Escolha uma opção:',
        '1. Agendar esse serviço',
        '2. Escolher outro serviço',
        '3. Voltar ao menu principal',
      ].join('\n')
  return goto(state, 'CONFIRMANDO_SERVICO_INFO', text)
}

function handleServiceInfoConfirm(flow, state, jid, text) {
  const norm = normalizeText(text)
  if (/^1$/.test(norm) || norm.includes('agendar')) {
    state.menu.data.serviceOrigin = 'booking'
    return startDateStep(flow, state, jid)
  }
  if (/^2$/.test(norm) || norm.includes('outro')) return showServicesInfo(flow, state, jid)
  if (/^3$/.test(norm) || norm.includes('voltar')) return renderMainMenu(flow, state)
  return ambiguous(flow, state)
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function startDateStep(flow, state) {
  const menu = firstQuotedMenu(flow.sections.dateScreen)
  if (!menu) return ambiguous(flow, state)
  let count = 0
  const text = menu.text.replace(/\[data completa\]/gi, () => {
    count += 1
    return formatDateBr(count === 1 ? parseDateBr('hoje') : parseDateBr('amanha'))
  })
  return goto(state, 'ESCOLHENDO_DATA', text)
}

function handleDateChoice(flow, state, jid, text) {
  const norm = normalizeText(text)
  if (/^1$/.test(norm) || (norm.includes('hoje') && !norm.includes('amanha'))) return afterDateChosen(flow, state, jid, parseDateBr('hoje'))
  if (/^2$/.test(norm) || norm.includes('amanha')) return afterDateChosen(flow, state, jid, parseDateBr('amanha'))
  if (/^3$/.test(norm) || norm.includes('outra data') || norm.includes('escolher')) return askManualDate(flow, state)
  if (/^4$/.test(norm) || norm.includes('voltar')) return startBooking(flow, state, jid)
  const directDate = parseDateBr(text)
  if (directDate) return afterDateChosen(flow, state, jid, directDate)
  return ambiguous(flow, state)
}

function askManualDate(flow, state) {
  const block = allQuotedMenus(flow.sections.dateScreen)[1]
  const text = block ? block.text : 'Envie a data no formato DD/MM/AAAA.\n\nExemplo: 25/08/2026'
  return goto(state, 'INFORMANDO_DATA_MANUAL', text)
}

function handleManualDate(flow, state, jid, text) {
  const date = parseDateBr(text)
  if (!date) {
    const block = allQuotedMenus(flow.sections.dateScreen)[2]
    const invalidText = block ? block.text : 'Não consegui identificar a data.\n\nEnvie no formato DD/MM/AAAA.\n\nExemplo: 25/08/2026'
    return goto(state, 'INFORMANDO_DATA_MANUAL', invalidText)
  }
  return afterDateChosen(flow, state, jid, date)
}

function afterDateChosen(flow, state, jid, date) {
  state.menu.data.date = date
  return startPeriodStep(flow, state, jid)
}

// ---------------------------------------------------------------------------
// Período
// ---------------------------------------------------------------------------

function startPeriodStep(flow, state, jid) {
  if (state.menu.data.hintedTime) return startTimeStep(flow, state, jid)
  const menu = firstQuotedMenu(flow.sections.periodScreen)
  if (!menu) return startTimeStep(flow, state, jid)
  return goto(state, 'ESCOLHENDO_PERIODO', menu.text)
}

function handlePeriodChoice(flow, state, jid, text) {
  const menu = firstQuotedMenu(flow.sections.periodScreen)
  if (!menu) return startTimeStep(flow, state, jid)
  const opt = matchOption(text, menu.options)
  if (!opt) return ambiguous(flow, state)
  const norm = normalizeText(opt.label)
  if (norm.includes('voltar')) return startDateStep(flow, state, jid)
  if (norm.includes('primeiro')) return afterPeriodChosen(flow, state, jid, 'primeiro')
  const key = Object.keys(PERIOD_RANGES).find((k) => norm.includes(k))
  return afterPeriodChosen(flow, state, jid, key || null)
}

function afterPeriodChosen(flow, state, jid, period) {
  state.menu.data.period = period
  return startTimeStep(flow, state, jid)
}

// ---------------------------------------------------------------------------
// Horário — sempre consulta a agenda real, nunca inventa
// ---------------------------------------------------------------------------

function filterSlotsByPeriod(slots, period) {
  if (!period || period === 'primeiro') return slots
  const range = PERIOD_RANGES[period]
  if (!range) return slots
  return slots.filter((t) => { const h = Number(t.slice(0, 2)); return h >= range[0] && h < range[1] })
}

function startTimeStep(flow, state, jid) {
  let agenda
  try {
    agenda = getAvailableSlots(state.menu.data.date, 60)
  } catch (err) {
    return goto(state, 'MENU_PRINCIPAL', `Não consegui consultar a agenda agora (${err.message}).\n\n${flow.mainMenu.text}`)
  }
  if (!agenda.open) {
    const dateMenu = firstQuotedMenu(flow.sections.dateScreen)
    return goto(state, 'ESCOLHENDO_DATA', `Nesse dia não temos atendimento. Escolha outra data.\n\n${dateMenu ? dateMenu.text : ''}`)
  }
  let slots = filterSlotsByPeriod(agenda.slots || [], state.menu.data.period)
  const hinted = state.menu.data.hintedTime
  if (hinted) {
    delete state.menu.data.hintedTime
    if ((agenda.slots || []).includes(hinted)) return afterTimeChosen(flow, state, jid, hinted)
  }
  if (state.menu.data.period === 'primeiro') slots = slots.slice(0, 1)
  state.menu.data.slotOffset = 0
  return renderTimeOptions(flow, state, slots)
}

function renderTimeOptions(flow, state, allSlots) {
  state.menu.data.allSlots = allSlots
  const offset = state.menu.data.slotOffset || 0
  const page = allSlots.slice(offset, offset + 3)
  if (page.length === 0) {
    const block = allQuotedMenus(flow.sections.timeScreen)[1]
    const text = block
      ? block.text
      : [
          'Não encontrei horários disponíveis nesse período.',
          '',
          'Escolha uma opção:',
          '',
          '1. Consultar outro período',
          '2. Consultar outra data',
          '3. Escolher outro barbeiro',
          '4. Falar com a equipe',
          '5. Voltar ao menu principal',
        ].join('\n')
    return goto(state, 'SEM_HORARIO', text)
  }
  const lines = page.map((t, i) => `${i + 1}. ${t}`)
  const hasMore = offset + page.length < allSlots.length
  lines.push(`${page.length + 1}. ${hasMore ? 'Ver outras opções' : 'Escolher outro período/data'}`)
  lines.push(`${page.length + 2}. Voltar`)
  state.menu.data.timePageOptions = page
  return goto(state, 'ESCOLHENDO_HORARIO', `Encontrei estes horários disponíveis:\n\n${lines.join('\n')}\n\nResponda com o número do horário.`)
}

function handleTimeChoice(flow, state, jid, text) {
  const norm = normalizeText(text)
  const page = state.menu.data.timePageOptions || []
  if (/^\d{1,2}$/.test(norm)) {
    const n = Number(norm)
    if (n >= 1 && n <= page.length) return afterTimeChosen(flow, state, jid, page[n - 1])
    if (n === page.length + 1) {
      state.menu.data.slotOffset = (state.menu.data.slotOffset || 0) + 3
      return renderTimeOptions(flow, state, state.menu.data.allSlots || [])
    }
    if (n === page.length + 2) return startPeriodStep(flow, state, jid)
  }
  const directTime = parseTimeBr(text)
  if (directTime && page.includes(directTime)) return afterTimeChosen(flow, state, jid, directTime)
  return ambiguous(flow, state)
}

function handleNoSlots(flow, state, jid, text) {
  const norm = normalizeText(text)
  if (/^1$/.test(norm) || norm.includes('periodo')) return startPeriodStep(flow, state, jid)
  if (/^2$/.test(norm) || norm.includes('data')) return startDateStep(flow, state, jid)
  if (/^3$/.test(norm) || norm.includes('barbeiro')) return startBarberStep(flow, state, jid)
  if (/^4$/.test(norm) || norm.includes('equipe') || norm.includes('humano')) return showHandoffReasons(flow, state, jid)
  if (/^5$/.test(norm) || norm.includes('menu principal')) return renderMainMenu(flow, state)
  return ambiguous(flow, state)
}

function afterTimeChosen(flow, state, jid, time) {
  state.menu.data.time = time
  return startBarberStep(flow, state, jid)
}

// ---------------------------------------------------------------------------
// Barbeiro
// ---------------------------------------------------------------------------

function startBarberStep(flow, state, jid) {
  const menu = firstQuotedMenu(flow.sections.barberScreen)
  if (!menu) return afterBarberChosen(flow, state, jid, null)
  return goto(state, 'ESCOLHENDO_BARBEIRO', menu.text)
}

function handleBarberChoice(flow, state, jid, text) {
  const menu = firstQuotedMenu(flow.sections.barberScreen)
  if (!menu) return startRegistrationOrConfirm(flow, state, jid)
  const opt = matchOption(text, menu.options)
  if (!opt) return ambiguous(flow, state)
  const norm = normalizeText(opt.label)
  if (norm.includes('voltar')) return startTimeStep(flow, state, jid)
  if (norm.includes('qualquer')) return afterBarberChosen(flow, state, jid, null)
  return afterBarberChosen(flow, state, jid, opt.label)
}

function afterBarberChosen(flow, state, jid, barber) {
  state.menu.data.barber = barber
  return startRegistrationOrConfirm(flow, state, jid)
}

// ---------------------------------------------------------------------------
// Cadastro do cliente (nome) — versão simplificada: se já cadastrado, reusa
// o nome; senão pede o nome e segue direto para a confirmação final (o
// prompt tem uma tela extra só de "confirme seu nome", que aqui é dobrada
// dentro da confirmação final do agendamento para reduzir uma pergunta).
// ---------------------------------------------------------------------------

function startRegistrationOrConfirm(flow, state, jid) {
  const customer = findCustomerByJid(jid)
  if (customer) {
    state.menu.data.customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim()
    return showConfirmScreen(flow, state, jid)
  }
  const block = firstQuotedMenu(flow.sections.registration, { withOptions: false })
  const text = block ? block.text : 'Para continuar, envie seu nome.'
  return goto(state, 'CONFIRMANDO_CADASTRO', text)
}

function handleRegistration(flow, state, jid, text) {
  const name = String(text || '').trim()
  if (name.length < 2) return goto(state, 'CONFIRMANDO_CADASTRO', 'Para continuar, envie seu nome.')
  state.menu.data.customerName = name
  return showConfirmScreen(flow, state, jid)
}

// ---------------------------------------------------------------------------
// Confirmação final e criação/alteração real do agendamento
// ---------------------------------------------------------------------------

function showConfirmScreen(flow, state, jid) {
  const d = state.menu.data
  const block = firstQuotedMenu(flow.sections.confirmScreen)
  const name = d.customerName || contactNameForCalendar(jid) || 'Cliente'
  d.customerName = name
  const values = {
    servico: d.serviceName || d.alterTarget?.title || '-',
    'data completa': formatDateBr(d.date || d.alterTarget?.date),
    data: formatDateBr(d.date || d.alterTarget?.date),
    horario: d.time || d.alterTarget?.time,
    barbeiro: d.barber || 'Qualquer barbeiro disponível',
    valor: d.servicePrice || 'a combinar',
    nome: name,
  }
  const text = block
    ? renderTemplate(block.text, values)
    : [
        'Confira os dados:', '',
        `Serviço: ${values.servico}`, `Data: ${values.data}`, `Horário: ${values.horario}`,
        `Barbeiro: ${values.barbeiro}`, `Valor: ${values.valor}`, `Nome: ${values.nome}`, '',
        'Escolha uma opção:',
        '1. Confirmar agendamento', '2. Alterar serviço', '3. Alterar data',
        '4. Alterar horário', '5. Alterar barbeiro', '6. Cancelar solicitação',
      ].join('\n')
  return goto(state, 'CONFIRMANDO_AGENDAMENTO', text)
}

function handleConfirm(flow, state, jid, text) {
  const norm = normalizeText(text)
  if (CONFIRM_WORDS.test(norm)) return createOrUpdateAppointment(flow, state, jid)
  if (/^2$/.test(norm) || norm.includes('servico')) {
    state.menu.data.serviceOrigin = 'booking'
    return startBooking(flow, state, jid)
  }
  if (/^3$/.test(norm) || norm.includes('data')) return startDateStep(flow, state, jid)
  if (/^4$/.test(norm) || norm.includes('horario')) return startTimeStep(flow, state, jid)
  if (/^5$/.test(norm) || norm.includes('barbeiro')) return startBarberStep(flow, state, jid)
  if (/^6$/.test(norm) || norm.includes('cancelar')) return renderMainMenu(flow, state)
  return ambiguous(flow, state)
}

function createOrUpdateAppointment(flow, state, jid) {
  const d = state.menu.data
  try {
    let appointment
    if (d.alterTarget) {
      appointment = changeAppointment(d.alterTarget.id, {
        date: d.date || d.alterTarget.date,
        time: d.time || d.alterTarget.time,
        title: d.serviceName || d.alterTarget.title,
      }, { jidScope: jid, source: 'ai' })
    } else {
      appointment = createAppointment({
        date: d.date,
        time: d.time,
        title: d.serviceName || 'Atendimento',
        jid,
        customerName: d.customerName || contactNameForCalendar(jid) || 'Cliente',
        duration: 60,
        notes: d.barber ? `Barbeiro: ${d.barber}` : '',
      }, { source: 'ai' })
    }
    const block = firstQuotedMenu(flow.sections.confirmedScreen)
    const values = {
      servico: d.serviceName || appointment.title,
      data: formatDateBr(appointment.start_at.slice(0, 10)),
      horario: appointment.start_at.slice(11, 16),
      barbeiro: d.barber || 'Qualquer barbeiro disponível',
      valor: d.servicePrice || 'a combinar',
    }
    const text = block
      ? renderTemplate(block.text, values)
      : [
          'Agendamento confirmado ✅', '',
          `Serviço: ${values.servico}`, `Data: ${values.data}`, `Horário: ${values.horario}`,
          `Barbeiro: ${values.barbeiro}`, `Valor: ${values.valor}`, '',
          '1. Voltar ao menu principal', '2. Encerrar atendimento',
        ].join('\n')
    resetBooking(state)
    return goto(state, 'MENU_PRINCIPAL_POS', text)
  } catch (err) {
    const block = allQuotedMenus(flow.sections.confirmedScreen)[1]
    const text = block
      ? block.text
      : [
          `Não consegui concluir o agendamento no sistema (${err.message}).`, '',
          '1. Tentar novamente', '2. Escolher outro horário', '3. Falar com a equipe', '4. Voltar ao menu principal',
        ].join('\n')
    return goto(state, 'FALHA_AGENDAMENTO', text)
  }
}

function handlePostBooking(flow, state, jid, text) {
  const norm = normalizeText(text)
  if (/^2$/.test(norm) || norm.includes('encerrar')) {
    state.menu = null
    return 'Foi um prazer te atender! Se precisar de algo, é só chamar. 👋'
  }
  return renderMainMenu(flow, state)
}

function handleBookingFailure(flow, state, jid, text) {
  const norm = normalizeText(text)
  if (/^1$/.test(norm) || norm.includes('tentar')) return createOrUpdateAppointment(flow, state, jid)
  if (/^2$/.test(norm) || norm.includes('horario')) return startTimeStep(flow, state, jid)
  if (/^3$/.test(norm) || norm.includes('equipe')) return showHandoffReasons(flow, state, jid)
  return renderMainMenu(flow, state)
}

// ---------------------------------------------------------------------------
// Cancelamento
// ---------------------------------------------------------------------------

function startCancel(flow, state, jid) {
  const list = customerAppointments(jid).filter((a) => a.status === 'scheduled')
  if (list.length === 0) return goto(state, 'MENU_PRINCIPAL', `Não encontrei nenhum agendamento ativo no seu número.\n\n${flow.mainMenu.text}`)
  if (list.length === 1) {
    state.menu.data.cancelTarget = list[0]
    return showCancelConfirm(flow, state)
  }
  state.menu.data.cancelChoices = list
  const lines = list.map((a, i) => `${i + 1}. ${a.title} — ${formatDateBr(a.date)} às ${a.time}`)
  lines.push(`${list.length + 1}. Voltar ao menu principal`)
  return goto(state, 'ESCOLHENDO_AGENDAMENTO_CANCELAR', `Escolha o agendamento que deseja cancelar:\n\n${lines.join('\n')}`)
}

function handleCancelPick(flow, state, jid, text) {
  const norm = normalizeText(text)
  const choices = state.menu.data.cancelChoices || []
  if (/^\d{1,2}$/.test(norm)) {
    const n = Number(norm)
    if (n === choices.length + 1) return renderMainMenu(flow, state)
    if (n >= 1 && n <= choices.length) {
      state.menu.data.cancelTarget = choices[n - 1]
      return showCancelConfirm(flow, state)
    }
  }
  return ambiguous(flow, state)
}

function showCancelConfirm(flow, state) {
  const a = state.menu.data.cancelTarget
  const block = firstQuotedMenu(flow.sections.cancelScreen)
  const values = { servico: a.title, data: formatDateBr(a.date), horario: a.time, barbeiro: '-' }
  const text = block
    ? renderTemplate(block.text, values)
    : [
        'Encontrei este agendamento:', '',
        `Serviço: ${a.title}`, `Data: ${formatDateBr(a.date)}`, `Horário: ${a.time}`, '',
        '1. Confirmar cancelamento', '2. Manter agendamento', '3. Voltar ao menu principal',
      ].join('\n')
  return goto(state, 'CONFIRMANDO_CANCELAMENTO', text)
}

function handleCancelConfirm(flow, state, jid, text) {
  const norm = normalizeText(text)
  if (/^1$/.test(norm) || CONFIRM_WORDS.test(norm)) {
    try {
      changeAppointment(state.menu.data.cancelTarget.id, { status: 'cancelled' }, { jidScope: jid, source: 'ai' })
      return goto(state, 'MENU_PRINCIPAL', `Cancelado ✅ Quando quiser remarcar, é só me chamar.\n\n${flow.mainMenu.text}`)
    } catch (err) {
      return goto(state, 'MENU_PRINCIPAL', `Não consegui cancelar (${err.message}).\n\n${flow.mainMenu.text}`)
    }
  }
  if (/^2$/.test(norm) || norm.includes('manter')) return goto(state, 'MENU_PRINCIPAL', `Sem problemas, mantive seu agendamento como estava.\n\n${flow.mainMenu.text}`)
  if (/^3$/.test(norm) || norm.includes('voltar')) return renderMainMenu(flow, state)
  return ambiguous(flow, state)
}

// ---------------------------------------------------------------------------
// Alteração
// ---------------------------------------------------------------------------

function startAlter(flow, state, jid) {
  const list = customerAppointments(jid).filter((a) => a.status === 'scheduled')
  if (list.length === 0) return goto(state, 'MENU_PRINCIPAL', `Não encontrei nenhum agendamento no seu número.\n\n${flow.mainMenu.text}`)
  if (list.length === 1) {
    state.menu.data.alterTarget = list[0]
    return showAlterFieldMenu(flow, state)
  }
  state.menu.data.alterChoices = list
  const lines = list.map((a, i) => `${i + 1}. ${a.title} — ${formatDateBr(a.date)} às ${a.time}`)
  lines.push(`${list.length + 1}. Voltar ao menu principal`)
  return goto(state, 'ESCOLHENDO_AGENDAMENTO_ALTERAR', `Escolha o agendamento que deseja alterar:\n\n${lines.join('\n')}`)
}

function handleAlterPick(flow, state, jid, text) {
  const norm = normalizeText(text)
  const choices = state.menu.data.alterChoices || []
  if (/^\d{1,2}$/.test(norm)) {
    const n = Number(norm)
    if (n === choices.length + 1) return renderMainMenu(flow, state)
    if (n >= 1 && n <= choices.length) {
      state.menu.data.alterTarget = choices[n - 1]
      return showAlterFieldMenu(flow, state)
    }
  }
  return ambiguous(flow, state)
}

function showAlterFieldMenu(flow, state) {
  const a = state.menu.data.alterTarget
  const block = firstQuotedMenu(flow.sections.alterScreen)
  const text = block
    ? renderTemplate(block.text, { servico: a.title, data: formatDateBr(a.date), horario: a.time, barbeiro: '-' })
    : [
        'Encontrei este agendamento:', '',
        `Serviço: ${a.title}`, `Data: ${formatDateBr(a.date)}`, `Horário: ${a.time}`, '',
        'Escolha o que deseja alterar:',
        '1. Serviço', '2. Data', '3. Horário', '4. Barbeiro', '5. Não alterar', '6. Voltar ao menu principal',
      ].join('\n')
  return goto(state, 'ALTERANDO_AGENDAMENTO', text)
}

function handleAlter(flow, state, jid, text) {
  const norm = normalizeText(text)
  if (/^1$/.test(norm) || norm.includes('servico')) {
    state.menu.data.serviceOrigin = 'booking'
    return startBooking(flow, state, jid)
  }
  if (/^2$/.test(norm) || norm.includes('data')) return startDateStep(flow, state, jid)
  if (/^3$/.test(norm) || norm.includes('horario')) return startTimeStep(flow, state, jid)
  if (/^4$/.test(norm) || norm.includes('barbeiro')) return startBarberStep(flow, state, jid)
  if (/^5$/.test(norm) || norm.includes('nao alterar') || /^6$/.test(norm) || norm.includes('voltar')) return renderMainMenu(flow, state)
  return ambiguous(flow, state)
}

// ---------------------------------------------------------------------------
// Endereço
// ---------------------------------------------------------------------------

function showAddress(flow, state) {
  const menu = firstQuotedMenu(flow.sections.addressScreen)
  if (!menu) return ambiguous(flow, state)
  return goto(state, 'ENDERECO_INFO', menu.text)
}

function handleAddressInfo(flow, state, jid, text) {
  const norm = normalizeText(text)
  if (/^1$/.test(norm) || norm.includes('agendar')) return startBooking(flow, state, jid)
  if (/^2$/.test(norm) || norm.includes('servico')) return showServicesInfo(flow, state, jid)
  if (/^3$/.test(norm) || norm.includes('equipe')) return showHandoffReasons(flow, state, jid)
  if (/^4$/.test(norm) || norm.includes('menu')) return renderMainMenu(flow, state)
  return ambiguous(flow, state)
}

// ---------------------------------------------------------------------------
// Transferência para atendimento humano
// ---------------------------------------------------------------------------

function showHandoffReasons(flow, state) {
  const menu = firstQuotedMenu(flow.sections.handoffScreen)
  const text = menu
    ? menu.text
    : [
        'Vou encaminhar seu atendimento para nossa equipe.', '', 'Motivo:', '',
        '1. Dúvida não disponível no sistema', '2. Problema com agendamento', '3. Problema com pagamento',
        '4. Reclamação', '5. Solicitação de atendente', '6. Outro assunto',
      ].join('\n')
  return goto(state, 'TRANSFERINDO_MOTIVO', text)
}

function handleHandoffReason(flow, state, jid) {
  try { setContactPaused(jid, true) } catch { /* segue mesmo se não conseguir pausar */ }
  const block = allQuotedMenus(flow.sections.handoffScreen)[1]
  const text = block ? block.text : 'Seu atendimento foi encaminhado para nossa equipe.'
  state.menu.screen = 'TRANSFERINDO'
  state.menu.lastText = text
  return text
}

// ---------------------------------------------------------------------------
// Dispatcher principal
// ---------------------------------------------------------------------------

export function menuFlowReply(jid, userText, settings, state) {
  const flow = buildFlow(settings)
  if (!flow) return null

  if (!state.menu) {
    state.menu = { screen: 'MENU_PRINCIPAL', data: {}, lastText: '' }
    return renderMainMenu(flow, state)
  }

  const text = String(userText || '').trim()
  const screen = state.menu.screen

  switch (screen) {
    case 'MENU_PRINCIPAL': return handleMainMenu(flow, state, jid, text)
    case 'ESCOLHENDO_SERVICO': return handleServiceChoice(flow, state, jid, text)
    case 'CONFIRMANDO_SERVICO_INFO': return handleServiceInfoConfirm(flow, state, jid, text)
    case 'ESCOLHENDO_DATA': return handleDateChoice(flow, state, jid, text)
    case 'INFORMANDO_DATA_MANUAL': return handleManualDate(flow, state, jid, text)
    case 'ESCOLHENDO_PERIODO': return handlePeriodChoice(flow, state, jid, text)
    case 'ESCOLHENDO_HORARIO': return handleTimeChoice(flow, state, jid, text)
    case 'SEM_HORARIO': return handleNoSlots(flow, state, jid, text)
    case 'ESCOLHENDO_BARBEIRO': return handleBarberChoice(flow, state, jid, text)
    case 'CONFIRMANDO_CADASTRO': return handleRegistration(flow, state, jid, text)
    case 'CONFIRMANDO_AGENDAMENTO': return handleConfirm(flow, state, jid, text)
    case 'MENU_PRINCIPAL_POS': return handlePostBooking(flow, state, jid, text)
    case 'FALHA_AGENDAMENTO': return handleBookingFailure(flow, state, jid, text)
    case 'ESCOLHENDO_AGENDAMENTO_CANCELAR': return handleCancelPick(flow, state, jid, text)
    case 'CONFIRMANDO_CANCELAMENTO': return handleCancelConfirm(flow, state, jid, text)
    case 'ESCOLHENDO_AGENDAMENTO_ALTERAR': return handleAlterPick(flow, state, jid, text)
    case 'ALTERANDO_AGENDAMENTO': return handleAlter(flow, state, jid, text)
    case 'ENDERECO_INFO': return handleAddressInfo(flow, state, jid, text)
    case 'TRANSFERINDO_MOTIVO': return handleHandoffReason(flow, state, jid)
    case 'TRANSFERINDO': return null // atendimento humano assumiu; a IA para de responder
    default: return renderMainMenu(flow, state)
  }
}
