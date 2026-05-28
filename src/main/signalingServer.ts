/**
 * WebSocket signaling-сервер. Раньше это был чистый relay для P2P; теперь
 * сидит между WS-клиентами и встроенным SFU (см. sfu.ts).
 *
 * Протокол сообщений:
 *
 * Client → Server:
 *   { type: 'join', channel, nickname, avatar? }
 *   { type: 'offer', sdp }
 *   { type: 'answer', sdp }
 *   { type: 'ice-candidate', candidate }
 *   { type: 'stop-produce', kind: 'video' }
 *   { type: 'announce', nickname, avatar? }
 *   { type: 'chat', text }
 *   { type: 'leave' }
 *
 * Server → Client:
 *   { type: 'welcome', id, iceServers, participants }
 *   { type: 'offer', sdp }
 *   { type: 'answer', sdp }
 *   { type: 'ice-candidate', candidate }
 *   { type: 'participant-joined', participant }
 *   { type: 'participant-left', id }
 *   { type: 'participant-updated', participant }
 *   { type: 'participant-sharing', id, isSharing }
 *   { type: 'chat', from, text, nickname, avatar? }
 */
import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import { createServer, Server as HttpServer } from 'http'
import { SFU, getClientIceServers } from './sfu'

let wss: WebSocketServer | null = null
let httpServer: HttpServer | null = null
let sfu: SFU | null = null

function safeSend(ws: WebSocket, msg: object) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  } catch { /* socket dead */ }
}

interface TaggedWS extends WebSocket {
  _peerId?: string
  _channel?: string
  _nickname?: string
  _avatar?: string
  isAlive?: boolean
}

async function handleLeave(ws: TaggedWS): Promise<void> {
  const channel = ws._channel
  const id = ws._peerId
  if (!channel || !id || !sfu) return
  const room = sfu.getRoom(channel)
  if (!room) return
  await room.remove(id)
  sfu.removeIfEmpty(channel)
  ws._channel = undefined
}

export function startServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (wss) return resolve()

    sfu = new SFU()

    const timer = setTimeout(() => reject(new Error('Server start timeout')), 3000)

    httpServer = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
    wss = new WebSocketServer({ server: httpServer })

    wss.on('connection', (ws: TaggedWS) => {
      ws.isAlive = true
      ws.on('pong', () => { ws.isAlive = true })

      ws._peerId = randomUUID()

      ws.on('message', async (raw) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(raw.toString()) } catch { return }
        const id = ws._peerId!

        try {
          switch (msg.type) {
            case 'join': {
              const { channel, nickname, avatar } = msg as { channel: string; nickname: string; avatar?: string }
              if (!channel || !nickname || !sfu) return

              await handleLeave(ws)

              ws._channel = channel
              ws._nickname = nickname
              ws._avatar = avatar

              const room = sfu.getOrCreateRoom(channel)
              const existing = room.list()
              room.add(id, ws, { id, nickname, avatar })

              safeSend(ws, {
                type: 'welcome',
                id,
                iceServers: getClientIceServers(),
                participants: existing,
              })
              break
            }

            case 'offer': {
              const { sdp } = msg as { sdp: string }
              if (!sdp || !ws._channel) return
              const room = sfu?.getRoom(ws._channel)
              await room?.handleOffer(id, sdp)
              break
            }

            case 'answer': {
              const { sdp } = msg as { sdp: string }
              if (!sdp || !ws._channel) return
              const room = sfu?.getRoom(ws._channel)
              await room?.handleAnswer(id, sdp)
              break
            }

            case 'ice-candidate': {
              const { candidate } = msg as { candidate: { candidate: string; sdpMid?: string; sdpMLineIndex?: number } }
              if (!candidate || !ws._channel) return
              const room = sfu?.getRoom(ws._channel)
              await room?.handleIceCandidate(id, candidate)
              break
            }

            case 'stop-produce': {
              const { kind } = msg as { kind: string }
              if (kind !== 'video' || !ws._channel) return
              const room = sfu?.getRoom(ws._channel)
              await room?.stopProduceVideo(id)
              break
            }

            case 'announce': {
              const { nickname, avatar } = msg as { nickname: string; avatar?: string }
              if (!nickname || !ws._channel) return
              ws._nickname = nickname
              ws._avatar = avatar
              const room = sfu?.getRoom(ws._channel)
              room?.updateInfo(id, { nickname, avatar })
              break
            }

            case 'chat': {
              const { text } = msg as { text: string }
              if (!text || !ws._channel) return
              const room = sfu?.getRoom(ws._channel)
              room?.broadcast({
                type: 'chat',
                from: id,
                text,
                nickname: ws._nickname ?? 'unknown',
                avatar: ws._avatar,
              }, id)
              break
            }

            case 'leave': {
              await handleLeave(ws)
              break
            }
          }
        } catch (e) {
          console.warn(`[signaling] message handler error for ${id.slice(0, 8)}:`, e)
        }
      })

      ws.on('close', () => { handleLeave(ws).catch(() => {}) })
      ws.on('error', () => { handleLeave(ws).catch(() => {}) })
    })

    const interval = setInterval(() => {
      wss?.clients.forEach((ws) => {
        const w = ws as TaggedWS
        if (w.isAlive === false) { w.terminate(); return }
        w.isAlive = false
        try { w.ping() } catch {}
      })
    }, 25000)

    wss.on('close', () => clearInterval(interval))

    httpServer.listen(port, () => { clearTimeout(timer); resolve() })
    httpServer.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

export function getServerPort(): number | null {
  if (!httpServer) return null
  const addr = httpServer.address()
  if (addr && typeof addr === 'object') return addr.port
  return null
}

export async function stopServer(): Promise<void> {
  if (sfu) {
    await sfu.closeAll()
    sfu = null
  }
  wss?.close()
  httpServer?.close()
  wss = null
  httpServer = null
}
