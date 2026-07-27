import * as baileys from '@whiskeysockets/baileys'
import pino from 'pino'
import QRCode from 'qrcode'
import fs from 'node:fs'
import path from 'node:path'
import { bus } from './bus.js'
import { handleIncoming, prepareIncomingConversation, reconcileExternalAuthorizations } from './pipeline.js'
import {
  addHistoricalMessage, addMediaMessage, addMessage, DATA_DIR, getContact, getMessageByExternalId, listPendingAppointmentNotifications, listTenants,
  markAppointmentNotificationError, markAppointmentNotificationSent,
  upsertContact, upsertSyncedContact,
} from './db.js'
import { messageTypeForMedia, removeTenantMedia, safeFileName, saveMediaBuffer } from './media.js'
import { syncWhatsAppContactToCustomer } from './customers.js'
import { currentTenantId, runWithTenant } from './tenant-context.js'

const {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  isPnUser, isLidUser, jidNormalizedUser,
} = baileys
const makeWASocket = baileys.makeWASocket ?? baileys.default
const logger = pino({ level: 'warn' })
const AUTH_ROOT = path.join(DATA_DIR, 'auth-tenants')
const LEGACY_AUTH_DIR = path.join(DATA_DIR, 'auth')
const sessions = new Map()
const MAX_PROCESSED_MESSAGE_IDS = 5000
const MAX_BUFFERED_HISTORY_MESSAGES = 100000

fs.mkdirSync(AUTH_ROOT, { recursive: true })
const primaryAuthDir = path.join(AUTH_ROOT, '1')
if (fs.existsSync(LEGACY_AUTH_DIR) && !fs.existsSync(primaryAuthDir)) {
  fs.renameSync(LEGACY_AUTH_DIR, primaryAuthDir)
}

function getSession(tenantId = currentTenantId()) {
  const id = Number(tenantId)
  if (!sessions.has(id)) {
    sessions.set(id, {
      tenantId: id,
      sock: null,
      starting: false,
      reconnectTimer: null,
      suspended: false,
      processedMessageIds: new Set(),
      historyContacts: new Map(),
      historyMessages: new Map(),
      historyComplete: false,
      syncRequested: false,
      syncQueue: Promise.resolve(),
      syncFinalizeTimer: null,
      state: {
        tenantId: id,
        status: 'disconnected',
        qr: null,
        user: null,
        sync: {
          status: 'idle',
          progress: 0,
          availableContacts: 0,
          availableMessages: 0,
          contactsImported: 0,
          customersCreated: 0,
          messagesImported: 0,
          conversationsImported: 0,
          lastSyncAt: null,
          error: null,
        },
      },
    })
  }
  return sessions.get(id)
}

export function getWhatsAppState(tenantId = currentTenantId()) {
  return { ...getSession(tenantId).state }
}

function setState(session, patch) {
  Object.assign(session.state, patch, { tenantId: session.tenantId })
  bus.emit('wa_state', { ...session.state })
}

function setSyncState(session, patch) {
  setState(session, { sync: { ...session.state.sync, ...patch } })
}

function extractText(message) {
  if (!message) return null
  const m = unwrapMessage(message)
  const ordinaryText = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption ||
    m.videoMessage?.caption || m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title
  if (ordinaryText) return ordinaryText
  const location = m.locationMessage || m.liveLocationMessage
  if (location) {
    const latitude = Number(location.degreesLatitude)
    const longitude = Number(location.degreesLongitude)
    const description = [location.name, location.address].filter(Boolean).join(' — ')
    const mapLink = Number.isFinite(latitude) && Number.isFinite(longitude)
      ? `https://maps.google.com/?q=${latitude},${longitude}`
      : ''
    return ['📍 Localização compartilhada', description, mapLink].filter(Boolean).join('\n')
  }
  if (m.contactMessage) {
    return [`👤 Contato compartilhado: ${m.contactMessage.displayName || 'Contato'}`, m.contactMessage.vcard].filter(Boolean).join('\n')
  }
  if (m.contactsArrayMessage?.contacts?.length) {
    return m.contactsArrayMessage.contacts.map((contact) => `👤 ${contact.displayName || 'Contato'}\n${contact.vcard || ''}`.trim()).join('\n\n')
  }
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3
  if (poll) {
    const options = (poll.options || []).map((option) => `• ${option.optionName || ''}`).filter((option) => option !== '• ')
    return [`📊 Enquete: ${poll.name || ''}`, ...options].join('\n')
  }
  return null
}

