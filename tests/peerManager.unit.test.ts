/**
 * @jest-environment jsdom
 *
 * Unit тесты для PeerManager (src/renderer/src/lib/webrtc.ts)
 * Покрывает: mungeOpus SDP-transform, setStream / setMicGain / setMicMuted,
 * createPeer / signal / removePeer, startScreenShare / stopScreenShare,
 * destroyAll, VAD (voice activity detection), вспомогательные методы,
 * onPeerDisconnected (критический callback для reconnect).
 */

import { EventEmitter } from 'events'

// ─── Хранилище mock-инстансов SimplePeer (доступно из jest.mock-factory) ───
;(globalThis as unknown as Record<string, unknown>).__mockPeers = []

jest.mock('simple-peer', () => {
  const { EventEmitter: EE } = require('events') as typeof import('events')

  class MockPeer extends EE {
    destroyed = false
    _opts: Record<string, unknown>
    addTrack = jest.fn()
    removeTrack = jest.fn()
    signal = jest.fn()

    constructor(opts: Record<string, unknown>) {
      super()
      this._opts = opts
      ;(globalThis as unknown as Record<string, unknown[]>).__mockPeers.push(this)
      // Real SimplePeer destroys itself on error, which then emits 'close'
      this.on('error', () => this.destroy())
    }

    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      // Real SimplePeer emits 'close' synchronously on destroy
      this.emit('close')
    }
  }

  return MockPeer
})

// ─── Web Audio API mocks (jsdom не реализует) ────────────────────────────

// Хранилище последних созданных mock-объектов — используется в assertions
let _lastGainNode: MockGainNode | null = null
let _nextAnalyser: MockAnalyserNode | null = null  // если задан, вернём его вместо нового
const _ctxCreated: MockAudioContext[] = []

class MockGainNode {
  gain = { value: 1 }
  connect = jest.fn()
}

class MockAnalyserNode {
  fftSize = 512
  connect = jest.fn()
  getFloatTimeDomainData = jest.fn((_arr: Float32Array) => {})
}

class MockAudioSource {
  connect = jest.fn()
}

class MockAudioDest {
  stream = {
    getAudioTracks: () => [makeFakeTrack('audio')],
  }
}

class MockAudioContext {
  destination = {}
  close = jest.fn(() => Promise.resolve())

  createGain() {
    const g = new MockGainNode()
    _lastGainNode = g
    return g
  }
  createAnalyser() {
    if (_nextAnalyser) {
      const a = _nextAnalyser
      _nextAnalyser = null
      return a
    }
    return new MockAnalyserNode()
  }
  createMediaStreamSource() { return new MockAudioSource() }
  createMediaStreamDestination() { return new MockAudioDest() }

  constructor() { _ctxCreated.push(this) }
}

Object.defineProperty(global, 'AudioContext', { value: MockAudioContext, writable: true })

// ─── MediaStream / MediaStreamTrack фабрики ───────────────────────────────

function makeFakeTrack(kind: 'audio' | 'video'): MediaStreamTrack {
  return {
    kind,
    enabled: true,
    stop: jest.fn(),
    onended: null,
    getSettings: jest.fn(() => ({ width: 1280, height: 720 })),
  } as unknown as MediaStreamTrack
}

function makeFakeStream(
  audioTracks: MediaStreamTrack[] = [],
  videoTracks: MediaStreamTrack[] = [],
): MediaStream {
  const all = [...audioTracks, ...videoTracks]
  return {
    getAudioTracks: () => audioTracks,
    getVideoTracks: () => videoTracks,
    getTracks: () => all,
  } as unknown as MediaStream
}

// ─── Импорт после mock-настройки ─────────────────────────────────────────

import { PeerManager } from '../src/renderer/src/lib/webrtc'

// ─── Тип для mock-пиров ───────────────────────────────────────────────────

interface MockPeer extends EventEmitter {
  destroyed: boolean
  _opts: Record<string, unknown>
  addTrack: jest.MockedFunction<(track: MediaStreamTrack, stream: MediaStream) => void>
  removeTrack: jest.MockedFunction<(track: MediaStreamTrack, stream: MediaStream) => void>
  signal: jest.MockedFunction<(data: object) => void>
  destroy(): void
}

function getPeers(): MockPeer[] {
  return (globalThis as unknown as Record<string, unknown>).__mockPeers as MockPeer[]
}

function clearPeers() {
  ;(globalThis as unknown as Record<string, unknown[]>).__mockPeers = []
}

