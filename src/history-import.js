import crypto from 'node:crypto'
import { addHistoricalMessage, getContact, recordHistoryImport, upsertSyncedContact } from './db.js'

function normalizeName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
}

function parseDateTime(dateText, timeText) {
  const parts = String(dateText || '').split(/[/. -]/).map(Number)
  if (parts.length < 3) return null
  let [day, month, year] = parts
  if (year < 100) year += 2000
  const time = String(timeText || '').trim().toLowerCase()
  const match = time.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/)
  if (!match) return null
  let hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3] || 0)
  if (match[4]?.startsWith('p') && hour < 12) hour += 12
  if (match[4]?.startsWith('a') && hour === 12) hour = 0
  const value = new Date(year, month - 1, day, hour, minute, second)
  return Number.isNaN(value.getTime()) ? null : value.toISOString()
}

function parseHeader(line) {
  const patterns = [
    /^\[?(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})[,\s]+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\]?\s*[-–]\s*([^:]+):\s?(.*)$/iu,
    /^\[?(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})[,\s]+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\]?\s+([^:]+):\s?(.*)$/iu,
  ]
  for (const pattern of patterns) {
    const match = line.match(pattern)
    if (match) {
      const createdAt = parseDateTime(match[1], match[2])
      if (createdAt) return { createdAt, author: match[3].trim(), text: match[4] || '' }
    }
  }
  return null
}

export function parseWhatsAppExport(content) {
  const text = String(content || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const entries = []
  for (const line of text.split('\n')) {
    const header = parseHeader(line)
    if (header) {
      entries.push(header)
    } else if (entries.length) {
      entries.at(-1).text += `\n${line}`
    }
  }
  return entries
    .map((entry) => ({ ...entry, text: entry.text.trim() }))
    .filter((entry) => entry.text && !/mensagens e chamadas são protegidas|messages and calls are end-to-end encrypted/iu.test(entry.text))
}

export function importWhatsAppExport({
  jid,
  content,
  fileName,
  ownNames = [],
  importedBy,
  contactName = '',
}) {
  const contact = getContact(jid)
  if (!contact) {
    upsertSyncedContact(jid, { name: contactName || jid.split('@')[0], rawName: contactName || null, transportJid: jid })
  }
  const own = new Set(ownNames.map(normalizeName).filter(Boolean))
  const entries = parseWhatsAppExport(content)
  let imported = 0
  let ignored = 0
  for (const entry of entries) {
    const direction = own.has(normalizeName(entry.author)) ? 'out' : 'in'
    const externalId = `manual:${crypto.createHash('sha256')
      .update(`${jid}\n${entry.createdAt}\n${entry.author}\n${entry.text}`)
      .digest('hex')}`
    const result = addHistoricalMessage({
      jid,
      direction,
      text: entry.text,
      source: 'manual_history',
      externalId,
      createdAt: entry.createdAt,
    })
    if (result.inserted) imported++
    else ignored++
  }
  const historyImport = recordHistoryImport({
    jid,
    importedBy,
    fileName,
    messagesImported: imported,
  })
  return { parsed: entries.length, imported, ignored, historyImport }
}