function unwrapMessage(message) {
  let current = message
  for (let depth = 0; depth < 5 && current; depth++) {
    const nested = current.ephemeralMessage?.message
      || current.viewOnceMessage?.message
      || current.viewOnceMessageV2?.message
      || current.viewOnceMessageV2Extension?.message
      || current.documentWithCaptionMessage?.message
    if (!nested) break
    current = nested
  }
  return current || {}
}

function numericValue(value) {
  return typeof value?.toNumber === 'function' ? value.toNumber() : Number(value || 0)
}

function extractMediaDescriptor(message) {
  const content = unwrapMessage(message)
  const entries = [
    ['imageMessage', 'image', 'imagem.jpg'],
    ['videoMessage', content.videoMessage?.gifPlayback ? 'gif' : 'video', content.videoMessage?.gifPlayback ? 'animacao.mp4' : 'video.mp4'],
    ['audioMessage', 'audio', content.audioMessage?.ptt ? 'mensagem-de-voz.ogg' : 'audio.ogg'],
    ['documentMessage', 'document', content.documentMessage?.fileName || 'documento'],
    ['stickerMessage', 'sticker', 'sticker.webp'],
  ]
  for (const [key, messageType, fallbackName] of entries) {
    const media = content[key]
    if (!media) continue
    return {
      messageType,
      mimeType: String(media.mimetype || ''),
      fileName: safeFileName(media.fileName || fallbackName),
      caption: String(media.caption || '').trim(),
      fileSize: numericValue(media.fileLength),
      durationSeconds: numericValue(media.seconds) || null,
      isVoiceNote: Boolean(media.ptt),
    }
  }
  return null
}

async function storeIncomingMedia(session, message, jid, descriptor, {
  direction = 'in',
  source = 'user',
  createdAt = timestampIso(message.messageTimestamp),
} = {}) {
  const buffer = await baileys.downloadMediaMessage(
    message,
    'buffer',
    {},
    { logger, reuploadRequest: (item) => session.sock.updateMediaMessage(item) }
  )
  const saved = saveMediaBuffer({
    tenantId: session.tenantId,
    buffer,
    mimeType: descriptor.mimeType,
    fileName: descriptor.fileName,
  })
  return addMediaMessage({
    jid,
    direction,
    text: descriptor.caption,
    source,
    messageType: descriptor.messageType,
    mimeType: descriptor.mimeType,
    fileName: saved.fileName,
    mediaPath: saved.mediaPath,
    fileSize: saved.fileSize,
    durationSeconds: descriptor.durationSeconds,
    isVoiceNote: descriptor.isVoiceNote,
    externalId: message.key?.id || null,
    createdAt,
  })
}

function timestampIso(value) {
  const numeric = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value || 0)
  return numeric > 0 ? new Date(numeric * 1000).toISOString() : new Date().toISOString()
}

function phoneFromJid(value) {
  const jid = jidNormalizedUser(String(value || ''))
  if (!isPnUser(jid)) return null
  const digits = jid.split('@')[0].replace(/\D/g, '')
  return /^\d{10,15}$/.test(digits) ? digits : null
}

function directContactJid(contact = {}) {
  const candidate = contact.phoneNumber || (isPnUser(contact.id) ? contact.id : null)
  return candidate ? jidNormalizedUser(candidate) : null
}

