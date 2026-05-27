/**
 * @jest-environment jsdom
 *
 * Unit тесты для SteamSignalingClient (src/renderer/src/lib/steamSignaling.ts)
 *
 * Главный кейс (регрессия — offer glare):
 *   Если announce от owner приходил ДО резолва steam:joinLobby (т.е. пока
 *   connect() ждал ответа лобби), msgListener вызывал onPeerJoined → peer
 *   создавался как initiator:true. Потом onPeers тоже пытался создать пира,
 *   но createPeer возвращал ранний return (пир уже есть). Итог: оба конца
 *   имеют initiator:true → offer glare → SimplePeer error → removePeer →
 *   участник пропадает из UI.
 *
 *   Фикс: флаг _ready = false во время connect(). Announce до _ready обновляет
 *   seenPeers но НЕ вызывает onPeerJoined. onPeers создаёт пира с initiator:false.
 *   После _ready=true announce нового пира корректно вызывает onPeerJoined.
 */

// ─── IPC mock ──────────────────────────────────────────────────────────────────

type IpcHandler = (event: unknown, ...args: unknown[]) => void
const mockInvokeImpls: Record<string, (...args: unknown[]) => unknown> = {}
const mockListeners: Record<string, IpcHandler[]> = {}

const mockIpc = {
  invoke: jest.fn().mockImplementation(async (channel: string, ...args: unknown[]) => {
    return mockInvokeImpls[channel]?.(...args)
  }),
  on: jest.fn().mockImplementation((channel: string, h: IpcHandler) => {
    (mockListeners[channel] ||= []).push(h)
  }),
  removeListener: jest.fn().mockImplementation((channel: string, h: IpcHandler) => {
    mockListeners[channel] = (mockListeners[channel] || []).filter(x => x !== h)
  }),
}

// Must be set at module level — before steamSignaling.ts is first require()'d
;(window as any).require = (mod: string) => {
  if (mod === 'electron') return { ipcRenderer: mockIpc }
  throw new Error(`Unexpected require('${mod}')`)
}

/** Доставить IPC-событие всем зарегистрированным обработчикам канала */
function emitIpc(channel: string, ...args: unknown[]) {
  for (const h of [...(mockListeners[channel] || [])]) {
    h({} /* ipc event */, ...args)
  }
}

// ─── Загружаем модуль ПОСЛЕ настройки window.require ─────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SteamSignalingClient: new (lobbyId: string, isOwner?: boolean) => any

beforeAll(() => {
  SteamSignalingClient = require('../src/renderer/src/lib/steamSignaling').SteamSignalingClient
})

beforeEach(() => {
  // Очищаем слушателей и реализации между тестами
  Object.keys(mockListeners).forEach(k => delete mockListeners[k])
  Object.keys(mockInvokeImpls).forEach(k => delete mockInvokeImpls[k])

  // Дефолтные реализации
  mockInvokeImpls['steam:getUser'] = () => ({ steamId: 'my-id', name: 'Me' })
  mockInvokeImpls['steam:joinLobby'] = () => []
  mockInvokeImpls['steam:sendMsg'] = () => undefined
  mockInvokeImpls['steam:leaveLobby'] = () => undefined

  mockIpc.invoke.mockClear()
  mockIpc.on.mockClear()
  mockIpc.removeListener.mockClear()
})

// ══════════════════════════════════════════════════════════════════════════════
// Главный кейс: offer glare — announce приходит ДО резолва steam:joinLobby
// ══════════════════════════════════════════════════════════════════════════════

