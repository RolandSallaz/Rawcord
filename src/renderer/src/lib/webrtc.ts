import SimplePeer from 'simple-peer'

interface ISignaling {
  relay(to: string, payload: object): void
}

export interface PeerState {
  id: string
  nickname: string
  isSharing?: boolean
}

function mungeOpus(sdp: string): string {
  const lines = sdp.split('\r\n')
  let opusPt = ''
  for (const line of lines) {
    const m = line.match(/a=rtpmap:(\d+) opus/i)
    if (m) { opusPt = m[1]; break }
  }
  if (!opusPt) return sdp
  return sdp.replace(
    new RegExp(`(a=fmtp:${opusPt} )([^\r\n]*)`, 'g'),
    (_, prefix, params) => {
      const parts = (params as string).split(';').filter(Boolean)
      const addIfMissing = (k: string, v: string) => {
        if (!parts.some(p => p.trim().startsWith(k))) parts.push(`${k}=${v}`)
      }
      addIfMissing('usedtx', '1')
      addIfMissing('useinbandfec', '1')
      addIfMissing('stereo', '0')
      addIfMissing('maxaveragebitrate', '40000')
      return prefix + parts.join(';')
    }
  )
}

export class PeerManager {
  private peers = new Map<string, SimplePeer.Instance>()
  private stream: MediaStream | null = null
  private originalStream: MediaStream | null = null
  private micAudioCtx: AudioContext | null = null
  private micGainNode: GainNode | null = null
  private micVolume = 100
  private micMutedState = false
  private signaling: ISignaling
  private audioContainer: HTMLDivElement
  private outputDeviceId = ''

  private screenStream: MediaStream | null = null
  private screenTrack: MediaStreamTrack | null = null
  private screenAudioTrack: MediaStreamTrack | null = null
  private peerNicknames = new Map<string, string>()
  private sharingPeers = new Set<string>()
  private audioCtx: AudioContext | null = null
  private analysers = new Map<string, AnalyserNode>()
  private speakingPeers = new Set<string>()
  private vadInterval: ReturnType<typeof setInterval> | null = null

  onPeersChanged: (peers: PeerState[]) => void = () => {}
  onRemoteVideo: (peerId: string, track: MediaStreamTrack, streams: readonly MediaStream[]) => void = () => {}
  onRemoteVideoEnded: (peerId: string) => void = () => {}
  onSharingChanged: (sharingPeerIds: Set<string>) => void = () => {}
  onSpeakingChanged: (speaking: Set<string>) => void = () => {}

  constructor(signaling: ISignaling) {
    this.signaling = signaling
    this.audioContainer = document.createElement('div')
    this.audioContainer.style.display = 'none'
    document.body.appendChild(this.audioContainer)
  }

  setStream(stream: MediaStream) {
    this.originalStream = stream
    try {
      const ctx = new AudioContext()
      this.micAudioCtx = ctx
      const src = ctx.createMediaStreamSource(stream)
      const gain = ctx.createGain()
      gain.gain.value = this.micVolume / 100
      this.micGainNode = gain
      const dest = ctx.createMediaStreamDestination()
      src.connect(gain)
      gain.connect(dest)
      this.stream = new MediaStream(dest.stream.getAudioTracks())
    } catch {
      this.stream = stream
    }
  }

  setMicGain(volume: number) {
    this.micVolume = Math.max(0, Math.min(200, volume))
    if (this.micGainNode && !this.micMutedState) {
      this.micGainNode.gain.value = this.micVolume / 100
    }
  }

