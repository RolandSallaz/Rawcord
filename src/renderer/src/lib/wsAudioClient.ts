/**
 * WebSocket-based audio client.
 * Captures mic via AudioWorklet → sends Int16 PCM frames over WebSocket.
 * Receives Int16 PCM frames → plays via scheduled AudioBufferSourceNode.
 *
 * No WebRTC — works through any NAT/firewall on a single TCP port.
 */

import type { SignalingClient } from './signaling'

export interface PeerInfo {
  id: string
  nickname: string
  avatar?: string
}

const SAMPLE_RATE = 48000
const FRAME_SAMPLES = 1920  // 40 ms at 48 kHz — good balance of latency vs message rate
const JITTER_BUF_SEC = 0.06 // 60 ms jitter buffer

// Inline AudioWorklet code loaded as blob URL to avoid Vite/worker complications
const MIC_WORKLET_CODE = `
class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buf = []
    this._frameSize = ${FRAME_SAMPLES}
  }
  process(inputs) {
    const ch = inputs[0]?.[0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) this._buf.push(ch[i])
    while (this._buf.length >= this._frameSize) {
      const chunk = this._buf.splice(0, this._frameSize)
      const i16 = new Int16Array(this._frameSize)
      for (let i = 0; i < this._frameSize; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, chunk[i] * 32767 | 0))
      }
      this.port.postMessage(i16.buffer, [i16.buffer])
    }
    return true
  }
}
registerProcessor('mic-capture', MicCaptureProcessor)
`

export class WsAudioClient {
  private signaling: SignalingClient
  private micStream: MediaStream | null = null
  private micCtx: AudioContext | null = null
  private micWorkletNode: AudioWorkletNode | null = null
  private micMuted = false
  private micGain = 100

  private playCtx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private deafened = false
  private outputDeviceId = ''
  private peerGains = new Map<string, GainNode>()
  private nextPlayTimes = new Map<string, number>()

  // VAD
  private speakingPeers = new Set<string>()
  private peerRmsWindow = new Map<string, number[]>()
  private vadTimer: ReturnType<typeof setInterval> | null = null

  // Local VAD
  private localRms = 0
  private localVadTimer: ReturnType<typeof setInterval> | null = null

  onSpeakingChanged: (speaking: Set<string>) => void = () => {}
  onLocalSpeaking: (speaking: boolean) => void = () => {}

  constructor(signaling: SignalingClient) {
    this.signaling = signaling
    signaling.on('onAudioFrame', (senderId, pcm) => this.handleIncoming(senderId, pcm))
  }

  // ─── Setup ────────────────────────────────────────────────────────────────

  setStream(stream: MediaStream) {
    this.micStream = stream
  }

  async startCapture(): Promise<void> {
    if (!this.micStream) return

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    this.micCtx = ctx
    ctx.addEventListener('statechange', () => {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    })

    const blob = new Blob([MIC_WORKLET_CODE], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }

    const source = ctx.createMediaStreamSource(this.micStream)
    const worklet = new AudioWorkletNode(ctx, 'mic-capture')
    this.micWorkletNode = worklet

    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (this.micMuted) return
      this.signaling.sendBinary(e.data)
      // Local VAD
      const i16 = new Int16Array(e.data)
      let sum = 0
      for (let i = 0; i < i16.length; i++) {
        const f = i16[i] / 32768
        sum += f * f
      }
      this.localRms = Math.sqrt(sum / i16.length)
    }

    source.connect(worklet)
    // worklet doesn't need to connect to destination (no monitoring)

