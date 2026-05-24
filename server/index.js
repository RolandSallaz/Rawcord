const { WebSocketServer, WebSocket } = require('ws')
const { randomUUID } = require('crypto')
const http = require('http')

const PORT = process.env.PORT || 3001

// HTTP healthcheck — нужен для Render keepalive и проверок деплоя
const server = http.createServer((req, res) => {
  res.writeHead(200)
  res.end('ok')
})

const wss = new WebSocketServer({ server })

// ping каждые 25 сек — не даёт Render засыпать и убивает мёртвые коннекты
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return }
    ws.isAlive = false
    ws.ping()
  })
}, 25000)

// rooms: Map<channelName, Map<peerId, { ws, nickname }>>
const rooms = new Map()

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  const id = randomUUID()
  ws._peerId = id
  ws._channel = null

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === 'join') {
      const { channel, nickname } = msg
      if (!channel || !nickname) return

      // leave previous channel if any
      leaveChannel(ws)

      if (!rooms.has(channel)) rooms.set(channel, new Map())
      const room = rooms.get(channel)

      // send existing peers to newcomer
      const peers = [...room.values()].map(p => ({ id: p.id, nickname: p.nickname }))
      send(ws, { type: 'peers', peers })

      // notify existing peers
      room.forEach(peer => {
        send(peer.ws, { type: 'peer-joined', id, nickname })
      })

      room.set(id, { id, ws, nickname })
      ws._channel = channel

    } else if (msg.type === 'relay') {
      const { to, payload } = msg
      if (!to || !payload || !ws._channel) return

      const room = rooms.get(ws._channel)
      if (!room) return

      const target = room.get(to)
      if (target) {
        send(target.ws, { type: 'relay', from: id, payload })
      }

    } else if (msg.type === 'leave') {
      leaveChannel(ws)
    }
  })

  ws.on('close', () => leaveChannel(ws))
  ws.on('error', () => leaveChannel(ws))
})

function leaveChannel(ws) {
  const channel = ws._channel
  if (!channel) return

  const room = rooms.get(channel)
  if (room) {
    room.delete(ws._peerId)
    room.forEach(peer => {
      send(peer.ws, { type: 'peer-left', id: ws._peerId })
    })
    if (room.size === 0) rooms.delete(channel)
  }

  ws._channel = null
}

server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`)
})
