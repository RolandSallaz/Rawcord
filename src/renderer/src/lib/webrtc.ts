import SimplePeer from 'simple-peer'
import type { SignalingClient } from './signaling'

export interface PeerState {
  id: string
  nickname: string
}

export class PeerManager {
  private peers = new Map<string, SimplePeer.Instance>()
  private stream: MediaStream | null = null
  private signaling: SignalingClient
  private audioContainer: HTMLDivElement

  onPeersChanged: (peers: PeerState[]) => void = () => {}

  constructor(signaling: SignalingClient) {
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

    peer.on('stream', (remoteStream) => {
      const audio = document.createElement('audio')
      audio.srcObject = remoteStream
      audio.autoplay = true
      audio.dataset.peerId = peerId
      this.audioContainer.appendChild(audio)
    })

    peer.on('close', () => this.removePeer(peerId))
    peer.on('error', () => this.removePeer(peerId))

    this.peers.set(peerId, peer)
    this.notifyChanged()
  }

  signal(peerId: string, data: object) {
    const peer = this.peers.get(peerId)
    if (peer && !peer.destroyed) {
      peer.signal(data as SimplePeer.SignalData)
    }
  }

  removePeer(peerId: string) {
    const peer = this.peers.get(peerId)
    if (peer) {
      if (!peer.destroyed) peer.destroy()
      this.peers.delete(peerId)
    }

    const audio = this.audioContainer.querySelector(`[data-peer-id="${peerId}"]`)
    audio?.remove()

    this.notifyChanged()
  }

  destroyAll() {
    this.peers.forEach((peer) => { if (!peer.destroyed) peer.destroy() })
    this.peers.clear()
    this.audioContainer.innerHTML = ''
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
    this.notifyChanged()
  }

  getPeerIds(): string[] {
    return [...this.peers.keys()]
  }

  private notifyChanged() {
    // ChannelPage listens via onPeersChanged to re-render participant list
    this.onPeersChanged([...this.peers.keys()].map(id => ({ id, nickname: '' })))
  }

  destroy() {
    this.destroyAll()
    this.audioContainer.remove()
  }
}
