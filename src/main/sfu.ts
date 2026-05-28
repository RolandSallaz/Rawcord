/**
 * SFU (Selective Forwarding Unit) поверх werift.
 *
 * Архитектура: на каждого участника в комнате — один RTCPeerConnection.
 * Когда участник публикует трек (аудио/видео), сервер форвардит его в каждый
 * другой PC как sendonly-transceiver. werift проксирует RTP-пакеты между
 * source-track и sender'ом без декодирования.
 *
 * Negotiation flow:
 *   - Initial: client offer (mic) → server answer
 *   - При добавлении форвардов (новый участник / screen share от другого) —
 *     server-initiated offer → client answer
 *   - Screen share start/stop клиента — client renegotiate offer → server answer
 *   - Glare handling: пока не реализован; полагаемся на то что параллельная
 *     ренеготиация — редкий случай.
 */
import {
  RTCPeerConnection,
  RTCRtpTransceiver,
  RTCIceCandidate,
  MediaStreamTrack,
  type RTCIceServer,
} from 'werift'
import type { WebSocket } from 'ws'

export interface ParticipantInfo {
  id: string
  nickname: string
  avatar?: string
}

export interface RoomParticipant extends ParticipantInfo {
  isSharing: boolean
}

interface ParticipantState {
  id: string
  ws: WebSocket
  pc: RTCPeerConnection
  info: ParticipantInfo
  /** Их собственные треки (мы их получаем) */
  audio?: MediaStreamTrack
  video?: MediaStreamTrack
  isSharing: boolean
  /** Transceiver'ы, которыми мы шлём ИМ треки других участников. Ключ: `${sourceId}:${kind}` */
  outgoing: Map<string, RTCRtpTransceiver>
}

/** Диапазон UDP-портов для ICE. Нужно пробросить на роутере (внешний = внутренний) */
const ICE_PORT_RANGE: [number, number] = [40000, 50000]

/** Дополнительные IP-адреса хоста для ICE-кандидатов (публичный IP, если порты не проброшены 1:1) */
const ADDITIONAL_HOST_ADDRESSES: string[] = process.env.SFU_HOST_IPS
  ? process.env.SFU_HOST_IPS.split(',')
  : []

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

/** ICE-серверы, которые отдаём клиентам в welcome (та же конфигурация, что у самого SFU) */
export function getClientIceServers(): Array<{ urls: string; username?: string; credential?: string }> {
  return DEFAULT_ICE_SERVERS.map(s => ({
    urls: s.urls,
    ...(s.username !== undefined ? { username: s.username } : {}),
    ...(s.credential !== undefined ? { credential: s.credential } : {}),
  }))
}

function safeSend(ws: WebSocket, msg: object) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  } catch { /* socket dead */ }
}

export class Room {
  private participants = new Map<string, ParticipantState>()

  constructor(public readonly channel: string) {}

  get size(): number { return this.participants.size }
  get isEmpty(): boolean { return this.participants.size === 0 }

  /** Информация обо всех участниках комнаты — отдаётся новичку в welcome */
  list(): RoomParticipant[] {
    return [...this.participants.values()].map(p => ({ ...p.info, isSharing: p.isSharing }))
  }

  has(id: string): boolean { return this.participants.has(id) }

  /** Отправить сообщение всем участникам комнаты, кроме `except` */
  broadcast(msg: object, except?: string) {
    for (const [id, p] of this.participants) {
      if (id === except) continue
      safeSend(p.ws, msg)
    }
  }

