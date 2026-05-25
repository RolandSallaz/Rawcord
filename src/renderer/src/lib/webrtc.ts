import SimplePeer from 'simple-peer'

interface ISignaling {
  relay(to: string, payload: object): void
}

export interface PeerState {
  id: string
  nickname: string
  isSharing?: boolean
}

export class PeerManager {
  private peers = new Map<string, SimplePeer.Instance>()
  private stream: MediaStream | null = null
  private signaling: ISignaling
  private audioContainer: HTMLDivElement
  private outputDeviceId = ''

  private screenStream: MediaStream | null = null
  private screenTrack: MediaStreamTrack | null = null
  private peerNicknames = new Map<string, string>()
  private sharingPeers = new Set<string>()
  private audioCtx: AudioContext | null = null
  private analysers = new Map<string, AnalyserNode>()
  private speakingPeers = new Set<string>()
  private vadInterval: ReturnType<typeof setInterval> | null = null

  onPeersChanged: (peers: PeerState[]) => void = () => {}
  onRemoteVideo: (peerId: string, track: MediaStreamTrack, streams: readonly MediaStream[]) => void = () => {}
  onSharingChanged: (sharingPeerIds: Set<string>) => void = () => {}
  onSpeakingChanged: (speaking: Set<string>) => void = () => {}

  constructor(signaling: ISignaling) {
    this.signaling = signaling
    this.audioContainer = document.createElement('div')
    this.audioContainer.style.display = 'none'
    document.body.appendChild(this.audioContainer)
  }

  setStream(stream: MediaStream) {
    this.stream = stream
  }

  createPeer(peerId: string, nickname: string, initiator: boolean) {
    if (this.peers.has(peerId)) return

    this.peerNicknames.set(peerId, nickname)

    const peer = new SimplePeer({
      initiator,
      stream: this.stream ?? undefined,
      trickle: true,
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
      if (!this.audioContainer.querySelector(`audio[data-peer-id="${peerId}"]`)) {
        const audio = document.createElement('audio')
        audio.srcObject = remoteStream
        audio.autoplay = true
        audio.dataset.peerId = peerId
        if (this.outputDeviceId && (audio as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId) {
          (audio as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(this.outputDeviceId).catch(() => {})
        }
        this.audioContainer.appendChild(audio)

        // VAD: route source through a silent gain to force graph processing, then analyse
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
      // Handle video tracks arriving with the initial stream
      const videoTracks = remoteStream.getVideoTracks()
      if (videoTracks.length > 0) {
        this.sharingPeers.add(peerId)
        this.onSharingChanged(new Set(this.sharingPeers))
        this.onRemoteVideo(peerId, videoTracks[0], [remoteStream])
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
        }
      }
    })

    peer.on('close', () => this.removePeer(peerId))
    peer.on('error', () => this.removePeer(peerId))

    this.peers.set(peerId, peer)

    // If we are already sharing, immediately add the screen track to this new peer.
    // SimplePeer initialises _pc synchronously, so this is safe right after construction.
    if (this.screenTrack && this.screenStream) {
      const pc = (peer as unknown as { _pc: RTCPeerConnection })._pc
      pc.addTrack(this.screenTrack, this.screenStream)
    }

    this.notifyChanged()
  }

  async startScreenShare(stream: MediaStream): Promise<void> {
    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('No video track in stream')

    this.screenStream = stream
    this.screenTrack = track

    for (const [, peer] of this.peers) {
      if (peer.destroyed) continue
      const pc = (peer as unknown as { _pc: RTCPeerConnection })._pc
      pc.addTrack(track, stream)
      // onnegotiationneeded fires automatically → SimplePeer emits 'signal' → relay
    }

    // Handle user stopping via OS "Stop sharing" button
    track.onended = () => this.stopScreenShare()
  }

  stopScreenShare(): void {
    if (!this.screenTrack) return
    const t = this.screenTrack

    for (const [, peer] of this.peers) {
      if (peer.destroyed) continue
      const pc = (peer as unknown as { _pc: RTCPeerConnection })._pc
      const sender = pc.getSenders().find(s => s.track === t)
      if (sender) pc.removeTrack(sender)
    }

    t.stop()
    this.screenStream?.getTracks().forEach(tr => tr.stop())
    this.screenStream = null
    this.screenTrack = null
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
    this.audioContainer.innerHTML = ''
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
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
    this.stream?.getAudioTracks().forEach(t => { t.enabled = !muted })
  }

  setDeafened(deafened: boolean) {
    this.audioContainer.querySelectorAll('audio').forEach(el => { el.muted = deafened })
  }

  destroy() {
    this.destroyAll()
    this.audioContainer.remove()
  }
}
