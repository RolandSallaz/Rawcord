/**
 * Тонкий WS-клиент для сигналинга к SFU-серверу. Знает только про сериализацию
 * сообщений и dispatch событий — никакой WebRTC-логики, она в `sfuClient.ts`.
 */

import type { PeerState } from './sfuClient'

export interface SignalingHandlers {
  onWelcome: (data: {
    id: string
    iceServers: RTCIceServer[]
    participants: PeerState[]
  }) => void
  onSdpOffer: (sdp: string) => void
  onSdpAnswer: (sdp: string) => void
  onIceCandidate: (candidate: RTCIceCandidateInit) => void
  onParticipantJoined: (participant: PeerState) => void
  onParticipantLeft: (id: string) => void
  onParticipantUpdated: (participant: PeerState) => void
  onParticipantSharing: (id: string, isSharing: boolean) => void
  onChat: (from: string, text: string, nickname: string, avatar?: string) => void
  onClose: () => void
}

export class SignalingClient {
  private ws: WebSocket | null = null
  private handlers: Partial<SignalingHandlers> = {}

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
          case 'welcome':
            this.handlers.onWelcome?.({
              id: msg.id as string,
              iceServers: msg.iceServers as RTCIceServer[],
              participants: msg.participants as PeerState[],
            })
            break
          case 'offer':
            this.handlers.onSdpOffer?.(msg.sdp as string)
            break
          case 'answer':
            this.handlers.onSdpAnswer?.(msg.sdp as string)
            break
          case 'ice-candidate':
            this.handlers.onIceCandidate?.(msg.candidate as RTCIceCandidateInit)
            break
          case 'participant-joined':
            this.handlers.onParticipantJoined?.(msg.participant as PeerState)
            break
          case 'participant-left':
            this.handlers.onParticipantLeft?.(msg.id as string)
            break
          case 'participant-updated':
            this.handlers.onParticipantUpdated?.(msg.participant as PeerState)
            break
          case 'participant-sharing':
            this.handlers.onParticipantSharing?.(msg.id as string, msg.isSharing as boolean)
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

  send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  join(channel: string, nickname: string, avatar?: string): void {
    this.send({ type: 'join', channel, nickname, avatar })
  }

  sendChat(text: string): void {
    this.send({ type: 'chat', text })
  }

  updateProfile(nickname: string, avatar?: string): void {
    this.send({ type: 'announce', nickname, avatar })
  }

  leave(): void {
    this.send({ type: 'leave' })
  }

  disconnect(): void {
    this.leave()
    this.ws?.close()
    this.ws = null
  }
}