  createPeer(peerId: string, nickname: string, initiator: boolean) {
    if (this.peers.has(peerId)) return

    this.peerNicknames.set(peerId, nickname)

    const peer = new SimplePeer({
      initiator,
      stream: this.stream ?? undefined,
      trickle: true,
      sdpTransform: mungeOpus,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ]
      }
    })

    peer.on('signal', (data) => {
      this.signaling.relay(peerId, data)
    })

    peer.on('stream', (remoteStream: MediaStream) => {
      // Create audio element if not yet done for this peer.
      // Deliberately NOT filtering by video tracks — WebRTC may deliver a merged
      // stream containing both voice audio and screen video; we must always honour
      // the audio regardless of what else is in the stream.
      if (!this.audioContainer.querySelector(`audio[data-peer-id="${peerId}"]`)) {
        const audio = document.createElement('audio')
        audio.srcObject = remoteStream
        audio.autoplay = true
        audio.dataset.peerId = peerId
        if (this.outputDeviceId && (audio as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId) {
          (audio as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(this.outputDeviceId).catch(() => {})
        }
        this.audioContainer.appendChild(audio)

        // VAD: route source through a silent gain to force graph processing
        if (!this.audioCtx) this.audioCtx = new AudioContext()
        const source = this.audioCtx.createMediaStreamSource(remoteStream)
        const analyser = this.audioCtx.createAnalyser()
        analyser.fftSize = 512
        const mute = this.audioCtx.createGain()
        mute.gain.value = 0
        source.connect(analyser)
        source.connect(mute)
        mute.connect(this.audioCtx.destination)
        this.analysers.set(peerId, analyser)
        if (!this.vadInterval) this.startVad()
      }

      // Handle video tracks arriving with this stream (screen share arriving as initial stream)
      const videoTracks = remoteStream.getVideoTracks()
      if (videoTracks.length > 0) {
        this.sharingPeers.add(peerId)
        this.onSharingChanged(new Set(this.sharingPeers))
        this.onRemoteVideo(peerId, videoTracks[0], [remoteStream])
        videoTracks[0].onended = () => {
          this.sharingPeers.delete(peerId)
          this.onSharingChanged(new Set(this.sharingPeers))
          this.onRemoteVideoEnded(peerId)
        }
      }
    })

    // Fires during renegotiation when a peer adds a video track mid-connection
    peer.on('track', (track: MediaStreamTrack, streams: readonly MediaStream[]) => {
      if (track.kind === 'video') {
        this.sharingPeers.add(peerId)
        this.onSharingChanged(new Set(this.sharingPeers))
        this.onRemoteVideo(peerId, track, streams)
        track.onended = () => {
          this.sharingPeers.delete(peerId)
          this.onSharingChanged(new Set(this.sharingPeers))
          this.onRemoteVideoEnded(peerId)
        }
      }
    })

    peer.on('close', () => this.removePeer(peerId))
    peer.on('error', () => this.removePeer(peerId))

    this.peers.set(peerId, peer)

    // If we are already sharing, immediately add the screen tracks to this new peer.
    if (this.screenTrack && this.screenStream) {
      peer.addTrack(this.screenTrack, this.screenStream)
      if (this.screenAudioTrack) {
        peer.addTrack(this.screenAudioTrack, this.screenStream)
      }
    }

    this.notifyChanged()
  }

  async startScreenShare(stream: MediaStream): Promise<void> {
    const videoTrack = stream.getVideoTracks()[0]
    if (!videoTrack) throw new Error('No video track in stream')

    this.screenStream = stream
    this.screenTrack = videoTrack
    this.screenAudioTrack = stream.getAudioTracks()[0] ?? null

    for (const [, peer] of this.peers) {
      if (peer.destroyed) continue
      peer.addTrack(videoTrack, stream)
      if (this.screenAudioTrack) {
        peer.addTrack(this.screenAudioTrack, stream)
      }
    }

    videoTrack.onended = () => this.stopScreenShare()

    // Set video bitrate based on actual track resolution after renegotiation settles
    setTimeout(() => this.applyScreenBitrate(), 1500)
  }

  private async applyScreenBitrate(): Promise<void> {
    if (!this.screenTrack) return
    const s = this.screenTrack.getSettings()
    const pixels = (s.width ?? 1280) * (s.height ?? 720)
    let kbps: number
    if (pixels >= 1920 * 1080) kbps = 4000
    else if (pixels >= 1280 * 720) kbps = 2000
    else if (pixels >= 854 * 480) kbps = 1000
    else kbps = 500

    for (const [, peer] of this.peers) {
      if (peer.destroyed) continue
      try {
        const pc = (peer as unknown as { _pc: RTCPeerConnection })._pc
        if (!pc) continue
        const sender = pc.getSenders().find(s => s.track === this.screenTrack)
        if (!sender) continue
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
        params.encodings[0].maxBitrate = kbps * 1000
        await sender.setParameters(params)
      } catch { /* best-effort */ }
    }
  }

  stopScreenShare(): void {
    if (!this.screenTrack) return
    const vt = this.screenTrack
    const at = this.screenAudioTrack
    const s = this.screenStream

    for (const [, peer] of this.peers) {
      if (peer.destroyed) continue
      if (s) peer.removeTrack(vt, s)
      if (at && s) peer.removeTrack(at, s)
    }

    vt.stop()
    at?.stop()
    this.screenStream?.getTracks().forEach(tr => tr.stop())
    this.screenStream = null
    this.screenTrack = null
    this.screenAudioTrack = null
  }

  updatePeerNickname(peerId: string, nickname: string) {
    this.peerNicknames.set(peerId, nickname)
    this.notifyChanged()
  }

  signal(peerId: string, data: object) {
    const peer = this.peers.get(peerId)
    if (peer && !peer.destroyed) {
      peer.signal(data as SimplePeer.SignalData)
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
          speaking ? this.speakingPeers.add(id) : this.speakingPeers.delete(id)
          changed = true
        }
      }
      if (changed) this.onSpeakingChanged(new Set(this.speakingPeers))
    }, 80)
  }

  removePeer(peerId: string) {
    const peer = this.peers.get(peerId)
    if (peer) {
      if (!peer.destroyed) peer.destroy()
      this.peers.delete(peerId)
    }

    this.peerNicknames.delete(peerId)
    this.sharingPeers.delete(peerId)
    this.analysers.delete(peerId)
    this.speakingPeers.delete(peerId)

    if (this.analysers.size === 0 && this.vadInterval) {
      clearInterval(this.vadInterval)
      this.vadInterval = null
    }

    const audio = this.audioContainer.querySelector(`[data-peer-id="${peerId}"]`)
    audio?.remove()

    this.notifyChanged()
  }

  destroyAll() {
    this.stopScreenShare()
    this.peers.forEach((peer) => { if (!peer.destroyed) peer.destroy() })
    this.peers.clear()
    this.peerNicknames.clear()
    this.sharingPeers.clear()
    this.analysers.clear()
    this.speakingPeers.clear()
    if (this.vadInterval) { clearInterval(this.vadInterval); this.vadInterval = null }
    this.audioCtx?.close()
    this.audioCtx = null
    this.micAudioCtx?.close()
    this.micAudioCtx = null
    this.micGainNode = null
    this.audioContainer.innerHTML = ''
    // Stop the processed stream's virtual tracks (WebAudio destination)
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
    // Stop the original hardware mic stream
    this.originalStream?.getTracks().forEach(t => t.stop())
    this.originalStream = null
    this.notifyChanged()
  }

  getPeerIds(): string[] {
    return [...this.peers.keys()]
  }

  private notifyChanged() {
    this.onPeersChanged([...this.peers.keys()].map(id => ({
      id,
      nickname: this.peerNicknames.get(id) ?? id.slice(0, 8),
      isSharing: this.sharingPeers.has(id),
    })))
  }

  setOutputDevice(deviceId: string) {
    this.outputDeviceId = deviceId
    this.audioContainer.querySelectorAll('audio').forEach(el => {
      const audio = el as unknown as { setSinkId?: (id: string) => Promise<void> }
      if (deviceId && audio.setSinkId) audio.setSinkId(deviceId).catch(() => {})
    })
  }

  setMicMuted(muted: boolean) {
    this.micMutedState = muted
    if (this.micGainNode) {
      this.micGainNode.gain.value = muted ? 0 : this.micVolume / 100
    } else {
      this.stream?.getAudioTracks().forEach(t => { t.enabled = !muted })
    }
  }

  setDeafened(deafened: boolean) {
    this.audioContainer.querySelectorAll('audio').forEach(el => { el.muted = deafened })
  }

  /** Устанавливает персональную громкость для конкретного пира (0–200, где 100 = 100%) */
  setPeerVolume(peerId: string, volume: number) {
    const el = this.audioContainer.querySelector<HTMLAudioElement>(`audio[data-peer-id="${peerId}"]`)
    if (el) el.volume = Math.max(0, Math.min(2, volume / 100))
  }

  getPeerVolume(peerId: string): number {
    const el = this.audioContainer.querySelector<HTMLAudioElement>(`audio[data-peer-id="${peerId}"]`)
    return el ? Math.round(el.volume * 100) : 100
  }

  destroy() {
    this.destroyAll()
    this.audioContainer.remove()
  }
}
