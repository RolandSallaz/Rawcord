import { useState, useRef, FormEvent } from 'react'
import type { SavedServer } from '../lib/servers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ipcRenderer } = (window as any).require('electron')

interface Props {
  onAdd: (server: SavedServer) => void
  onClose: () => void
}

type Mode = 'choose' | 'config-hosting' | 'hosting' | 'joining'

export default function AddServerModal({ onAdd, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('choose')
  const [hostPort, setHostPort] = useState(3001)
  const [hostInfo, setHostInfo] = useState<{ ip: string; port: number } | null>(null)
  const [joinAddress, setJoinAddress] = useState('')
  const [serverName, setServerName] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  async function handleStartHost(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const info = await ipcRenderer.invoke('server:start', hostPort) as { ip: string; port: number }
      setHostInfo(info)
      setServerName(`${info.ip}:${info.port}`)
      setMode('hosting')
    } finally {
      setLoading(false)
    }
  }

  function handleChooseJoin() {
    setMode('joining')
  }

  function handleCopy() {
    if (!hostInfo) return
    navigator.clipboard.writeText(`${hostInfo.ip}:${hostInfo.port}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleSubmitHost(e: FormEvent) {
    e.preventDefault()
    if (!hostInfo) return
    const name = serverName.trim() || `${hostInfo.ip}:${hostInfo.port}`
    onAdd({
      id: crypto.randomUUID(),
      name,
      url: `ws://localhost:${hostInfo.port}`,
      isHost: true,
    })
  }

  function handleSubmitJoin(e: FormEvent) {
    e.preventDefault()
    const addr = joinAddress.trim()
    if (!addr) return
    const url = addr.startsWith('ws') ? addr : `ws://${addr}`
    const name = serverName.trim() || addr
    onAdd({
      id: crypto.randomUUID(),
      name,
      url,
      isHost: false,
    })
  }

  function handleBack() {
    if (mode === 'hosting') {
      ipcRenderer.invoke('server:stop')
      setHostInfo(null)
    }
    setMode('choose')
    setServerName('')
    setJoinAddress('')
  }

  function handleClose() {
    if (mode === 'hosting') ipcRenderer.invoke('server:stop')
    onClose()
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) handleClose()
  }

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">Добавить сервер</span>
          <button className="modal-close" onClick={handleClose}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <div className="modal-section">
          {mode === 'choose' && (
            <div className="add-server-choices">
              <button className="lobby-choice-btn" onClick={() => setMode('config-hosting')}>
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
              <button className="lobby-choice-btn" onClick={handleChooseJoin}>
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

          {mode === 'config-hosting' && (
            <form className="add-server-form" onSubmit={handleStartHost}>
              <div className="settings-row">
                <label className="settings-label" htmlFor="host-port">Порт сервера</label>
                <input
                  id="host-port"
                  autoFocus
                  className="settings-input"
                  type="number"
                  min={1024}
                  max={65535}
                  value={hostPort}
                  onChange={e => setHostPort(Number(e.target.value))}
                />
              </div>
              <p className="settings-hint">Порт должен быть открыт в брандмауэре для входящих подключений</p>
              <div className="add-server-actions">
                <button type="button" className="lobby-back-btn" onClick={handleBack}>← Назад</button>
                <button type="submit" className="connect-btn" disabled={loading}>
                  {loading ? 'Запуск…' : 'Запустить сервер'}
                </button>
              </div>
            </form>
          )}

          {mode === 'hosting' && hostInfo && (
            <form className="add-server-form" onSubmit={handleSubmitHost}>
              <div className="settings-row">
                <span className="settings-label">Твой адрес</span>
                <div className="hosting-address">
                  <span className="address-text">{hostInfo.ip}:{hostInfo.port}</span>
                  <button type="button" className="copy-btn" onClick={handleCopy}>
                    {copied ? '✓' : 'Скопировать'}
                  </button>
                </div>
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="srv-name-host">Название сервера</label>
                <input
                  id="srv-name-host"
                  className="settings-input"
                  type="text"
                  placeholder={`${hostInfo.ip}:${hostInfo.port}`}
                  value={serverName}
                  onChange={e => setServerName(e.target.value)}
                />
              </div>
              <div className="add-server-actions">
                <button type="button" className="lobby-back-btn" onClick={handleBack}>← Назад</button>
                <button type="submit" className="connect-btn">Добавить и войти</button>
              </div>
            </form>
          )}

          {mode === 'joining' && (
            <form className="add-server-form" onSubmit={handleSubmitJoin}>
              <div className="settings-row">
                <label className="settings-label" htmlFor="join-addr">Адрес (IP:PORT)</label>
                <input
                  id="join-addr"
                  autoFocus
                  className="settings-input"
                  type="text"
                  placeholder="192.168.1.5:3001"
                  value={joinAddress}
                  onChange={e => setJoinAddress(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="srv-name-join">Название сервера</label>
                <input
                  id="srv-name-join"
                  className="settings-input"
                  type="text"
                  placeholder={joinAddress || '192.168.1.5:3001'}
                  value={serverName}
                  onChange={e => setServerName(e.target.value)}
                />
              </div>
              <div className="add-server-actions">
                <button type="button" className="lobby-back-btn" onClick={handleBack}>← Назад</button>
                <button
                  type="submit"
                  className="connect-btn"
                  disabled={joinAddress.trim().length < 7}
                >
                  Добавить и войти
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
