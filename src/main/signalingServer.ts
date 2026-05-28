/**
 * Pure WebSocket relay server.
 *
 * Text frames (JSON):
 *   C→S: join | announce | chat | leave | ping | stream-start | stream-stop
 *   S→C: welcome | participant-joined | participant-left | participant-updated |
 *        stream-started | stream-stopped | chat
 *
 * Binary frames:
 *   C→S: [1 byte type: 0x01=audio, 0x02=video] + payload
 *   S→C: [36-byte ASCII sender UUID] + [1 byte type] + payload
 *
 * Video init-chunk (first 0x02 frame per sender) is stored per-room so late
 * viewers can initialise their MSE SourceBuffer when joining mid-stream.
 */
import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import { createServer, Server as HttpServer } from 'http'

export interface ParticipantInfo {
  id: string
  nickname: string
  avatar?: string
}

interface StreamerInfo {
  mimeType: string
  initChunk: string   // base64 — first video chunk, contains WebM init segment
}

interface RoomClient extends ParticipantInfo {
  ws: WebSocket
  isAlive: boolean
}

class Room {
  private clients = new Map<string, RoomClient>()
  /** Active screen-share streamers keyed by participant ID */
  streamers = new Map<string, StreamerInfo>()

  add(id: string, ws: WebSocket, info: ParticipantInfo) {
    this.clients.set(id, { ...info, ws, isAlive: true })
    this.broadcast({ type: 'participant-joined', participant: info }, id)
  }

  remove(id: string) {
    this.clients.delete(id)
    this.streamers.delete(id)
    this.broadcast({ type: 'participant-left', id })
  }

  update(id: string, info: Partial<ParticipantInfo>) {
    const c = this.clients.get(id)
    if (!c) return
    Object.assign(c, info)
    this.broadcast({ type: 'participant-updated', participant: { id: c.id, nickname: c.nickname, avatar: c.avatar } }, id)
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

  /** Send the stored init-chunk to a specific client so they can start MSE */
  sendInitChunks(targetId: string) {
    const c = this.clients.get(targetId)
    if (!c) return
    for (const [senderId, info] of this.streamers) {
      try {
        if (c.ws.readyState !== WebSocket.OPEN) continue
        // Send as binary: [36 ID] + [0x02] + [init chunk bytes]
        const initBuf = Buffer.from(info.initChunk, 'base64')
        const idBuf = Buffer.from(senderId.padEnd(36).slice(0, 36), 'ascii')
        const typeBuf = Buffer.alloc(1); typeBuf[0] = 0x02
        c.ws.send(Buffer.concat([idBuf, typeBuf, initBuf]), { binary: true })
      } catch {}
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
  _initSent?: boolean   // whether we've stored this sender's video init chunk
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
      ws._initSent = false

      ws.on('message', (raw, isBinary) => {
        const id = ws._peerId!

        if (isBinary) {
          try {
            const payload = Buffer.isBuffer(raw) ? raw : Buffer.concat(raw as Buffer[])
            if (payload.length === 0) return

            const typeByte = payload[0]          // 0x01=audio, 0x02=video
            const data = payload.slice(1)          // actual payload

            const channel = ws._channel
            if (!channel) return
            const room = rooms.get(channel)
            if (!room) return

            // For video: store first chunk as init segment for late viewers
            if (typeByte === 0x02 && !ws._initSent) {
              ws._initSent = true
              const streamer = room.streamers.get(id)
              if (streamer) {
                streamer.initChunk = data.toString('base64')
              }
            }

            // Relay: prepend [36-byte sender ID] + [type byte]
            const idBuf = Buffer.from(id.padEnd(36).slice(0, 36), 'ascii')
            const typeBuf = Buffer.alloc(1); typeBuf[0] = typeByte
            room.broadcastBinary(Buffer.concat([idBuf, typeBuf, data]), id)
          } catch (e) {
            console.warn('[signaling] binary relay error:', e)
          }
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
              // Current streamers for late-join
              const streamers = [...room.streamers.entries()].map(([sid, info]) => ({
                id: sid, mimeType: info.mimeType,
              }))
              room.add(id, ws, { id, nickname, avatar })
              safeSend(ws, { type: 'welcome', id, participants: existing, streamers })
              // Send stored init chunks immediately so they can start MSE
              room.sendInitChunks(id)
              break
            }

            case 'announce': {
              const { nickname, avatar } = msg as { nickname: string; avatar?: string }
              if (!nickname || !ws._channel) return
              ws._nickname = nickname; ws._avatar = avatar
              rooms.get(ws._channel)?.update(id, { nickname, avatar })
              break
            }

            case 'stream-start': {
              const { mimeType } = msg as { mimeType: string }
              if (!mimeType || !ws._channel) return
              const room = rooms.get(ws._channel)
              if (!room) return
              room.streamers.set(id, { mimeType, initChunk: '' })
              ws._initSent = false  // reset so next binary stores new init chunk
              room.broadcast({ type: 'stream-started', from: id, mimeType }, id)
              break
            }

            case 'stream-stop': {
              if (!ws._channel) return
              const room = rooms.get(ws._channel)
              if (!room) return
              room.streamers.delete(id)
              ws._initSent = false
              room.broadcast({ type: 'stream-stopped', from: id }, id)
              break
            }

            case 'chat': {
              const { text } = msg as { text: string }
              if (!text || !ws._channel) return
              rooms.get(ws._channel)?.broadcast({
                type: 'chat', from: id, text,
                nickname: ws._nickname ?? 'unknown', avatar: ws._avatar,
              }, id)
              break
            }

            case 'ping': break   // application-level heartbeat
            case 'leave': handleLeave(ws); break
          }
        } catch (e) {
          console.warn('[signaling] error:', e)
        }
      })

      ws.on('close', () => handleLeave(ws))
      ws.on('error', () => handleLeave(ws))
    })

    const pingInterval = setInterval(() => {
      wss?.clients.forEach((ws) => {
        const w = ws as TaggedWS
        if (w.isAlive === false) { w.terminate(); return }
        w.isAlive = false
        try { w.ping() } catch {}
      })
    }, 8000)

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
