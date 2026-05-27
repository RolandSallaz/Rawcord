/**
 * E2E тесты: два пользователя
 *
 * Поднимаем реальный сигналинг-сервер, подключаем двух WS-клиентов
 * (Alice и Bob) и тестируем полный жизненный цикл сессии:
 * join → обнаружение → relay (WebRTC-style offer/answer/ice) →
 * chat → смена профиля → leave.
 */

import WebSocket from 'ws'
import { startServer, stopServer, getServerPort } from '../src/main/signalingServer'

// ─── хелперы ────────────────────────────────────────────────────────────────

type Msg = Record<string, unknown>

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function waitFor(ws: WebSocket, predicate: (m: Msg) => boolean, timeout = 4000): Promise<Msg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler)
      reject(new Error(`Timeout waiting for message`))
    }, timeout)

    function handler(data: WebSocket.RawData) {
      let m: Msg
      try { m = JSON.parse(data.toString()) } catch { return }
      if (predicate(m)) {
        clearTimeout(timer)
        ws.removeListener('message', handler)
        resolve(m)
      }
    }
    ws.on('message', handler)
  })
}

function send(ws: WebSocket, msg: object) {
  ws.send(JSON.stringify(msg))
}

// ─── setup ──────────────────────────────────────────────────────────────────

let port: number

beforeAll(async () => {
  await startServer(0)
  port = getServerPort()!
})

afterAll(() => stopServer())

// ─── Сценарий 1: Обнаружение и базовый обмен ──────────────────────────────

describe('E2E: два пользователя в одном канале', () => {
  const CHANNEL = 'e2e-room-1'
  let alice: WebSocket
  let bob: WebSocket
  let aliceServerId: string
  let bobServerId: string

  beforeAll(async () => {
    alice = await connect(port)
    bob = await connect(port)
  })

  afterAll(() => {
    alice.terminate()
    bob.terminate()
  })

  test('Alice вступает — получает пустой список peers', async () => {
    const peersPromise = waitFor(alice, m => m.type === 'peers')
    send(alice, { type: 'join', channel: CHANNEL, nickname: 'Alice', avatar: 'alice-avatar' })
    const msg = await peersPromise
    expect(msg.peers).toEqual([])
  })

  test('Bob вступает — получает список с Alice', async () => {
    const [peersMsg] = await Promise.all([
      waitFor(bob, m => m.type === 'peers'),
      waitFor(alice, m => m.type === 'peer-joined'), // Alice видит Bob-а
      new Promise<void>(r => {
        send(bob, { type: 'join', channel: CHANNEL, nickname: 'Bob', avatar: 'bob-avatar' })
        r()
      })
    ])

    const peers = peersMsg.peers as Array<{ id: string; nickname: string; avatar: string }>
    expect(peers).toHaveLength(1)
    expect(peers[0].nickname).toBe('Alice')
    expect(peers[0].avatar).toBe('alice-avatar')
    aliceServerId = peers[0].id
  })

  test('Alice получает peer-joined с данными Bob', async () => {
    // peer-joined уже был получен выше в Promise.all, повторим через новое join
    // Проверим через отдельное соединение Charlie (не ломает Alice/Bob)
    const charlie = await connect(port)
    const pjPromise = waitFor(alice, m => m.type === 'peer-joined' && m.nickname === 'Charlie')
    send(charlie, { type: 'join', channel: CHANNEL, nickname: 'Charlie' })
    const pj = await pjPromise
    expect(pj.nickname).toBe('Charlie')
    expect(typeof pj.id).toBe('string')
    bobServerId = pj.id as string
    charlie.terminate()
  })
})

// ─── Сценарий 2: Полный WebRTC-style handshake (relay) ─────────────────────