describe('offer glare prevention (pre-connect announce)', () => {
  test('announce во время connect() НЕ вызывает onPeerJoined', async () => {
    // Управляемый промис для steam:joinLobby — позволяет прислать announce раньше
    let resolveLobby!: (members: unknown[]) => void
    mockInvokeImpls['steam:joinLobby'] = () => new Promise(r => { resolveLobby = r as (m: unknown[]) => void })

    const client = new SteamSignalingClient('lobby-1', false)
    const onPeerJoined = jest.fn()
    const onPeers = jest.fn()
    client.on('onPeerJoined', onPeerJoined)
    client.on('onPeers', onPeers)

    const connectPromise = client.connect()

    // Ждём пока steam:getUser отработает и слушатели зарегистрируются
    // (connect() приостанавливается на steam:joinLobby)
    await Promise.resolve()

    // Симулируем: owner присылает P2P announce пока мы ещё ждём joinLobby
    emitIpc('steam:msg', {
      from: 'owner-id',
      data: JSON.stringify({ type: 'announce', nickname: 'Owner', avatar: '' }),
    })

    // Резолвим joinLobby: owner числится в existingMembers (но nick у него пустой)
    resolveLobby([{ steamId: 'owner-id', name: '' }])
    await connectPromise

    // onPeerJoined НЕ должен был вызываться — иначе peer создался бы как initiator:true
    expect(onPeerJoined).not.toHaveBeenCalled()
  })

  test('onPeers вызывается с ником из announce, а не заглушкой из existingMembers', async () => {
    let resolveLobby!: (members: unknown[]) => void
    mockInvokeImpls['steam:joinLobby'] = () => new Promise(r => { resolveLobby = r as (m: unknown[]) => void })

    const client = new SteamSignalingClient('lobby-2', false)
    const onPeers = jest.fn()
    client.on('onPeers', onPeers)
    client.on('onPeerJoined', jest.fn())

    const connectPromise = client.connect()
    await Promise.resolve()

    // Announce с настоящим именем приходит раньше existingMembers
    emitIpc('steam:msg', {
      from: 'owner-id',
      data: JSON.stringify({ type: 'announce', nickname: 'RealOwnerName', avatar: 'data:img' }),
    })

    // joinLobby возвращает владельца с пустым именем (как это делает steam.ts)
    resolveLobby([{ steamId: 'owner-id', name: '' }])
    await connectPromise

    expect(onPeers).toHaveBeenCalledTimes(1)
    const peersArg = onPeers.mock.calls[0][0] as Array<{ id: string; nickname: string; avatar?: string }>
    const owner = peersArg.find(p => p.id === 'owner-id')
    expect(owner).toBeDefined()
    // Ник должен быть из announce, а не "owner" → последние 6 символов id
    expect(owner!.nickname).toBe('RealOwnerName')
    expect(owner!.avatar).toBe('data:img')
  })

  test('onPeers включает пиров добавленных через pre-connect announce', async () => {
    let resolveLobby!: (members: unknown[]) => void
    mockInvokeImpls['steam:joinLobby'] = () => new Promise(r => { resolveLobby = r as (m: unknown[]) => void })

    const client = new SteamSignalingClient('lobby-3', false)
    const onPeers = jest.fn()
    client.on('onPeers', onPeers)
    client.on('onPeerJoined', jest.fn())

    const connectPromise = client.connect()
    await Promise.resolve()

    emitIpc('steam:msg', {
      from: 'peer-a',
      data: JSON.stringify({ type: 'announce', nickname: 'PeerA' }),
    })
    emitIpc('steam:msg', {
      from: 'peer-b',
      data: JSON.stringify({ type: 'announce', nickname: 'PeerB' }),
    })

    // Оба пира есть в existingMembers
    resolveLobby([
      { steamId: 'peer-a', name: '' },
      { steamId: 'peer-b', name: '' },
    ])
    await connectPromise

    const peersArg = onPeers.mock.calls[0][0] as Array<{ id: string }>
    expect(peersArg.map(p => p.id)).toEqual(expect.arrayContaining(['peer-a', 'peer-b']))
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Нормальная работа после connect() (_ready = true)
// ══════════════════════════════════════════════════════════════════════════════

describe('post-connect: нормальная работа', () => {
  test('announce нового пира после connect вызывает onPeerJoined', async () => {
    mockInvokeImpls['steam:joinLobby'] = () => []  // пустое лобби

    const client = new SteamSignalingClient('lobby-4', true)
    const onPeerJoined = jest.fn()
    client.on('onPeerJoined', onPeerJoined)
    client.on('onPeers', jest.fn())

    await client.connect()

    // После connect() _ready=true. Новый пир присылает announce.
    emitIpc('steam:msg', {
      from: 'joiner-id',
      data: JSON.stringify({ type: 'announce', nickname: 'Joiner' }),
    })

    expect(onPeerJoined).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'joiner-id', nickname: 'Joiner' }),
    )
  })

  test('steam:peer-joined (LobbyChatUpdate path) вызывает onPeerJoined', async () => {
    mockInvokeImpls['steam:joinLobby'] = () => []

    const client = new SteamSignalingClient('lobby-5', true)
    const onPeerJoined = jest.fn()
    client.on('onPeerJoined', onPeerJoined)
    client.on('onPeers', jest.fn())

    await client.connect()
    // join() устанавливает myNickname — нужно для ответного announce
    client.join('voice', 'Me')

    emitIpc('steam:peer-joined', { steamId: 'joiner-id', name: '' })

    expect(onPeerJoined).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'joiner-id' }),
    )
  })

  test('повторный announce от известного пира вызывает onPeerUpdated, а не onPeerJoined', async () => {
    mockInvokeImpls['steam:joinLobby'] = () => []

    const client = new SteamSignalingClient('lobby-6', true)
    const onPeerJoined = jest.fn()
    const onPeerUpdated = jest.fn()
    client.on('onPeerJoined', onPeerJoined)
    client.on('onPeerUpdated', onPeerUpdated)
    client.on('onPeers', jest.fn())

    await client.connect()

    emitIpc('steam:msg', {
      from: 'joiner-id',
      data: JSON.stringify({ type: 'announce', nickname: 'Joiner v1' }),
    })
    expect(onPeerJoined).toHaveBeenCalledTimes(1)

    // Второй announce — обновление профиля
    emitIpc('steam:msg', {
      from: 'joiner-id',
      data: JSON.stringify({ type: 'announce', nickname: 'Joiner v2' }),
    })
    expect(onPeerJoined).toHaveBeenCalledTimes(1)  // не добавился повторно
    expect(onPeerUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'joiner-id', nickname: 'Joiner v2' }),
    )
  })

  test('relay форвардится в onRelay', async () => {
    mockInvokeImpls['steam:joinLobby'] = () => []

    const client = new SteamSignalingClient('lobby-7', false)
    const onRelay = jest.fn()
    client.on('onRelay', onRelay)
    client.on('onPeers', jest.fn())

    await client.connect()

    const payload = { type: 'offer', sdp: 'v=0\r\n' }
    emitIpc('steam:msg', {
      from: 'sender-id',
      data: JSON.stringify({ type: 'relay', payload }),
    })

    expect(onRelay).toHaveBeenCalledWith('sender-id', payload)
  })

  test('relay от себя игнорируется', async () => {
    mockInvokeImpls['steam:joinLobby'] = () => []

    const client = new SteamSignalingClient('lobby-8', false)
    const onRelay = jest.fn()
    client.on('onRelay', onRelay)
    client.on('onPeers', jest.fn())

    await client.connect()

    emitIpc('steam:msg', {
      from: 'my-id',  // самого себя
      data: JSON.stringify({ type: 'relay', payload: { type: 'offer' } }),
    })

    expect(onRelay).not.toHaveBeenCalled()
  })

  test('steam:peer-left вызывает onPeerLeft', async () => {
    mockInvokeImpls['steam:joinLobby'] = () => []

    const client = new SteamSignalingClient('lobby-9', true)
    const onPeerLeft = jest.fn()
    client.on('onPeerLeft', onPeerLeft)
    client.on('onPeerJoined', jest.fn())
    client.on('onPeers', jest.fn())

    await client.connect()

    emitIpc('steam:peer-joined', { steamId: 'peer-x', name: '' })
    emitIpc('steam:peer-left', 'peer-x')

    expect(onPeerLeft).toHaveBeenCalledWith('peer-x')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// disconnect() убирает слушателей
// ══════════════════════════════════════════════════════════════════════════════

describe('disconnect', () => {
  test('disconnect удаляет все IPC-слушатели', async () => {
    mockInvokeImpls['steam:joinLobby'] = () => []

    const client = new SteamSignalingClient('lobby-10', false)
    client.on('onPeers', jest.fn())

    await client.connect()

    const countBefore = Object.values(mockListeners).flat().length
    expect(countBefore).toBeGreaterThan(0)

    client.disconnect()

    const countAfter = Object.values(mockListeners).flat().length
    expect(countAfter).toBe(0)
  })

  test('после disconnect события IPC не обрабатываются', async () => {
    mockInvokeImpls['steam:joinLobby'] = () => []

    const client = new SteamSignalingClient('lobby-11', true)
    const onPeerJoined = jest.fn()
    client.on('onPeerJoined', onPeerJoined)
    client.on('onPeers', jest.fn())

    await client.connect()
    client.disconnect()

    // После disconnect — события не должны вызывать обработчики
    emitIpc('steam:peer-joined', { steamId: 'ghost', name: '' })
    expect(onPeerJoined).not.toHaveBeenCalled()
  })
})
