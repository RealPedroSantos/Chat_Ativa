import {
  appendSmartNote,
  createSmartNote,
  deleteAppointmentRecord,
  findOpenSmartNote,
  getAppointment,
  getCalendarException,
  getContact,
  getSettings,
  hasAppointmentConflict,
  insertAppointment,
  listCalendarExceptions,
  listContactAppointments,
  listWeeklyAvailability,
  updateAppointmentRecord,
} from './db.js'
import { bus } from './bus.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const WEEKDAY_LABELS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const CAPACITY_RESOURCES = '(?:barbeir[oa]s?|profissionais?|atendentes?|m[eé]dic[oa]s?|dentistas?|t[eé]cnic[oa]s?|mec[aâ]nic[oa]s?|salas?|cadeiras?|equipes?|ve[ií]culos?)'
const NUMBER_WORDS = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5,
  seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
}

function normalizedPolicyText(value) {
  return String(value || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim()
}

function capacityNumber(value) {
  const normalized = normalizedPolicyText(value)
  const number = /^\d+$/.test(normalized) ? Number(normalized) : NUMBER_WORDS[normalized]
  return Number.isInteger(number) ? Math.max(1, Math.min(50, number)) : null
}

export function calendarConcurrentCapacity(settings = getSettings()) {
  const text = normalizedPolicyText(`${settings.system_prompt || ''}\n${settings.business_info || ''}`)
  const explicitPatterns = [
    /(?:capacidade|limite)(?:\s+de)?(?:\s+atendimentos?)?(?:\s+simultane[oa]s?)?\s*[:=e]?\s*(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)/,
    /(?:permitir|permite|aceitar|aceita)(?:\s+ate)?\s+(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+(?:agendamentos?|atendimentos?|clientes?)(?:\s+simultane[oa]s?|\s+no mesmo horario)?/,
  ]
  for (const pattern of explicitPatterns) {
    const capacity = capacityNumber(text.match(pattern)?.[1])
    if (capacity) return capacity
  }

  const resourcePattern = new RegExp(`(?:possui|tem|conta com)\\s+(\\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\\s+${CAPACITY_RESOURCES}`)
  const resourceCapacity = capacityNumber(text.match(resourcePattern)?.[1])
  if (resourceCapacity) return resourceCapacity

  if (/(?:permitir|permite|aceitar|aceita).{0,40}(?:varios|multiplos).{0,30}(?:agendamentos?|atendimentos?).{0,40}(?:mesmo horario|simultane)/.test(text)) {
    return 50
  }
  return 1
}

function requireDate(value) {
  if (!DATE_RE.test(String(value || ''))) throw new Error('Data inválida. Use AAAA-MM-DD.')
  const date = new Date(`${value}T12:00:00`)
  if (Number.isNaN(date.getTime()) || localDate(date) !== value) throw new Error('Data inválida.')
  return String(value)
}

function requireTime(value) {
  if (!TIME_RE.test(String(value || ''))) throw new Error('Horário inválido. Use HH:MM.')
  return String(value)
}

function localDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function toMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

function fromMinutes(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

function normalizeDuration(value) {
  const duration = Number(value || 60)
  if (!Number.isInteger(duration) || duration < 15 || duration > 720) throw new Error('Duração deve ficar entre 15 e 720 minutos.')
  return duration
}

function normalizeJid(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.includes('@')) return raw
  const digits = raw.replace(/\D/g, '')
  return digits ? `${digits}@s.whatsapp.net` : null
}

function scheduleForDate(date) {
  requireDate(date)
  const exception = getCalendarException(date)
  const weekday = new Date(`${date}T12:00:00`).getDay()
  const weekly = listWeeklyAvailability().find((row) => row.weekday === weekday)

  if (exception) {
    if (!exception.is_open) return { open: false, source: 'exception', note: exception.note || '', weekday }
    return {
      open: true,
      startTime: exception.start_time || weekly?.start_time || '09:00',
      endTime: exception.end_time || weekly?.end_time || '18:00',
      slotMinutes: weekly?.slot_minutes || 60,
      source: 'exception',
      note: exception.note || '',
      weekday,
    }
  }

  if (!weekly?.enabled) return { open: false, source: 'weekly', note: '', weekday }
  return {
    open: true,
    startTime: weekly.start_time,
    endTime: weekly.end_time,
    slotMinutes: weekly.slot_minutes,
    source: 'weekly',
    note: '',
    weekday,
  }
}

export function getAvailableSlots(date, duration = 60, excludeAppointmentId = 0) {
  date = requireDate(date)
  duration = normalizeDuration(duration)
  const schedule = scheduleForDate(date)
  if (!schedule.open) return { date, open: false, slots: [], schedule }

  const start = toMinutes(requireTime(schedule.startTime))
  const end = toMinutes(requireTime(schedule.endTime))
  if (end <= start) throw new Error('O horário final precisa ser posterior ao inicial.')

  const capacity = calendarConcurrentCapacity()

  const slots = []
  for (let minute = start; minute + duration <= end; minute += schedule.slotMinutes) {
    const time = fromMinutes(minute)
    const slotStart = `${date} ${time}:00`
    const slotEnd = `${date} ${fromMinutes(minute + duration)}:00`
    const busy = hasAppointmentConflict(slotStart, slotEnd, excludeAppointmentId, capacity)
    if (!busy) slots.push(time)
  }
  return { date, open: true, slots, schedule, capacity }
}

function notifyAiAppointment(appointment, action = 'criado') {
  if (!appointment.jid) return
  const text = `Agendamento ${action} pela IA: ${appointment.title} — ${appointment.start_at.slice(0, 16).replace(' ', ' às ')}.`
  const existing = findOpenSmartNote(appointment.jid, 'appointment', 1440)
  const note = existing
    ? appendSmartNote(existing.id, null, text)
    : createSmartNote({
        jid: appointment.jid,
        category: 'appointment',
        title: 'Agendamento administrado pela IA',
        content: `O atendente deve revisar e acompanhar este compromisso.\n• ${text}`,
        messageId: null,
      })
  if (note) bus.emit('note_update', { id: note.id, jid: appointment.jid, action: existing ? 'updated' : 'created' })
}

export function createAppointment(input, { source = 'manual', createdBy = null } = {}) {
  const date = requireDate(input.date)
  const time = requireTime(input.time)
  const duration = normalizeDuration(input.duration)
  const customerName = String(input.customerName || '').trim()
  const title = String(input.title || '').trim()
  if (!customerName) throw new Error('Informe o nome do cliente.')
  if (!title) throw new Error('Informe o motivo do agendamento.')

  const availability = getAvailableSlots(date, duration)
  if (!availability.open) throw new Error('O calendário está fechado nesta data.')
  if (!availability.slots.includes(time)) {
    const alternatives = availability.slots.slice(0, 6).join(', ')
    throw new Error(alternatives ? `Horário indisponível. Horários livres: ${alternatives}.` : 'Não há horários disponíveis nessa data.')
  }

  const startAt = `${date} ${time}:00`
  const endAt = `${date} ${fromMinutes(toMinutes(time) + duration)}:00`
  const capacity = calendarConcurrentCapacity()
  if (hasAppointmentConflict(startAt, endAt, 0, capacity)) {
    throw new Error(`Esse horário atingiu a capacidade de ${capacity} atendimento(s) simultâneo(s).`)
  }

  const appointment = insertAppointment({
    jid: normalizeJid(input.jid),
    customerName,
    title,
    startAt,
    endAt,
    notes: String(input.notes || '').trim(),
    source,
    createdBy,
  })
  bus.emit('calendar_update', { action: 'created', appointment })
  if (source === 'ai') notifyAiAppointment(appointment, 'criado')
  return appointment
}

export function changeAppointment(id, patch, { jidScope = null, source = 'manual' } = {}) {
  const current = getAppointment(Number(id))
  if (!current) throw new Error('Agendamento não encontrado.')
  if (jidScope && current.jid !== jidScope) throw new Error('Agendamento não pertence a este cliente.')

  const currentStart = current.start_at.slice(0, 16)
  const currentDuration = Math.round((new Date(current.end_at.replace(' ', 'T')) - new Date(current.start_at.replace(' ', 'T'))) / 60000)
  const date = requireDate(patch.date || currentStart.slice(0, 10))
  const time = requireTime(patch.time || currentStart.slice(11, 16))
  const duration = normalizeDuration(patch.duration || currentDuration)
  const status = patch.status || current.status
  if (!['scheduled', 'completed', 'cancelled'].includes(status)) throw new Error('Status inválido.')

  if (status === 'scheduled') {
    const availability = getAvailableSlots(date, duration, current.id)
    if (!availability.open || !availability.slots.includes(time)) throw new Error('O novo horário não está disponível.')
  }

  const updated = updateAppointmentRecord(current.id, {
    jid: normalizeJid(patch.jid ?? current.jid),
    customerName: String(patch.customerName ?? current.customer_name).trim(),
    title: String(patch.title ?? current.title).trim(),
    startAt: `${date} ${time}:00`,
    endAt: `${date} ${fromMinutes(toMinutes(time) + duration)}:00`,
    status,
    notes: String(patch.notes ?? current.notes ?? '').trim(),
  })
  bus.emit('calendar_update', { action: 'updated', appointment: updated })
  if (source === 'ai') notifyAiAppointment(updated, status === 'cancelled' ? 'cancelado' : 'alterado')
  return updated
}

export function removeAppointment(id) {
  const appointment = getAppointment(Number(id))
  if (!appointment) throw new Error('Agendamento não encontrado.')
  deleteAppointmentRecord(appointment.id)
  bus.emit('calendar_update', { action: 'deleted', appointment })
  return appointment
}

export function customerAppointments(jid) {
  return listContactAppointments(jid).map((appointment) => ({
    id: appointment.id,
    title: appointment.title,
    date: appointment.start_at.slice(0, 10),
    time: appointment.start_at.slice(11, 16),
    status: appointment.status,
  }))
}

export function calendarContext() {
  const weekly = listWeeklyAvailability()
    .map((row) => row.enabled
      ? `${WEEKDAY_LABELS[row.weekday]}: ${row.start_time}–${row.end_time} (intervalos de ${row.slot_minutes} min)`
      : `${WEEKDAY_LABELS[row.weekday]}: fechado`)
    .join('; ')
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
  const exceptions = listCalendarExceptions(today, '9999-12-31').slice(0, 15)
    .map((item) => item.is_open
      ? `${item.date}: aberto ${item.start_time}–${item.end_time}${item.note ? ` (${item.note})` : ''}`
      : `${item.date}: fechado${item.note ? ` (${item.note})` : ''}`)
    .join('; ')
  const capacity = calendarConcurrentCapacity()
  return {
    today,
    weekly,
    exceptions: exceptions || 'nenhuma exceção futura cadastrada',
    capacity,
    capacityPolicy: capacity > 1
      ? `até ${capacity} atendimentos simultâneos no mesmo horário, conforme o prompt`
      : 'um atendimento por horário',
  }
}

export function contactNameForCalendar(jid) {
  return getContact(jid)?.name || jid.split('@')[0]
}
