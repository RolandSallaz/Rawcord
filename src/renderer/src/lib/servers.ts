export interface SavedServer {
  id: string
  name: string
  url: string
  isHost: boolean
}

const KEY = 'rawcord_servers'

export function loadServers(): SavedServer[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedServer[]
  } catch {
    return []
  }
}

export function saveServers(list: SavedServer[]): void {
  localStorage.setItem(KEY, JSON.stringify(list))
}
