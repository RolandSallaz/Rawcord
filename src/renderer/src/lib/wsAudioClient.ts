/**
 * WebSocket-based audio + video client.
 *
 * Audio: Int16 PCM frames sent as 0x01 binary frames.
 * Video: WebM chunks from MediaRecorder sent as 0x02 binary frames.
 *        Received chunks fed into MSE (MediaSource Extensions) per sender.
 *
 * System audio during screen share: Web Audio phase-cancellation removes
 * the Rawcord voice output from the loopback capture (best-effort).
 */

import type { SignalingClient, StreamerInfo } from './signaling'

export interface PeerInfo {
  id: string
  nickname: string
  avatar?: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 48000
const FRAME_SAMPLES = 1920   // 40 ms
const JITTER_BUF_SEC = 0.06  // 60 ms jitter buffer

const MIC_WORKLET_CODE = `
class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._buf = []; this._frameSize = ${FRAME_SAMPLES} }
  process(inputs) {
    const ch = inputs[0]?.[0]; if (!ch) return true
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

// ─── VideoReceiver: MSE-based stream player ───────────────────────────────────

class VideoReceiver {
  private ms = new MediaSource()
  private sb: SourceBuffer | null = null
  private queue: ArrayBuffer[] = []
  private url: string
  readonly el: HTMLVideoElement

  // Live playback tuning
  private static readonly MAX_LATENCY = 1.0    // seconds behind live before we jump forward
  private static readonly EVICT_BEHIND = 8.0   // keep at most this much buffered behind currentTime

  constructor(mimeType: string) {
    this.el = document.createElement('video')
    this.el.autoplay = true
    this.el.playsInline = true
    this.el.style.width = '100%'
    this.el.style.display = 'block'
    // Start muted so autoplay is never blocked by the browser policy; the UI
    // unmutes once the user opens the stream (a user gesture).
    this.el.muted = true

    this.url = URL.createObjectURL(this.ms)
    this.el.src = this.url

    // Kick playback whenever data is ready (autoplay can still stall otherwise).
    const tryPlay = () => { this.el.play().catch(() => {}) }
    this.el.addEventListener('canplay', tryPlay)
    this.el.addEventListener('loadeddata', tryPlay)
    // Keep close to the live edge.
    this.el.addEventListener('timeupdate', () => this.catchUpToLive())

    this.ms.addEventListener('sourceopen', () => {
      if (this.ms.readyState !== 'open') return
      try {
        this.sb = this.ms.addSourceBuffer(mimeType)
        this.sb.mode = 'sequence'   // chunks arrive in order; ignore internal timestamps
        this.sb.addEventListener('updateend', () => { this.evictOld(); this.drainQueue() })
        this.drainQueue()
      } catch (e) {
        console.warn('[VideoReceiver] addSourceBuffer failed:', mimeType, e)
      }
    })
  }

  append(chunk: ArrayBuffer) {
    this.queue.push(chunk)
    if (this.sb && !this.sb.updating) this.drainQueue()
  }

  private drainQueue() {
    while (this.queue.length > 0 && this.sb && !this.sb.updating) {
      try {
        this.sb.appendBuffer(this.queue.shift()!)
      } catch (e) {
        // QuotaExceededError: buffer is full — evict old data and retry next tick.
        if (e instanceof DOMException && e.name === 'QuotaExceededError') {
          this.evictOld(true)
        } else {
          console.warn('[VideoReceiver] appendBuffer error:', e)
        }
        break   // wait for updateend / next frame instead of dropping everything
      }
    }
  }

  /** Drop buffered data well behind the playhead to avoid unbounded growth / quota stalls. */
  private evictOld(aggressive = false) {
    if (!this.sb || this.sb.updating || this.sb.buffered.length === 0) return
    const start = this.sb.buffered.start(0)
    const cutoff = (aggressive ? this.el.currentTime - 2 : this.el.currentTime - VideoReceiver.EVICT_BEHIND)
    if (cutoff > start) {
      try { this.sb.remove(start, cutoff) } catch {}
    }
  }

  /** If playback has drifted behind the live edge, jump forward. */
  private catchUpToLive() {
    if (!this.sb || this.sb.buffered.length === 0) return
    const liveEdge = this.sb.buffered.end(this.sb.buffered.length - 1)
    if (liveEdge - this.el.currentTime > VideoReceiver.MAX_LATENCY) {
      this.el.currentTime = liveEdge - 0.1
    }
  }

  destroy() {
    this.sb = null
    try { if (this.ms.readyState === 'open') this.ms.endOfStream() } catch {}
    URL.revokeObjectURL(this.url)
    this.el.src = ''
    this.el.removeAttribute('src')
    this.el.load()
  }
}

// ─── WsAudioClient ─────────────────────────────────────────────────────────────

export class WsAudioClient {
  private signaling: SignalingClient

  // Mic capture
  private micStream: MediaStream | null = null
  private micCtx: AudioContext | null = null
  private micWorkletNode: AudioWorkletNode | null = null
  private micMuted = false
  private micVolume = 100

  // Playback
  private playCtx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private deafened = false
  private outputDeviceId = ''
  private peerGains = new Map<string, GainNode>()
  private nextPlayTimes = new Map<string, number>()
  private voiceOutputDest: MediaStreamAudioDestinationNode | null = null

  // VAD
  private speakingPeers = new Set<string>()
  private peerRmsWindow = new Map<string, number[]>()
  private localRms = 0
  private localVadTimer: ReturnType<typeof setInterval> | null = null

  // Screen share — sender
  private screenRecorder: MediaRecorder | null = null
  private screenStream: MediaStream | null = null
  private cancelCtx: AudioContext | null = null  // for voice cancellation from sys audio

  // Screen share — receiver
  private videoReceivers = new Map<string, VideoReceiver>()

  // Callbacks
  onSpeakingChanged: (speaking: Set<string>) => void = () => {}
  onLocalSpeaking: (speaking: boolean) => void = () => {}
  onStreamStarted: (peerId: string, el: HTMLVideoElement) => void = () => {}
  onStreamStopped: (peerId: string) => void = () => {}
  onRemoteStreamMimeType = new Map<string, string>()   // peerId → mimeType

  constructor(signaling: SignalingClient) {
    this.signaling = signaling

    signaling.on('onAudioFrame', (id, payload) => this.handleAudioFrame(id, payload))
    signaling.on('onVideoFrame', (id, chunk) => this.handleVideoFrame(id, chunk))
    signaling.on('onStreamStarted', (id, mimeType) => this.handleStreamStarted(id, mimeType))
    signaling.on('onStreamStopped', (id) => this.handleStreamStopped(id))
  }

  // ─── Setup ─────────────────────────────────────────────────────────────────

  setStream(stream: MediaStream) { this.micStream = stream }

  /**
   * Detach the mic stream so a subsequent destroy() will NOT stop its tracks.
   * Used during reconnect to keep the same capture device alive across sockets.
   */
  detachMicStream(): MediaStream | null {
    const s = this.micStream
    this.micStream = null
    return s
  }

  /** Apply live audio constraints (e.g. noise suppression) to the active mic track. */
  async applyMicConstraints(constraints: MediaTrackConstraints): Promise<void> {
    const track = this.micStream?.getAudioTracks()[0]
    if (!track) return
    try { await track.applyConstraints(constraints) } catch (e) { console.warn('[WsAudioClient] applyConstraints failed:', e) }
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
      const i16 = new Int16Array(e.data)
      // Apply mic gain (volume slider, 0–200% → 0.0–2.0).
      const factor = this.micVolume / 100
      if (factor !== 1) {
        for (let i = 0; i < i16.length; i++) {
          i16[i] = Math.max(-32768, Math.min(32767, Math.round(i16[i] * factor)))
        }
      }
      this.signaling.sendBinary(0x01, e.data)
      // Local VAD (post-gain)
      let sum = 0; for (let i = 0; i < i16.length; i++) { const f = i16[i] / 32768; sum += f * f }
      this.localRms = Math.sqrt(sum / i16.length)
    }

    source.connect(worklet)

    this.localVadTimer = setInterval(() => {
      this.onLocalSpeaking(this.localRms > 0.01)
    }, 80)
  }

  /** Initialize known streamers (received in welcome) */
  initStreamers(streamers: StreamerInfo[]) {
    for (const s of streamers) {
      this.onRemoteStreamMimeType.set(s.id, s.mimeType)
      // VideoReceiver will be created on first video frame
    }
  }

  // ─── Audio playback ────────────────────────────────────────────────────────

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

  /** Returns a MediaStream of all received peer audio (for system-audio cancellation) */
  getVoiceOutputStream(): MediaStream | null {
    if (!this.playCtx || !this.masterGain) return null
    try {
      // Reuse a single destination node to avoid leaking one per call.
      if (!this.voiceOutputDest) {
        this.voiceOutputDest = this.playCtx.createMediaStreamDestination()
        this.masterGain.connect(this.voiceOutputDest)
      }
      return this.voiceOutputDest.stream
    } catch { return null }
  }

  // ─── Incoming audio ─────────────────────────────────────────────────────────

  private handleAudioFrame(peerId: string, data: ArrayBuffer) {
    const int16 = new Int16Array(data)

    // VAD
    let sum = 0
    for (let i = 0; i < int16.length; i++) { const f = int16[i] / 32768; sum += f * f }
    const rms = Math.sqrt(sum / int16.length)
    let win = this.peerRmsWindow.get(peerId)
    if (!win) { win = []; this.peerRmsWindow.set(peerId, win) }
    win.push(rms); if (win.length > 4) win.shift()
    const avg = win.reduce((a, b) => a + b, 0) / win.length
    const was = this.speakingPeers.has(peerId)
    const is = avg > 0.005
    if (is !== was) { is ? this.speakingPeers.add(peerId) : this.speakingPeers.delete(peerId); this.onSpeakingChanged(new Set(this.speakingPeers)) }

    if (this.deafened) return

    const ctx = this.getPlayCtx()
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768
    const buffer = ctx.createBuffer(1, float32.length, SAMPLE_RATE)
    buffer.copyToChannel(float32, 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.getPeerGain(peerId))
    const now = ctx.currentTime
    const prev = this.nextPlayTimes.get(peerId) ?? 0
    const startAt = Math.max(now + JITTER_BUF_SEC, prev)
    source.start(startAt)
    this.nextPlayTimes.set(peerId, startAt + float32.length / SAMPLE_RATE)
  }

  // ─── Screen share — receiver ────────────────────────────────────────────────

  private handleVideoFrame(peerId: string, chunk: ArrayBuffer) {
    let receiver = this.videoReceivers.get(peerId)
    if (!receiver) {
      // Create receiver lazily on first video frame
      const mimeType = this.onRemoteStreamMimeType.get(peerId) ?? 'video/webm'
      receiver = new VideoReceiver(mimeType)
      this.videoReceivers.set(peerId, receiver)
      this.onStreamStarted(peerId, receiver.el)
    }
    receiver.append(chunk)
  }

  private handleStreamStarted(peerId: string, mimeType: string) {
    this.onRemoteStreamMimeType.set(peerId, mimeType)
    // VideoReceiver created lazily when first chunk arrives
  }

  private handleStreamStopped(peerId: string) {
    const receiver = this.videoReceivers.get(peerId)
    if (receiver) { receiver.destroy(); this.videoReceivers.delete(peerId) }
    this.onRemoteStreamMimeType.delete(peerId)
    this.onStreamStopped(peerId)
  }

  // ─── Screen share — sender ──────────────────────────────────────────────────

  /**
   * Start screen sharing.
   * captureStream: from getDisplayMedia (video + optional audio)
   * If captureStream has audio, attempts to cancel Rawcord voices from it.
   */
  async startScreenShare(captureStream: MediaStream): Promise<void> {
    if (this.screenRecorder) return

    const videoTrack = captureStream.getVideoTracks()[0]
    if (!videoTrack) throw new Error('No video track')

    let streamToRecord = captureStream

    // System audio: subtract Rawcord voice output (best-effort phase cancellation)
    const sysAudioTrack = captureStream.getAudioTracks()[0]
    if (sysAudioTrack) {
      const voiceStream = this.getVoiceOutputStream()
      if (voiceStream && voiceStream.getAudioTracks().length > 0) {
        try {
          const ctx = new AudioContext()
          this.cancelCtx = ctx
          const sysSrc = ctx.createMediaStreamSource(new MediaStream([sysAudioTrack]))
          const voiceSrc = ctx.createMediaStreamSource(voiceStream)
          // Delay voice reference ~20ms to match system-audio loopback latency
          const delay = ctx.createDelay(0.1)
          delay.delayTime.value = 0.02
          const cancelGain = ctx.createGain()
          cancelGain.gain.value = -1   // invert
          const dest = ctx.createMediaStreamDestination()
          sysSrc.connect(dest)
          voiceSrc.connect(delay)
          delay.connect(cancelGain)
          cancelGain.connect(dest)
          const cleanAudio = dest.stream.getAudioTracks()[0]
          streamToRecord = new MediaStream([videoTrack, cleanAudio])
        } catch {
          // Cancellation failed — fall back to raw system audio
        }
      }
    }

    const mimeType = this.pickMimeType()
    this.signaling.streamStart(mimeType)

    const recorder = new MediaRecorder(streamToRecord, {
      mimeType,
      videoBitsPerSecond: 1_500_000,
    })

    recorder.ondataavailable = async (e) => {
      if (e.data.size === 0) return
      const buf = await e.data.arrayBuffer()
      this.signaling.sendBinary(0x02, buf)
    }

    recorder.start(200)   // 200ms chunks
    this.screenRecorder = recorder
    this.screenStream = captureStream

    videoTrack.addEventListener('ended', () => { this.stopScreenShare() })
  }

  stopScreenShare() {
    if (!this.screenRecorder) return
    this.screenRecorder.stop()
    this.screenRecorder = null
    this.screenStream?.getTracks().forEach(t => t.stop())
    this.screenStream = null
    this.cancelCtx?.close()
    this.cancelCtx = null
    this.signaling.streamStop()
  }

  isSharing(): boolean { return this.screenRecorder !== null }

  private pickMimeType(): string {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ]
    return candidates.find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'
  }

  // ─── Controls ──────────────────────────────────────────────────────────────

  setMicMuted(muted: boolean) {
    this.micMuted = muted
    this.micStream?.getAudioTracks().forEach(t => { t.enabled = !muted })
  }

  setMicGain(volume: number) {
    this.micVolume = Math.max(0, Math.min(200, volume))
  }

  setDeafened(deafened: boolean) {
    this.deafened = deafened
    if (this.masterGain) this.masterGain.gain.value = deafened ? 0 : 1
  }

  setOutputDevice(deviceId: string) {
    this.outputDeviceId = deviceId
    if (this.playCtx && 'setSinkId' in this.playCtx) {
      (this.playCtx as unknown as { setSinkId: (id: string) => Promise<void> })
        .setSinkId(deviceId).catch(() => {})
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
    // Also clean up any video receiver for this peer
    this.handleStreamStopped(peerId)
  }

  getVideoElement(peerId: string): HTMLVideoElement | null {
    return this.videoReceivers.get(peerId)?.el ?? null
  }

  getActiveStreamers(): string[] {
    return [...this.videoReceivers.keys()]
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  destroy() {
    if (this.localVadTimer) { clearInterval(this.localVadTimer); this.localVadTimer = null }
    this.stopScreenShare()

    this.micWorkletNode?.disconnect()
    this.micWorkletNode = null
    this.micCtx?.close(); this.micCtx = null
    this.micStream?.getTracks().forEach(t => t.stop()); this.micStream = null

    for (const g of this.peerGains.values()) g.disconnect()
    this.peerGains.clear()
    this.voiceOutputDest?.disconnect(); this.voiceOutputDest = null
    this.masterGain?.disconnect(); this.masterGain = null
    this.playCtx?.close(); this.playCtx = null

    for (const r of this.videoReceivers.values()) r.destroy()
    this.videoReceivers.clear()
    this.onRemoteStreamMimeType.clear()

    this.nextPlayTimes.clear()
    this.peerRmsWindow.clear()
    this.speakingPeers.clear()
  }
}