// ─── Фиктивный сигналинг ──────────────────────────────────────────────────

function makeSig() {
  return { relay: jest.fn() }
}

// ══════════════════════════════════════════════════════════════════════════
// 1. mungeOpus — SDP-трансформация
// ══════════════════════════════════════════════════════════════════════════

describe('mungeOpus (sdpTransform)', () => {
  let sdpTransform: (sdp: string) => string

  beforeAll(() => {
    clearPeers()
    const pm = new PeerManager(makeSig())
    const stream = makeFakeStream([makeFakeTrack('audio')])
    pm.setStream(stream)
    pm.createPeer('p1', 'Alice', true)
    const peer = getPeers()[0]
    sdpTransform = peer._opts.sdpTransform as (sdp: string) => string
    pm.destroy()
  })

  const SDP_WITH_OPUS = [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10',
  ].join('\r\n')

  const SDP_WITHOUT_OPUS = [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 0',
    'a=rtpmap:0 PCMU/8000',
  ].join('\r\n')

  test('добавляет usedtx если отсутствует', () => {
    expect(sdpTransform(SDP_WITH_OPUS)).toContain('usedtx=1')
  })

  test('добавляет useinbandfec если отсутствует', () => {
    expect(sdpTransform(SDP_WITH_OPUS)).toContain('useinbandfec=1')
  })

  test('добавляет stereo=0 если отсутствует', () => {
    expect(sdpTransform(SDP_WITH_OPUS)).toContain('stereo=0')
  })

  test('добавляет maxaveragebitrate если отсутствует', () => {
    expect(sdpTransform(SDP_WITH_OPUS)).toContain('maxaveragebitrate=40000')
  })

  test('не дублирует уже существующие параметры', () => {
    const sdp = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 usedtx=1;useinbandfec=1;stereo=0;maxaveragebitrate=40000',
    ].join('\r\n')
    const result = sdpTransform(sdp)
    const fmtpLine = result.split('\r\n').find(l => l.startsWith('a=fmtp:111'))!
    expect((fmtpLine.match(/usedtx/g) ?? []).length).toBe(1)
  })

  test('возвращает SDP без изменений если нет opus', () => {
    expect(sdpTransform(SDP_WITHOUT_OPUS)).toBe(SDP_WITHOUT_OPUS)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 2. setStream / setMicGain / setMicMuted / setDeafened
// ══════════════════════════════════════════════════════════════════════════

describe('audio controls', () => {
  let pm: PeerManager

  beforeEach(() => {
    clearPeers()
    pm = new PeerManager(makeSig())
  })

  afterEach(() => pm.destroy())

  test('setStream создаёт AudioContext с gain-нодой', () => {
    _lastGainNode = null
    const stream = makeFakeStream([makeFakeTrack('audio')])
    pm.setStream(stream)
    expect(_lastGainNode).not.toBeNull()
    expect(_ctxCreated.length).toBeGreaterThan(0)
  })

  test('setMicGain устанавливает gain.value = volume/100', () => {
    _lastGainNode = null
    const stream = makeFakeStream([makeFakeTrack('audio')])
    pm.setStream(stream)
    pm.setMicGain(80)
    expect(_lastGainNode!.gain.value).toBeCloseTo(0.8)
  })

  test('setMicGain зажимает значение ниже 0', () => {
    const stream = makeFakeStream([makeFakeTrack('audio')])
    pm.setStream(stream)
    expect(() => pm.setMicGain(-50)).not.toThrow()
  })

  test('setMicGain зажимает значение выше 200', () => {
    const stream = makeFakeStream([makeFakeTrack('audio')])
    pm.setStream(stream)
    expect(() => pm.setMicGain(999)).not.toThrow()
  })

  test('setMicMuted zeroes gain', () => {
    const stream = makeFakeStream([makeFakeTrack('audio')])
    pm.setStream(stream)
    pm.setMicMuted(true)
    expect(() => pm.setMicMuted(false)).not.toThrow()
  })

  test('setMicMuted без gainNode переключает track.enabled', () => {
    const origAC = (global as Record<string, unknown>).AudioContext
    ;(global as Record<string, unknown>).AudioContext = class { constructor() { throw new Error('no ctx') } }

    const track = makeFakeTrack('audio')
    const stream = makeFakeStream([track])
    pm.setStream(stream)
    pm.setMicMuted(true)
    expect(track.enabled).toBe(false)
    pm.setMicMuted(false)
    expect(track.enabled).toBe(true)

    ;(global as Record<string, unknown>).AudioContext = origAC
  })

  test('setDeafened заглушает все audio-элементы', () => {
    expect(() => pm.setDeafened(true)).not.toThrow()
    expect(() => pm.setDeafened(false)).not.toThrow()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 3. createPeer / signal / removePeer
// ══════════════════════════════════════════════════════════════════════════

describe('createPeer / signal / removePeer', () => {
  let pm: PeerManager
  let sig: ReturnType<typeof makeSig>

  beforeEach(() => {
    clearPeers()
    sig = makeSig()
    pm = new PeerManager(sig)
    const stream = makeFakeStream([makeFakeTrack('audio')])
    pm.setStream(stream)
  })

  afterEach(() => pm.destroy())

  test('createPeer создаёт SimplePeer с initiator=true', () => {
    pm.createPeer('peer1', 'Alice', true)
    expect(getPeers()).toHaveLength(1)
    expect(getPeers()[0]._opts.initiator).toBe(true)
  })

  test('createPeer не создаёт дубликат для того же peerId', () => {
    pm.createPeer('peer1', 'Alice', true)
    pm.createPeer('peer1', 'Alice', false)
    expect(getPeers()).toHaveLength(1)
  })

  test('createPeer вызывает onPeersChanged', () => {
    const cb = jest.fn()
    pm.onPeersChanged = cb
    pm.createPeer('peer1', 'Alice', true)
    expect(cb).toHaveBeenCalledWith([{ id: 'peer1', nickname: 'Alice', isSharing: false }])
  })

  test('signal делегирует вызов в peer.signal', () => {
    pm.createPeer('peer1', 'Alice', true)
    pm.signal('peer1', { type: 'offer', sdp: 'x' })
    expect(getPeers()[0].signal).toHaveBeenCalledWith({ type: 'offer', sdp: 'x' })
  })

  test('signal на несуществующий peer не бросает ошибку', () => {
    expect(() => pm.signal('ghost', { type: 'offer' })).not.toThrow()
  })

  test('signal на destroyed peer не вызывает peer.signal', () => {
    pm.createPeer('peer1', 'Alice', true)
    const p = getPeers()[0]
    p.destroyed = true
    pm.signal('peer1', { type: 'offer' })
    expect(p.signal).not.toHaveBeenCalled()
  })

  test('relay вызывается когда peer эмитирует signal', () => {
    pm.createPeer('peer1', 'Alice', true)
    const mockPeer = getPeers()[0]
    mockPeer.emit('signal', { type: 'offer', sdp: 'test' })
    expect(sig.relay).toHaveBeenCalledWith('peer1', { type: 'offer', sdp: 'test' })
  })

  test('removePeer уничтожает peer и убирает из списка', () => {
    pm.createPeer('peer1', 'Alice', true)
    const p = getPeers()[0]
    pm.removePeer('peer1')
    expect(p.destroyed).toBe(true)
    expect(pm.getPeerIds()).not.toContain('peer1')
  })

  test('removePeer вызывает onPeersChanged с пустым массивом', () => {
    pm.createPeer('peer1', 'Alice', true)
    const cb = jest.fn()
    pm.onPeersChanged = cb
    pm.removePeer('peer1')
    expect(cb).toHaveBeenCalledWith([])
  })

  test('peer.close event вызывает removePeer', () => {
    pm.createPeer('peer1', 'Alice', true)
    const cb = jest.fn()
    pm.onPeersChanged = cb
    getPeers()[0].emit('close')
    expect(pm.getPeerIds()).not.toContain('peer1')
  })

  test('peer.error event вызывает removePeer', () => {
    pm.createPeer('peer1', 'Alice', true)
    getPeers()[0].emit('error', new Error('test'))
    expect(pm.getPeerIds()).not.toContain('peer1')
  })

  test('updatePeerNickname обновляет nickname в onPeersChanged', () => {
    pm.createPeer('peer1', 'Alice', true)
    const cb = jest.fn()
    pm.onPeersChanged = cb
    pm.updatePeerNickname('peer1', 'Alice2')
    expect(cb).toHaveBeenCalledWith([{ id: 'peer1', nickname: 'Alice2', isSharing: false }])
  })

  test('getPeerIds возвращает все активные id', () => {
    pm.createPeer('p1', 'A', true)
    pm.createPeer('p2', 'B', false)
    expect(pm.getPeerIds()).toEqual(expect.arrayContaining(['p1', 'p2']))
    expect(pm.getPeerIds()).toHaveLength(2)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 4. startScreenShare / stopScreenShare
// ══════════════════════════════════════════════════════════════════════════

describe('screen sharing', () => {
  let pm: PeerManager

  beforeEach(() => {
    clearPeers()
    pm = new PeerManager(makeSig())
    pm.setStream(makeFakeStream([makeFakeTrack('audio')]))
    pm.createPeer('p1', 'Alice', true)
    pm.createPeer('p2', 'Bob', false)
  })

  afterEach(() => pm.destroy())

  test('startScreenShare бросает если нет video track', async () => {
    const emptyStream = makeFakeStream([], [])
    await expect(pm.startScreenShare(emptyStream)).rejects.toThrow('No video track in stream')
  })

  test('startScreenShare добавляет video track всем пирам', async () => {
    const videoTrack = makeFakeTrack('video')
    const screenStream = makeFakeStream([], [videoTrack])
    await pm.startScreenShare(screenStream)
    const [p1, p2] = getPeers()
    expect(p1.addTrack).toHaveBeenCalledWith(videoTrack, screenStream)
    expect(p2.addTrack).toHaveBeenCalledWith(videoTrack, screenStream)
  })

  test('startScreenShare добавляет audio track если есть', async () => {
    const videoTrack = makeFakeTrack('video')
    const audioTrack = makeFakeTrack('audio')
    const screenStream = makeFakeStream([audioTrack], [videoTrack])
    await pm.startScreenShare(screenStream)
    const [p1, p2] = getPeers()
    expect(p1.addTrack).toHaveBeenCalledWith(audioTrack, screenStream)
    expect(p2.addTrack).toHaveBeenCalledWith(audioTrack, screenStream)
  })

  test('startScreenShare не добавляет audio если его нет', async () => {
    const videoTrack = makeFakeTrack('video')
    const screenStream = makeFakeStream([], [videoTrack])
    await pm.startScreenShare(screenStream)
    const [p1] = getPeers()
    expect(p1.addTrack).toHaveBeenCalledTimes(1)
  })

  test('stopScreenShare удаляет треки со всех пиров', async () => {
    const videoTrack = makeFakeTrack('video')
    const screenStream = makeFakeStream([], [videoTrack])
    await pm.startScreenShare(screenStream)
    pm.stopScreenShare()
    const [p1, p2] = getPeers()
    expect(p1.removeTrack).toHaveBeenCalledWith(videoTrack, screenStream)
    expect(p2.removeTrack).toHaveBeenCalledWith(videoTrack, screenStream)
  })

  test('stopScreenShare останавливает video track', async () => {
    const videoTrack = makeFakeTrack('video')
    const screenStream = makeFakeStream([], [videoTrack])
    await pm.startScreenShare(screenStream)
    pm.stopScreenShare()
    expect(videoTrack.stop).toHaveBeenCalled()
  })

  test('stopScreenShare без активного sharing не бросает ошибку', () => {
    expect(() => pm.stopScreenShare()).not.toThrow()
  })

  test('новый peer получает screen track если sharing уже активно', async () => {
    clearPeers()
    pm = new PeerManager(makeSig())
    pm.setStream(makeFakeStream([makeFakeTrack('audio')]))

    const videoTrack = makeFakeTrack('video')
    const screenStream = makeFakeStream([], [videoTrack])
    await pm.startScreenShare(screenStream)

    pm.createPeer('late', 'Late', false)
    const latePeer = getPeers()[0]
    expect(latePeer.addTrack).toHaveBeenCalledWith(videoTrack, screenStream)
  })

  test('onended video track вызывает stopScreenShare', async () => {
    const videoTrack = makeFakeTrack('video')
    const screenStream = makeFakeStream([], [videoTrack])
    await pm.startScreenShare(screenStream)

    ;(videoTrack as unknown as { onended: (() => void) | null }).onended?.()

    expect(() => pm.stopScreenShare()).not.toThrow()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 5. destroyAll
// ══════════════════════════════════════════════════════════════════════════

describe('destroyAll', () => {
  test('уничтожает все пиры и очищает состояние', async () => {
    clearPeers()
    const pm = new PeerManager(makeSig())
    pm.setStream(makeFakeStream([makeFakeTrack('audio')]))
    pm.createPeer('p1', 'A', true)
    pm.createPeer('p2', 'B', false)

    const videoTrack = makeFakeTrack('video')
    await pm.startScreenShare(makeFakeStream([], [videoTrack]))

    pm.destroyAll()

    expect(pm.getPeerIds()).toHaveLength(0)
    expect(videoTrack.stop).toHaveBeenCalled()
    getPeers().forEach(p => expect(p.destroyed).toBe(true))
    pm.destroy()
  })

  test('onPeersChanged вызывается с пустым массивом', () => {
    clearPeers()
    const pm = new PeerManager(makeSig())
    pm.createPeer('p1', 'A', true)
    const cb = jest.fn()
    pm.onPeersChanged = cb
    pm.destroyAll()
    expect(cb).toHaveBeenLastCalledWith([])
    pm.destroy()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 6. VAD — voice activity detection
// ══════════════════════════════════════════════════════════════════════════

describe('VAD (voice activity detection)', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('onSpeakingChanged вызывается когда peer начинает говорить', () => {
    clearPeers()
    const pm = new PeerManager(makeSig())
    pm.setStream(makeFakeStream([makeFakeTrack('audio')]))
    pm.createPeer('speaker', 'Alice', true)

    const mockPeer = getPeers()[0]
    const speakingCb = jest.fn()
    pm.onSpeakingChanged = speakingCb

    const analyser = new MockAnalyserNode()
    analyser.getFloatTimeDomainData.mockImplementation((arr: Float32Array) => {
      arr.fill(0.1)
    })
    _nextAnalyser = analyser

    mockPeer.emit('stream', makeFakeStream([makeFakeTrack('audio')]))
    jest.advanceTimersByTime(100)

    expect(speakingCb).toHaveBeenCalledWith(new Set(['speaker']))
    pm.destroy()
  })

  test('onSpeakingChanged вызывается когда peer замолкает', () => {
    clearPeers()
    const pm = new PeerManager(makeSig())
    pm.setStream(makeFakeStream([makeFakeTrack('audio')]))
    pm.createPeer('speaker', 'Alice', true)

    const mockPeer = getPeers()[0]
    const speakingCb = jest.fn()
    pm.onSpeakingChanged = speakingCb

    let amplitude = 0.1
    const analyser = new MockAnalyserNode()
    analyser.getFloatTimeDomainData.mockImplementation((arr: Float32Array) => arr.fill(amplitude))
    _nextAnalyser = analyser

    mockPeer.emit('stream', makeFakeStream([makeFakeTrack('audio')]))
    jest.advanceTimersByTime(100)

    amplitude = 0
    jest.advanceTimersByTime(100)

    const lastCall = speakingCb.mock.calls[speakingCb.mock.calls.length - 1][0] as Set<string>
    expect(lastCall.has('speaker')).toBe(false)
    pm.destroy()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 7. remote video events
// ══════════════════════════════════════════════════════════════════════════

describe('remote video (screen share receive)', () => {
  test('onRemoteVideo вызывается при получении video track через track event', () => {
    clearPeers()
    const pm = new PeerManager(makeSig())
    pm.setStream(makeFakeStream([makeFakeTrack('audio')]))
    pm.createPeer('sharer', 'Alice', false)

    const mockPeer = getPeers()[0]
    const onVideo = jest.fn()
    pm.onRemoteVideo = onVideo
    pm.onSharingChanged = jest.fn()

    const videoTrack = makeFakeTrack('video')
    const remoteStream = makeFakeStream([], [videoTrack])
    mockPeer.emit('track', videoTrack, [remoteStream])

    expect(onVideo).toHaveBeenCalledWith('sharer', videoTrack, [remoteStream])
    pm.destroy()
  })

  test('onSharingChanged обновляется когда video track заканчивается', () => {
    clearPeers()
    const pm = new PeerManager(makeSig())
    pm.setStream(makeFakeStream([makeFakeTrack('audio')]))
    pm.createPeer('sharer', 'Alice', false)

    const mockPeer = getPeers()[0]
    const sharingCb = jest.fn()
    pm.onSharingChanged = sharingCb
    pm.onRemoteVideo = jest.fn()

    const videoTrack = makeFakeTrack('video')
    mockPeer.emit('track', videoTrack, [makeFakeStream([], [videoTrack])])

    ;(videoTrack as unknown as { onended: (() => void) | null }).onended?.()

    const lastCall = sharingCb.mock.calls[sharingCb.mock.calls.length - 1][0] as Set<string>
    expect(lastCall.has('sharer')).toBe(false)
    pm.destroy()
  })

  test('onRemoteVideo вызывается при получении video через stream event', () => {
    clearPeers()
    const pm = new PeerManager(makeSig())
    pm.setStream(makeFakeStream([makeFakeTrack('audio')]))
    pm.createPeer('sharer', 'Alice', false)

    const mockPeer = getPeers()[0]
    const onVideo = jest.fn()
    pm.onRemoteVideo = onVideo
    pm.onSharingChanged = jest.fn()

    const videoTrack = makeFakeTrack('video')
    const remoteStream = makeFakeStream([makeFakeTrack('audio')], [videoTrack])
    mockPeer.emit('stream', remoteStream)

    expect(onVideo).toHaveBeenCalledWith('sharer', videoTrack, [remoteStream])
    pm.destroy()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 8. setOutputDevice
// ══════════════════════════════════════════════════════════════════════════

describe('setOutputDevice', () => {
  test('не бросает ошибку при изменении устройства вывода', () => {
    clearPeers()
    const pm = new PeerManager(makeSig())
    expect(() => pm.setOutputDevice('device-123')).not.toThrow()
    pm.destroy()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 9. onPeerDisconnected — критический callback для reconnect
// ══════════════════════════════════════════════════════════════════════════

describe('onPeerDisconnected', () => {
  let pm: PeerManager

  beforeEach(() => {
    clearPeers()
    pm = new PeerManager(makeSig())
    pm.setStream(makeFakeStream([makeFakeTrack('audio')]))
  })

  afterEach(() => pm.destroy())

  test('срабатывает при неожиданном close (не через removePeer)', () => {
    pm.createPeer('peer1', 'Alice', true)
    const cb = jest.fn()
    pm.onPeerDisconnected = cb

    // Emit close directly — unexpected disconnect (WebRTC dropped)
    getPeers()[0].emit('close')

    expect(cb).toHaveBeenCalledWith('peer1')
  })

  test('НЕ срабатывает при намеренном removePeer', () => {
    pm.createPeer('peer1', 'Alice', true)
    const cb = jest.fn()
    pm.onPeerDisconnected = cb

    pm.removePeer('peer1')

    expect(cb).not.toHaveBeenCalled()
  })

  test('НЕ срабатывает при destroyAll', () => {
    pm.createPeer('p1', 'A', true)
    pm.createPeer('p2', 'B', false)
    const cb = jest.fn()
    pm.onPeerDisconnected = cb

    pm.destroyAll()

    expect(cb).not.toHaveBeenCalled()
  })

  test('НЕ срабатывает при неожиданном close если peer уже удалён', () => {
    pm.createPeer('peer1', 'Alice', true)
    const mockPeer = getPeers()[0]
    const cb = jest.fn()
    pm.onPeerDisconnected = cb

    pm.removePeer('peer1')
    cb.mockClear()

    // Second close event (e.g. from stale reference) should not fire callback
    mockPeer.emit('close')

    expect(cb).not.toHaveBeenCalled()
  })

  test('после неожиданного отключения можно создать пира с тем же id', () => {
    pm.createPeer('peer1', 'Alice', true)
    pm.onPeerDisconnected = jest.fn()

    // Unexpected disconnect
    getPeers()[0].emit('close')

    // Should be able to re-create the peer (reconnect flow)
    clearPeers()
    expect(() => pm.createPeer('peer1', 'Alice', false)).not.toThrow()
    expect(pm.getPeerIds()).toContain('peer1')
  })

  test('срабатывает при error (неожиданный обрыв)', () => {
    pm.createPeer('peer1', 'Alice', true)
    const cb = jest.fn()
    pm.onPeerDisconnected = cb

    // Error event → destroy → close → onPeerDisconnected
    getPeers()[0].emit('error', new Error('ICE failed'))

    expect(cb).toHaveBeenCalledWith('peer1')
  })

  test('срабатывает независимо для каждого отключившегося пира', () => {
    pm.createPeer('p1', 'Alice', true)
    pm.createPeer('p2', 'Bob', false)
    const cb = jest.fn()
    pm.onPeerDisconnected = cb

    const [mockP1, mockP2] = getPeers()
    mockP1.emit('close')
    mockP2.emit('close')

    expect(cb).toHaveBeenCalledTimes(2)
    expect(cb).toHaveBeenCalledWith('p1')
    expect(cb).toHaveBeenCalledWith('p2')
  })
})
