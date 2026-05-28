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

  /**
   * Tracks peers that are being intentionally destroyed (via removePeer/destroyAll).
   * When a peer closes unexpectedly (NOT in this set), onPeerDisconnected is called.
   */
  private intendedRemovals = new Set<string>()

  onPeersChanged: (peers: PeerState[]) => void = () => {}
  onRemoteVideo: (peerId: string, track: MediaStreamTrack, streams: readonly MediaStream[]) => void = () => {}
  onRemoteVideoEnded: (peerId: string) => void = () => {}
  onSharingChanged: (sharingPeerIds: Set<string>) => void = () => {}
  onSpeakingChanged: (speaking: Set<string>) => void = () => {}
  /**
   * Fired when a WebRTC peer connection drops unexpectedly (not via removePeer).
   * The caller can use this to attempt peer reconnection via the signaling channel.
   */
  onPeerDisconnected: (peerId: string) => void = () => {}

  constructor(signaling: ISignaling) {
    this.signaling = signaling
    this.audioContainer = document.createElement('div')
    this.audioContainer.style.display = 'none'
    document.body.appendChild(this.audioContainer)
  }

  setStream(stream: MediaStream) {
    this.originalStream = stream
    // Use the RAW getUserMedia stream for WebRTC. Routing through a
    // MediaStreamAudioDestinationNode used to mute outgoing audio silently
    // in Electron when the AudioContext was suspended at the moment tracks
    // were added to the peer connection. Mic mute is handled via track.enabled.
    this.stream = stream
    // Set up an offline AudioContext only to drive the mic gain slider.
    // The gain node is wired to a destination that is NOT used for WebRTC —
    // it exists so future code can swap to a processed track via replaceTrack
    // if a non-default gain is needed. For now setMicGain only changes the
    // internal gain.value (no effect on outgoing audio) — at micVolume=100
    // the raw track is identical anyway.
    try {
      const ctx = new AudioContext()
      this.micAudioCtx = ctx
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      })
      const src = ctx.createMediaStreamSource(stream)
      const gain = ctx.createGain()
      gain.gain.value = this.micVolume / 100
      this.micGainNode = gain
      src.connect(gain)
      // Don't connect gain to destination — we don't want to monitor our own mic.
    } catch { /* gain slider optional */ }
    console.log('[PeerManager] setStream — using raw track for WebRTC, tracks:',
      stream.getAudioTracks().map(t => ({ id: t.id, label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState })))
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
    console.log(`[PeerManager] createPeer ${peerId.slice(0,8)} initiator=${initiator} streamTracks=${this.stream?.getAudioTracks().length ?? 0}`)

    const peer = new SimplePeer({
      initiator,
      stream: this.stream ?? undefined,
      trickle: true,
      sdpTransform: mungeOpus,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:stun3.l.google.com:19302' },
        ]
      }
    })

    // Attach ICE connection state listener for restart on failure + diagnostics.
    // Deferred slightly so SimplePeer's own handlers attach first.
    setTimeout(() => {
      if (peer.destroyed) return
      const pc = (peer as unknown as { _pc?: RTCPeerConnection })._pc
      if (!pc) return
      pc.addEventListener('iceconnectionstatechange', () => {
        console.log(`[PeerManager] ${peerId.slice(0,8)} iceConnectionState=${pc.iceConnectionState}`)
        if (peer.destroyed) return
        if (pc.iceConnectionState === 'failed') {
          try { pc.restartIce() } catch { /* browser may not support it */ }
        }
      })
    }, 0)

    peer.on('signal', (data) => {
      const t = (data as { type?: string }).type ?? 'candidate'
      console.log(`[PeerManager] ${peerId.slice(0,8)} signal out: ${t}`)
      this.signaling.relay(peerId, data)
    })

    peer.on('connect', () => {
      console.log(`[PeerManager] ${peerId.slice(0,8)} connect (data channel open)`)
    })

    peer.on('stream', (remoteStream: MediaStream) => {
      console.log(`[PeerManager] ${peerId.slice(0,8)} stream event — audio=${remoteStream.getAudioTracks().length} video=${remoteStream.getVideoTracks().length}`)
      // Create audio element if not yet done for this peer.
      // Deliberately NOT filtering by video tracks — WebRTC may deliver a merged
      // stream containing both voice audio and screen video.
      if (!this.audioContainer.querySelector(`audio[data-peer-id="${peerId}"]`)) {
        const audio = document.createElement('audio')
        audio.srcObject = remoteStream
        audio.autoplay = true
        audio.dataset.peerId = peerId
        // Force play (some Chromium versions need an explicit play call even with autoplay)
        audio.play().catch((err) => console.warn(`[PeerManager] ${peerId.slice(0,8)} audio.play() failed:`, err))
        if (this.outputDeviceId) {
          const a = audio as unknown as { setSinkId?: (id: string) => Promise<void> }
          if (a.setSinkId) a.setSinkId(this.outputDeviceId).catch(() => {})
        }
        this.audioContainer.appendChild(audio)

        // VAD: route source through a silent gain to force graph processing
        if (!this.audioCtx) {
          this.audioCtx = new AudioContext()
          // Auto-resume if the browser suspends it later — otherwise VAD stops
          // working and (more importantly) the audio graph that helps drive the
          // remote stream may stall.
          this.audioCtx.addEventListener('statechange', () => {
            if (this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => {})
          })
        }
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {})
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

      // Handle video tracks arriving with this stream (screen share as initial stream)
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

    // Fires for each individual track on the remote side
    peer.on('track', (track: MediaStreamTrack, streams: readonly MediaStream[]) => {
      console.log(`[PeerManager] ${peerId.slice(0,8)} track event kind=${track.kind} muted=${track.muted} readyState=${track.readyState}`)
      // Fallback path for audio: if the 'stream' event never fired (some browser
      // versions emit only 'track' for audio), create the audio element here too.
      if (track.kind === 'audio' && !this.audioContainer.querySelector(`audio[data-peer-id="${peerId}"]`)) {
        const remoteStream = streams[0] ?? new MediaStream([track])
        const audio = document.createElement('audio')
        audio.srcObject = remoteStream
        audio.autoplay = true
        audio.dataset.peerId = peerId
        if (this.outputDeviceId) {
          const a = audio as unknown as { setSinkId?: (id: string) => Promise<void> }
          if (a.setSinkId) a.setSinkId(this.outputDeviceId).catch(() => {})
        }
        this.audioContainer.appendChild(audio)
        audio.play().catch((err) => console.warn(`[PeerManager] ${peerId.slice(0,8)} audio.play() failed:`, err))
      }
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

    peer.on('close', () => {
      // Guard: if peer was already cleaned up (e.g. stale second close), ignore
      if (!this.peers.has(peerId)) return
      const intended = this.intendedRemovals.has(peerId)
      if (!intended) {
        // Unexpected disconnect — notify caller so it can attempt reconnection
        this.onPeerDisconnected(peerId)
      }
      this.doCleanup(peerId)
    })

    // SimplePeer emits 'error' then 'close'; let the 'close' handler do cleanup
    peer.on('error', () => { /* handled by close */ })

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

  /**
   * Internal cleanup after a peer's WebRTC connection closes.
   * Called from the peer's 'close' event handler.
   */
  private doCleanup(peerId: string) {
    this.intendedRemovals.delete(peerId)
    this.peers.delete(peerId)
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

  /**
   * Intentionally remove a peer (e.g., they left the room via signaling).
   * Does NOT fire onPeerDisconnected.
   */
  removePeer(peerId: string) {
    const peer = this.peers.get(peerId)
    if (peer) {
      this.intendedRemovals.add(peerId)
      if (!peer.destroyed) peer.destroy()
      // doCleanup is triggered by the 'close' event.
      // Safety fallback in case close never fires:
      setTimeout(() => {
        if (this.intendedRemovals.has(peerId)) {
          this.doCleanup(peerId)
        }
      }, 400)
    } else {
      this.doCleanup(peerId)
    }
  }

  destroyAll() {
    this.stopScreenShare()
    // Mark all as intended BEFORE destroying so close handlers don't fire onPeerDisconnected
    this.peers.forEach((_, id) => this.intendedRemovals.add(id))
    this.peers.forEach((peer) => { if (!peer.destroyed) peer.destroy() })
    this.peers.clear()
    this.peerNicknames.clear()
    this.sharingPeers.clear()
    this.analysers.clear()
    this.speakingPeers.clear()
    this.intendedRemovals.clear()
    if (this.vadInterval) { clearInterval(this.vadInterval); this.vadInterval = null }
    this.audioCtx?.close()
    this.audioCtx = null
    this.micAudioCtx?.close()
    this.micAudioCtx = null
    this.micGainNode = null
    this.audioContainer.innerHTML = ''
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
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
    // Raw stream is in the WebRTC path now, so mute via track.enabled.
    this.stream?.getAudioTracks().forEach(t => { t.enabled = !muted })
    // Also reflect on the gain node so future processed-track swaps stay consistent.
    if (this.micGainNode) {
      this.micGainNode.gain.value = muted ? 0 : this.micVolume / 100
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
