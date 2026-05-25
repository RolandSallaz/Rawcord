export interface SavedServer {
  id: string
  name: string
  lobbyId: string
  isOwner: boolean
}

const KEY = 'rawcord_servers'

export function loadServers(): SavedServer[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Record<string, unknown>[]
    // Filter out legacy WebSocket servers that don't have lobbyId
    return raw.filter(s => typeof s.lobbyId === 'string') as unknown as SavedServer[]
  } catch {
    return []
  }
}

export function saveServers(list: SavedServer[]): void {
  localStorage.setItem(KEY, JSON.stringify(list))
}
