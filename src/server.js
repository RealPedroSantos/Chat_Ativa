import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  countUsers, createUser, deleteUser, getUserById, getUserByUsername, listUsers, updateUser, updateUserPassword,
  createTenant, deleteTenants, getTenant, listTenants, updateTenant,
  getSetting, getSettings, setSetting, updateSettings, getContact, listContacts, markContactRead, setContactPaused, getMessageMedia, getMessages, updateMessageText,
  createInternalMessage, createInternalNote, deleteInternalNote, ensureOpenConversationCycle,
  getInternalMessageMedia, listInternalContacts, listInternalMessages, listInternalNotes,
  resolveConversation, transferConversation,
  listCanned, createCanned, updateCanned, deleteCanned,
  listRules, createRule, updateRule, deleteRule,
  listKnowledge, createKnowledge, updateKnowledge, setKnowledgeStatus, deleteKnowledge,
  listSmartNotes, setSmartNoteStatus, deleteSmartNote,
  enqueueAppointmentNotification, getAppointment, listAppointments, listCalendarExceptions, listWeeklyAvailability,
  updateWeeklyAvailability, upsertCalendarException, deleteCalendarException,
  getApiUsageReport,
} from './db.js'
import { hashPassword, normalizeUsername, publicUser, validatePassword, verifyPassword } from './auth.js'
import { changeAppointment, createAppointment, getAvailableSlots, removeAppointment } from './calendar.js'
import {
  flushPendingAppointmentNotifications, getWhatsAppState, logoutWhatsApp,
  removeWhatsAppTenant, requestWhatsAppSync, sendMediaMessage, sendMessage, startWhatsApp, stopWhatsApp, syncCustomerToWhatsApp,
} from './whatsapp.js'
import { MAX_MEDIA_BYTES, resolveMediaPath, safeFileName } from './media.js'
import { messageTypeForMedia, saveMediaBuffer } from './media.js'
import { aiConfigured } from './ai.js'
import { learnFromHumanReply } from './ai-interna.js'
import { learnFromConversations } from './learning.js'
import {
  createCustomer, customerFields, customerFormFields, deleteCustomer, deleteCustomers, exportCustomersTxt,
  listCustomers, parseWhatsAppContactName, updateCustomer,
} from './customers.js'
import { syncPromptKnowledge } from './prompt-knowledge.js'
import { bus } from './bus.js'
import { currentTenantId, runWithTenant } from './tenant-context.js'
import { importWhatsAppExport } from './history-import.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tokens = new Map()

function publicSettings() {
  const { xai_api_key: _secret, ...settings } = getSettings()
  return settings
}

function apiKeySource() {
  if (getSetting('xai_api_key')?.trim()) return 'panel'
  if (process.env.XAI_API_KEY?.trim()) return 'environment'
  return null
}

// AI is ready when the internal engine is selected (no API key needed) or
// when the external provider has a configured key.
function aiReady() {
  return getSetting('ai_provider') === 'interna' || aiConfigured()
}

