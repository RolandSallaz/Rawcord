/**
 * Thin WebSocket client for signaling.
 *
 * Text frames: JSON room management.
 * Binary frames:
 *   Received: [36-byte ASCII sender ID] + [1-byte type: 0x01=audio, 0x02=video] + payload
 *   Sent:     [1-byte type] + payload
 */

export interface ParticipantInfo {
  id: string
  nickname: string
  avatar?: string
}

export interface StreamerInfo {
  id: string
  mimeType: string
}

export interface SignalingHandlers {
  onWelcome: (data: { id: string; participants: ParticipantInfo[]; streamers: StreamerInfo[] }) => void
  onParticipantJoined: (participant: ParticipantInfo) => void
  onParticipantLeft: (id: string) => void
  onParticipantUpdated: (participant: ParticipantInfo) => void
  onStreamStarted: (from: string, mimeType: string) => void
  onStreamStopped: (from: string) => void
  onChat: (from: string, text: string, nickname: string, avatar?: string) => void
  onAudioFrame: (senderId: string, payload: ArrayBuffer) => void
  onVideoFrame: (senderId: string, chunk: ArrayBuffer) => void
  onClose: () => void
}

export class SignalingClient {
  private ws: WebSocket | null = null
  private handlers: Partial<SignalingHandlers> = {}
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private opened = false      // socket reached OPEN at least once
  private closeFired = false  // onClose handler invoked (guard against double-fire)

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
        this.opened = true
        this.heartbeatTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, 5000)
        resolve()
      }

      this.ws.onerror = () => {
        clearTimeout(timer)
        // If we never opened, this is an initial-connect failure: reject the
        // promise and let the caller decide. Do NOT fire onClose here - onclose
        // always follows and is the single place we notify disconnects, so
        // firing here would double-trigger reconnect scheduling.
        if (!this.opened) reject(new Error('Cannot connect to server'))
      }

      this.ws.onmessage = (e) => {
        // Binary: [36-byte sender ID] + [1-byte type] + payload
        if (e.data instanceof ArrayBuffer) {
          if (e.data.byteLength < 37) return   // need at least ID(36) + type(1)
          const idBytes = new Uint8Array(e.data, 0, 36)
          const senderId = new TextDecoder().decode(idBytes).trimEnd()
          const typeByte = new Uint8Array(e.data, 36, 1)[0]
          const payload = e.data.slice(37)

          if (typeByte === 0x01) {
            this.handlers.onAudioFrame?.(senderId, payload)
          } else if (typeByte === 0x02) {
            this.handlers.onVideoFrame?.(senderId, payload)
          }
          return
        }

        let msg: Record<string, unknown>
        try { msg = JSON.parse(e.data as string) } catch { return }

        switch (msg.type) {
          case 'welcome':
            this.handlers.onWelcome?.({
              id: msg.id as string,
              participants: msg.participants as ParticipantInfo[],
              streamers: (msg.streamers as StreamerInfo[]) ?? [],
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
          case 'stream-started':
            this.handlers.onStreamStarted?.(msg.from as string, msg.mimeType as string)
            break
          case 'stream-stopped':
            this.handlers.onStreamStopped?.(msg.from as string)
            break
          case 'chat':
            this.handlers.onChat?.(
              msg.from as string, msg.text as string,
              msg.nickname as string, msg.avatar as string | undefined,
            )
            break
        }
      }

      this.ws.onclose = () => {
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
        // Only notify once, and only if we actually got connected. A failed
        // initial connect is reported via the rejected connect() promise.
        if (this.opened && !this.closeFired) {
          this.closeFired = true
          this.handlers.onClose?.()
        }
      }
    })
  }

  send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  /** Send binary frame: [1-byte type] + payload */
  sendBinary(type: 0x01 | 0x02, payload: ArrayBuffer) {
    const ws = this.ws
    if (ws?.readyState !== WebSocket.OPEN) return
    // Backpressure: on a congested/limited uplink the socket send buffer grows.
    // Queued real-time AUDIO only adds latency, so drop it instead of buffering
    // — this also frees the pipe so the video stream / init segment keeps
    // flowing (otherwise the viewer gets a black screen + voice lag).
    if (type === 0x01 && ws.bufferedAmount > 256 * 1024) return
    const frame = new Uint8Array(1 + payload.byteLength)
    frame[0] = type
    frame.set(new Uint8Array(payload), 1)
    ws.send(frame.buffer)
  }

  join(channel: string, nickname: string, avatar?: string) {
    this.send({ type: 'join', channel, nickname, avatar })
  }

  announce(nickname: string, avatar?: string) {
    this.send({ type: 'announce', nickname, avatar })
  }

  streamStart(mimeType: string) {
    this.send({ type: 'stream-start', mimeType })
  }

  streamStop() {
    this.send({ type: 'stream-stop' })
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