  /** Создать PC для нового участника и зарегистрировать в комнате */
  add(id: string, ws: WebSocket, info: ParticipantInfo): void {
    const pc = new RTCPeerConnection({
      iceServers: DEFAULT_ICE_SERVERS,
      icePortRange: ICE_PORT_RANGE,
      iceUseIpv4: true,
      iceUseIpv6: false,
      iceAdditionalHostAddresses: ADDITIONAL_HOST_ADDRESSES,
    })

    const p: ParticipantState = {
      id, ws, pc,
      info: { id, nickname: info.nickname, avatar: info.avatar },
      isSharing: false,
      outgoing: new Map(),
    }

    pc.onIceCandidate.subscribe(cand => {
      if (!cand) return
      safeSend(ws, { type: 'ice-candidate', candidate: cand.toJSON() })
    })

    pc.onTrack.subscribe(track => {
      this.handleIncomingTrack(p, track).catch(e => console.warn('[SFU] handleIncomingTrack', e))
    })

    pc.iceConnectionStateChange.subscribe(state => {
      console.log(`[SFU] ${id.slice(0, 8)} iceConnectionState=${state}`)
    })

    pc.connectionStateChange.subscribe(state => {
      console.log(`[SFU] ${id.slice(0, 8)} connectionState=${state}`)
    })

    this.participants.set(id, p)

    this.broadcast({
      type: 'participant-joined',
      participant: { ...p.info, isSharing: false },
    }, id)
  }

  /** Обработать SDP offer от клиента (initial connect или client-initiated renegotiation) */
  async handleOffer(id: string, sdp: string): Promise<void> {
    const p = this.participants.get(id)
    if (!p) return
    try {
      await p.pc.setRemoteDescription({ type: 'offer', sdp })

      const hadExistingForwards = p.outgoing.size > 0
      // Если это initial offer — добавляем форварды от существующих участников.
      // Они появятся в нашем следующем server-initiated offer, не в этом answer.
      if (!hadExistingForwards) {
        this.attachExistingForwards(p)
      }

      const answer = await p.pc.createAnswer()
      await p.pc.setLocalDescription(answer)
      safeSend(p.ws, { type: 'answer', sdp: p.pc.localDescription!.sdp })

      // После answer отправляем отдельный server-initiated offer, чтобы
      // доставить форварды от существующих участников новому клиенту.
      if (!hadExistingForwards && p.outgoing.size > 0) {
        await this.renegotiate(id)
      }
    } catch (e) {
      console.warn(`[SFU] handleOffer ${id.slice(0, 8)} failed`, e)
    }
  }

  /** Добавить sendonly-transceiver'ы со всеми существующими треками других участников */
  private attachExistingForwards(p: ParticipantState): void {
    for (const [otherId, other] of this.participants) {
      if (otherId === p.id) continue
      if (other.audio) this.ensureForward(p, otherId, other.audio)
      if (other.video) this.ensureForward(p, otherId, other.video)
    }
  }

  /** Запустить server-initiated renegotiation (когда нужно отдать новые форварды) */
  async renegotiate(id: string): Promise<void> {
    const p = this.participants.get(id)
    if (!p) return
    try {
      const offer = await p.pc.createOffer()
      await p.pc.setLocalDescription(offer)
      safeSend(p.ws, { type: 'offer', sdp: p.pc.localDescription!.sdp })
    } catch (e) {
      console.warn(`[SFU] renegotiate ${id.slice(0, 8)} failed`, e)
    }
  }

  async handleAnswer(id: string, sdp: string): Promise<void> {
    const p = this.participants.get(id)
    if (!p) return
    try {
      await p.pc.setRemoteDescription({ type: 'answer', sdp })
    } catch (e) {
      console.warn(`[SFU] handleAnswer ${id.slice(0, 8)} failed`, e)
    }
  }

