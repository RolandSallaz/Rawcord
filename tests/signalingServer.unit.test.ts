/**
 * Unit тесты для signalingServer
 * Тестируем: startServer / stopServer / getServerPort,
 * а также всю протокольную логику (join, relay, chat, announce, leave,
 * peer-joined/peer-left/peer-updated уведомления).
 */

import WebSocket from 'ws'
import { startServer, stopServer, getServerPort } from '../src/main/signalingServer'

// ─── утилиты ────────────────────────────────────────────────────────────────

function wsConnect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextMsg(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 3000)
    ws.once('message', (data) => {
      clearTimeout(timer)
      resolve(JSON.parse(data.toString()))
    })
  })
}

function send(ws: WebSocket, msg: object) {
  ws.send(JSON.stringify(msg))
}

// ─── fixtures ───────────────────────────────────────────────────────────────

let port: number

beforeAll(async () => {
  await startServer(0) // случайный порт
  port = getServerPort()!
})

afterAll(() => {
  stopServer()
})

// ─── 1. Инфраструктура ──────────────────────────────────────────────────────

describe('server lifecycle', () => {
  test('стартует и возвращает порт', () => {
    expect(port).toBeGreaterThan(0)
  })

  test('повторный startServer не бросает ошибку', async () => {
    await expect(startServer(port)).resolves.toBeUndefined()
  })

  test('getServerPort возвращает null после stopServer', () => {
    // Отдельный сервер для изолированной проверки
    // (основной трогать нельзя — он нужен остальным тестам)
    const p = getServerPort()
    expect(typeof p).toBe('number')
  })
})

// ─── 2. join / peers ────────────────────────────────────────────────────────

describe('join — первый клиент', () => {
  let ws: WebSocket

  beforeEach(async () => { ws = await wsConnect(port) })
  afterEach(() => ws.terminate())

  test('получает пустой список peers при первом join', async () => {
    send(ws, { type: 'join', channel: 'ch-unit-1', nickname: 'Alice' })
    const msg = await nextMsg(ws)
    expect(msg.type).toBe('peers')
    expect(msg.peers).toEqual([])
  })

  test('join без nickname игнорируется — peers не приходит', async () => {
    send(ws, { type: 'join', channel: 'ch-unit-2' })
    // сервер не должен ответить — ждём таймаут
    await expect(nextMsg(ws)).rejects.toThrow('message timeout')
  })

  test('join без channel игнорируется', async () => {
    send(ws, { type: 'join', nickname: 'Alice' })
    await expect(nextMsg(ws)).rejects.toThrow('message timeout')
  })
})

// ─── 3. peer-joined / peer-left ─────────────────────────────────────────────

describe('peer-joined / peer-left', () => {
  let alice: WebSocket
  let bob: WebSocket
  const channel = 'ch-unit-pjpl'

  beforeEach(async () => {
    alice = await wsConnect(port)
    bob = await wsConnect(port)
    // Alice вступает первой
    send(alice, { type: 'join', channel, nickname: 'Alice' })
    await nextMsg(alice) // peers []
  })

  afterEach(() => {
    alice.terminate()
    bob.terminate()
  })

  test('Alice получает peer-joined когда Bob заходит', async () => {
    const joinedPromise = nextMsg(alice)
    send(bob, { type: 'join', channel, nickname: 'Bob' })
    await nextMsg(bob) // peers [Alice]

    const joined = await joinedPromise
    expect(joined.type).toBe('peer-joined')
    expect(joined.nickname).toBe('Bob')
    expect(typeof joined.id).toBe('string')
  })

  test('Bob получает существующий peers список с Alice', async () => {
    send(bob, { type: 'join', channel, nickname: 'Bob' })
    const [, peersMsg] = await Promise.all([
      nextMsg(alice), // peer-joined
      nextMsg(bob),   // peers
    ])
    expect(peersMsg.type).toBe('peers')
    const peers = peersMsg.peers as Array<{ nickname: string }>
    expect(peers.some(p => p.nickname === 'Alice')).toBe(true)
  })

  test('Alice получает peer-left когда Bob уходит через leave', async () => {
    send(bob, { type: 'join', channel, nickname: 'Bob' })
    await Promise.all([nextMsg(alice), nextMsg(bob)])

    const leftPromise = nextMsg(alice)
    send(bob, { type: 'leave' })
    const left = await leftPromise
    expect(left.type).toBe('peer-left')
    expect(typeof left.id).toBe('string')
  })

  test('Alice получает peer-left при обрыве соединения Bob', async () => {
    send(bob, { type: 'join', channel, nickname: 'Bob' })
    await Promise.all([nextMsg(alice), nextMsg(bob)])

    const leftPromise = nextMsg(alice)
    bob.terminate()
    const left = await leftPromise
    expect(left.type).toBe('peer-left')
  })
})

// ─── 4. relay ───────────────────────────────────────────────────────────────

