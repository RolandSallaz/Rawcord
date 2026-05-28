/**
 * Thin WebSocket client for signaling.
 * Text frames: JSON room management (join/leave/chat/participant events).
 * Binary frames: audio PCM relay — first 36 bytes = sender UUID, rest = PCM.
 */

export interface ParticipantInfo {
  id: string
  nickname: string
  avatar?: string
}

export interface SignalingHandlers {
  onWelcome: (data: { id: string; participants: ParticipantInfo[] }) => void
  onParticipantJoined: (participant: ParticipantInfo) => void
  onParticipantLeft: (id: string) => void
  onParticipantUpdated: (participant: ParticipantInfo) => void
  onChat: (from: string, text: string, nickname: string, avatar?: string) => void
  onAudioFrame: (senderId: string, pcm: ArrayBuffer) => void
  onClose: () => void
}

export class SignalingClient {
  private ws: WebSocket | null = null
  private handlers: Partial<SignalingHandlers> = {}
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(private url: string) {}

  on<K extends keyof SignalingHandlers>(event: K, handler: SignalingHandlers[K]) {
    this.handlers[event] = handler
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)
      this.ws.binaryType = 'arraybuffer'

      const timer = setTimeout(() => { this.ws?.close(); reject(new Error('Connection timeout')) }, 5000)

      this.ws.onopen = () => {
        clearTimeout(timer)
        // Application-level heartbeat — keeps the connection alive through proxies/NAT
        this.heartbeatTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, 5000)
        resolve()
      }
      this.ws.onerror = () => {
        clearTimeout(timer)
        // Trigger onClose so ChannelPage schedules a reconnect
        this.handlers.onClose?.()
        reject(new Error('Cannot connect to server'))
      }

      this.ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          // Binary: [36 bytes ASCII sender ID] [PCM data]
          if (e.data.byteLength < 36) return
          const idBytes = new Uint8Array(e.data, 0, 36)
          const senderId = new TextDecoder().decode(idBytes).trimEnd()
          const pcm = e.data.slice(36)
          this.handlers.onAudioFrame?.(senderId, pcm)
          return
        }

        let msg: Record<string, unknown>
        try { msg = JSON.parse(e.data as string) } catch { return }

        switch (msg.type) {
          case 'welcome':
            this.handlers.onWelcome?.({
              id: msg.id as string,
              participants: msg.participants as ParticipantInfo[],
            })
            break
          case 'participant-joined':
            this.handlers.onParticipantJoined?.(msg.participant as ParticipantInfo)
            break
          case 'participant-left':
            this.handlers.onParticipantLeft?.(msg.id as string)
            break
          case 'participant-updated':
            this.handlers.onParticipantUpdated?.(msg.participant as ParticipantInfo)
            break
          case 'chat':
            this.handlers.onChat?.(
              msg.from as string,
              msg.text as string,
              msg.nickname as string,
              msg.avatar as string | undefined,
            )
            break
        }
      }

      this.ws.onclose = () => this.handlers.onClose?.()
    })
  }

  send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  sendBinary(data: ArrayBuffer) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data)
  }

  join(channel: string, nickname: string, avatar?: string) {
    this.send({ type: 'join', channel, nickname, avatar })
  }

  announce(nickname: string, avatar?: string) {
    this.send({ type: 'announce', nickname, avatar })
  }

  sendChat(text: string) {
    this.send({ type: 'chat', text })
  }

  disconnect() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    this.send({ type: 'leave' })
    this.ws?.close()
    this.ws = null
  }
}
