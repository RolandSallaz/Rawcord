import { ipcMain, BrowserWindow } from 'electron'

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const sw = require('steamworks.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let activeLobby: any = null   // Lobby object returned by createLobby / joinLobby
let msgPollId: ReturnType<typeof setInterval> | null = null

function broadcast(channel: string, ...args: unknown[]) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

function startMsgPoll() {
  if (msgPollId) return
  msgPollId = setInterval(() => {
    if (!client) return
    try {
      let size: number
      while ((size = client.networking.isP2PPacketAvailable()) > 0) {
        const pkt = client.networking.readP2PPacket(size)
        broadcast('steam:msg', {
          from: pkt.steamId.steamId64.toString(),
          data: pkt.data.toString('utf8'),
        })
      }
    } catch {}
  }, 50)
}

function stopMsgPoll() {
  if (msgPollId) { clearInterval(msgPollId); msgPollId = null }
}

export function initSteam(): boolean {
  try {
    client = sw.init(480)

    // Auto-accept P2P session requests from any peer
    client.callback.register(sw.SteamCallback.P2PSessionRequest, (d: { remote: bigint }) => {
      client.networking.acceptP2PSession(d.remote)
    })

    // Real-time lobby member change events
    client.callback.register(sw.SteamCallback.LobbyChatUpdate, (d: {
      lobby: bigint; user_changed: bigint; member_state_change: number
    }) => {
      if (!activeLobby || d.lobby.toString() !== activeLobby.id.toString()) return
      const myId = client.localplayer.getSteamId().steamId64.toString()
      if (d.user_changed.toString() === myId) return
      const sid = d.user_changed.toString()
      // Steam SDK bitmask: Entered=1, Left=2, Disconnected=4, Kicked=8, Banned=16
      // steamworks.js TS types map Entered=0 (wrong) — handle both interpretations
      const entered = d.member_state_change === 0 || (d.member_state_change & 1) !== 0
      if (entered) {
        broadcast('steam:peer-joined', { steamId: sid, name: '' })
      } else {
        broadcast('steam:peer-left', sid)
      }
    })

    // Friends can join via Steam "Join Game" button
    client.callback.register(sw.SteamCallback.GameLobbyJoinRequested, (d: { lobby_steam_id: bigint }) => {
      broadcast('steam:join-requested', d.lobby_steam_id.toString())
    })

    console.log('[Steam] Ready:', client.localplayer.getName())
    return true
  } catch (e) {
    console.warn('[Steam] Not available:', (e as Error).message)
    return false
  }
}

export function setupSteamIPC() {
  ipcMain.handle('steam:available', () => !!client)

  ipcMain.handle('steam:getUser', () => {
    if (!client) return null
    const id = client.localplayer.getSteamId()
    return { steamId: id.steamId64.toString(), name: client.localplayer.getName() as string }
  })

  ipcMain.handle('steam:createLobby', async () => {
    if (!client) throw new Error('Steam not available')
    const lobby = await client.matchmaking.createLobby(2 /* Public */, 20)
    activeLobby = lobby
    startMsgPoll()
    const lobbyId = (lobby.id as bigint).toString()
    const ownerName = client.localplayer.getName() as string
    try {
      lobby.setData('rawcord', '1')
      lobby.setData('owner', ownerName)
    } catch {}
    client.localplayer.setRichPresence('connect', `+lobby ${lobbyId}`)
    client.localplayer.setRichPresence('steam_display', '#Status_InLobby')
    return lobbyId
  })

  ipcMain.handle('steam:getLobbies', async () => {
    if (!client) return []
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lobbies: any[] = await client.matchmaking.getLobbies()
      return lobbies
        .filter((l) => l.getData('rawcord') === '1')
        .map((l) => ({
          lobbyId: (l.id as bigint).toString(),
          owner: (l.getData('owner') as string) || '?',
          members: Number(l.getMemberCount()),
          maxMembers: Number(l.getMemberLimit() ?? 20),
        }))
    } catch (e) {
      console.warn('[Steam] getLobbies error:', e)
      return []
    }
  })

  ipcMain.handle('steam:inviteFriends', () => {
    if (!client || !activeLobby) return
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const overlay = (client as any).overlay ?? (require('steamworks.js') as any).overlay
      overlay.activateInviteDialog(activeLobby.id)
    } catch (e) {
      console.warn('[Steam] inviteFriends error:', e)
    }
  })

  ipcMain.handle('steam:joinLobby', async (_e, lobbyIdStr: string) => {
    if (!client) throw new Error('Steam not available')

    // If we already have this lobby active, skip re-join
    if (activeLobby) {
      if (activeLobby.id.toString() === lobbyIdStr) {
        startMsgPoll()
        const myId = client.localplayer.getSteamId().steamId64
        const myIdStr = myId.toString()
        try {
          const raw = activeLobby.getMembers()
          const members = (Array.isArray(raw) ? raw : [])
            .filter(m => {
              const id = m?.steamId64 ?? m
              return id !== myId && id?.toString() !== myIdStr
            })
            .map(m => ({ steamId: (m?.steamId64 ?? m).toString(), name: '' }))
          return members
        } catch {
          return []
        }
      }
      // Different lobby — leave the old one first
      try { activeLobby.leave() } catch {}
      activeLobby = null
      stopMsgPoll()
    }

    let lobby
    try {
      lobby = await client.matchmaking.joinLobby(BigInt(lobbyIdStr))
    } catch (err) {
      // Lobby likely expired — clean up stale state
      activeLobby = null
      stopMsgPoll()
      throw new Error('LOBBY_EXPIRED')
    }
    activeLobby = lobby
    startMsgPoll()
    const myId = client.localplayer.getSteamId().steamId64
    const myIdStr = myId.toString()
    const raw = lobby.getMembers()
    const members = (Array.isArray(raw) ? raw : [])
      .filter(m => {
        const id = m?.steamId64 ?? m
        return id !== myId && id?.toString() !== myIdStr
      })
      .map(m => ({ steamId: (m?.steamId64 ?? m).toString(), name: '' }))
    return members
  })

  // isOwner=true means keep the lobby alive (just unregister from voice, don't destroy lobby)
  ipcMain.handle('steam:leaveLobby', (_e, isOwner = false) => {
    if (!client || !activeLobby) return
    stopMsgPoll()
    if (!isOwner) {
      try { activeLobby.leave() } catch {}
      activeLobby = null
      client.localplayer.setRichPresence('connect', '')
      client.localplayer.setRichPresence('steam_display', '')
    }
  })

  // Fully destroy the lobby (called when owner removes the server)
  ipcMain.handle('steam:destroyLobby', () => {
    if (!client || !activeLobby) return
    try { activeLobby.leave() } catch {}
    activeLobby = null
    stopMsgPoll()
    client.localplayer.setRichPresence('connect', '')
    client.localplayer.setRichPresence('steam_display', '')
  })

  ipcMain.handle('steam:sendMsg', (_e, targetSteamId: string, data: string) => {
    if (!client) return
    try {
      client.networking.sendP2PPacket(BigInt(targetSteamId), 2 /* Reliable */, Buffer.from(data, 'utf8'))
    } catch {}
  })
}