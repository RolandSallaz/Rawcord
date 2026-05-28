/**
 * Клиентская обёртка над одним RTCPeerConnection к SFU-серверу.
 *
 * API сделан так, чтобы `ChannelPage.tsx` мог использовать класс почти как
 * прежний `PeerManager` (P2P-mesh). Внутри — один WebRTC-коннект к серверу:
 * исходящий трек микрофона (и опционально видео для screen share) — наш,
 * входящие треки = форварды от других участников, помеченные streamId =
 * sourceParticipantId.
 *
 * Сигналинг идёт через инжектированный объект ISignalingTransport, который
 * умеет слать сообщения (`offer`, `answer`, `ice-candidate`, `stop-produce`)
 * на сервер.
 */

export interface ParticipantInfo {
  id: string
  nickname: string
  avatar?: string
}

export interface PeerState extends ParticipantInfo {
  isSharing: boolean
}

export interface ISignalingTransport {
  send(msg: object): void
}

export class SFUClient {
  private pc: RTCPeerConnection | null = null
  private signaling: ISignalingTransport
  private audioContainer: HTMLDivElement

  /** Микрофон-стрим из getUserMedia (то что отдаём в SFU как наш audio) */
  private micStream: MediaStream | null = null
  private micAudioCtx: AudioContext | null = null
  private micGainNode: GainNode | null = null
  private micVolume = 100
  private micMutedState = false
  private outputDeviceId = ''

  /** Текущее screen-share стрим (то что отдаём как наш video) */
  private screenStream: MediaStream | null = null
  private screenSender: RTCRtpSender | null = null

  /** Известные участники комнаты (без нас) */
  private participants = new Map<string, PeerState>()
  /** Входящие треки от участников: peerId → стрим со звуком и/или видео */
  private remoteStreams = new Map<string, MediaStream>()

  /** VAD по входящему звуку */
  private audioCtx: AudioContext | null = null
  private analysers = new Map<string, AnalyserNode>()
  private speakingPeers = new Set<string>()
  private vadInterval: ReturnType<typeof setInterval> | null = null

  // Callbacks — совместимы по сигнатурам со старым PeerManager, где возможно
  onPeersChanged: (peers: PeerState[]) => void = () => {}
  onRemoteVideo: (peerId: string, track: MediaStreamTrack, streams: readonly MediaStream[]) => void = () => {}
  onRemoteVideoEnded: (peerId: string) => void = () => {}
  onSharingChanged: (sharingPeerIds: Set<string>) => void = () => {}
  onSpeakingChanged: (speaking: Set<string>) => void = () => {}
  onParticipantsUpdated: (peers: PeerState[]) => void = () => {}
  onChat: (from: string, text: string, nickname: string, avatar?: string) => void = () => {}
  onDisconnected: () => void = () => {}

  constructor(signaling: ISignalingTransport) {
    this.signaling = signaling
    this.audioContainer = document.createElement('div')
    this.audioContainer.style.display = 'none'
    document.body.appendChild(this.audioContainer)
  }

