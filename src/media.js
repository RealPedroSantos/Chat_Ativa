import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DATA_ROOT = path.resolve(process.cwd(), 'data')
const MEDIA_ROOT = path.join(DATA_ROOT, 'media')
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024

fs.mkdirSync(MEDIA_ROOT, { recursive: true })

const MIME_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'application/zip': '.zip',
}

export function safeFileName(value, fallback = 'arquivo') {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || fallback).slice(0, 180)
}

export function messageTypeForMedia(mimeType = '', preferred = '') {
  if (preferred === 'sticker') return 'sticker'
  if (preferred === 'gif') return 'gif'
  if (preferred === 'voice') return 'audio'
  const mime = String(mimeType).toLowerCase()
  if (mime === 'image/gif') return 'gif'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'document'
}

export function saveMediaBuffer({ tenantId, buffer, mimeType, fileName }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('O arquivo está vazio.')
  if (buffer.length > MAX_MEDIA_BYTES) throw new Error('O arquivo excede o limite de 25 MB.')
  const id = Number(tenantId)
  if (!Number.isInteger(id) || id < 1) throw new Error('Empresa inválida para armazenar o arquivo.')
  const safeName = safeFileName(fileName)
  const originalExtension = path.extname(safeName).toLowerCase().replace(/[^a-z0-9.]/g, '')
  const extension = originalExtension || MIME_EXTENSIONS[String(mimeType || '').toLowerCase()] || '.bin'
  const tenantDirectory = path.join(MEDIA_ROOT, String(id))
  fs.mkdirSync(tenantDirectory, { recursive: true })
  const storedName = `${Date.now()}-${crypto.randomUUID()}${extension}`
  const absolutePath = path.join(tenantDirectory, storedName)
  fs.writeFileSync(absolutePath, buffer, { flag: 'wx' })
  return {
    mediaPath: `${id}/${storedName}`,
    fileName: safeName,
    fileSize: buffer.length,
  }
}

export function resolveMediaPath(mediaPath, tenantId) {
  const normalized = String(mediaPath || '').replaceAll('\\', '/')
  const prefix = `${Number(tenantId)}/`
  if (!normalized.startsWith(prefix) || normalized.includes('../')) return null
  const absolutePath = path.resolve(MEDIA_ROOT, normalized)
  const tenantRoot = path.resolve(MEDIA_ROOT, String(Number(tenantId))) + path.sep
  return absolutePath.startsWith(tenantRoot) && fs.existsSync(absolutePath) ? absolutePath : null
}

export function removeTenantMedia(tenantId) {
  fs.rmSync(path.join(MEDIA_ROOT, String(Number(tenantId))), { recursive: true, force: true })
}
