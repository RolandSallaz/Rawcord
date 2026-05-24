import { useState, FormEvent } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ipcRenderer } = (window as any).require('electron')

interface Props {
  nickname: string
  onConnect: (url: string, isHost: boolean) => void
  onBack: () => void
}

type Mode = 'choose' | 'hosting' | 'joining'

export default function LobbyPage({ nickname, onConnect, onBack }: Props) {
  const [mode, setMode] = useState<Mode>('choose')
  const [hostInfo, setHostInfo] = useState<{ ip: string; port: number } | null>(null)
  const [joinAddress, setJoinAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  async function handleHost() {
    setLoading(true)
    try {
      const info = await ipcRenderer.invoke('server:start') as { ip: string; port: number }
      setHostInfo(info)
      setMode('hosting')
    } finally {
      setLoading(false)
    }
  }

  function handleCopy() {
    if (!hostInfo) return
    navigator.clipboard.writeText(`${hostInfo.ip}:${hostInfo.port}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleEnterChannel() {
    onConnect('ws://localhost:3001', true)
  }

  function handleJoinSubmit(e: FormEvent) {
    e.preventDefault()
    const addr = joinAddress.trim()
    if (!addr) return
    const url = addr.startsWith('ws') ? addr : `ws://${addr}`
    onConnect(url, false)
  }

  function handleBack() {
    if (mode === 'hosting') {
      ipcRenderer.invoke('server:stop')
      setHostInfo(null)
    }
    if (mode === 'choose') {
      onBack()
    } else {
      setMode('choose')
    }
  }

  return (
    <div className="lobby-page">
      <div className="lobby-card">

        <div className="lobby-greeting">
          <span className="lobby-nick">{nickname}</span>
          <span className="lobby-sub">как хочешь подключиться?</span>
        </div>

        {mode === 'choose' && (
          <div className="lobby-choices">
            <button className="lobby-choice-btn" onClick={handleHost} disabled={loading}>
              <div className="choice-icon">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-5 11H4v-2h11v2zm3-4H4V9h14v2z"/>
                </svg>
              </div>
              <div className="choice-text">
                <span className="choice-title">Захостить сервер</span>
                <span className="choice-desc">Запусти у себя и поделись адресом</span>
              </div>
            </button>

            <button className="lobby-choice-btn" onClick={() => setMode('joining')}>
              <div className="choice-icon">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
                </svg>
              </div>
              <div className="choice-text">
                <span className="choice-title">Подключиться по IP</span>
                <span className="choice-desc">Введи адрес хоста</span>
              </div>
            </button>
          </div>
        )}

        {mode === 'hosting' && hostInfo && (
          <div className="lobby-hosting">
            <p className="hosting-label">твой адрес</p>
            <div className="hosting-address">
              <span className="address-text">{hostInfo.ip}:{hostInfo.port}</span>
              <button className="copy-btn" onClick={handleCopy}>
                {copied ? '✓' : 'Скопировать'}
              </button>
            </div>
            <p className="hosting-hint">Отправь этот адрес другу — он вставит его при подключении</p>
            <button className="connect-btn hosting-enter" onClick={handleEnterChannel}>
              Войти в канал
            </button>
          </div>
        )}

        {mode === 'joining' && (
          <form className="lobby-join-form" onSubmit={handleJoinSubmit}>
            <label className="input-label">АДРЕС ХОСТА (IP:PORT)</label>
            <input
              autoFocus
              className="nickname-input"
              type="text"
              placeholder="192.168.1.5:3001"
              value={joinAddress}
              onChange={e => setJoinAddress(e.target.value)}
              spellCheck={false}
            />
            <button
              className="join-btn"
              type="submit"
              disabled={joinAddress.trim().length < 7}
            >
              Подключиться
            </button>
          </form>
        )}

        <button className="lobby-back-btn" onClick={handleBack}>
          ← Назад
        </button>

      </div>
    </div>
  )
}
