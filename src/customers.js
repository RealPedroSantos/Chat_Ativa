import { db, getSettings } from './db.js'
import { currentTenantId } from './tenant-context.js'

const BASE_FIELD_KEYS = new Set([
  'nome', 'name', 'nome_completo', 'primeiro_nome', 'first_name', 'sobrenome', 'last_name',
  'telefone', 'phone', 'celular', 'whatsapp', 'numero', 'numero_de_telefone', 'numero_de_contato',
  'telefone_de_contato', 'melhor_numero_de_telefone',
])

function normalizeLabel(value) {
  return String(value || '').replace(/^[-*•\d.)\s]+/, '').replace(/\s*\((?:obrigat[oó]ri[oa]|opcional)\)\s*$/iu, '').trim()
}

function fieldKey(label) {
  return String(label || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60)
}

function cleanPersonName(value) {
  return String(value || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,.;:\-–—|/]+|[,.;:\-–—|/]+$/g, '')
    .trim()
}

function addField(fields, label) {
  const cleanLabel = normalizeLabel(label)
  const key = fieldKey(cleanLabel)
  if (!cleanLabel || !key || BASE_FIELD_KEYS.has(key) || fields.some((field) => field.key === key)) return
  fields.push({ key, label: cleanLabel.slice(0, 80) })
}

function addInlineFields(fields, value) {
  for (const item of String(value || '').split(/[;,|]/)) addField(fields, item)
}

/**
 * Campos extras são declarados no prompt em um formato explícito, por exemplo:
 * "Campos do formulário de clientes: Nome; Número de contato; CPF; E-mail".
 * Nome e número de contato são sempre os campos mínimos do sistema.
 * Também aceita uma lista de tópicos logo abaixo dessa linha.
 */