function contactDisplayName(contact = {}, phone = '') {
  return String(contact.name || contact.verifiedName || contact.notify || contact.username || phone).trim()
}

function bufferSyncPayload(session, { contacts = [], messages = [], progress = null, isLatest = false } = {}) {
  for (const contact of contacts) {
    const key = contact.phoneNumber || contact.id || contact.lid
    if (key) session.historyContacts.set(key, { ...(session.historyContacts.get(key) || {}), ...contact })
  }
  for (const message of messages) {
    const id = message?.key?.id
    if (!id || session.historyMessages.size >= MAX_BUFFERED_HISTORY_MESSAGES) continue
    session.historyMessages.set(id, message)
  }
  if (isLatest || Number(progress) >= 100) session.historyComplete = true
  setSyncState(session, {
    availableContacts: session.historyContacts.size,
    availableMessages: session.historyMessages.size,
    progress: Math.max(Number(session.state.sync.progress || 0), Number(progress || 0)),
  })
}

function importContact(session, contact) {
  const jid = directContactJid(contact)
  const phone = phoneFromJid(jid)
  if (!jid || !phone || jid === jidNormalizedUser(session.state.user || '')) return null
  const rawName = contactDisplayName(contact, phone)
  const customerResult = syncWhatsAppContactToCustomer({ phone, displayName: rawName })
  const cleanName = [customerResult.customer.first_name, customerResult.customer.last_name].filter(Boolean).join(' ')
  upsertSyncedContact(jid, {
    name: cleanName || rawName,
    rawName,
    transportJid: jid,
  })
  return customerResult
}

async function importHistoryMessage(session, message) {
  if (!message?.message || !message.key?.id) return null
  const jid = resolveDirectJid(message.key)
  if (!jid) return null
  const text = extractText(message.message)
  const mediaDescriptor = extractMediaDescriptor(message.message)
  if (!text?.trim() && !mediaDescriptor) return null
  const createdAt = timestampIso(message.messageTimestamp)
  const contact = session.historyContacts.get(jid)
    || [...session.historyContacts.values()].find((item) => directContactJid(item) === jid)
  const rawName = contactDisplayName(contact, message.pushName || phoneFromJid(jid) || '')
  const existingContact = getContact(jid)
  upsertSyncedContact(jid, {
    name: existingContact?.name || rawName,
    rawName,
    transportJid: jid,
    lastMessageAt: createdAt,
  })
  if (mediaDescriptor) {
    const existing = getMessageByExternalId(message.key.id)
    if (existing) return { inserted: false, row: existing }
    const row = await storeIncomingMedia(session, message, jid, mediaDescriptor, {
      direction: message.key.fromMe ? 'out' : 'in',
      source: 'whatsapp_history',
      createdAt,
    })
    return { inserted: true, row }
  }
  return addHistoricalMessage({
    jid,
    direction: message.key.fromMe ? 'out' : 'in',
    text: text.trim(),
    externalId: message.key.id,
    createdAt,
  })
}

function finishSync(session, status = 'complete', error = null) {
  clearTimeout(session.syncFinalizeTimer)
  setSyncState(session, {
    status,
    progress: status === 'complete' ? 100 : session.state.sync.progress,
    lastSyncAt: status === 'complete' ? new Date().toISOString() : session.state.sync.lastSyncAt,
    error,
  })
  bus.emit('contact_update', { tenantId: session.tenantId, source: 'whatsapp_sync' })
  bus.emit('customer_update', { tenantId: session.tenantId, source: 'whatsapp_sync' })
}

function scheduleSyncFinalization(session) {
  clearTimeout(session.syncFinalizeTimer)
  session.syncFinalizeTimer = setTimeout(() => {
    if (session.syncRequested && session.state.sync.status === 'syncing') {
      finishSync(session)
    }
  }, 12000)
}