  /** Создать PC. iceServers — то что прислал сервер в welcome */
  private ensurePc(iceServers: RTCIceServer[]): RTCPeerConnection {
    if (this.pc) return this.pc
    const pc = new RTCPeerConnection({ iceServers })
    this.pc = pc

    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) {
        this.signaling.send({ type: 'ice-candidate', candidate: e.candidate.toJSON() })
      }
    })

    pc.addEventListener('iceconnectionstatechange', () => {
      console.log(`[SFUClient] iceConnectionState=${pc.iceConnectionState}`)
      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce() } catch { /* ignore */ }
      }
    })

    pc.addEventListener('connectionstatechange', () => {
      console.log(`[SFUClient] connectionState=${pc.connectionState}`)
    })

    pc.addEventListener('track', (e) => {
      this.handleIncomingTrack(e.track, e.streams)
    })

    return pc
  }

  /** Стартуем подключение: создаём PC, addTrack mic, шлём offer */
  async start(iceServers: RTCIceServer[]): Promise<void> {
    const pc = this.ensurePc(iceServers)

    if (this.micStream) {
      for (const track of this.micStream.getAudioTracks()) {
        pc.addTrack(track, this.micStream)
      }
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.signaling.send({ type: 'offer', sdp: pc.localDescription!.sdp })
  }

  /** Применить welcome — узнать участников */
  setInitialParticipants(list: PeerState[]) {
    this.participants.clear()
    for (const p of list) {
      this.participants.set(p.id, p)
    }
    this.notifyPeersChanged()
    this.notifySharingChanged()
  }

  /** Обработать SDP-сообщение от сервера */
  async handleSdp(type: 'offer' | 'answer', sdp: string): Promise<void> {
    if (!this.pc) return
    if (type === 'answer') {
      await this.pc.setRemoteDescription({ type: 'answer', sdp })
    } else {
      // Server-initiated renegotiation (новые форварды)
      await this.pc.setRemoteDescription({ type: 'offer', sdp })
      const answer = await this.pc.createAnswer()
      await this.pc.setLocalDescription(answer)
      this.signaling.send({ type: 'answer', sdp: this.pc.localDescription!.sdp })
    }
  }

  async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc) return
    try { await this.pc.addIceCandidate(candidate) } catch { /* might race */ }
  }

  // ─── Participants events from server ──────────────────────────────────────

  participantJoined(p: PeerState) {
    this.participants.set(p.id, p)
    this.notifyPeersChanged()
  }

  participantLeft(id: string) {
    this.participants.delete(id)
    this.cleanupRemote(id)
    this.notifyPeersChanged()
    this.notifySharingChanged()
  }

  participantUpdated(p: PeerState) {
    const existing = this.participants.get(p.id)
    if (!existing) return
    this.participants.set(p.id, { ...existing, ...p })
    this.notifyPeersChanged()
  }

  participantSharing(id: string, isSharing: boolean) {
    const p = this.participants.get(id)
    if (!p) return
    this.participants.set(id, { ...p, isSharing })
    if (!isSharing) {
      // удалим видео-трек из локального remoteStream
      const s = this.remoteStreams.get(id)
      if (s) {
        for (const t of s.getVideoTracks()) {
          s.removeTrack(t)
        }
      }
      this.onRemoteVideoEnded(id)
    }
    this.notifySharingChanged()
  }

  // ─── Incoming tracks ──────────────────────────────────────────────────────

  private handleIncomingTrack(track: MediaStreamTrack, streams: readonly MediaStream[]) {
    // SFU помечает streamId = sourceParticipantId
    const peerId = streams[0]?.id || track.id
    console.log(`[SFUClient] incoming track kind=${track.kind} peerId=${peerId.slice(0, 8)}`)

    let stream = this.remoteStreams.get(peerId)
    if (!stream) {
      stream = new MediaStream()
      this.remoteStreams.set(peerId, stream)
    }
    // Если в stream уже есть трек того же kind — удалим (replace)
    for (const existing of stream.getTracks()) {
      if (existing.kind === track.kind) {
        stream.removeTrack(existing)
      }
    }
    stream.addTrack(track)

    if (track.kind === 'audio') {
      this.attachAudio(peerId, stream)
    } else if (track.kind === 'video') {
      this.onRemoteVideo(peerId, track, [stream])
      track.onended = () => {
        const s = this.remoteStreams.get(peerId)
        if (s) {
          for (const t of s.getVideoTracks()) s.removeTrack(t)
        }
        this.onRemoteVideoEnded(peerId)
      }
    }
  }

  private attachAudio(peerId: string, stream: MediaStream) {
    let audio = this.audioContainer.querySelector<HTMLAudioElement>(`audio[data-peer-id="${peerId}"]`)
    if (audio) {
      audio.srcObject = stream
    } else {
      audio = document.createElement('audio')
      audio.srcObject = stream
      audio.autoplay = true
      audio.dataset.peerId = peerId
      if (this.outputDeviceId) {
        const a = audio as unknown as { setSinkId?: (id: string) => Promise<void> }
        a.setSinkId?.(this.outputDeviceId).catch(() => {})
      }
      this.audioContainer.appendChild(audio)
      audio.play().catch((err) => console.warn(`[SFUClient] ${peerId.slice(0, 8)} audio.play()`, err))
    }

    // VAD setup
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext()
      this.audioCtx.addEventListener('statechange', () => {
        if (this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => {})
      })
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {})
    if (!this.analysers.has(peerId)) {
      try {
        const source = this.audioCtx.createMediaStreamSource(stream)
        const analyser = this.audioCtx.createAnalyser()
        analyser.fftSize = 512
        const mute = this.audioCtx.createGain()
        mute.gain.value = 0
        source.connect(analyser)
        source.connect(mute)
        mute.connect(this.audioCtx.destination)
        this.analysers.set(peerId, analyser)
        if (!this.vadInterval) this.startVad()
      } catch (e) {
        console.warn('[SFUClient] VAD setup failed', e)
      }
    }
  }

  private startVad() {
    const buf = new Float32Array(512)
    this.vadInterval = setInterval(() => {
      let changed = false
      for (const [id, analyser] of this.analysers) {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += v * v
        const speaking = Math.sqrt(sum / buf.length) > 0.01
        const was = this.speakingPeers.has(id)
        if (speaking !== was) {
          if (speaking) this.speakingPeers.add(id)
          else this.speakingPeers.delete(id)
          changed = true
        }
      }
      if (changed) this.onSpeakingChanged(new Set(this.speakingPeers))
    }, 80)
  }

  private cleanupRemote(peerId: string) {
    this.remoteStreams.delete(peerId)
    this.analysers.delete(peerId)
    this.speakingPeers.delete(peerId)
    const audio = this.audioContainer.querySelector(`audio[data-peer-id="${peerId}"]`)
    audio?.remove()
    if (this.analysers.size === 0 && this.vadInterval) {
      clearInterval(this.vadInterval)
      this.vadInterval = null
    }
  }

  // ─── Public API (compat with old PeerManager) ─────────────────────────────

  setStream(stream: MediaStream): void {
    this.micStream = stream
    console.log('[SFUClient] setStream', stream.getAudioTracks().map(t => ({ label: t.label, enabled: t.enabled })))
  }

  setMicGain(volume: number): void {
    this.micVolume = Math.max(0, Math.min(200, volume))
    if (this.micGainNode && !this.micMutedState) {
      this.micGainNode.gain.value = this.micVolume / 100
    }
  }

  setMicMuted(muted: boolean): void {
    this.micMutedState = muted
    this.micStream?.getAudioTracks().forEach(t => { t.enabled = !muted })
  }

  setDeafened(deafened: boolean): void {
    this.audioContainer.querySelectorAll('audio').forEach(el => { (el as HTMLAudioElement).muted = deafened })
  }

  setOutputDevice(deviceId: string): void {
    this.outputDeviceId = deviceId
    this.audioContainer.querySelectorAll('audio').forEach(el => {
      const a = el as unknown as { setSinkId?: (id: string) => Promise<void> }
      if (deviceId && a.setSinkId) a.setSinkId(deviceId).catch(() => {})
    })
  }

  setPeerVolume(peerId: string, volume: number): void {
    const el = this.audioContainer.querySelector<HTMLAudioElement>(`audio[data-peer-id="${peerId}"]`)
    if (el) el.volume = Math.max(0, Math.min(2, volume / 100))
  }

  getPeerVolume(peerId: string): number {
    const el = this.audioContainer.querySelector<HTMLAudioElement>(`audio[data-peer-id="${peerId}"]`)
    return el ? Math.round(el.volume * 100) : 100
  }

  async startScreenShare(stream: MediaStream): Promise<void> {
    if (!this.pc) throw new Error('PC not ready')
    this.screenStream = stream
    const videoTrack = stream.getVideoTracks()[0]
    if (!videoTrack) throw new Error('No video track in screen share stream')

    this.screenSender = this.pc.addTrack(videoTrack, stream)

    // Send share audio if available (system sound from screen share)
    const audioTrack = stream.getAudioTracks()[0]
    if (audioTrack) {
      // Помечаем как отдельный трек — это пойдёт на сервер как ещё один аудио,
      // но текущий SFU мапит по kind, что не идеально. Пока шлём только видео.
      // TODO: разделить mic-audio и screen-audio метками в SDP.
    }

    videoTrack.onended = () => { this.stopScreenShare().catch(() => {}) }

    // Renegotiate
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    this.signaling.send({ type: 'offer', sdp: this.pc.localDescription!.sdp })
  }

  async stopScreenShare(): Promise<void> {
    if (!this.pc) return
    if (this.screenSender) {
      try { this.pc.removeTrack(this.screenSender) } catch {}
      this.screenSender = null
    }
    this.screenStream?.getTracks().forEach(t => t.stop())
    this.screenStream = null

    // Notify SFU
    this.signaling.send({ type: 'stop-produce', kind: 'video' })

    // Renegotiate
    try {
      const offer = await this.pc.createOffer()
      await this.pc.setLocalDescription(offer)
      this.signaling.send({ type: 'offer', sdp: this.pc.localDescription!.sdp })
    } catch { /* ignore */ }
  }

  // ─── Helpers / lifecycle ──────────────────────────────────────────────────

  private notifyPeersChanged() {
    const peers = [...this.participants.values()]
    this.onPeersChanged(peers)
    this.onParticipantsUpdated(peers)
  }

  private notifySharingChanged() {
    const sharing = new Set<string>()
    for (const p of this.participants.values()) {
      if (p.isSharing) sharing.add(p.id)
    }
    this.onSharingChanged(sharing)
  }

  getPeerIds(): string[] {
    return [...this.participants.keys()]
  }

  getPeerStates(): PeerState[] {
    return [...this.participants.values()]
  }

  destroy(): void {
    if (this.vadInterval) { clearInterval(this.vadInterval); this.vadInterval = null }
    try { this.pc?.close() } catch {}
    this.pc = null
    this.micStream?.getTracks().forEach(t => t.stop())
    this.micStream = null
    this.screenStream?.getTracks().forEach(t => t.stop())
    this.screenStream = null
    this.audioCtx?.close()
    this.audioCtx = null
    this.micAudioCtx?.close()
    this.micAudioCtx = null
    this.micGainNode = null
    this.audioContainer.remove()
    this.participants.clear()
    this.remoteStreams.clear()
    this.analysers.clear()
    this.speakingPeers.clear()
  }
}