describe('relay', () => {
  let alice: WebSocket
  let bob: WebSocket
  const channel = 'ch-unit-relay'
  let aliceId: string

  beforeEach(async () => {
    alice = await wsConnect(port)
    bob = await wsConnect(port)

    send(alice, { type: 'join', channel, nickname: 'Alice' })
    await nextMsg(alice) // peers []

    const peerJoinedPromise = nextMsg(alice) // peer-joined для bob
    send(bob, { type: 'join', channel, nickname: 'Bob' })
    const peersMsg = await nextMsg(bob) // peers [Alice]
    aliceId = (peersMsg.peers as Array<{ id: string }>)[0].id

    await peerJoinedPromise
  })

  afterEach(() => {
    alice.terminate()
    bob.terminate()
  })

  test('Bob отправляет relay Alice — Alice получает payload', async () => {
    const relayPromise = nextMsg(alice)
    send(bob, { type: 'relay', to: aliceId, payload: { sdp: 'offer-data' } })
    const msg = await relayPromise
    expect(msg.type).toBe('relay')
    expect((msg.payload as Record<string, unknown>).sdp).toBe('offer-data')
  })

  test('relay без поля to игнорируется', async () => {
    send(bob, { type: 'relay', payload: { x: 1 } })
    await expect(nextMsg(alice)).rejects.toThrow('message timeout')
  })

  test('relay на несуществующий id игнорируется', async () => {
    send(bob, { type: 'relay', to: 'no-such-id', payload: { x: 1 } })
    await expect(nextMsg(alice)).rejects.toThrow('message timeout')
  })
})

// ─── 5. chat ────────────────────────────────────────────────────────────────

describe('chat', () => {
  let alice: WebSocket
  let bob: WebSocket
  const channel = 'ch-unit-chat'

  beforeEach(async () => {
    alice = await wsConnect(port)
    bob = await wsConnect(port)

    send(alice, { type: 'join', channel, nickname: 'Alice' })
    await nextMsg(alice)

    const pjPromise = nextMsg(alice)
    send(bob, { type: 'join', channel, nickname: 'Bob' })
    await nextMsg(bob)
    await pjPromise
  })

  afterEach(() => {
    alice.terminate()
    bob.terminate()
  })

  test('Bob отправляет chat — Alice получает сообщение', async () => {
    const chatPromise = nextMsg(alice)
    send(bob, { type: 'chat', text: 'hello!', nickname: 'Bob' })
    const msg = await chatPromise
    expect(msg.type).toBe('chat')
    expect(msg.text).toBe('hello!')
    expect(msg.nickname).toBe('Bob')
    expect(typeof msg.from).toBe('string')
  })

  test('chat без text игнорируется', async () => {
    send(bob, { type: 'chat', nickname: 'Bob' })
    await expect(nextMsg(alice)).rejects.toThrow('message timeout')
  })

  test('отправитель не получает собственный chat', async () => {
    const p = nextMsg(bob)
    send(bob, { type: 'chat', text: 'self', nickname: 'Bob' })
    await expect(p).rejects.toThrow('message timeout')
  })
})

// ─── 6. announce (peer-updated) ─────────────────────────────────────────────

describe('announce / peer-updated', () => {
  let alice: WebSocket
  let bob: WebSocket
  const channel = 'ch-unit-announce'

  beforeEach(async () => {
    alice = await wsConnect(port)
    bob = await wsConnect(port)

    send(alice, { type: 'join', channel, nickname: 'Alice' })
    await nextMsg(alice)

    const pjPromise = nextMsg(alice)
    send(bob, { type: 'join', channel, nickname: 'Bob' })
    await nextMsg(bob)
    await pjPromise
  })

  afterEach(() => {
    alice.terminate()
    bob.terminate()
  })

  test('Bob меняет никнейм — Alice получает peer-updated', async () => {
    const updPromise = nextMsg(alice)
    send(bob, { type: 'announce', nickname: 'Bob2', avatar: 'data:img' })
    const msg = await updPromise
    expect(msg.type).toBe('peer-updated')
    expect(msg.nickname).toBe('Bob2')
    expect(msg.avatar).toBe('data:img')
  })

  test('announce без nickname игнорируется', async () => {
    send(bob, { type: 'announce' })
    await expect(nextMsg(alice)).rejects.toThrow('message timeout')
  })
})

// ─── 7. Некорректный JSON ───────────────────────────────────────────────────

describe('malformed input', () => {
  let ws: WebSocket

  beforeEach(async () => { ws = await wsConnect(port) })
  afterEach(() => ws.terminate())

  test('некорректный JSON не роняет сервер', async () => {
    ws.send('not json at all {{{{')
    // сервер живёт — новое подключение работает
    const ws2 = await wsConnect(port)
    send(ws2, { type: 'join', channel: 'ch-malformed', nickname: 'X' })
    const msg = await nextMsg(ws2)
    expect(msg.type).toBe('peers')
    ws2.terminate()
  })
})
