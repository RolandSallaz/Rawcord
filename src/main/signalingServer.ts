/**
 * Pure WebSocket relay server — no WebRTC/SFU.
 *
 * Text frames (JSON):
 *   C→S: join | announce | chat | leave
 *   S→C: welcome | participant-joined | participant-left | participant-updated | chat
 *
 * Binary frames:
 *   C→S: raw PCM Int16 audio (960 samples, 48 kHz mono = 20 ms)
 *   S→C: [36-byte ASCII sender UUID] + same PCM data
 */
import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import { createServer, Server as HttpServer } from 'http'

export interface ParticipantInfo {
  id: string
  nickname: string
  avatar?: string
}

interface RoomClient extends ParticipantInfo {
  ws: WebSocket
  isAlive: boolean
}

class Room {
  private clients = new Map<string, RoomClient>()

  add(id: string, ws: WebSocket, info: ParticipantInfo) {
    this.clients.set(id, { ...info, ws, isAlive: true })
    // Notify existing members
    this.broadcast({ type: 'participant-joined', participant: info }, id)
  }

  remove(id: string): ParticipantInfo | undefined {
    const c = this.clients.get(id)
    this.clients.delete(id)
    if (c) this.broadcast({ type: 'participant-left', id })
    return c
  }

  update(id: string, info: Partial<ParticipantInfo>) {
    const c = this.clients.get(id)
    if (!c) return
    Object.assign(c, info)
    this.broadcast({ type: 'participant-updated', participant: { ...c, ws: undefined } }, id)
  }

  list(): ParticipantInfo[] {
    return [...this.clients.values()].map(({ id, nickname, avatar }) => ({ id, nickname, avatar }))
  }

  get(id: string) { return this.clients.get(id) }

  broadcast(msg: object, excludeId?: string) {
    const data = JSON.stringify(msg)
    for (const [id, c] of this.clients) {
      if (id === excludeId) continue
      try { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data) } catch {}
    }
  }

  broadcastBinary(buf: Buffer, excludeId: string) {
    for (const [id, c] of this.clients) {
      if (id === excludeId) continue
      try { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(buf, { binary: true }) } catch {}
    }
  }

  get size() { return this.clients.size }
}

const rooms = new Map<string, Room>()
let wss: WebSocketServer | null = null
let httpServer: HttpServer | null = null

function getOrCreateRoom(channel: string): Room {
  let room = rooms.get(channel)
  if (!room) { room = new Room(); rooms.set(channel, room) }
  return room
}

function safeSend(ws: WebSocket, msg: object) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)) } catch {}
}

interface TaggedWS extends WebSocket {
  _peerId?: string
  _channel?: string
  _nickname?: string
  _avatar?: string
  isAlive?: boolean
}

function handleLeave(ws: TaggedWS) {
  const { _channel, _peerId } = ws
  if (!_channel || !_peerId) return
  const room = rooms.get(_channel)
  if (!room) return
  room.remove(_peerId)
  if (room.size === 0) rooms.delete(_channel)
  ws._channel = undefined
}

export function startServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (wss) return resolve()

    const timer = setTimeout(() => reject(new Error('Server start timeout')), 3000)
    httpServer = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
    wss = new WebSocketServer({ server: httpServer })

    wss.on('connection', (ws: TaggedWS) => {
      ws.isAlive = true
      ws.on('pong', () => { ws.isAlive = true })
      ws._peerId = randomUUID()

      ws.on('message', (raw, isBinary) => {
        const id = ws._peerId!

        // Binary = audio frame, relay immediately
        if (isBinary) {
          const channel = ws._channel
          if (!channel) return
          const room = rooms.get(channel)
          if (!room) return
          // Prepend 36-byte sender ID so clients know who is speaking
          const idBuf = Buffer.from(id.padEnd(36).slice(0, 36), 'ascii')
          const frame = Buffer.concat([idBuf, raw as Buffer])
          room.broadcastBinary(frame, id)
          return
        }

        let msg: Record<string, unknown>
        try { msg = JSON.parse(raw.toString()) } catch { return }

        try {
          switch (msg.type) {
            case 'join': {
              const { channel, nickname, avatar } = msg as { channel: string; nickname: string; avatar?: string }
              if (!channel || !nickname) return
              handleLeave(ws)
              ws._channel = channel
              ws._nickname = nickname
              ws._avatar = avatar
              const room = getOrCreateRoom(channel)
              const existing = room.list()
              room.add(id, ws, { id, nickname, avatar })
              safeSend(ws, { type: 'welcome', id, participants: existing })
              break
            }

            case 'announce': {
              const { nickname, avatar } = msg as { nickname: string; avatar?: string }
              if (!nickname || !ws._channel) return
              ws._nickname = nickname
              ws._avatar = avatar
              rooms.get(ws._channel)?.update(id, { nickname, avatar })
              break
            }

            case 'chat': {
              const { text } = msg as { text: string }
              if (!text || !ws._channel) return
              rooms.get(ws._channel)?.broadcast({
                type: 'chat', from: id, text,
                nickname: ws._nickname ?? 'unknown',
                avatar: ws._avatar,
              }, id)
              break
            }

            case 'leave':
              handleLeave(ws)
              break
          }
        } catch (e) {
          console.warn('[signaling] error:', e)
        }
      })

      ws.on('close', () => handleLeave(ws))
      ws.on('error', () => handleLeave(ws))
    })

    // Keepalive ping
    const pingInterval = setInterval(() => {
      wss?.clients.forEach((ws) => {
        const w = ws as TaggedWS
        if (w.isAlive === false) { w.terminate(); return }
        w.isAlive = false
        try { w.ping() } catch {}
      })
    }, 25000)

    wss.on('close', () => clearInterval(pingInterval))
    httpServer.listen(port, () => { clearTimeout(timer); resolve() })
    httpServer.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

export function getServerPort(): number | null {
  if (!httpServer) return null
  const addr = httpServer.address()
  return addr && typeof addr === 'object' ? addr.port : null
}

export async function stopServer(): Promise<void> {
  rooms.clear()
  wss?.close()
  httpServer?.close()
  wss = null
  httpServer = null
}
