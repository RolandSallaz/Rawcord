import type { PeerInfo } from './signaling'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ipcRenderer } = (window as any).require('electron')

type RelayPayload = object

interface SteamSignalingHandlers {
  onPeers: (peers: PeerInfo[]) => void
  onPeerJoined: (peer: PeerInfo) => void
  onPeerLeft: (id: string) => void
  onRelay: (from: string, payload: RelayPayload) => void
  onClose: () => void
  onPeerUpdated: (peer: PeerInfo) => void
}

export class SteamSignalingClient {
  private handlers: Partial<SteamSignalingHandlers> = {}
  private seenPeers = new Map<string, PeerInfo>()
  private myNickname = ''
  private myAvatar?: string
  private msgListener: ((_e: unknown, msg: { from: string; data: string }) => void) | null = null
  private joinedListener: ((_e: unknown, peer: { steamId: string; name: string }) => void) | null = null
  private leftListener: ((_e: unknown, steamId: string) => void) | null = null

  constructor(private lobbyId: string) {}

  on<K extends keyof SteamSignalingHandlers>(event: K, handler: SteamSignalingHandlers[K]) {
    this.handlers[event] = handler
  }

  async connect(): Promise<void> {
    this.msgListener = (_e, { from, data }) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data) } catch { return }

      if (msg.type === 'announce') {
        const peer: PeerInfo = {
          id: from,
          nickname: (msg.nickname as string) || from.slice(-6),
          avatar: msg.avatar as string | undefined,
        }
        if (this.seenPeers.has(from)) {
          this.seenPeers.set(from, peer)
          this.handlers.onPeerUpdated?.(peer)
        } else {
          this.seenPeers.set(from, peer)
          this.handlers.onPeerJoined?.(peer)
        }
        // Reply with our own info so they know who we are
        if (this.myNickname) {
          this.sendMsg(from, { type: 'announce', nickname: this.myNickname, avatar: this.myAvatar })
        }
      } else if (msg.type === 'relay') {
        this.handlers.onRelay?.(from, msg.payload as RelayPayload)
      }
    }

    this.joinedListener = (_e, { steamId, name }) => {
      if (this.seenPeers.has(steamId)) return
      const peer: PeerInfo = { id: steamId, nickname: name || steamId.slice(-6), avatar: undefined }
      this.seenPeers.set(steamId, peer)
      this.handlers.onPeerJoined?.(peer)
      // Send our announce so they know who we are
      if (this.myNickname) {
        this.sendMsg(steamId, { type: 'announce', nickname: this.myNickname, avatar: this.myAvatar })
      }
    }

    this.leftListener = (_e, steamId) => {
      this.seenPeers.delete(steamId)
      this.handlers.onPeerLeft?.(steamId)
    }

    ipcRenderer.on('steam:msg', this.msgListener)
    ipcRenderer.on('steam:peer-joined', this.joinedListener)
    ipcRenderer.on('steam:peer-left', this.leftListener)

    const existingMembers: { steamId: string; name: string }[] =
      await ipcRenderer.invoke('steam:joinLobby', this.lobbyId)

    for (const m of existingMembers) {
      const peer: PeerInfo = { id: m.steamId, nickname: m.steamId.slice(-6), avatar: undefined }
      this.seenPeers.set(m.steamId, peer)
    }

    this.handlers.onPeers?.([...this.seenPeers.values()])
  }

  join(_channel: string, nickname: string, avatar?: string) {
    this.myNickname = nickname
    this.myAvatar = avatar
    for (const peerId of this.seenPeers.keys()) {
      this.sendMsg(peerId, { type: 'announce', nickname, avatar })
    }
  }

  relay(to: string, payload: RelayPayload) {
    this.sendMsg(to, { type: 'relay', payload })
  }

  leave() {
    ipcRenderer.invoke('steam:leaveLobby').catch(() => {})
  }

  disconnect() {
    this.leave()
    if (this.msgListener) {
      ipcRenderer.removeListener('steam:msg', this.msgListener)
      this.msgListener = null
    }
    if (this.joinedListener) {
      ipcRenderer.removeListener('steam:peer-joined', this.joinedListener)
      this.joinedListener = null
    }
    if (this.leftListener) {
      ipcRenderer.removeListener('steam:peer-left', this.leftListener)
      this.leftListener = null
    }
    this.seenPeers.clear()
  }

  private sendMsg(to: string, msg: object) {
    ipcRenderer.invoke('steam:sendMsg', to, JSON.stringify(msg)).catch(() => {})
  }
}