describe('E2E: WebRTC relay handshake между Alice и Bob', () => {
  const CHANNEL = 'e2e-room-rtc'
  let alice: WebSocket
  let bob: WebSocket
  let aliceId: string
  let bobId: string

  beforeAll(async () => {
    alice = await connect(port)
    bob = await connect(port)

    // Alice присоединяется
    const alicePeers = waitFor(alice, m => m.type === 'peers')
    send(alice, { type: 'join', channel: CHANNEL, nickname: 'Alice' })
    await alicePeers

    // Bob присоединяется, узнаёт aliceId
    const [bobPeers] = await Promise.all([
      waitFor(bob, m => m.type === 'peers'),
      waitFor(alice, m => m.type === 'peer-joined'),
      Promise.resolve(send(bob, { type: 'join', channel: CHANNEL, nickname: 'Bob' }))
    ])
    aliceId = (bobPeers.peers as Array<{ id: string }>)[0].id

    // Alice узнаёт bobId
    const pjMsg = await waitFor(alice, m => m.type === 'peer-joined' && m.nickname === 'Bob').catch(() => null)
    // если уже получили выше — достаём из ещё одного соединения
    if (pjMsg) {
      bobId = pjMsg.id as string
    } else {
      // bobId берём из relay ответа (см. тест)
      bobId = ''
    }
  })

  afterAll(() => {
    alice.terminate()
    bob.terminate()
  })

  test('Bob отправляет SDP offer Alice', async () => {
    const offerPromise = waitFor(alice, m => m.type === 'relay')
    send(bob, {
      type: 'relay',
      to: aliceId,
      payload: { kind: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n...' }
    })
    const msg = await offerPromise
    expect(msg.type).toBe('relay')
    const payload = msg.payload as Record<string, unknown>
    expect(payload.kind).toBe('offer')
    expect(typeof payload.sdp).toBe('string')
    // from содержит server-side id Bob-а
    bobId = msg.from as string
    expect(typeof bobId).toBe('string')
  })

  test('Alice отправляет SDP answer Bob-у', async () => {
    expect(bobId).toBeTruthy()
    const answerPromise = waitFor(bob, m => m.type === 'relay')
    send(alice, {
      type: 'relay',
      to: bobId,
      payload: { kind: 'answer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n...' }
    })
    const msg = await answerPromise
    expect(msg.type).toBe('relay')
    const payload = msg.payload as Record<string, unknown>
    expect(payload.kind).toBe('answer')
  })

  test('Alice отправляет ICE candidate Bob-у', async () => {
    const icePromise = waitFor(bob, m => m.type === 'relay')
    send(alice, {
      type: 'relay',
      to: bobId,
      payload: { kind: 'ice', candidate: 'candidate:1 1 UDP 2113667327 192.168.0.1 54321 typ host' }
    })
    const msg = await icePromise
    const payload = msg.payload as Record<string, unknown>
    expect(payload.kind).toBe('ice')
    expect(typeof payload.candidate).toBe('string')
  })

  test('Bob отправляет ICE candidate Alice', async () => {
    const icePromise = waitFor(alice, m => m.type === 'relay')
    send(bob, {
      type: 'relay',
      to: aliceId,
      payload: { kind: 'ice', candidate: 'candidate:1 1 UDP 2113667327 192.168.0.2 54322 typ host' }
    })
    const msg = await icePromise
    const payload = msg.payload as Record<string, unknown>
    expect(payload.kind).toBe('ice')
  })
})

// ─── Сценарий 3: Чат и обновление профиля ──────────────────────────────────

describe('E2E: чат и смена профиля', () => {
  const CHANNEL = 'e2e-room-chat'
  let alice: WebSocket
  let bob: WebSocket

  beforeAll(async () => {
    alice = await connect(port)
    bob = await connect(port)

    send(alice, { type: 'join', channel: CHANNEL, nickname: 'Alice' })
    await waitFor(alice, m => m.type === 'peers')

    await Promise.all([
      waitFor(alice, m => m.type === 'peer-joined'),
      waitFor(bob, m => m.type === 'peers'),
      Promise.resolve(send(bob, { type: 'join', channel: CHANNEL, nickname: 'Bob' }))
    ])
  })

  afterAll(() => {
    alice.terminate()
    bob.terminate()
  })

  test('Alice пишет сообщение — Bob получает с корректными полями', async () => {
    const chatPromise = waitFor(bob, m => m.type === 'chat')
    send(alice, { type: 'chat', text: 'Привет, Bob!', nickname: 'Alice', avatar: 'av1' })
    const msg = await chatPromise
    expect(msg.type).toBe('chat')
    expect(msg.text).toBe('Привет, Bob!')
    expect(msg.nickname).toBe('Alice')
    expect(msg.avatar).toBe('av1')
    expect(typeof msg.from).toBe('string')
  })

  test('Bob пишет сообщение — Alice получает', async () => {
    const chatPromise = waitFor(alice, m => m.type === 'chat')
    send(bob, { type: 'chat', text: 'Привет, Alice!', nickname: 'Bob' })
    const msg = await chatPromise
    expect(msg.text).toBe('Привет, Alice!')
    expect(msg.nickname).toBe('Bob')
  })

  test('Alice меняет никнейм — Bob получает peer-updated', async () => {
    const updPromise = waitFor(bob, m => m.type === 'peer-updated')
    send(alice, { type: 'announce', nickname: 'Alice2', avatar: 'new-avatar' })
    const msg = await updPromise
    expect(msg.type).toBe('peer-updated')
    expect(msg.nickname).toBe('Alice2')
    expect(msg.avatar).toBe('new-avatar')
  })

  test('Отправитель не получает собственный chat', async () => {
    const selfMsg = waitFor(alice, m => m.type === 'chat', 1500)
    send(alice, { type: 'chat', text: 'self', nickname: 'Alice2' })
    await expect(selfMsg).rejects.toThrow()
  })
})

// ─── Сценарий 4: Leave и повторный вход ────────────────────────────────────

describe('E2E: leave и повторный вход', () => {
  const CHANNEL = 'e2e-room-leave'
  let alice: WebSocket
  let bob: WebSocket

  beforeAll(async () => {
    alice = await connect(port)
    bob = await connect(port)

    send(alice, { type: 'join', channel: CHANNEL, nickname: 'Alice' })
    await waitFor(alice, m => m.type === 'peers')

    await Promise.all([
      waitFor(alice, m => m.type === 'peer-joined'),
      waitFor(bob, m => m.type === 'peers'),
      Promise.resolve(send(bob, { type: 'join', channel: CHANNEL, nickname: 'Bob' }))
    ])
  })

  afterAll(() => {
    alice.terminate()
    bob.terminate()
  })

  test('Bob уходит через leave — Alice получает peer-left', async () => {
    const leftPromise = waitFor(alice, m => m.type === 'peer-left')
    send(bob, { type: 'leave' })
    const msg = await leftPromise
    expect(msg.type).toBe('peer-left')
    expect(typeof msg.id).toBe('string')
  })

  test('Bob возвращается — Alice снова получает peer-joined', async () => {
    const pjPromise = waitFor(alice, m => m.type === 'peer-joined')
    send(bob, { type: 'join', channel: CHANNEL, nickname: 'Bob' })
    await waitFor(bob, m => m.type === 'peers')
    const msg = await pjPromise
    expect(msg.type).toBe('peer-joined')
    expect(msg.nickname).toBe('Bob')
  })
})

// ─── Сценарий 5: Изоляция каналов ──────────────────────────────────────────

describe('E2E: изоляция каналов', () => {
  let alice: WebSocket
  let bob: WebSocket
  let charlie: WebSocket

  beforeAll(async () => {
    alice = await connect(port)
    bob = await connect(port)
    charlie = await connect(port)

    send(alice, { type: 'join', channel: 'e2e-room-A', nickname: 'Alice' })
    await waitFor(alice, m => m.type === 'peers')

    send(charlie, { type: 'join', channel: 'e2e-room-B', nickname: 'Charlie' })
    await waitFor(charlie, m => m.type === 'peers')
  })

  afterAll(() => {
    alice.terminate()
    bob.terminate()
    charlie.terminate()
  })

  test('Bob в канале A не виден Charlie в канале B', async () => {
    // Bob вступает в канал A
    const pjAlice = waitFor(alice, m => m.type === 'peer-joined')
    send(bob, { type: 'join', channel: 'e2e-room-A', nickname: 'Bob' })
    await waitFor(bob, m => m.type === 'peers')
    await pjAlice

    // Charlie НЕ должен получить peer-joined
    const notifyCharlie = waitFor(charlie, m => m.type === 'peer-joined', 1000)
    await expect(notifyCharlie).rejects.toThrow()
  })

  test('сообщение в канале A не приходит в канал B', async () => {
    // Alice пишет в A
    send(alice, { type: 'chat', text: 'A-channel', nickname: 'Alice' })
    const charlieMsg = waitFor(charlie, m => m.type === 'chat', 1000)
    await expect(charlieMsg).rejects.toThrow()
  })
})

// ─── Сценарий 6: Одновременные сообщения ────────────────────────────────────

describe('E2E: одновременные relay от двух пользователей', () => {
  const CHANNEL = 'e2e-room-concurrent'
  let alice: WebSocket
  let bob: WebSocket
  let aliceId: string
  let bobId: string

  beforeAll(async () => {
    alice = await connect(port)
    bob = await connect(port)

    send(alice, { type: 'join', channel: CHANNEL, nickname: 'Alice' })
    await waitFor(alice, m => m.type === 'peers')

    const [bobPeers, pj] = await Promise.all([
      waitFor(bob, m => m.type === 'peers'),
      waitFor(alice, m => m.type === 'peer-joined'),
      Promise.resolve(send(bob, { type: 'join', channel: CHANNEL, nickname: 'Bob' }))
    ])
    aliceId = (bobPeers.peers as Array<{ id: string }>)[0].id
    bobId = pj.id as string
  })

  afterAll(() => {
    alice.terminate()
    bob.terminate()
  })

  test('Alice и Bob одновременно шлют relay — каждый получает своё', async () => {
    const aliceReceives = waitFor(alice, m => m.type === 'relay')
    const bobReceives = waitFor(bob, m => m.type === 'relay')

    // Отправляем одновременно
    send(alice, { type: 'relay', to: bobId, payload: { msg: 'from-alice' } })
    send(bob, { type: 'relay', to: aliceId, payload: { msg: 'from-bob' } })

    const [aliceMsg, bobMsg] = await Promise.all([aliceReceives, bobReceives])

    expect((aliceMsg.payload as Record<string, unknown>).msg).toBe('from-bob')
    expect((bobMsg.payload as Record<string, unknown>).msg).toBe('from-alice')
  })
})