function processBufferedSync(session) {
  session.syncQueue = session.syncQueue.then(() => runWithTenant(session.tenantId, async () => {
    if (!session.syncRequested) return
    setSyncState(session, { status: 'syncing', error: null })
    let contactsImported = Number(session.state.sync.contactsImported || 0)
    let customersCreated = Number(session.state.sync.customersCreated || 0)
    let messagesImported = Number(session.state.sync.messagesImported || 0)
    const conversations = new Set()

    for (const [key, contact] of [...session.historyContacts]) {
      try {
        const result = importContact(session, contact)
        if (result) {
          contactsImported++
          if (result.action === 'created') customersCreated++
        }
      } catch (err) {
        console.warn(`[whatsapp:${session.tenantId}] contato ignorado na sincronização:`, err.message)
      }
      session.historyContacts.delete(key)
    }

    for (const [id, message] of [...session.historyMessages]) {
      if (session.state.sync.includeHistory === false) {
        session.historyMessages.delete(id)
        continue
      }
      try {
        const result = await importHistoryMessage(session, message)
        if (result?.inserted) {
          messagesImported++
          if (result.row?.jid) conversations.add(result.row.jid)
        }
      } catch (err) {
        console.warn(`[whatsapp:${session.tenantId}] mensagem ignorada na sincronização:`, err.message)
      }
      session.historyMessages.delete(id)
    }

    setSyncState(session, {
      contactsImported,
      customersCreated,
      messagesImported,
      conversationsImported: Number(session.state.sync.conversationsImported || 0) + conversations.size,
      availableContacts: session.historyContacts.size,
      availableMessages: session.historyMessages.size,
    })
    if (session.historyComplete) finishSync(session)
    else scheduleSyncFinalization(session)
  })).catch((err) => {
    console.error(`[whatsapp:${session.tenantId}] sincronização:`, err)
    finishSync(session, 'error', err.message)
  })
  return session.syncQueue
}

export function resolveDirectJid(key = {}) {
  const rawJid = key.remoteJid
  if (!isPnUser(rawJid) && !isLidUser(rawJid)) return null
  const phoneJid = key.remoteJidAlt || key.senderPn || key.participantPn
  return jidNormalizedUser(isPnUser(phoneJid) ? phoneJid : rawJid)
}

export function claimMessageId(id, tenantId = currentTenantId()) {
  if (!id) return true
  const processed = getSession(tenantId).processedMessageIds
  if (processed.has(id)) return false
  processed.add(id)
  if (processed.size > MAX_PROCESSED_MESSAGE_IDS) processed.delete(processed.values().next().value)
  return true
}

export async function sendMessage(jid, text, source = 'human', conversationJid = jid, {
  authorUserId = null,
  authorName = null,
  messageType = 'text',
} = {}) {
  const session = getSession()
  if (!session.sock || session.state.status !== 'connected') throw new Error('WhatsApp não está conectado nesta empresa')
  try {
    await session.sock.presenceSubscribe(jid)
    await session.sock.sendPresenceUpdate('composing', jid)
    await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 800 + text.length * 15)))
    await session.sock.sendPresenceUpdate('paused', jid)
  } catch {
    // Presence is cosmetic.
  }
  await session.sock.sendMessage(jid, { text })
  const stored = addMessage(conversationJid, 'out', text, source, { authorUserId, authorName, messageType })
  bus.emit('message', stored)
  return stored
}

