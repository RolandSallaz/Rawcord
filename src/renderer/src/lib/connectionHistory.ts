/**
 * История недавних серверов — сохраняется для пользователей,
 * которые подключаются (не создают) серверы.
 */

export interface RecentServer {
  url: string          // ws://host:port
  lastConnected: number
}

const KEY = 'rawcord_recent_servers'
const MAX_ENTRIES = 8

export function loadRecentServers(): RecentServer[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as RecentServer[]
    if (!Array.isArray(raw)) return []
    return raw.filter(s => typeof s.url === 'string' && typeof s.lastConnected === 'number')
  } catch {
    return []
  }
}

export function addRecentServer(url: string): void {
  const list = loadRecentServers().filter(s => s.url !== url)
  list.unshift({ url, lastConnected: Date.now() })
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)))
}

export function removeRecentServer(url: string): void {
  const list = loadRecentServers().filter(s => s.url !== url)
  localStorage.setItem(KEY, JSON.stringify(list))
}

export function formatRelativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return 'только что'
  if (diff < 3600) return `${Math.floor(diff / 60)} мин. назад`
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч. назад`
  return `${Math.floor(diff / 86400)} д. назад`
}