  async handleIceCandidate(id: string, candidate: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }): Promise<void> {
    const p = this.participants.get(id)
    if (!p) return
    try {
      await p.pc.addIceCandidate(new RTCIceCandidate(candidate))
    } catch (e) {
      console.warn(`[SFU] addIceCandidate ${id.slice(0, 8)} failed`, e)
    }
  }

  /** Установить или обновить форвард track'а sourceId → target */
  private ensureForward(target: ParticipantState, sourceId: string, track: MediaStreamTrack): boolean {
    const key = `${sourceId}:${track.kind}`
    const existing = target.outgoing.get(key)
    if (existing) {
      existing.sender.replaceTrack(track).catch(() => {})
      return false
    }
    // Помечаем streamId треку source-id, чтобы клиент знал откуда трек
    track.streamId = sourceId
    const tx = target.pc.addTransceiver(track, { direction: 'sendonly' })
    target.outgoing.set(key, tx)
    return true
  }

  /** Убрать форвард sourceId → target */
  private removeForward(target: ParticipantState, sourceId: string, kind: 'audio' | 'video'): boolean {
    const key = `${sourceId}:${kind}`
    const tx = target.outgoing.get(key)
    if (!tx) return false
    try { tx.sender.replaceTrack(null).catch(() => {}) } catch {}
    target.outgoing.delete(key)
    return true
  }

  /** Сработало onTrack для одного из участников — форвардим всем остальным */
  private async handleIncomingTrack(source: ParticipantState, track: MediaStreamTrack): Promise<void> {
    console.log(`[SFU] ${source.id.slice(0, 8)} produced track kind=${track.kind}`)
    if (track.kind === 'audio') {
      source.audio = track
    } else if (track.kind === 'video') {
      source.video = track
      if (!source.isSharing) {
        source.isSharing = true
        this.broadcast({ type: 'participant-sharing', id: source.id, isSharing: true })
      }
    }

    const affected: ParticipantState[] = []
    for (const [otherId, other] of this.participants) {
      if (otherId === source.id) continue
      if (this.ensureForward(other, source.id, track)) {
        affected.push(other)
      }
    }
    for (const other of affected) {
      await this.renegotiate(other.id)
    }
  }

  /** Клиент сообщает что больше не транслирует видео (screen share off) */
  async stopProduceVideo(id: string): Promise<void> {
    const p = this.participants.get(id)
    if (!p) return
    if (!p.video) return
    p.video = undefined
    p.isSharing = false
    this.broadcast({ type: 'participant-sharing', id, isSharing: false })

    const affected: ParticipantState[] = []
    for (const [otherId, other] of this.participants) {
      if (otherId === id) continue
      if (this.removeForward(other, id, 'video')) affected.push(other)
    }
    for (const other of affected) {
      await this.renegotiate(other.id)
    }
  }

  updateInfo(id: string, info: Partial<Omit<ParticipantInfo, 'id'>>): void {
    const p = this.participants.get(id)
    if (!p) return
    p.info = { ...p.info, ...info }
    this.broadcast({ type: 'participant-updated', participant: { ...p.info, isSharing: p.isSharing } })
  }

  /** Участник отключился — закрываем его PC и убираем его треки у всех остальных */
  async remove(id: string): Promise<void> {
    const p = this.participants.get(id)
    if (!p) return
    this.participants.delete(id)
    try { await p.pc.close() } catch {}

    const affected: ParticipantState[] = []
    for (const [otherId, other] of this.participants) {
      const removedAudio = this.removeForward(other, id, 'audio')
      const removedVideo = this.removeForward(other, id, 'video')
      if (removedAudio || removedVideo) affected.push(other)
    }
    for (const other of affected) {
      await this.renegotiate(other.id)
    }

    this.broadcast({ type: 'participant-left', id })
  }

  async closeAll(): Promise<void> {
    for (const p of this.participants.values()) {
      try { await p.pc.close() } catch {}
    }
    this.participants.clear()
  }
}

export class SFU {
  private rooms = new Map<string, Room>()

  getOrCreateRoom(channel: string): Room {
    let r = this.rooms.get(channel)
    if (!r) {
      r = new Room(channel)
      this.rooms.set(channel, r)
    }
    return r
  }

  getRoom(channel: string): Room | undefined {
    return this.rooms.get(channel)
  }

  removeIfEmpty(channel: string): void {
    const r = this.rooms.get(channel)
    if (r && r.isEmpty) {
      this.rooms.delete(channel)
    }
  }

  async closeAll(): Promise<void> {
    for (const room of this.rooms.values()) {
      await room.closeAll()
    }
    this.rooms.clear()
  }
}