function safe(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

function validRole(role) {
  return ['admin', 'attendant'].includes(role) ? role : null
}

function normalizeSlug(value) {
  const slug = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  if (slug.length < 3) throw new Error('Informe um identificador válido para a empresa.')
  return slug
}

function appointmentMoment(value) {
  const [date, time = ''] = String(value || '').split(' ')
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year} às ${time.slice(0, 5)}`
}

function appointmentUpdateMessage(previous, updated) {
  return [
    `Olá, ${updated.customer_name}. Seu agendamento foi atualizado.`,
    '',
    `Horário anterior: ${appointmentMoment(previous.start_at)}`,
    `Novo horário: ${appointmentMoment(updated.start_at)}`,
    `Serviço: ${updated.title}`,
    '',
    'Se precisar alterar novamente, responda por aqui.',
  ].join('\n')
}

function appointmentCancellationMessage(appointment) {
  return [
    `Olá, ${appointment.customer_name}. Seu agendamento foi cancelado.`,
    '',
    `Data e horário: ${appointmentMoment(appointment.start_at)}`,
    `Serviço: ${appointment.title}`,
    '',
    'Se desejar marcar um novo horário, responda por aqui.',
  ].join('\n')
}

function renderServiceTemplate(template, {
  customer = 'cliente',
  attendant = 'Atendente',
  newAttendant = 'Atendente',
} = {}) {
  return String(template || '')
    .replaceAll('{cliente}', customer)
    .replaceAll('{atendente}', attendant)
    .replaceAll('{novo_atendente}', newAttendant)
    .trim()
}

function humanMessageText(text, user) {
  const clean = String(text || '').trim()
  if (getSetting('attendant_name_enabled') !== 'true') return clean
  return `*${String(user?.display_name || 'Atendente').replaceAll('*', '')}*\n${clean}`
}

export function createServer() {
  const app = express()
  app.use(express.json())
  app.use(express.static(path.join(__dirname, '..', 'public')))

  function sessionUser(req) {
    const token = req.headers['x-auth-token'] || req.query.token
    const session = token && tokens.get(token)
    const user = session && getUserById(session.userId)
    return user?.active ? user : null
  }

  function requestSession(req) {
    const token = req.headers['x-auth-token'] || req.query.token
    return token ? { token, session: tokens.get(token) } : { token: null, session: null }
  }

  function auth(req, res, next) {
    const { session } = requestSession(req)
    const user = session && getUserById(session.userId)
    if (!user?.active) return res.status(401).json({ error: 'Não autorizado' })
    const tenantId = user.role === 'super_admin' ? Number(session.tenantId || user.tenant_id) : Number(user.tenant_id)
    const tenant = getTenant(tenantId)
    if (!tenant || !tenant.active) return res.status(403).json({ error: 'Esta conta está desativada.' })
    req.user = user
    req.tenantId = tenantId
    req.tenant = tenant
    runWithTenant(tenantId, next)
  }

  function accountAdmin(req, res, next) {
    auth(req, res, () => {
      if (!['super_admin', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Acesso permitido somente ao administrador.' })
      next()
    })
  }

  function superOnly(req, res, next) {
    auth(req, res, () => {
      if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Acesso permitido somente ao Super Master.' })
      next()
    })
  }

  // ---------- authentication ----------
  app.get('/api/auth-status', (req, res) => {
    res.json({ setupRequired: countUsers() === 0, user: publicUser(sessionUser(req)) })
  })

  app.get('/api/auth-required', (_req, res) => res.json({ required: true, setupRequired: countUsers() === 0 }))

  app.post('/api/setup-master', safe((req, res) => {
    if (countUsers() > 0) return res.status(409).json({ error: 'O usuário master já foi configurado.' })
    const username = normalizeUsername(req.body?.username)
    const displayName = String(req.body?.displayName || '').trim()
    if (displayName.length < 2) return res.status(400).json({ error: 'Informe o nome do usuário master.' })
    const user = createUser({ username, displayName, passwordHash: hashPassword(req.body?.password), role: 'super_admin', tenantId: 1 })
    const token = crypto.randomBytes(32).toString('hex')
    tokens.set(token, { userId: user.id, tenantId: 1 })
    res.status(201).json({ token, user: publicUser(user) })
  }))

  app.post('/api/login', (req, res) => {
    const user = getUserByUsername(req.body?.username)
    if (!user?.active || !verifyPassword(req.body?.password, user.password_hash)) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' })
    }
    const token = crypto.randomBytes(32).toString('hex')
    tokens.set(token, { userId: user.id, tenantId: user.tenant_id })
    res.json({ token, user: publicUser(user) })
  })

  app.post('/api/logout', auth, (req, res) => {
    const token = req.headers['x-auth-token']
    if (token) tokens.delete(token)
    res.json({ ok: true })
  })

  // ---------- state / SSE ----------
  app.get('/api/state', auth, (req, res) => {
    const manager = ['super_admin', 'admin'].includes(req.user.role)
    const superAdmin = req.user.role === 'super_admin'
    res.json({
      wa: getWhatsAppState(),
      user: publicUser(req.user),
      tenant: req.tenant,
      tenants: superAdmin ? listTenants() : undefined,
      aiConfigured: manager ? aiReady() : true,
      apiKeySource: superAdmin ? apiKeySource() : (aiConfigured() ? 'central' : null),
      settings: manager ? publicSettings() : undefined,
    })
  })

  app.get('/api/events', auth, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    write('wa_state', getWhatsAppState())

    const listeners = {
      wa_state: (data) => Number(data?.tenantId || data?.tenant_id || currentTenantId()) === req.tenantId && write('wa_state', data),
      message: (data) => Number(data?.tenantId || data?.tenant_id || currentTenantId()) === req.tenantId && write('message', data),
      contact_update: (data) => Number(data?.tenantId || data?.tenant_id || currentTenantId()) === req.tenantId && write('contact_update', data),
      customer_update: (data) => Number(data?.tenantId || data?.tenant_id || currentTenantId()) === req.tenantId && write('customer_update', data),
      conversation_deleted: (data) => Number(data?.tenantId || data?.tenant_id || currentTenantId()) === req.tenantId && write('conversation_deleted', data),
      handoff: (data) => Number(data?.tenantId || data?.tenant_id || currentTenantId()) === req.tenantId && write('handoff', data),
      knowledge_update: (data) => Number(data?.tenantId || data?.tenant_id || currentTenantId()) === req.tenantId && write('knowledge_update', data),
      note_update: (data) => Number(data?.tenantId || data?.tenant_id || currentTenantId()) === req.tenantId && write('note_update', data),
      calendar_update: (data) => Number(data?.tenantId || data?.tenant_id || currentTenantId()) === req.tenantId && write('calendar_update', data),
      service_update: (data) => Number(data?.tenantId || data?.tenant_id || currentTenantId()) === req.tenantId && write('service_update', data),
      unanswered_alert: (data) => Number(data?.tenantId || data?.tenant_id || currentTenantId()) === req.tenantId && write('unanswered_alert', data),
      internal_message: (data) => {
        if (Number(data?.tenantId || data?.tenant_id || currentTenantId()) !== req.tenantId) return
        if ([Number(data?.sender_id), Number(data?.recipient_id)].includes(Number(req.user.id))) write('internal_message', data)
      },
    }
    for (const [event, listener] of Object.entries(listeners)) bus.on(event, listener)

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000)
    req.on('close', () => {
      clearInterval(heartbeat)
      for (const [event, listener] of Object.entries(listeners)) bus.off(event, listener)
    })
  })

  // ---------- Super Master: commercial account control ----------
  app.get('/api/super/tenants', superOnly, (_req, res) => res.json(listTenants()))

  app.post('/api/super/tenants', superOnly, safe((req, res) => {
    const name = String(req.body?.name || '').trim()
    const slug = normalizeSlug(req.body?.slug || name)
    const adminDisplayName = String(req.body?.adminDisplayName || '').trim()
    const adminUsername = normalizeUsername(req.body?.adminUsername)
    if (name.length < 2) return res.status(400).json({ error: 'Informe o nome da empresa.' })
    if (adminDisplayName.length < 2) return res.status(400).json({ error: 'Informe o nome do administrador.' })
    if (getUserByUsername(adminUsername)) return res.status(409).json({ error: 'Este nome de usuário já existe.' })
    const adminPasswordHash = hashPassword(req.body?.adminPassword)
    const tenant = createTenant({ name, slug })
    const admin = createUser({
      tenantId: tenant.id,
      username: adminUsername,
      displayName: adminDisplayName,
      passwordHash: adminPasswordHash,
      role: 'admin',
    })
    startWhatsApp(tenant.id)
    res.status(201).json({ tenant, admin: publicUser(admin) })
  }))

  app.put('/api/super/tenants/:id', superOnly, (req, res) => {
    const tenant = getTenant(Number(req.params.id))
    if (!tenant) return res.status(404).json({ error: 'Empresa não encontrada.' })
    const updated = updateTenant(tenant.id, {
      name: String(req.body?.name || tenant.name).trim(),
      active: req.body?.active !== false && req.body?.active !== 0,
    })
    if (updated.active) startWhatsApp(updated.id)
    else stopWhatsApp(updated.id)
    if (!updated.active && req.tenantId === updated.id) {
      const fallback = listTenants().find((item) => item.active)
      if (!fallback) {
        updateTenant(updated.id, { name: updated.name, active: true })
        return res.status(400).json({ error: 'É necessário manter ao menos uma empresa ativa.' })
      }
      requestSession(req).session.tenantId = fallback.id
    }
    res.json(updated)
  })

  app.delete('/api/super/tenants/bulk', superOnly, (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger))].slice(0, 100)
    if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos uma empresa.' })
    if (ids.includes(1)) return res.status(400).json({ error: 'A empresa principal não pode ser excluída.' })
    if (ids.includes(req.tenantId)) return res.status(400).json({ error: 'Troque de empresa antes de excluir a conta atualmente aberta.' })
    const tenants = ids.map(getTenant)
    if (tenants.some((tenant) => !tenant)) return res.status(404).json({ error: 'Uma ou mais empresas não foram encontradas.' })
    for (const id of ids) removeWhatsAppTenant(id)
    const deleted = deleteTenants(ids)
    for (const session of tokens.values()) {
      if (ids.includes(Number(session.tenantId))) session.tenantId = 1
    }
    res.json({ ok: true, deleted })
  })

  app.delete('/api/super/tenants/:id', superOnly, (req, res) => {
    const id = Number(req.params.id)
    if (id === 1) return res.status(400).json({ error: 'A empresa principal não pode ser excluída.' })
    if (id === req.tenantId) return res.status(400).json({ error: 'Troque de empresa antes de excluir a conta atualmente aberta.' })
    const tenant = getTenant(id)
    if (!tenant) return res.status(404).json({ error: 'Empresa não encontrada.' })
    removeWhatsAppTenant(id)
    const deleted = deleteTenants([id])
    for (const session of tokens.values()) {
      if (Number(session.tenantId) === id) session.tenantId = 1
    }
    res.json({ ok: true, deleted })
  })

  app.post('/api/super/tenants/:id/select', superOnly, (req, res) => {
    const tenant = getTenant(Number(req.params.id))
    if (!tenant?.active) return res.status(404).json({ error: 'Empresa não encontrada ou desativada.' })
    const { session } = requestSession(req)
    session.tenantId = tenant.id
    res.json({ ok: true, tenant })
  })

  // ---------- users (account administrators) ----------
  app.get('/api/users', accountAdmin, (_req, res) => res.json(listUsers()))

  app.post('/api/users', accountAdmin, safe((req, res) => {
    const username = normalizeUsername(req.body?.username)
    const displayName = String(req.body?.displayName || '').trim()
    const role = req.user.role === 'admin' ? 'attendant' : validRole(req.body?.role)
    if (displayName.length < 2) return res.status(400).json({ error: 'Informe o nome do usuário.' })
    if (!role) return res.status(400).json({ error: 'Função inválida.' })
    if (getUserByUsername(username)) return res.status(409).json({ error: 'Este nome de usuário já existe.' })
    const user = createUser({ username, displayName, passwordHash: hashPassword(req.body?.password), role, tenantId: req.tenantId })
    res.status(201).json(publicUser(user))
  }))

  app.put('/api/users/:id', accountAdmin, safe((req, res) => {
    const id = Number(req.params.id)
    const current = getUserById(id)
    if (!current || current.tenant_id !== req.tenantId || current.role === 'super_admin') return res.status(404).json({ error: 'Usuário não encontrado.' })
    const displayName = String(req.body?.displayName || current.display_name).trim()
    const role = req.user.role === 'admin' ? current.role : validRole(req.body?.role || current.role)
    const active = req.body?.active !== false && req.body?.active !== 0
    if (!role || displayName.length < 2) return res.status(400).json({ error: 'Dados do usuário inválidos.' })
    const activeAdmins = listUsers().filter((item) => item.role === 'admin' && item.active)
    const removesLastAdmin = current.role === 'admin' && current.active && (role !== 'admin' || !active) && activeAdmins.length <= 1
    if (removesLastAdmin) return res.status(400).json({ error: 'A empresa precisa manter pelo menos um administrador ativo.' })
    if (id === req.user.id && !active) return res.status(400).json({ error: 'Você não pode desativar seu próprio usuário.' })
    res.json(publicUser(updateUser(id, { displayName, role, active })))
  }))

  app.put('/api/users/:id/password', accountAdmin, safe((req, res) => {
    const id = Number(req.params.id)
    const current = getUserById(id)
    if (!current || current.tenant_id !== req.tenantId || current.role === 'super_admin') return res.status(404).json({ error: 'Usuário não encontrado.' })
    updateUserPassword(id, hashPassword(req.body?.password))
    res.json({ ok: true })
  }))

  app.delete('/api/users/:id', accountAdmin, (req, res) => {
    const id = Number(req.params.id)
    const current = getUserById(id)
    if (!current || current.tenant_id !== req.tenantId || current.role === 'super_admin') return res.status(404).json({ error: 'Usuário não encontrado.' })
    if (id === req.user.id) return res.status(400).json({ error: 'Você não pode excluir seu próprio usuário.' })
    if (current.role === 'admin' && current.active && listUsers().filter((item) => item.role === 'admin' && item.active).length <= 1) {
      return res.status(400).json({ error: 'A empresa precisa manter pelo menos um administrador ativo.' })
    }
    deleteUser(id)
    res.json({ ok: true })
  })
  app.delete('/api/bulk/users', accountAdmin, (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger))].slice(0, 200)
    if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos um usuário.' })
    const targets = ids.map(getUserById)
    if (targets.some((user) => !user || user.tenant_id !== req.tenantId || user.role === 'super_admin')) {
      return res.status(404).json({ error: 'Um ou mais usuários não foram encontrados.' })
    }
    if (ids.includes(req.user.id)) return res.status(400).json({ error: 'Você não pode excluir seu próprio usuário.' })
    const activeAdmins = listUsers().filter((item) => item.role === 'admin' && item.active)
    const removedActiveAdmins = targets.filter((item) => item.role === 'admin' && item.active).length
    if (activeAdmins.length - removedActiveAdmins < 1) {
      return res.status(400).json({ error: 'A empresa precisa manter pelo menos um administrador ativo.' })
    }
    let deleted = 0
    for (const id of ids) if (deleteUser(id)) deleted++
    res.json({ ok: true, deleted })
  })

  // ---------- settings (account administrators) ----------
  app.put('/api/settings', accountAdmin, (req, res) => {
    const patch = { ...(req.body || {}) }
    if (req.user.role === 'super_admin' && typeof patch.xai_api_key === 'string') {
      patch.xai_api_key = patch.xai_api_key.trim()
      if (!patch.xai_api_key) delete patch.xai_api_key
    } else delete patch.xai_api_key
    updateSettings(patch)
    const promptKnowledge = syncPromptKnowledge(getSettings())
    if (promptKnowledge.added || promptKnowledge.removed) {
      bus.emit('knowledge_update', { tenantId: req.tenantId, source: 'prompt', ...promptKnowledge })
    }
    res.json({ ok: true, aiConfigured: aiReady(), apiKeySource: apiKeySource(), settings: publicSettings(), promptKnowledge })
  })

  app.delete('/api/settings/xai-api-key', superOnly, (_req, res) => {
    setSetting('xai_api_key', '')
    res.json({ ok: true, aiConfigured: aiReady(), apiKeySource: apiKeySource() })
  })

  // ---------- API usage and costs (isolated by account) ----------
  app.get('/api/usage', accountAdmin, (req, res) => {
    const today = new Date().toISOString().slice(0, 10)
    const monthStart = `${today.slice(0, 8)}01`
    const from = String(req.query.from || monthStart)
    const to = String(req.query.to || today)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      return res.status(400).json({ error: 'Período inválido.' })
    }
    const days = Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000)
    if (days > 366) return res.status(400).json({ error: 'O relatório pode abranger no máximo 367 dias.' })
    const settings = getSettings()
    res.json({
      from,
      to,
      generatedAt: new Date().toISOString(),
      budgetUsd: Number(settings.api_monthly_budget_usd) || 0,
      alertPercent: Number(settings.api_cost_alert_percent) || 80,
      usdBrlRate: Number(settings.api_usd_brl_rate) || 0,
      ...getApiUsageReport(from, to),
    })
  })

  // ---------- WhatsApp / atendimento ----------
  app.post('/api/whatsapp/logout', auth, safe(async (_req, res) => {
    await logoutWhatsApp()
    res.json({ ok: true })
  }))
  app.post('/api/whatsapp/sync', auth, safe(async (req, res) => {
    const sync = await requestWhatsAppSync({ includeHistory: req.body?.includeHistory !== false })
    res.json({ ok: true, sync })
  }))
  app.post(
    '/api/whatsapp/import-history',
    accountAdmin,
    express.text({ type: ['text/plain', 'application/octet-stream'], limit: '15mb' }),
    safe((req, res) => {
      const jid = String(req.query.jid || '').trim()
      if (!jid) return res.status(400).json({ error: 'Selecione o contato da conversa.' })
      if (!String(req.body || '').trim()) return res.status(400).json({ error: 'Selecione o arquivo .txt exportado pelo WhatsApp.' })
      const decodeHeader = (name, fallback = '') => {
        try { return decodeURIComponent(String(req.headers[name] || fallback)) } catch { return fallback }
      }
      const ownNames = [
        req.user.display_name,
        getSetting('business_name'),
        ...decodeHeader('x-own-names').split(','),
      ]
      const result = importWhatsAppExport({
        jid,
        content: req.body,
        fileName: safeFileName(decodeHeader('x-file-name', 'conversa-do-whatsapp.txt')),
        ownNames,
        importedBy: req.user.id,
        contactName: getContact(jid)?.name || '',
      })
      bus.emit('contact_update', { jid, source: 'manual_history' })
      res.status(201).json({ ok: true, ...result })
    })
  )

  app.get('/api/contacts', auth, (_req, res) => res.json(listContacts()))
  app.get('/api/attendants', auth, (_req, res) => {
    res.json(listUsers().filter((user) => user.active && ['admin', 'attendant'].includes(user.role)))
  })
  app.post('/api/contacts/:jid/read', auth, (req, res) => {
    const jid = String(req.params.jid || '').trim()
    if (!jid || !markContactRead(jid)) return res.status(404).json({ error: 'Contato não encontrado.' })
    res.json({ ok: true })
  })
  app.post('/api/contacts/:jid/pause', auth, (req, res) => {
    setContactPaused(req.params.jid, Boolean(req.body?.paused))
    bus.emit('contact_update', { jid: req.params.jid })
    res.json({ ok: true })
  })
  app.post('/api/contacts/:jid/resolve', auth, safe(async (req, res) => {
    const jid = String(req.params.jid || '').trim()
    const contact = getContact(jid)
    if (!contact) return res.status(404).json({ error: 'Contato não encontrado.' })
    ensureOpenConversationCycle(jid, req.user.id)
    const template = String(req.body?.message || getSetting('resolved_message')).trim()
    const message = renderServiceTemplate(template, {
      customer: contact.name || 'cliente',
      attendant: req.user.display_name,
    })
    if (message) {
      await sendMessage(
        contact.transport_jid || jid,
        message,
        'system',
        jid,
        { authorUserId: req.user.id, authorName: req.user.display_name, messageType: 'system_event' }
      )
    }
    const updated = resolveConversation(jid, req.user.id)
    bus.emit('service_update', { jid, action: 'resolved', contact: updated })
    bus.emit('contact_update', { jid })
    res.json({ ok: true, contact: updated })
  }))
  app.post('/api/contacts/:jid/transfer', auth, safe(async (req, res) => {
    const jid = String(req.params.jid || '').trim()
    const contact = getContact(jid)
    const target = getUserById(Number(req.body?.userId))
    if (!contact) return res.status(404).json({ error: 'Contato não encontrado.' })
    if (!target || target.tenant_id !== req.tenantId || !target.active || !['admin', 'attendant'].includes(target.role)) {
      return res.status(400).json({ error: 'Selecione um atendente ativo.' })
    }
    ensureOpenConversationCycle(jid, req.user.id)
    const template = String(req.body?.message || getSetting('transfer_message')).trim()
    const message = renderServiceTemplate(template, {
      customer: contact.name || 'cliente',
      attendant: req.user.display_name,
      newAttendant: target.display_name,
    })
    if (message) {
      await sendMessage(
        contact.transport_jid || jid,
        message,
        'system',
        jid,
        { authorUserId: req.user.id, authorName: req.user.display_name, messageType: 'system_event' }
      )
    }
    const result = transferConversation(jid, target.id)
    bus.emit('service_update', { jid, action: 'transferred', userId: target.id, userName: target.display_name })
    bus.emit('contact_update', { jid })
    res.json({ ok: true, ...result })
  }))
  app.get('/api/messages', auth, (req, res) => res.json(getMessages(String(req.query.jid || ''), 200)))
  app.delete('/api/messages/:id', auth, (_req, res) => {
    res.status(405).json({ error: 'Mensagens do histórico permanente não podem ser apagadas.' })
  })
  app.patch('/api/messages/:id', auth, (req, res) => {
    const id = Number(req.params.id)
    const text = String(req.body?.text ?? '').trim()
    if (!id) return res.status(400).json({ error: 'ID de mensagem inválido.' })
    if (!text) return res.status(400).json({ error: 'O texto não pode ser vazio.' })
    const result = updateMessageText(id, text)
    if (!result.changes) return res.status(404).json({ error: 'Mensagem não encontrada.' })
    res.json({ ok: true, text })
  })
  app.get('/api/messages/:id/media', auth, (req, res) => {
    const media = getMessageMedia(Number(req.params.id))
    if (!media?.media_path) return res.status(404).json({ error: 'Arquivo não encontrado.' })
    const absolutePath = resolveMediaPath(media.media_path, req.tenantId)
    if (!absolutePath || !fs.existsSync(absolutePath)) return res.status(404).json({ error: 'Arquivo não encontrado.' })
    const fileName = safeFileName(media.file_name, 'arquivo').replaceAll('"', '')
    const headerFileName = fileName.replace(/[^\x20-\x7e]/g, '_')
    res.type(media.mime_type || 'application/octet-stream')
    res.setHeader('Content-Disposition', `inline; filename="${headerFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    res.sendFile(absolutePath)
  })
  app.delete('/api/conversations/bulk', accountAdmin, (_req, res) => {
    res.status(405).json({ error: 'Conversas de clientes são permanentes e não podem ser apagadas.' })
  })
  app.delete('/api/conversations/:jid', accountAdmin, (_req, res) => {
    res.status(405).json({ error: 'Conversas de clientes são permanentes e não podem ser apagadas.' })
  })
  app.post('/api/send', auth, safe(async (req, res) => {
    const { jid, text } = req.body || {}
    if (!jid || !text?.trim()) return res.status(400).json({ error: 'jid e text são obrigatórios' })
    const contact = getContact(jid)
    if (!contact) return res.status(404).json({ error: 'Contato não encontrado.' })
    ensureOpenConversationCycle(jid, req.user.id)
    // Aprendizado em tempo real da IA interna: a resposta do atendente humano
    // à última pergunta do cliente vira conhecimento (pendente ou aprovado).
    const settings = getSettings()
    if (settings.learning_enabled === 'true') {
      try {
        learnFromHumanReply({ jid, answerText: text.trim(), settings })
      } catch (err) {
        console.error('[ia-interna] falha ao aprender com a resposta humana:', err.message)
      }
    }
    const outgoingText = humanMessageText(text, req.user)
    await sendMessage(
      contact?.transport_jid || jid,
      outgoingText,
      'human',
      jid,
      { authorUserId: req.user.id, authorName: req.user.display_name }
    )
    res.json({ ok: true })
  }))
  app.post(
    '/api/send-media',
    auth,
    express.raw({ type: 'application/octet-stream', limit: MAX_MEDIA_BYTES }),
    safe(async (req, res) => {
      const jid = String(req.query.jid || '').trim()
      if (!jid) return res.status(400).json({ error: 'Selecione uma conversa.' })
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Selecione um arquivo.' })
      const decodeHeader = (name, fallback = '') => {
        try { return decodeURIComponent(String(req.headers[name] || fallback)) } catch { return fallback }
      }
      const mimeType = decodeHeader('x-media-mime', 'application/octet-stream').slice(0, 150)
      const fileName = safeFileName(decodeHeader('x-file-name', 'arquivo'))
      const rawCaption = decodeHeader('x-media-caption', '').slice(0, 4000)
      const caption = rawCaption ? humanMessageText(rawCaption, req.user) : ''
      const preferredType = decodeHeader('x-media-kind', '').slice(0, 30)
      const voiceNote = req.headers['x-voice-note'] === 'true'
      const contact = getContact(jid)
      if (!contact) return res.status(404).json({ error: 'Contato não encontrado.' })
      ensureOpenConversationCycle(jid, req.user.id)
      const message = await sendMediaMessage(
        contact?.transport_jid || jid,
        {
          buffer: req.body, mimeType, fileName, caption, preferredType, voiceNote,
          authorUserId: req.user.id, authorName: req.user.display_name,
        },
        jid
      )
      res.status(201).json({ ok: true, message })
    })
  )

  // ---------- shared notes in customer conversations ----------
  app.get('/api/internal-notes', auth, (req, res) => {
    const jid = String(req.query.jid || '').trim()
    if (!jid) return res.status(400).json({ error: 'Selecione uma conversa.' })
    res.json(listInternalNotes(jid))
  })
  app.post('/api/internal-notes', auth, (req, res) => {
    const jid = String(req.body?.jid || '').trim()
    const text = String(req.body?.text || '').trim()
    if (!getContact(jid)) return res.status(404).json({ error: 'Contato não encontrado.' })
    if (!text) return res.status(400).json({ error: 'Escreva a nota interna.' })
    const note = createInternalNote({
      jid,
      text: text.slice(0, 8000),
      authorId: req.user.id,
      authorName: req.user.display_name,
    })
    bus.emit('note_update', { jid, action: 'internal_note_created', note })
    res.status(201).json(note)
  })
  app.delete('/api/internal-notes/:id', auth, (req, res) => {
    const result = deleteInternalNote(Number(req.params.id), req.user)
    if (result.forbidden) return res.status(403).json({ error: 'Você só pode apagar suas próprias notas.' })
    if (!result.deleted) return res.status(404).json({ error: 'Nota não encontrada.' })
    bus.emit('note_update', { action: 'internal_note_deleted', id: Number(req.params.id) })
    res.json({ ok: true })
  })

  // ---------- direct internal team chat ----------
  app.get('/api/internal/contacts', auth, (req, res) => res.json(listInternalContacts(req.user.id)))
  app.get('/api/internal/messages', auth, (req, res) => {
    const otherUserId = Number(req.query.userId)
    if (!otherUserId) return res.status(400).json({ error: 'Selecione um usuário.' })
    res.json(listInternalMessages(req.user.id, otherUserId))
  })
  app.post('/api/internal/send', auth, (req, res) => {
    const recipientId = Number(req.body?.userId)
    const text = String(req.body?.text || '').trim()
    if (!recipientId || !text) return res.status(400).json({ error: 'Destinatário e mensagem são obrigatórios.' })
    const message = createInternalMessage({
      senderId: req.user.id,
      senderName: req.user.display_name,
      recipientId,
      text: text.slice(0, 8000),
    })
    if (!message) return res.status(404).json({ error: 'Usuário não encontrado.' })
    bus.emit('internal_message', message)
    res.status(201).json(message)
  })
  app.post(
    '/api/internal/send-media',
    auth,
    express.raw({ type: 'application/octet-stream', limit: MAX_MEDIA_BYTES }),
    (req, res) => {
      const recipientId = Number(req.query.userId)
      if (!recipientId) return res.status(400).json({ error: 'Selecione um usuário.' })
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Selecione um arquivo.' })
      const decodeHeader = (name, fallback = '') => {
        try { return decodeURIComponent(String(req.headers[name] || fallback)) } catch { return fallback }
      }
      const mimeType = decodeHeader('x-media-mime', 'audio/webm').slice(0, 150)
      const fileName = safeFileName(decodeHeader('x-file-name', 'mensagem-de-voz.webm'))
      const preferredType = decodeHeader('x-media-kind', '').slice(0, 30)
      const caption = decodeHeader('x-media-caption', '').slice(0, 8000)
      const voiceNote = req.headers['x-voice-note'] === 'true'
      const saved = saveMediaBuffer({ tenantId: req.tenantId, buffer: req.body, mimeType, fileName })
      const message = createInternalMessage({
        senderId: req.user.id,
        senderName: req.user.display_name,
        recipientId,
        text: caption,
        messageType: messageTypeForMedia(mimeType, voiceNote ? 'voice' : preferredType),
        mimeType,
        fileName: saved.fileName,
        mediaPath: saved.mediaPath,
        fileSize: saved.fileSize,
        isVoiceNote: voiceNote,
      })
      if (!message) return res.status(404).json({ error: 'Usuário não encontrado.' })
      bus.emit('internal_message', message)
      res.status(201).json(message)
    }
  )
  app.get('/api/internal/messages/:id/media', auth, (req, res) => {
    const media = getInternalMessageMedia(Number(req.params.id), req.user.id)
    if (!media?.media_path) return res.status(404).json({ error: 'Arquivo não encontrado.' })
    const absolutePath = resolveMediaPath(media.media_path, req.tenantId)
    if (!absolutePath) return res.status(404).json({ error: 'Arquivo não encontrado.' })
    res.type(media.mime_type || 'application/octet-stream')
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(media.file_name || 'audio')}`)
    res.sendFile(absolutePath)
  })

  // ---------- customer database ----------
  app.get('/api/customers', auth, (_req, res) => {
    res.json({ items: listCustomers(), fields: customerFields(), formFields: customerFormFields() })
  })
  app.get('/api/customer-draft', auth, (req, res) => {
    const jid = String(req.query.jid || '').trim()
    const contact = getContact(jid)
    if (!contact) return res.status(404).json({ error: 'Contato não encontrado.' })
    const parsed = parseWhatsAppContactName(contact.whatsapp_name_raw || contact.name)
    res.json({
      name: parsed.fullName,
      phone: jid.split('@')[0],
      extras: parsed.extras,
      originalName: parsed.rawName,
    })
  })
  app.post('/api/customers', auth, safe(async (req, res) => {
    const customer = createCustomer(req.body || {})
    let whatsappSync
    try {
      whatsappSync = await syncCustomerToWhatsApp(customer)
    } catch (err) {
      whatsappSync = { status: 'error', message: `Cliente salvo, mas a sincronização com o WhatsApp falhou: ${err.message}` }
    }
    bus.emit('customer_update', { tenantId: req.tenantId, id: customer.id, action: 'created' })
    res.status(201).json({ ...customer, whatsappSync })
  }))
  app.put('/api/customers/:id', auth, safe((req, res) => {
    const customer = updateCustomer(Number(req.params.id), req.body || {})
    bus.emit('customer_update', { tenantId: req.tenantId, id: customer.id, action: 'updated' })
    res.json(customer)
  }))
  app.delete('/api/customers/bulk', accountAdmin, (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos um cliente.' })
    const deleted = deleteCustomers(ids)
    bus.emit('customer_update', { tenantId: req.tenantId, ids, action: 'bulk_deleted' })
    res.json({ ok: true, deleted })
  })
  app.delete('/api/customers/:id', accountAdmin, safe((req, res) => {
    const id = Number(req.params.id)
    deleteCustomer(id)
    bus.emit('customer_update', { tenantId: req.tenantId, id, action: 'deleted' })
    res.json({ ok: true })
  }))
  app.get('/api/customers-export.txt', auth, (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="clientes.txt"')
    res.send(exportCustomersTxt())
  })

  // ---------- smart notes ----------
  app.get('/api/notes', auth, (req, res) => {
    const status = ['open', 'done'].includes(req.query.status) ? req.query.status : null
    res.json(listSmartNotes(status))
  })
  app.put('/api/notes/:id/status', auth, (req, res) => {
    const status = req.body?.status
    if (!['open', 'done'].includes(status)) return res.status(400).json({ error: 'Status inválido' })
    const note = setSmartNoteStatus(Number(req.params.id), status)
    if (!note) return res.status(404).json({ error: 'Anotação não encontrada' })
    bus.emit('note_update', { id: note.id, jid: note.jid, action: status })
    res.json({ ok: true, note })
  })
  app.delete('/api/notes/:id', auth, (req, res) => {
    const id = Number(req.params.id)
    deleteSmartNote(id)
    bus.emit('note_update', { id, action: 'deleted' })
    res.json({ ok: true })
  })
  app.delete('/api/bulk/notes', auth, (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger))].slice(0, 500)
    if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos uma nota.' })
    for (const id of ids) deleteSmartNote(id)
    bus.emit('note_update', { ids, action: 'bulk_deleted' })
    res.json({ ok: true, deleted: ids.length })
  })

  // ---------- intelligent calendar ----------
  app.get('/api/calendar/hours', auth, (_req, res) => res.json(listWeeklyAvailability()))
  app.put('/api/calendar/hours/:weekday', auth, (req, res) => {
    const weekday = Number(req.params.weekday)
    const { enabled, startTime, endTime, slotMinutes } = req.body || {}
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return res.status(400).json({ error: 'Dia da semana inválido.' })
    if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || startTime >= endTime) {
      return res.status(400).json({ error: 'Informe um intervalo de horário válido.' })
    }
    const slot = Number(slotMinutes)
    if (!Number.isInteger(slot) || slot < 15 || slot > 240) return res.status(400).json({ error: 'Intervalo deve ficar entre 15 e 240 minutos.' })
    const row = updateWeeklyAvailability(weekday, { enabled, startTime, endTime, slotMinutes: slot })
    bus.emit('calendar_update', { action: 'availability', weekday })
    res.json(row)
  })

  app.get('/api/calendar/exceptions', auth, (req, res) => {
    res.json(listCalendarExceptions(String(req.query.from || '0000-01-01'), String(req.query.to || '9999-12-31')))
  })
  app.put('/api/calendar/exceptions/:date', auth, (req, res) => {
    const date = req.params.date
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Data inválida.' })
    const isOpen = Boolean(req.body?.isOpen)
    if (isOpen && (!/^\d{2}:\d{2}$/.test(req.body?.startTime) || !/^\d{2}:\d{2}$/.test(req.body?.endTime) || req.body.startTime >= req.body.endTime)) {
      return res.status(400).json({ error: 'Informe os horários de abertura e fechamento.' })
    }
    const exception = upsertCalendarException({
      date, isOpen,
      startTime: isOpen ? req.body.startTime : null,
      endTime: isOpen ? req.body.endTime : null,
      note: String(req.body?.note || '').trim(),
    })
    bus.emit('calendar_update', { action: 'exception', date })
    res.json(exception)
  })
  app.delete('/api/calendar/exceptions/:date', auth, (req, res) => {
    deleteCalendarException(req.params.date)
    bus.emit('calendar_update', { action: 'exception_deleted', date: req.params.date })
    res.json({ ok: true })
  })
  app.delete('/api/bulk/calendar-exceptions', auth, (req, res) => {
    const dates = [...new Set((Array.isArray(req.body?.dates) ? req.body.dates : []).map(String).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].slice(0, 366)
    if (!dates.length) return res.status(400).json({ error: 'Selecione ao menos uma data especial.' })
    for (const date of dates) deleteCalendarException(date)
    bus.emit('calendar_update', { dates, action: 'exceptions_bulk_deleted' })
    res.json({ ok: true, deleted: dates.length })
  })

  app.get('/api/calendar/slots', auth, safe((req, res) => {
    res.json(getAvailableSlots(String(req.query.date || ''), Number(req.query.duration || 60), Number(req.query.excludeId || 0)))
  }))
  app.get('/api/appointments', auth, (req, res) => {
    const from = String(req.query.from || '0000-01-01')
    const to = String(req.query.to || '9999-12-31')
    res.json(listAppointments(`${from} 00:00:00`, `${to} 00:00:00`))
  })
  app.post('/api/appointments', auth, safe((req, res) => {
    const appointment = createAppointment(req.body || {}, { source: 'manual', createdBy: req.user.id })
    res.status(201).json(appointment)
  }))
  app.put('/api/appointments/:id', auth, safe(async (req, res) => {
    const id = Number(req.params.id)
    const previous = getAppointment(id)
    const appointment = changeAppointment(id, req.body || {})
    const scheduleChanged = Boolean(previous)
      && (previous.start_at !== appointment.start_at || previous.end_at !== appointment.end_at)
    const wasCancelled = Boolean(previous)
      && previous.status !== 'cancelled' && appointment.status === 'cancelled'
    const shouldNotifyCustomer = wasCancelled || (scheduleChanged && appointment.status === 'scheduled')
    let customerNotification = { status: 'not_needed' }

    if (shouldNotifyCustomer) {
      if (!appointment.jid) {
        customerNotification = {
          status: 'missing_phone',
          message: wasCancelled
            ? 'Agendamento cancelado, mas o cliente não possui telefone vinculado.'
            : 'Agendamento atualizado, mas o cliente não possui telefone vinculado.',
        }
      } else {
        const message = wasCancelled
          ? appointmentCancellationMessage(appointment)
          : appointmentUpdateMessage(previous, appointment)
        const contact = getContact(appointment.jid)
        try {
          const sent = await sendMessage(contact?.transport_jid || appointment.jid, message, 'system', appointment.jid)
          customerNotification = { status: 'sent', messageId: sent.id }
        } catch (err) {
          const queued = enqueueAppointmentNotification({
            appointmentId: appointment.id,
            jid: appointment.jid,
            message,
            error: err.message,
          })
          customerNotification = { status: 'queued', notificationId: queued.id }
          flushPendingAppointmentNotifications().catch(() => {})
        }
      }
    }

    res.json({ ...appointment, customerNotification })
  }))
  app.delete('/api/appointments/:id', auth, safe((req, res) => {
    res.json({ ok: true, appointment: removeAppointment(Number(req.params.id)) })
  }))
  app.delete('/api/bulk/appointments', auth, safe((req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger))].slice(0, 500)
    if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos um agendamento.' })
    const appointments = ids.map((id) => removeAppointment(id))
    res.json({ ok: true, deleted: appointments.length, appointments })
  }))

  // ---------- account automation/content ----------
  app.get('/api/canned', accountAdmin, (_req, res) => res.json(listCanned()))
  app.post('/api/canned', accountAdmin, (req, res) => { createCanned(req.body); res.json({ ok: true }) })
  app.put('/api/canned/:id', accountAdmin, (req, res) => { updateCanned(Number(req.params.id), req.body); res.json({ ok: true }) })
  app.delete('/api/canned/:id', accountAdmin, (req, res) => { deleteCanned(Number(req.params.id)); res.json({ ok: true }) })
  app.delete('/api/bulk/canned', accountAdmin, (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger))].slice(0, 500)
    if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos uma resposta pronta.' })
    for (const id of ids) deleteCanned(id)
    res.json({ ok: true, deleted: ids.length })
  })

  app.get('/api/rules', accountAdmin, (_req, res) => res.json(listRules()))
  app.post('/api/rules', accountAdmin, (req, res) => { createRule(req.body); res.json({ ok: true }) })
  app.put('/api/rules/:id', accountAdmin, (req, res) => { updateRule(Number(req.params.id), req.body); res.json({ ok: true }) })
  app.delete('/api/rules/:id', accountAdmin, (req, res) => { deleteRule(Number(req.params.id)); res.json({ ok: true }) })
  app.delete('/api/bulk/rules', accountAdmin, (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger))].slice(0, 500)
    if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos uma regra.' })
    for (const id of ids) deleteRule(id)
    res.json({ ok: true, deleted: ids.length })
  })

  app.get('/api/knowledge', accountAdmin, (req, res) => res.json(listKnowledge(req.query.status || null)))
  app.post('/api/knowledge', accountAdmin, (req, res) => {
    createKnowledge({ ...req.body, source: 'manual', status: 'approved' })
    res.json({ ok: true })
  })
  app.put('/api/knowledge/:id', accountAdmin, (req, res) => { updateKnowledge(Number(req.params.id), req.body); res.json({ ok: true }) })
  app.post('/api/knowledge/:id/approve', accountAdmin, (req, res) => { setKnowledgeStatus(Number(req.params.id), 'approved'); res.json({ ok: true }) })
  app.post('/api/knowledge/:id/reject', accountAdmin, (req, res) => { deleteKnowledge(Number(req.params.id)); res.json({ ok: true }) })
  app.delete('/api/knowledge/:id', accountAdmin, (req, res) => { deleteKnowledge(Number(req.params.id)); res.json({ ok: true }) })
  app.delete('/api/bulk/knowledge', accountAdmin, (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger))].slice(0, 500)
    if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos um conhecimento.' })
    for (const id of ids) deleteKnowledge(id)
    bus.emit('knowledge_update', { ids, action: 'bulk_deleted' })
    res.json({ ok: true, deleted: ids.length })
  })
  app.post('/api/learn', accountAdmin, safe(async (_req, res) => res.json(await learnFromConversations({ force: true }))))

  app.use((err, _req, res, _next) => {
    res.status(400).json({ error: err.message || 'Erro interno.' })
  })

  return app
}
