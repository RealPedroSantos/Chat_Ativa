import { EventEmitter } from 'node:events'

// Global event bus: whatsapp/pipeline emit, SSE endpoint relays to the dashboard.
export const bus = new EventEmitter()
bus.setMaxListeners(100)