export async function sendMediaMessage(jid, {
  buffer,
  mimeType,
  fileName,
  caption = '',
  preferredType = '',
  voiceNote = false,
  authorUserId = null,
  authorName = null,
}, conversationJid = jid) {
  const session = getSession()
  if (!session.sock || session.state.status !== 'connected') throw new Error('WhatsApp não está conectado nesta empresa')
  const messageType = messageTypeForMedia(mimeType, voiceNote ? 'voice' : preferredType)
  const safeName = safeFileName(fileName, messageType === 'audio' ? 'audio' : 'arquivo')
  let content
  if (messageType === 'image' || (messageType === 'gif' && String(mimeType).toLowerCase() === 'image/gif')) {
    content = { image: buffer, caption: String(caption || '').trim(), mimetype: mimeType }
  } else if (messageType === 'video' || messageType === 'gif') {
    content = {
      video: buffer,
      caption: String(caption || '').trim(),
      mimetype: mimeType,
      gifPlayback: messageType === 'gif',
    }
  } else if (messageType === 'audio') {
    content = { audio: buffer, mimetype: mimeType, ptt: Boolean(voiceNote) }
  } else if (messageType === 'sticker') {
    content = { sticker: buffer, mimetype: mimeType }
  } else {
    content = { document: buffer, mimetype: mimeType, fileName: safeName, caption: String(caption || '').trim() }
  }
  await session.sock.sendMessage(jid, content)
  const saved = saveMediaBuffer({
    tenantId: session.tenantId,
    buffer,
    mimeType,
    fileName: safeName,
  })
  const stored = addMediaMessage({
    jid: conversationJid,
    direction: 'out',
    text: String(caption || '').trim(),
    source: 'human',
    messageType,
    mimeType,
    fileName: saved.fileName,
    mediaPath: saved.mediaPath,
    fileSize: saved.fileSize,
    isVoiceNote: Boolean(voiceNote),
    authorUserId,
    authorName,
  })
  bus.emit('message', stored)
  return stored
}

export async function flushPendingAppointmentNotifications() {
  const session = getSession()
  if (!session.sock || session.state.status !== 'connected') return
  for (const notification of listPendingAppointmentNotifications()) {
    try {
      const contact = getContact(notification.jid)
      await sendMessage(contact?.transport_jid || notification.jid, notification.message, 'system', notification.jid)
      markAppointmentNotificationSent(notification.id)
    } catch (err) {
      markAppointmentNotificationError(notification.id, err.message)
      break
    }
  }
}

export async function requestWhatsAppSync({ includeHistory = true } = {}, tenantId = currentTenantId()) {
  const session = getSession(tenantId)
  if (!session.sock || !['connected', 'qr'].includes(session.state.status)) {
    throw new Error('Conecte o WhatsApp antes de iniciar a sincronização.')
  }
  session.syncRequested = true
  setSyncState(session, {
    status: session.state.status === 'qr' ? 'waiting_scan' : 'syncing',
    progress: 0,
    contactsImported: 0,
    customersCreated: 0,
    messagesImported: 0,
    conversationsImported: 0,
    error: null,
    includeHistory: Boolean(includeHistory),
  })
  if (session.state.status === 'connected') await processBufferedSync(session)
  return getWhatsAppState(tenantId).sync
}

