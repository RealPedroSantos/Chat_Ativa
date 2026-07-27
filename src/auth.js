import crypto from 'node:crypto'

export function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new Error('O usuário deve ter de 3 a 40 caracteres e usar apenas letras, números, ponto, hífen ou sublinhado.')
  }
  return username
}

export function validatePassword(value) {
  const password = String(value || '')
  if (password.length < 8) throw new Error('A senha deve ter pelo menos 8 caracteres.')
  if (password.length > 200) throw new Error('Senha muito longa.')
  return password
}

export function hashPassword(value) {
  const password = validatePassword(value)
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(value, stored) {
  try {
    const [algorithm, saltHex, hashHex] = String(stored || '').split('$')
    if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false
    const expected = Buffer.from(hashHex, 'hex')
    const actual = crypto.scryptSync(String(value || ''), Buffer.from(saltHex, 'hex'), expected.length)
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export function publicUser(user) {
  if (!user) return null
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    tenantId: user.tenant_id,
    active: Boolean(user.active),
  }
}
