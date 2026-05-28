import { useState, useEffect } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ipcRenderer } = (window as any).require('electron')

interface Source {
  id: string
  name: string
  thumbnail: string
  type: 'screen' | 'window'
}

interface Quality {
  label: string
  width: number
  height: number
}

const QUALITIES: Quality[] = [
  { label: '1080p', width: 1920, height: 1080 },
  { label: '720p',  width: 1280, height: 720  },
  { label: '480p',  width: 854,  height: 480  },
  { label: '320p',  width: 568,  height: 320  },
]

const FPS_OPTIONS = [10, 30, 60]

interface Props {
  onStart: (stream: MediaStream, sourceId: string, withAudio: boolean) => void
  onClose: () => void
}

export default function ScreenShareModal({ onStart, onClose }: Props) {
  const [sources, setSources] = useState<Source[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<'screen' | 'window'>('screen')
  const [qualityIdx, setQualityIdx] = useState(1)
  const [fps, setFps] = useState(30)
  const [withAudio, setWithAudio] = useState(true)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    ipcRenderer.invoke('screen:getSources')
      .then((srcs: Source[]) => {
        setSources(srcs)
        const first = srcs.find(s => s.type === 'screen')
        if (first) setSelectedId(first.id)
        setLoading(false)
      })
      .catch(() => {
        setError('Не удалось получить список источников')
        setLoading(false)
      })
  }, [])

  // When tab changes, auto-select first item in that tab
  useEffect(() => {
    const first = sources.find(s => s.type === tab)
    setSelectedId(first?.id ?? null)
  }, [tab, sources])

  const visibleSources = sources.filter(s => s.type === tab)

  async function handleStart() {
    if (!selectedId) return
    setStarting(true)
    setError('')

    const q = QUALITIES[qualityIdx]
    try {
      // Store the selected source in the main process so setDisplayMediaRequestHandler can use it
      await ipcRenderer.invoke('screen:capture', selectedId)
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: withAudio,
        video: {
          width: { ideal: q.width },
          height: { ideal: q.height },
          frameRate: { ideal: fps },
        },
      })
      onStart(stream, selectedId, withAudio)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка захвата экрана')
      setStarting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal screenshare-modal">
        <div className="modal-header">
          <span className="modal-title">Трансляция экрана</span>
          <button className="modal-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <div className="modal-section">
          <div className="ss-tabs">
            <button
              className={`ss-tab${tab === 'screen' ? ' active' : ''}`}
              onClick={() => setTab('screen')}
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3l-1 1v2h12v-2l-1-1h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/>
              </svg>
              Экраны
            </button>
            <button
              className={`ss-tab${tab === 'window' ? ' active' : ''}`}
              onClick={() => setTab('window')}
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M2 4v16h20V4H2zm18 14H4V8h16v10zm0-12H4V6h16v2z"/>
              </svg>
              Приложения
            </button>
          </div>

          {loading && <p className="settings-hint">Загрузка источников…</p>}
          {error && <p className="settings-hint" style={{ color: 'var(--red)' }}>{error}</p>}
          {!loading && !error && visibleSources.length === 0 && (
            <p className="settings-hint">
              {tab === 'screen' ? 'Экраны не найдены' : 'Открытые приложения не найдены'}
            </p>
          )}
          {!loading && visibleSources.length > 0 && (
            <div className="ss-source-grid">
              {visibleSources.map(src => (
                <button
                  key={src.id}
                  className={`ss-source-item${selectedId === src.id ? ' selected' : ''}`}
                  onClick={() => setSelectedId(src.id)}
                >
                  <img src={src.thumbnail} alt={src.name} className="ss-source-thumb" draggable={false} />
                  <span className="ss-source-name">{src.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="modal-section">
          <div className="modal-section-title">ЗВУК</div>
          <div className="settings-row">
            <span className="settings-label">Звук компьютера</span>
            <label className="ss-toggle">
              <input type="checkbox" checked={withAudio} onChange={e => setWithAudio(e.target.checked)} />
              <span className="ss-toggle-track" />
            </label>
          </div>
          {withAudio && (
            <p className="settings-hint" style={{ marginTop: 4 }}>
              Голоса участников Rawcord будут убраны из трансляции автоматически
            </p>
          )}
        </div>

        <div className="modal-section">
          <div className="modal-section-title">КАЧЕСТВО</div>
          <div className="settings-row">
            <span className="settings-label">Разрешение</span>
            <select
              className="settings-select"
              value={qualityIdx}
              onChange={e => setQualityIdx(Number(e.target.value))}
            >
              {QUALITIES.map((q, i) => (
                <option key={q.label} value={i}>{q.label}</option>
              ))}
            </select>
          </div>
          <div className="settings-row">
            <span className="settings-label">FPS</span>
            <select
              className="settings-select"
              value={fps}
              onChange={e => setFps(Number(e.target.value))}
            >
              {FPS_OPTIONS.map(f => (
                <option key={f} value={f}>{f} fps</option>
              ))}
            </select>
          </div>
        </div>

        <div className="modal-section" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="ptt-bind-btn" onClick={onClose}>Отмена</button>
          <button
            className="connect-btn"
            style={{ marginTop: 0, padding: '8px 24px' }}
            disabled={!selectedId || starting}
            onClick={handleStart}
          >
            {starting ? 'Запуск…' : 'Начать трансляцию'}
          </button>
        </div>
      </div>
    </div>
  )
}
