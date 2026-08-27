import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const originalCwd = process.cwd()
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-ativa-conversations-'))
process.chdir(testDir)

const { db, deleteConversations } = await import(`../src/db.js?conversation-test=${Date.now()}`)
const { runWithTenant } = await import('../src/tenant-context.js')

test.after(() => {
  db.close()
  process.chdir(originalCwd)
  fs.rmSync(testDir, { recursive: true, force: true })
})

test('Super Master pode apagar a conversa sem apagar cliente ou agendamento', () => {
  const jid = '5521999999999@s.whatsapp.net'
  const otherTenant = db.prepare("INSERT INTO tenants (name, slug) VALUES ('Outra', 'outra')").run().lastInsertRowid

  db.prepare('INSERT INTO contacts (tenant_id, jid, name) VALUES (1, ?, ?)').run(jid, 'Cliente principal')
  db.prepare('INSERT INTO contacts (tenant_id, jid, name) VALUES (?, ?, ?)').run(otherTenant, jid, 'Mesmo número em outra empresa')
  const messageId = db.prepare("INSERT INTO messages (tenant_id, jid, direction, text) VALUES (1, ?, 'in', 'Olá')").run(jid).lastInsertRowid
  db.prepare("INSERT INTO messages (tenant_id, jid, direction, text) VALUES (?, ?, 'in', 'Preservar')").run(otherTenant, jid)
  db.prepare("INSERT INTO internal_notes (tenant_id, jid, author_name, text) VALUES (1, ?, 'Admin', 'Nota')").run(jid)
  db.prepare("INSERT INTO conversation_cycles (tenant_id, jid) VALUES (1, ?)").run(jid)
  db.prepare("INSERT INTO history_imports (tenant_id, jid, file_name) VALUES (1, ?, 'historico.txt')").run(jid)
  const noteId = db.prepare("INSERT INTO smart_notes (tenant_id, jid, category, title, content) VALUES (1, ?, 'lead', 'Lead', 'Conteúdo')").run(jid).lastInsertRowid
  db.prepare('INSERT INTO smart_note_messages (note_id, message_id) VALUES (?, ?)').run(noteId, messageId)
  db.prepare("INSERT INTO customers (tenant_id, first_name, last_name, phone) VALUES (1, 'Cliente', 'Principal', '5521999999999')").run()
  db.prepare("INSERT INTO appointments (tenant_id, jid, customer_name, title, start_at, end_at) VALUES (1, ?, 'Cliente principal', 'Consulta', '2030-01-01 10:00', '2030-01-01 11:00')").run(jid)

  const result = runWithTenant(1, () => deleteConversations([jid, jid]))

  assert.equal(result.conversations, 1)
  assert.equal(result.messages, 1)
  for (const table of ['contacts', 'messages', 'internal_notes', 'conversation_cycles', 'history_imports', 'smart_notes']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE tenant_id = 1`).get().total, 0, table)
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM smart_note_messages').get().total, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM customers WHERE tenant_id = 1').get().total, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM appointments WHERE tenant_id = 1').get().total, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM contacts WHERE tenant_id = ?').get(otherTenant).total, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM messages WHERE tenant_id = ?').get(otherTenant).total, 1)
})