function vCardForCustomer(customer) {
  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim()
  const safeName = fullName.replace(/[;\r\n]/g, ' ').trim()
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${safeName}`,
    `N:${customer.last_name || ''};${customer.first_name || ''};;;`,
    `TEL;TYPE=CELL;TYPE=VOICE;waid=${customer.phone}:+${customer.phone}`,
    'END:VCARD',
  ].join('\n')
}

export async function syncCustomerToWhatsApp(customer, tenantId = currentTenantId()) {
  const session = getSession(tenantId)
  if (!session.sock || session.state.status !== 'connected') {
    return { status: 'pending', message: 'Cliente salvo; sincronize quando o WhatsApp estiver conectado.' }
  }
  const matches = await session.sock.onWhatsApp(customer.phone)
  const account = matches?.find((item) => item.exists)
  if (!account?.jid) {
    return { status: 'not_found', message: 'Cliente salvo, mas o número não foi encontrado no WhatsApp.' }
  }
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim()
  upsertContact(jidNormalizedUser(account.jid), name, jidNormalizedUser(account.jid))
  const ownJid = jidNormalizedUser(session.state.user || session.sock.user?.id)
  await session.sock.sendMessage(ownJid, {
    contacts: {
      displayName: name,
      contacts: [{ displayName: name, vcard: vCardForCustomer(customer) }],
    },
  })
  bus.emit('contact_update', { tenantId: session.tenantId, jid: jidNormalizedUser(account.jid) })
  return {
    status: 'contact_card_sent',
    message: 'Cliente salvo e cartão enviado ao seu WhatsApp para adicionar à agenda com um toque.',
  }
}

export async function logoutWhatsApp(tenantId = currentTenantId()) {
  const session = getSession(tenantId)
  clearTimeout(session.reconnectTimer)
  try { await session.sock?.logout() } catch { /* already disconnected */ }
  session.sock = null
  session.suspended = false
  session.starting = false
  session.syncRequested = false
  session.historyComplete = false
  session.historyContacts.clear()
  session.historyMessages.clear()
  clearTimeout(session.syncFinalizeTimer)
  session.state.sync = {
    status: 'idle',
    progress: 0,
    availableContacts: 0,
    availableMessages: 0,
    contactsImported: 0,
    customersCreated: 0,
    messagesImported: 0,
    conversationsImported: 0,
    lastSyncAt: null,
    error: null,
  }
  fs.rmSync(path.join(AUTH_ROOT, String(session.tenantId)), { recursive: true, force: true })
  setState(session, { status: 'disconnected', qr: null, user: null })
  return startWhatsApp(session.tenantId)
}

export function stopWhatsApp(tenantId) {
  const session = getSession(tenantId)
  session.suspended = true
  clearTimeout(session.reconnectTimer)
  try { session.sock?.end?.(new Error('Conta desativada')) } catch { /* socket already closed */ }
  session.sock = null
  session.starting = false
  setState(session, { status: 'disconnected', qr: null, user: null })
}

export function removeWhatsAppTenant(tenantId) {
  const id = Number(tenantId)
  const session = sessions.get(id)
  if (session) {
    session.suspended = true
    clearTimeout(session.reconnectTimer)
    clearTimeout(session.syncFinalizeTimer)
    try { session.sock?.end?.(new Error('Empresa excluída')) } catch { /* socket already closed */ }
    sessions.delete(id)
  }
  fs.rmSync(path.join(AUTH_ROOT, String(id)), { recursive: true, force: true })
  removeTenantMedia(id)
}

function scheduleReconnect(session, delay) {
  clearTimeout(session.reconnectTimer)
  session.reconnectTimer = setTimeout(() => startWhatsApp(session.tenantId), delay)
}

export async function startWhatsApp(tenantId = currentTenantId()) {
  const session = getSession(tenantId)
  if (session.starting) return
  session.suspended = false
  session.starting = true
  return runWithTenant(session.tenantId, async () => {
    try {
      setState(session, { status: 'connecting', qr: null })
      const authDir = path.join(AUTH_ROOT, String(session.tenantId))
      const { state, saveCreds } = await useMultiFileAuthState(authDir)
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))

      session.sock = makeWASocket({
        version, auth: state, logger,
        browser: ['atnva.ia', 'Chrome', '1.0.0'],
        // O histórico chega criptografado do aparelho principal. Ele fica em
        // memória até o usuário autorizar a importação no painel.
        syncFullHistory: true,
        markOnlineOnConnect: true,
      })
      const socket = session.sock
      socket.ev.on('creds.update', saveCreds)

      socket.ev.on('connection.update', (update) => runWithTenant(session.tenantId, async () => {
        if (socket !== session.sock) return
        const { connection, lastDisconnect, qr } = update
        if (qr) {
          const qrImage = await QRCode.toDataURL(qr, { margin: 1, width: 320 })
          setState(session, { status: 'qr', qr: qrImage })
          console.log(`[whatsapp:${session.tenantId}] QR code disponível no painel`)
        }
        if (connection === 'open') {
          setState(session, { status: 'connected', qr: null, user: socket.user?.id ?? null })
          console.log(`[whatsapp:${session.tenantId}] conectado como`, socket.user?.id)
          reconcileExternalAuthorizations(sendMessage).catch((err) => console.error(`[whatsapp:${session.tenantId}] autorizações:`, err.message))
          flushPendingAppointmentNotifications().catch((err) => console.error(`[whatsapp:${session.tenantId}] avisos:`, err.message))
          if (session.syncRequested) processBufferedSync(session)
        }
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode
          const loggedOut = statusCode === DisconnectReason.loggedOut
          if (loggedOut) fs.rmSync(authDir, { recursive: true, force: true })
          setState(session, { status: loggedOut ? 'disconnected' : 'connecting', qr: null, user: loggedOut ? null : session.state.user })
          session.starting = false
          if (!session.suspended) scheduleReconnect(session, loggedOut ? 1000 : 3000)
        }
      }))

      socket.ev.on('contacts.upsert', (contacts) => runWithTenant(session.tenantId, async () => {
        if (socket !== session.sock) return
        bufferSyncPayload(session, { contacts })
        if (session.syncRequested) await processBufferedSync(session)
      }))

      socket.ev.on('contacts.update', (contacts) => runWithTenant(session.tenantId, async () => {
        if (socket !== session.sock) return
        bufferSyncPayload(session, { contacts })
        if (session.syncRequested) await processBufferedSync(session)
      }))

      socket.ev.on('messaging-history.set', (payload) => runWithTenant(session.tenantId, async () => {
        if (socket !== session.sock) return
        bufferSyncPayload(session, payload)
        if (session.syncRequested) await processBufferedSync(session)
      }))

      socket.ev.on('messaging-history.status', ({ status, explicit }) => runWithTenant(session.tenantId, async () => {
        if (socket !== session.sock || status !== 'complete') return
        session.historyComplete = true
        if (session.syncRequested) {
          await processBufferedSync(session)
          if (session.state.sync.status !== 'error') finishSync(session)
        }
        if (!explicit) console.warn(`[whatsapp:${session.tenantId}] histórico finalizado por inatividade`)
      }))

      socket.ev.on('messages.upsert', ({ messages, type }) => runWithTenant(session.tenantId, async () => {
        if (type !== 'notify' || socket !== session.sock) return
        for (const msg of messages) {
          const messageId = msg.key.id
          try {
            if (!msg.message || msg.key.fromMe) continue
            const jid = resolveDirectJid(msg.key)
            if (!jid || !claimMessageId(messageId, session.tenantId)) continue
            const replyJid = jidNormalizedUser(msg.key.remoteJid)
            const text = extractText(msg.message)
            const mediaDescriptor = extractMediaDescriptor(msg.message)
            const preparation = mediaDescriptor
              ? prepareIncomingConversation({ jid, replyJid, name: msg.pushName || null })
              : null
            const storedMessage = mediaDescriptor
              ? await storeIncomingMedia(session, msg, jid, mediaDescriptor)
              : null
            await handleIncoming(
              {
                jid,
                replyJid,
                name: msg.pushName || null,
                text: text || '',
                hasText: Boolean(text?.trim()),
                storedMessage,
                preparation,
              },
              sendMessage
            )
          } catch (err) {
            if (messageId) session.processedMessageIds.delete(messageId)
            console.error(`[whatsapp:${session.tenantId}] mensagem:`, err)
          }
        }
      }))
    } catch (err) {
      console.error(`[whatsapp:${session.tenantId}] falha ao iniciar:`, err)
      setState(session, { status: 'disconnected', qr: null })
      scheduleReconnect(session, 5000)
    } finally {
      session.starting = false
    }
  })
}

export function startAllWhatsApps() {
  for (const tenant of listTenants().filter((item) => item.active)) startWhatsApp(tenant.id)
}
