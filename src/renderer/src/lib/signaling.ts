import { SIGNALING_URL } from '../config'

export interface PeerInfo {
  id: string
  nickname: string
}

type RelayPayload = object

interface SignalingHandlers {
  onPeers: (peers: PeerInfo[]) => void
  onPeerJoined: (peer: PeerInfo) => void
  onPeerLeft: (id: string) => void
  onRelay: (from: string, payload: RelayPayload) => void
  onClose: () => void
}

export class SignalingClient {
  private ws: WebSocket | null = null
  private handlers: Partial<SignalingHandlers> = {}

  on<K extends keyof SignalingHandlers>(event: K, handler: SignalingHandlers[K]) {
    this.handlers[event] = handler
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(SIGNALING_URL)

      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('Cannot connect to signaling server'))

      this.ws.onmessage = (e) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(e.data as string) } catch { return }

        switch (msg.type) {
          case 'peers':
            this.handlers.onPeers?.(msg.peers as PeerInfo[])
            break
          case 'peer-joined':
            this.handlers.onPeerJoined?.({ id: msg.id as string, nickname: msg.nickname as string })
            break
          case 'peer-left':
            this.handlers.onPeerLeft?.(msg.id as string)
            break
          case 'relay':
            this.handlers.onRelay?.(msg.from as string, msg.payload as RelayPayload)
            break
        }
      }

      this.ws.onclose = () => this.handlers.onClose?.()
    })
  }

  join(channel: string, nickname: string) {
    this.send({ type: 'join', channel, nickname })
  }

  relay(to: string, payload: RelayPayload) {
    this.send({ type: 'relay', to, payload })
  }

  leave() {
    this.send({ type: 'leave' })
  }

  disconnect() {
    this.leave()
    this.ws?.close()
    this.ws = null
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }
}
