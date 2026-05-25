import { useState, useRef, useEffect, FormEvent } from 'react'
import type { SavedServer } from '../lib/servers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ipcRenderer } = (window as any).require('electron')

interface Props {
  onAdd: (server: SavedServer) => void
  onClose: () => void
}

type Mode = 'choose' | 'creating' | 'created' | 'joining'

export default function AddServerModal({ onAdd, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('choose')
  const [steamAvailable, setSteamAvailable] = useState<boolean | null>(null)
  const [lobbyId, setLobbyId] = useState('')
  const [serverName, setServerName] = useState('')
  const [joinId, setJoinId] = useState('')
  const [joinName, setJoinName] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ipcRenderer.invoke('steam:available').then((ok: boolean) => setSteamAvailable(ok))
  }, [])

  async function handleCreateLobby(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const id: string = await ipcRenderer.invoke('steam:createLobby')
      setLobbyId(id)
      setServerName(`Lobby ${id.slice(-6)}`)
      setMode('created')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания лобби')
    } finally {
      setLoading(false)
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(lobbyId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleSubmitCreated(e: FormEvent) {
    e.preventDefault()
    const name = serverName.trim() || `Lobby ${lobbyId.slice(-6)}`
    onAdd({ id: crypto.randomUUID(), name, lobbyId, isOwner: true })
  }

  function handleSubmitJoin(e: FormEvent) {
    e.preventDefault()
    const id = joinId.trim()
    if (!id) return
    const name = joinName.trim() || `Lobby ${id.slice(-6)}`
    onAdd({ id: crypto.randomUUID(), name, lobbyId: id, isOwner: false })
  }

  function handleBack() {
    if (mode === 'created') {
      ipcRenderer.invoke('steam:leaveLobby').catch(() => {})
      setLobbyId('')
    }
    setMode('choose')
    setServerName('')
    setJoinId('')
    setJoinName('')
    setError('')
  }

  function handleClose() {
    if (mode === 'created') ipcRenderer.invoke('steam:leaveLobby').catch(() => {})
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
          {steamAvailable === false && (
            <p className="settings-hint" style={{ color: 'var(--red)' }}>
              Steam недоступен. Запусти приложение через Steam.
            </p>
          )}

          {mode === 'choose' && (
            <div className="add-server-choices">
              <button
                className="lobby-choice-btn"
                disabled={!steamAvailable}
                onClick={() => setMode('creating')}
              >
                <div className="choice-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-5 11H4v-2h11v2zm3-4H4V9h14v2z"/>
                  </svg>
                </div>
                <div className="choice-text">
                  <span className="choice-title">Создать лобби Steam</span>
                  <span className="choice-desc">Поделись ID лобби с друзьями</span>
                </div>
              </button>
              <button
                className="lobby-choice-btn"
                disabled={!steamAvailable}
                onClick={() => setMode('joining')}
              >
                <div className="choice-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>
                  </svg>
                </div>
                <div className="choice-text">
                  <span className="choice-title">Войти в лобби</span>
                  <span className="choice-desc">Введи ID лобби</span>
                </div>
              </button>
            </div>
          )}

          {mode === 'creating' && (
            <form className="add-server-form" onSubmit={handleCreateLobby}>
              <p className="settings-hint">Создаётся Steam лобби — другие игроки смогут подключиться через Steam или по ID.</p>
              {error && <p className="settings-hint" style={{ color: 'var(--red)' }}>{error}</p>}
              <div className="add-server-actions">
                <button type="button" className="lobby-back-btn" onClick={handleBack}>← Назад</button>
                <button type="submit" className="connect-btn" disabled={loading}>
                  {loading ? 'Создание…' : 'Создать лобби'}
                </button>
              </div>
            </form>
          )}

          {mode === 'created' && (
            <form className="add-server-form" onSubmit={handleSubmitCreated}>
              <div className="settings-row">
                <span className="settings-label">ID лобби</span>
                <div className="hosting-address">
                  <span className="address-text">{lobbyId}</span>
                  <button type="button" className="copy-btn" onClick={handleCopy}>
                    {copied ? '✓' : 'Скопировать'}
                  </button>
                </div>
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="srv-name-host">Название</label>
                <input
                  id="srv-name-host"
                  className="settings-input"
                  type="text"
                  placeholder={`Lobby ${lobbyId.slice(-6)}`}
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
                <label className="settings-label" htmlFor="join-id">ID лобби</label>
                <input
                  id="join-id"
                  autoFocus
                  className="settings-input"
                  type="text"
                  placeholder="109775241747550193"
                  value={joinId}
                  onChange={e => setJoinId(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="srv-name-join">Название</label>
                <input
                  id="srv-name-join"
                  className="settings-input"
                  type="text"
                  placeholder={joinId ? `Lobby ${joinId.slice(-6)}` : 'Моё лобби'}
                  value={joinName}
                  onChange={e => setJoinName(e.target.value)}
                />
              </div>
              <div className="add-server-actions">
                <button type="button" className="lobby-back-btn" onClick={handleBack}>← Назад</button>
                <button
                  type="submit"
                  className="connect-btn"
                  disabled={joinId.trim().length < 5}
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
