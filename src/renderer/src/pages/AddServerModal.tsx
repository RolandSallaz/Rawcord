import { useState, useRef, useEffect, FormEvent } from 'react'
import type { SavedServer } from '../lib/servers'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ipcRenderer } = (window as any).require('electron')

interface LobbyEntry {
  lobbyId: string
  owner: string
  members: number
  maxMembers: number
}

interface Props {
  onAdd: (server: SavedServer) => void
  onClose: () => void
}

type Mode = 'choose' | 'creating' | 'browse'

export default function AddServerModal({ onAdd, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('choose')
  const [steamAvailable, setSteamAvailable] = useState<boolean | null>(null)
  const [lobbies, setLobbies] = useState<LobbyEntry[]>([])
  const [loadingLobbies, setLoadingLobbies] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ipcRenderer.invoke('steam:available').then((ok: boolean) => setSteamAvailable(ok))
  }, [])

  async function fetchLobbies() {
    setLoadingLobbies(true)
    setError('')
    try {
      const list: LobbyEntry[] = await ipcRenderer.invoke('steam:getLobbies')
      setLobbies(list)
    } catch {
      setError('Не удалось загрузить список лобби')
    } finally {
      setLoadingLobbies(false)
    }
  }

  function handleBrowse() {
    setMode('browse')
    fetchLobbies()
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError('')
    try {
      const lobbyId: string = await ipcRenderer.invoke('steam:createLobby')
      onAdd({
        id: crypto.randomUUID(),
        name: 'Моё лобби',
        lobbyId,
        isOwner: true,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания лобби')
      setCreating(false)
    }
  }

  function handleJoin(entry: LobbyEntry) {
    onAdd({
      id: crypto.randomUUID(),
      name: `${entry.owner}'s lobby`,
      lobbyId: entry.lobbyId,
      isOwner: false,
    })
  }

  function handleBack() {
    setMode('choose')
    setError('')
  }

  function handleClose() {
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
          {error && <p className="settings-hint" style={{ color: 'var(--red)' }}>{error}</p>}

          {mode === 'choose' && (
            <div className="add-server-choices">
              <button className="lobby-choice-btn" disabled={!steamAvailable} onClick={handleCreate}>
                <div className="choice-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                  </svg>
                </div>
                <div className="choice-text">
                  <span className="choice-title">Создать лобби</span>
                  <span className="choice-desc">Друзья смогут найти тебя в списке</span>
                </div>
                {creating && <span className="choice-spinner" />}
              </button>
              <button className="lobby-choice-btn" disabled={!steamAvailable} onClick={handleBrowse}>
                <div className="choice-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                  </svg>
                </div>
                <div className="choice-text">
                  <span className="choice-title">Найти лобби</span>
                  <span className="choice-desc">Посмотреть активные лобби</span>
                </div>
              </button>
            </div>
          )}

          {mode === 'browse' && (
            <div className="lobby-browser">
              <div className="lobby-browser-header">
                <button className="lobby-back-btn" onClick={handleBack}>← Назад</button>
                <button
                  className="lobby-refresh-btn"
                  onClick={fetchLobbies}
                  disabled={loadingLobbies}
                  title="Обновить"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 16, height: 16 }}>
                    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                  </svg>
                </button>
              </div>

              {loadingLobbies && <p className="settings-hint">Поиск лобби…</p>}

              {!loadingLobbies && lobbies.length === 0 && (
                <p className="settings-hint">Активных лобби не найдено. Попроси друга создать лобби.</p>
              )}

              {!loadingLobbies && lobbies.length > 0 && (
                <div className="lobby-list">
                  {lobbies.map(entry => (
                    <div key={entry.lobbyId} className="lobby-entry">
                      <div className="lobby-entry-info">
                        <span className="lobby-entry-owner">{entry.owner}</span>
                        <span className="lobby-entry-count">{entry.members} / {entry.maxMembers}</span>
                      </div>
                      <button
                        className="connect-btn"
                        style={{ marginTop: 0, padding: '6px 18px', fontSize: 13 }}
                        onClick={() => handleJoin(entry)}
                      >
                        Войти
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
