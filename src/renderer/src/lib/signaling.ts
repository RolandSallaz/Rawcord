export interface PeerInfo {
  id: string
  nickname: string
  avatar?: string
}

type RelayPayload = object

interface SignalingHandlers {
  onPeers: (peers: PeerInfo[]) => void
  onPeerJoined: (peer: PeerInfo) => void
  onPeerLeft: (id: string) => void
  onRelay: (from: string, payload: RelayPayload) => void
  onClose: () => void
  onPeerUpdated: (peer: PeerInfo) => void
  onChat: (from: string, text: string, nickname: string, avatar?: string) => void
}

export class SignalingClient {
  private ws: WebSocket | null = null
  private handlers: Partial<SignalingHandlers> = {}
  private myNickname = ''
  private myAvatar?: string

  constructor(private url: string) {}

  on<K extends keyof SignalingHandlers>(event: K, handler: SignalingHandlers[K]) {
    this.handlers[event] = handler
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)

      const timer = setTimeout(() => {
        this.ws?.close()
        reject(new Error('Connection timeout'))
      }, 5000)

      this.ws.onopen = () => { clearTimeout(timer); resolve() }
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error('Cannot connect to signaling server')) }

      this.ws.onmessage = (e) => {
        let msg: Record<string, unknown>
        try { msg = JSON.parse(e.data as string) } catch { return }

        switch (msg.type) {
          case 'peers':
            this.handlers.onPeers?.(msg.peers as PeerInfo[])
            break
          case 'peer-joined':
            this.handlers.onPeerJoined?.({ id: msg.id as string, nickname: msg.nickname as string, avatar: msg.avatar as string | undefined })
            break
          case 'peer-left':
            this.handlers.onPeerLeft?.(msg.id as string)
            break
          case 'relay':
            this.handlers.onRelay?.(msg.from as string, msg.payload as RelayPayload)
            break
          case 'peer-updated':
            this.handlers.onPeerUpdated?.({ id: msg.id as string, nickname: msg.nickname as string, avatar: msg.avatar as string | undefined })
            break
          case 'chat':
            this.handlers.onChat?.(msg.from as string, msg.text as string, msg.nickname as string, msg.avatar as string | undefined)
            break
        }
      }

      this.ws.onclose = () => this.handlers.onClose?.()
    })
  }

  join(channel: string, nickname: string, avatar?: string) {
    this.myNickname = nickname
    this.myAvatar = avatar
    this.send({ type: 'join', channel, nickname, avatar })
  }

  relay(to: string, payload: RelayPayload) {
    this.send({ type: 'relay', to, payload })
  }

  sendChat(text: string) {
    this.send({ type: 'chat', text, nickname: this.myNickname, avatar: this.myAvatar })
  }

  updateProfile(nickname: string, avatar?: string) {
    this.myNickname = nickname
    this.myAvatar = avatar
    this.send({ type: 'announce', nickname, avatar })
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
