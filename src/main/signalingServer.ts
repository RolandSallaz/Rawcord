import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import { createServer, Server as HttpServer } from 'http'

interface Peer {
  id: string
  ws: WebSocket
  nickname: string
  avatar?: string
}

let wss: WebSocketServer | null = null
let httpServer: HttpServer | null = null

// rooms: channel → Map<peerId, Peer>
const rooms = new Map<string, Map<string, Peer>>()

function send(ws: WebSocket, msg: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function leaveChannel(ws: WebSocket & { _peerId?: string; _channel?: string }) {
  const channel = ws._channel
  if (!channel) return

  const room = rooms.get(channel)
  if (room) {
    room.delete(ws._peerId!)
    room.forEach(peer => send(peer.ws, { type: 'peer-left', id: ws._peerId }))
    if (room.size === 0) rooms.delete(channel)
  }

  ws._channel = undefined
}

export function startServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (wss) resolve() // already running

    httpServer = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
    wss = new WebSocketServer({ server: httpServer })

    wss.on('connection', (ws: WebSocket & { _peerId?: string; _channel?: string; isAlive?: boolean }) => {
      ws.isAlive = true
      ws.on('pong', () => { ws.isAlive = true })

      const id = randomUUID()
      ws._peerId = id

      ws.on('message', (raw) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(raw.toString()) } catch { return }

        if (msg.type === 'join') {
          const { channel, nickname, avatar } = msg as { channel: string; nickname: string; avatar?: string }
          if (!channel || !nickname) return

          leaveChannel(ws)

          if (!rooms.has(channel)) rooms.set(channel, new Map())
          const room = rooms.get(channel)!

          const peers = [...room.values()].map(p => ({ id: p.id, nickname: p.nickname, avatar: p.avatar }))
          send(ws, { type: 'peers', peers })

          room.forEach(peer => send(peer.ws, { type: 'peer-joined', id, nickname, avatar }))
          room.set(id, { id, ws, nickname, avatar })
          ws._channel = channel

        } else if (msg.type === 'relay') {
          const { to, payload } = msg as { to: string; payload: object }
          if (!to || !payload || !ws._channel) return

          const room = rooms.get(ws._channel)
          const target = room?.get(to)
          if (target) send(target.ws, { type: 'relay', from: id, payload })

        } else if (msg.type === 'leave') {
          leaveChannel(ws)
        }
      })

      ws.on('close', () => leaveChannel(ws))
      ws.on('error', () => leaveChannel(ws))
    })

    // keepalive
    const interval = setInterval(() => {
      wss?.clients.forEach((ws) => {
        const w = ws as WebSocket & { isAlive?: boolean }
        if (w.isAlive === false) { w.terminate(); return }
        w.isAlive = false
        w.ping()
      })
    }, 25000)

    wss.on('close', () => clearInterval(interval))

    httpServer.listen(port, () => resolve())
    httpServer.on('error', reject)
  })
}

export function stopServer() {
  wss?.close()
  httpServer?.close()
  wss = null
  httpServer = null
  rooms.clear()
}