    // Local speaking detection
    this.localVadTimer = setInterval(() => {
      this.onLocalSpeaking(this.localRms > 0.01)
    }, 80)
  }

  private getPlayCtx(): AudioContext {
    if (this.playCtx) return this.playCtx
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    ctx.addEventListener('statechange', () => {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    })
    const master = ctx.createGain()
    master.gain.value = this.deafened ? 0 : 1
    master.connect(ctx.destination)
    this.playCtx = ctx
    this.masterGain = master
    return ctx
  }

  private getPeerGain(peerId: string): GainNode {
    let g = this.peerGains.get(peerId)
    if (!g) {
      const ctx = this.getPlayCtx()
      g = ctx.createGain()
      g.connect(this.masterGain!)
      this.peerGains.set(peerId, g)
    }
    return g
  }

  // ─── Incoming audio ───────────────────────────────────────────────────────

  handleIncoming(peerId: string, data: ArrayBuffer) {
    const int16 = new Int16Array(data)

    // RMS for VAD
    let sum = 0
    for (let i = 0; i < int16.length; i++) {
      const f = int16[i] / 32768
      sum += f * f
    }
    const rms = Math.sqrt(sum / int16.length)
    let win = this.peerRmsWindow.get(peerId)
    if (!win) { win = []; this.peerRmsWindow.set(peerId, win) }
    win.push(rms)
    if (win.length > 4) win.shift()
    const avgRms = win.reduce((a, b) => a + b, 0) / win.length
    const wasSpeaking = this.speakingPeers.has(peerId)
    const isSpeaking = avgRms > 0.005
    if (isSpeaking !== wasSpeaking) {
      isSpeaking ? this.speakingPeers.add(peerId) : this.speakingPeers.delete(peerId)
      this.onSpeakingChanged(new Set(this.speakingPeers))
    }

    if (this.deafened) return
    this.scheduleAudio(peerId, int16)
  }

  private scheduleAudio(peerId: string, int16: Int16Array) {
    const ctx = this.getPlayCtx()
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768

    const buffer = ctx.createBuffer(1, float32.length, SAMPLE_RATE)
    buffer.copyToChannel(float32, 0)
    const duration = float32.length / SAMPLE_RATE

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.getPeerGain(peerId))

    const now = ctx.currentTime
    const prev = this.nextPlayTimes.get(peerId) ?? 0
    const startAt = Math.max(now + JITTER_BUF_SEC, prev)
    source.start(startAt)
    this.nextPlayTimes.set(peerId, startAt + duration)
  }

  // ─── Controls ─────────────────────────────────────────────────────────────

  setMicMuted(muted: boolean) {
    this.micMuted = muted
    if (this.micStream) {
      this.micStream.getAudioTracks().forEach(t => { t.enabled = !muted })
    }
  }

  setMicGain(volume: number) {
    this.micGain = Math.max(0, Math.min(200, volume))
    // Mic gain is applied via stream track (hardware level if supported)
    // For fine control, a GainNode before the worklet could be added later
  }

  setDeafened(deafened: boolean) {
    this.deafened = deafened
    if (this.masterGain) this.masterGain.gain.value = deafened ? 0 : 1
  }

  setOutputDevice(_deviceId: string) {
    this.outputDeviceId = _deviceId
    // AudioContext doesn't expose setSinkId directly;
    // use AudioContext.setSinkId() when available (Chrome 110+)
    if (this.playCtx && 'setSinkId' in this.playCtx) {
      (this.playCtx as unknown as { setSinkId: (id: string) => Promise<void> })
        .setSinkId(_deviceId).catch(() => {})
    }
  }

  setPeerVolume(peerId: string, volume: number) {
    const g = this.peerGains.get(peerId)
    if (g) g.gain.value = Math.max(0, Math.min(2, volume / 100))
  }

  getPeerVolume(peerId: string): number {
    const g = this.peerGains.get(peerId)
    return g ? Math.round(g.gain.value * 100) : 100
  }

  removePeer(peerId: string) {
    this.peerGains.get(peerId)?.disconnect()
    this.peerGains.delete(peerId)
    this.nextPlayTimes.delete(peerId)
    this.peerRmsWindow.delete(peerId)
    this.speakingPeers.delete(peerId)
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  destroy() {
    if (this.localVadTimer) { clearInterval(this.localVadTimer); this.localVadTimer = null }
    if (this.vadTimer) { clearInterval(this.vadTimer); this.vadTimer = null }

    this.micWorkletNode?.disconnect()
    this.micWorkletNode = null
    this.micCtx?.close()
    this.micCtx = null

    this.micStream?.getTracks().forEach(t => t.stop())
    this.micStream = null

    for (const g of this.peerGains.values()) g.disconnect()
    this.peerGains.clear()
    this.masterGain?.disconnect()
    this.masterGain = null
    this.playCtx?.close()
    this.playCtx = null

    this.nextPlayTimes.clear()
    this.peerRmsWindow.clear()
    this.speakingPeers.clear()
  }
}