export function parseCustomerExtraFields(settings = {}) {
  const lines = `${settings.system_prompt || ''}\n${settings.business_info || ''}`.split(/\r?\n/)
  const fields = []
  let readingList = false
  let allowBlankAfterDirective = false
  const directive = /^(?:(?:campos|dados)(?:\s+adicionais)?\s+(?:(?:do|para(?:\s+o)?)\s+)?cadastro(?:\s+de\s+(?:clientes?|contatos?))?|(?:campos|dados)\s+(?:(?:do|para(?:\s+o)?)\s+)?formul[aá]rio\s+de\s+(?:clientes?|contatos?)|cadastro\s+de\s+(?:clientes?|contatos?))\s*:\s*(.*)$/iu
  const collectDirective = /^(?:para|ao)\s+cadastr(?:ar|o)\s+(?:um\s+)?cliente.*?(?:colete|solicite|registre)\s*:\s*(.*)$/iu

  for (const rawLine of lines) {
    const line = rawLine.trim()
    const match = line.match(directive) || line.match(collectDirective)
    if (match) {
      readingList = true
      allowBlankAfterDirective = !match[1].trim()
      addInlineFields(fields, match[1])
      continue
    }
    if (!readingList) continue
    if (!line) {
      if (allowBlankAfterDirective) {
        allowBlankAfterDirective = false
        continue
      }
      readingList = false
      continue
    }
    if (/^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
      addField(fields, line)
      allowBlankAfterDirective = false
    }
    else readingList = false
    if (fields.length >= 30) break
  }

  // Também entende blocos naturais do prompt, como:
  // "Me envie estas informações:" seguido de "Data de nascimento:".
  let collectingRequestedData = false
  let requestedDataStarted = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (/(?:me\s+)?envie.*(?:estas|as)\s+informa[cç][oõ]es\s*:|(?:dados|informa[cç][oõ]es)\s+(?:necess[aá]rios|para\s+o\s+cadastro)\s*:/iu.test(line)) {
      collectingRequestedData = true
      requestedDataStarted = false
      continue
    }
    if (!collectingRequestedData) continue
    if (!line) {
      if (requestedDataStarted) collectingRequestedData = false
      continue
    }
    const fieldMatch = line.match(/^([^:]{2,80}):\s*$/u)
    if (fieldMatch) {
      addField(fields, fieldMatch[1])
      requestedDataStarted = true
      continue
    }
    if (requestedDataStarted || /^(?:assim que|quando|nao |não |---|#{2,})/iu.test(line)) collectingRequestedData = false
  }
  return fields.slice(0, 30)
}

export function normalizeCustomerPhone(value) {
  let digits = String(value || '').replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`
  if (!/^\d{12,15}$/.test(digits)) throw new Error('Informe um telefone válido com DDD.')
  return digits
}

function parseExtraData(value) {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function publicCustomer(row) {
  return row ? { ...row, extra_data: parseExtraData(row.extra_data) } : null
}

function validateName(value, label) {
  const clean = String(value || '').trim().replace(/\s+/g, ' ')
  if (clean.length < 2) throw new Error(`Informe ${label}.`)
  return clean.slice(0, 120)
}

function optionalName(value) {
  return cleanPersonName(value).slice(0, 120)
}

function splitCustomerName(input = {}) {
  const combined = input.name != null
    ? cleanPersonName(input.name)
    : cleanPersonName([input.firstName, input.lastName].filter(Boolean).join(' '))
  const fullName = validateName(combined, 'o nome')
  const parts = fullName.split(/\s+/)
  return {
    firstName: parts.shift(),
    lastName: parts.join(' '),
  }
}

function configuredFieldForLabel(label, configured) {
  const wanted = fieldKey(label)
  if (!wanted) return null
  return configured.find((field) => field.key === wanted)
    || configured.find((field) => wanted.includes(field.key) || field.key.includes(wanted))
    || null
}

/**
 * Nomes da agenda do WhatsApp frequentemente carregam contexto operacional,
 * por exemplo "Marina Souza | Loja Centro | VIP". Mantemos a parte pessoal no
 * nome do cliente e distribuímos o restante em campos pesquisáveis.
 */
export function parseWhatsAppContactName(displayName, settings = getSettings()) {
  const rawName = String(displayName || '').replace(/\s+/g, ' ').trim()
  const configured = parseCustomerExtraFields(settings)
  const chunks = rawName
    .split(/\s*(?:\||;|•|·|\s[-–—]\s|\s\/\s)\s*/u)
    .map(cleanPersonName)
    .filter(Boolean)

  const extras = {}
  const details = []
  let personChunk = ''

  function saveExtra(label, value) {
    const cleanValue = cleanPersonName(value)
    if (!cleanValue) return
    const configuredField = configuredFieldForLabel(label, configured)
    const key = configuredField?.key || fieldKey(label)
    if (key && !BASE_FIELD_KEYS.has(key)) extras[key] = cleanValue.slice(0, 2000)
  }

  for (const chunk of chunks) {
    const labelled = chunk.match(/^([^:]{2,50}):\s*(.+)$/u)
    if (labelled) {
      saveExtra(labelled[1], labelled[2])
      continue
    }
    const email = chunk.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu)?.[0]
    if (email) {
      saveExtra('E-mail', email)
      const remainder = cleanPersonName(chunk.replace(email, ''))
      if (remainder) details.push(remainder)
      continue
    }
    const document = chunk.match(/\b(?:\d[.\s-]?){11,14}\b/u)?.[0]
    if (document) {
      const digits = document.replace(/\D/g, '')
      saveExtra(digits.length === 11 ? 'CPF' : 'CNPJ', digits)
      continue
    }
    if (!personChunk && /[A-Za-zÀ-ÖØ-öø-ÿ]/u.test(chunk)) personChunk = chunk
    else details.push(chunk)
  }

  personChunk ||= cleanPersonName(rawName) || 'Contato WhatsApp'
  const nameParts = personChunk.split(/\s+/).filter(Boolean)
  const firstName = nameParts.shift() || 'Contato'
  const lastName = nameParts.join(' ')

  if (details.length) {
    const categoryField = configuredFieldForLabel('Categoria', configured)
    const companyField = configuredFieldForLabel('Empresa', configured)
    for (const detail of details) {
      if (categoryField && /\b(?:vip|cliente|lead|prospect|fornecedor|parceiro)\b/iu.test(detail) && !extras[categoryField.key]) {
        extras[categoryField.key] = detail
      } else if (companyField && !extras[companyField.key]) {
        extras[companyField.key] = detail
      } else {
        extras.detalhes_nome_whatsapp = [extras.detalhes_nome_whatsapp, detail].filter(Boolean).join(' | ')
      }
    }
  }

  return {
    firstName: optionalName(firstName) || 'Contato',
    lastName: optionalName(lastName),
    fullName: optionalName([firstName, lastName].filter(Boolean).join(' ')),
    rawName,
    extras,
  }
}

function cleanExtras(input, existing = {}) {
  const configured = parseCustomerExtraFields(getSettings())
  const allowed = new Set([...configured.map((field) => field.key), ...Object.keys(existing)])
  const clean = { ...existing }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return clean
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) continue
    clean[key] = String(value ?? '').trim().slice(0, 2000)
  }
  return clean
}

export function listCustomers() {
  return db.prepare(`
    SELECT * FROM customers WHERE tenant_id = ?
    ORDER BY first_name COLLATE NOCASE, last_name COLLATE NOCASE, id
  `).all(currentTenantId()).map(publicCustomer)
}

export function findCustomerByPhone(phone) {
  let normalized
  try {
    normalized = normalizeCustomerPhone(phone)
  } catch {
    return null
  }
  return publicCustomer(db.prepare('SELECT * FROM customers WHERE tenant_id = ? AND phone = ?').get(currentTenantId(), normalized))
}

export function findCustomerByJid(jid) {
  return findCustomerByPhone(String(jid || '').split('@')[0])
}

export function customerFields() {
  const configured = parseCustomerExtraFields(getSettings())
  const known = new Map(configured.map((field) => [field.key, field]))
  const standardLabels = { cpf: 'CPF', cnpj: 'CNPJ', rg: 'RG', cep: 'CEP', email: 'E-mail', e_mail: 'E-mail' }
  for (const customer of listCustomers()) {
    for (const key of Object.keys(customer.extra_data)) {
      if (!known.has(key)) known.set(key, {
        key,
        label: standardLabels[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      })
    }
  }
  return [...known.values()]
}

export function customerFormFields() {
  return parseCustomerExtraFields(getSettings())
}

export function createCustomer(input = {}) {
  const tenantId = currentTenantId()
  const { firstName, lastName } = splitCustomerName(input)
  const phone = normalizeCustomerPhone(input.phone)
  if (db.prepare('SELECT id FROM customers WHERE tenant_id = ? AND phone = ?').get(tenantId, phone)) {
    throw new Error('Já existe um cliente cadastrado com este telefone.')
  }
  const extras = cleanExtras(input.extras)
  const info = db.prepare(`
    INSERT INTO customers (tenant_id, first_name, last_name, phone, extra_data)
    VALUES (?, ?, ?, ?, ?)
  `).run(tenantId, firstName, lastName, phone, JSON.stringify(extras))
  return publicCustomer(db.prepare('SELECT * FROM customers WHERE tenant_id = ? AND id = ?').get(tenantId, info.lastInsertRowid))
}

export function updateCustomer(id, input = {}) {
  const tenantId = currentTenantId()
  const current = db.prepare('SELECT * FROM customers WHERE tenant_id = ? AND id = ?').get(tenantId, Number(id))
  if (!current) throw new Error('Cliente não encontrado.')
  const { firstName, lastName } = splitCustomerName(input)
  const phone = normalizeCustomerPhone(input.phone)
  const duplicate = db.prepare('SELECT id FROM customers WHERE tenant_id = ? AND phone = ? AND id <> ?').get(tenantId, phone, Number(id))
  if (duplicate) throw new Error('Já existe outro cliente cadastrado com este telefone.')
  const extras = cleanExtras(input.extras, parseExtraData(current.extra_data))
  db.prepare(`
    UPDATE customers SET first_name = ?, last_name = ?, phone = ?, extra_data = ?, updated_at = datetime('now')
    WHERE tenant_id = ? AND id = ?
  `).run(firstName, lastName, phone, JSON.stringify(extras), tenantId, Number(id))
  return publicCustomer(db.prepare('SELECT * FROM customers WHERE tenant_id = ? AND id = ?').get(tenantId, Number(id)))
}

export function syncWhatsAppContactToCustomer({ phone, displayName }) {
  const tenantId = currentTenantId()
  const normalizedPhone = normalizeCustomerPhone(phone)
  const parsed = parseWhatsAppContactName(displayName)
  const current = db.prepare('SELECT * FROM customers WHERE tenant_id = ? AND phone = ?').get(tenantId, normalizedPhone)
  if (!current) {
    const info = db.prepare(`
      INSERT INTO customers (tenant_id, first_name, last_name, phone, extra_data)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenantId, parsed.firstName, parsed.lastName, normalizedPhone, JSON.stringify(parsed.extras))
    return {
      action: 'created',
      customer: publicCustomer(db.prepare('SELECT * FROM customers WHERE tenant_id = ? AND id = ?').get(tenantId, info.lastInsertRowid)),
      parsed,
    }
  }

  const currentExtras = parseExtraData(current.extra_data)
  const mergedExtras = { ...parsed.extras, ...currentExtras }
  const shouldReplacePlaceholder = !current.first_name || /^(?:contato|cliente|whatsapp)$/iu.test(current.first_name)
  db.prepare(`
    UPDATE customers SET
      first_name = ?, last_name = ?, extra_data = ?, updated_at = datetime('now')
    WHERE tenant_id = ? AND id = ?
  `).run(
    shouldReplacePlaceholder ? parsed.firstName : current.first_name,
    shouldReplacePlaceholder ? parsed.lastName : current.last_name,
    JSON.stringify(mergedExtras),
    tenantId,
    current.id
  )
  return {
    action: 'updated',
    customer: publicCustomer(db.prepare('SELECT * FROM customers WHERE tenant_id = ? AND id = ?').get(tenantId, current.id)),
    parsed,
  }
}

export function deleteCustomer(id) {
  const result = db.prepare('DELETE FROM customers WHERE tenant_id = ? AND id = ?').run(currentTenantId(), Number(id))
  if (!result.changes) throw new Error('Cliente não encontrado.')
  return true
}

export function deleteCustomers(ids = []) {
  const unique = [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 500)
  if (!unique.length) return 0
  const placeholders = unique.map(() => '?').join(',')
  return db.prepare(`
    DELETE FROM customers
    WHERE tenant_id = ? AND id IN (${placeholders})
  `).run(currentTenantId(), ...unique).changes
}

function exportCell(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ')
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportCustomersTxt() {
  const fields = customerFields()
  const header = ['Nome', 'Número de contato', ...fields.map((field) => field.label)]
  const rows = listCustomers().map((customer) => [
    [customer.first_name, customer.last_name].filter(Boolean).join(' '),
    customer.phone,
    ...fields.map((field) => customer.extra_data[field.key] || ''),
  ])
  const delimiter = '  ;  '
  return `\uFEFF${[header, ...rows].map((row) => row.map(exportCell).join(delimiter)).join('\r\n')}\r\n`
}
