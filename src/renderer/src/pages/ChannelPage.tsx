import { useState, useEffect, useRef, useCallback } from 'react'
import { SignalingClient, type ParticipantInfo } from '../lib/signaling'
import { WsAudioClient } from '../lib/wsAudioClient'
import { loadSettings, saveSettings, type AudioSettings } from '../lib/settings'
import { loadProfile, saveProfile, type UserProfile } from '../lib/profile'
import { playJoinSound, playLeaveSound } from '../lib/sounds'
import { addRecentServer, loadRecentServers, removeRecentServer, formatRelativeTime, type RecentServer } from '../lib/connectionHistory'
import SettingsModal from './SettingsModal'
import ProfileCard from './ProfileCard'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ipcRenderer } = (window as any).require('electron')

type AppState = 'idle' | 'connecting' | 'connected' | 'error' | 'reconnecting'
const RECONNECT_DELAYS = [3000, 5000, 10000, 20000, 30000]

interface ChatMessage {
  id: string
  from: string
  text: string
  nickname: string
  avatar?: string
  timestamp: number
}

function AvatarImg({ src, initial, size = 32 }: { src?: string; initial: string; size?: number }) {
  if (src) return <img src={src} alt="av" className="avatar-img" style={{ width: size, height: size }} />
  return (
    <div className="avatar-initials" style={{ width: size, height: size, fontSize: size * 0.44 }}>
      {initial.toUpperCase()}
    </div>
  )
}

function IconMic() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
    </svg>
  )
}
function IconMicOff() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
    </svg>
  )
}
function IconHeadphones() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
    </svg>
  )
}
function IconHeadphonesOff() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
    </svg>
  )
}

export default function ChannelPage() {
  const [profile, setProfile] = useState<UserProfile>(() => loadProfile()!)
  const [settings, setSettings] = useState<AudioSettings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)

  const [appState, setAppState] = useState<AppState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [isOwner, setIsOwner] = useState(false)

  const [serverUrl, setServerUrl] = useState('')
  const [serverInput, setServerInput] = useState('')
  const [serverPort, setServerPort] = useState('3001')

  const [peers, setPeers] = useState<ParticipantInfo[]>([])
  const [micMuted, setMicMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [speakingPeers, setSpeakingPeers] = useState<Set<string>>(new Set())
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLInputElement>(null)

  const [reconnectCountdown, setReconnectCountdown] = useState(0)
  const [recentServers, setRecentServers] = useState<RecentServer[]>(() => loadRecentServers())
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [peerVolPopup, setPeerVolPopup] = useState<{ peer: ParticipantInfo; anchor: DOMRect } | null>(null)
  const [peerVolumes, setPeerVolumes] = useState<Map<string, number>>(new Map())
  const [profileCard, setProfileCard] = useState<{ peer: ParticipantInfo; anchor: DOMRect } | null>(null)

  const signalingRef = useRef<SignalingClient | null>(null)
  const audioRef = useRef<WsAudioClient | null>(null)
  const prevMicMutedRef = useRef(false)

  const intentionalDisconnectRef = useRef(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const lastConnectionRef = useRef<{ url: string; isOwner: boolean } | null>(null)

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chatMessages])
  useEffect(() => { return () => { cleanup() } }, [])

  useEffect(() => {
    audioRef.current?.setMicGain(settings.micVolume)
  }, [settings.micVolume])

  useEffect(() => {
    if (settings.voiceMode !== 'ptt' || appState !== 'connected') return
    audioRef.current?.setMicMuted(true)

    if (settings.pttKey.startsWith('Mouse')) {
      const btn = parseInt(settings.pttKey.replace('Mouse', ''))
      const onDown = (e: MouseEvent) => { if (e.button === btn) audioRef.current?.setMicMuted(false) }
      const onUp   = (e: MouseEvent) => { if (e.button === btn) audioRef.current?.setMicMuted(true) }
      window.addEventListener('mousedown', onDown)
      window.addEventListener('mouseup', onUp)
      return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('mouseup', onUp) }
    } else {
      const onDown = (e: KeyboardEvent) => { if (e.code === settings.pttKey && !e.repeat) audioRef.current?.setMicMuted(false) }
      const onUp   = (e: KeyboardEvent) => { if (e.code === settings.pttKey) audioRef.current?.setMicMuted(true) }
      window.addEventListener('keydown', onDown)
      window.addEventListener('keyup', onUp)
      return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
    }
  }, [settings.voiceMode, settings.pttKey, appState])

  function cleanup() {
    setIsSpeaking(false)
    setSpeakingPeers(new Set())
    audioRef.current?.destroy()
    audioRef.current = null
    signalingRef.current?.disconnect()
    signalingRef.current = null
  }

  function cancelReconnect() {
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
    reconnectAttemptRef.current = 0
  }

  function scheduleReconnect() {
    const attempt = reconnectAttemptRef.current
    if (attempt >= RECONNECT_DELAYS.length) {
      setAppState('error'); setErrorMsg('Не удалось восстановить соединение')
      reconnectAttemptRef.current = 0; return
    }
    const delay = RECONNECT_DELAYS[attempt]
    let remaining = Math.ceil(delay / 1000)
    setReconnectCountdown(remaining)
    setAppState('reconnecting')
    const countInterval = setInterval(() => {
      remaining -= 1; setReconnectCountdown(remaining)
      if (remaining <= 0) clearInterval(countInterval)
    }, 1000)
    reconnectTimerRef.current = setTimeout(async () => {
      clearInterval(countInterval)
      reconnectAttemptRef.current += 1
      const info = lastConnectionRef.current
      if (!info) { setAppState('idle'); return }
      setAppState('connecting')
      try {
        const url = info.isOwner ? `ws://127.0.0.1:${info.url.split(':').pop()}` : info.url
        await connectToChannel(url, info.isOwner)
      } catch { scheduleReconnect() }
    }, delay)
  }

  async function copyServerUrl() {
    if (!serverUrl) return
    try { await navigator.clipboard.writeText(serverUrl); setCopiedUrl(true); setTimeout(() => setCopiedUrl(false), 2000) } catch {}
  }

  const connectToChannel = useCallback(async (wsUrl: string, owner: boolean) => {
    // 1) Mic access
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: settings.inputDeviceId ? { exact: settings.inputDeviceId } : undefined,
          noiseSuppression: settings.noiseSuppression,
          echoCancellation: true,
          sampleRate: 48000,
        },
        video: false,
      })
    } catch {
      setErrorMsg('Нет доступа к микрофону'); setAppState('error'); return
    }

    // 2) Signaling client
    const signaling = new SignalingClient(wsUrl)

    // 3) WsAudioClient — all audio over WebSocket binary frames
    const audio = new WsAudioClient(signaling)
    audio.setStream(stream)
    audio.setMicGain(settings.micVolume)
    audio.setOutputDevice(settings.outputDeviceId)
    audio.onSpeakingChanged = (set) => setSpeakingPeers(new Set(set))
    audio.onLocalSpeaking = (speaking) => setIsSpeaking(speaking)

    // 4) Room management handlers
    signaling.on('onWelcome', async ({ participants }) => {
      setPeers(participants)
      // Start mic capture after welcome (user is in the room)
      try { await audio.startCapture() } catch (e) { console.error('[ChannelPage] startCapture failed:', e) }
    })

    signaling.on('onParticipantJoined', (p) => {
      setPeers(prev => prev.some(x => x.id === p.id) ? prev : [...prev, p])
      playJoinSound()
    })

    signaling.on('onParticipantLeft', (id) => {
      audio.removePeer(id)
      setPeers(prev => prev.filter(p => p.id !== id))
      playLeaveSound()
    })

    signaling.on('onParticipantUpdated', (p) => {
      setPeers(prev => prev.map(x => x.id === p.id ? { ...x, ...p } : x))
    })

    signaling.on('onChat', (from, text, nickname, avatar) => {
      setChatMessages(prev => [...prev, {
        id: `${from}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        from, text, nickname, avatar, timestamp: Date.now(),
      }])
    })

    signaling.on('onClose', () => {
      cleanup(); setPeers([]); setChatMessages([])
      if (intentionalDisconnectRef.current) {
        intentionalDisconnectRef.current = false; setAppState('idle'); setServerUrl('')
      } else {
        scheduleReconnect()
      }
    })

    // 5) Connect
    try { await signaling.connect() } catch {
      stream.getTracks().forEach(t => t.stop())
      cleanup(); setErrorMsg('Не удалось подключиться к серверу'); setAppState('error'); return
    }

    signalingRef.current = signaling
    audioRef.current = audio
    intentionalDisconnectRef.current = false
    reconnectAttemptRef.current = 0
    signaling.join('voice', profile.nickname, profile.avatar || undefined)
    setIsOwner(owner)
    setAppState('connected')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, profile])

  function handleDisconnect() {
    intentionalDisconnectRef.current = true
    cancelReconnect()
    cleanup()
    setPeers([])
    setMicMuted(false); setDeafened(false)
    prevMicMutedRef.current = false
    setServerUrl('')
    if (isOwner) ipcRenderer.invoke('server:stop').catch(() => {})
    setIsOwner(false)
    lastConnectionRef.current = null
    setAppState('idle')
  }

  function toggleMic() {
    const next = !micMuted
    setMicMuted(next)
    if (deafened && !next) { setDeafened(false); audioRef.current?.setDeafened(false) }
    audioRef.current?.setMicMuted(next)
  }

  function toggleDeafen() {
    const next = !deafened
    setDeafened(next)
    if (next) {
      prevMicMutedRef.current = micMuted
      setMicMuted(true); audioRef.current?.setMicMuted(true)
    } else {
      setMicMuted(prevMicMutedRef.current)
      audioRef.current?.setMicMuted(prevMicMutedRef.current)
    }
    audioRef.current?.setDeafened(next)
  }

  async function handleStartServer() {
    setAppState('connecting'); setErrorMsg(''); setServerUrl('')
    const port = parseInt(serverPort, 10)
    if (isNaN(port) || port < 1024 || port > 65535) {
      setErrorMsg('Укажите порт от 1024 до 65535'); setAppState('error'); return
    }
    try {
      const result: { port: number; ip: string } = await ipcRenderer.invoke('server:start', port)
      const url = `ws://127.0.0.1:${result.port}`
      const publicUrl = `ws://${result.ip}:${result.port}`
      setServerUrl(publicUrl)
      lastConnectionRef.current = { url: publicUrl, isOwner: true }
      await connectToChannel(url, true)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('EADDRINUSE') || msg.includes('already in use')) {
        setErrorMsg(`Порт ${serverPort} уже занят. Укажите другой порт.`)
      } else { setErrorMsg(msg || 'Не удалось запустить сервер') }
      setAppState('error')
    }
  }

  function handleConnectToServer(urlOverride?: string) {
    let input = (urlOverride ?? serverInput).trim()
    if (!input) return
    if (!input.startsWith('ws://') && !input.startsWith('wss://')) input = `ws://${input}`
    setAppState('connecting'); setErrorMsg(''); setServerUrl(input)
    lastConnectionRef.current = { url: input, isOwner: false }
    addRecentServer(input); setRecentServers(loadRecentServers())
    connectToChannel(input, false)
  }

  function handleSendChat() {
    const text = chatInput.trim()
    if (!text) return
    signalingRef.current?.sendChat(text)
    setChatMessages(prev => [...prev, {
      id: `self-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from: 'self', text, nickname: profile.nickname,
      avatar: profile.avatar || undefined, timestamp: Date.now(),
    }])
    setChatInput('')
  }

  // ─── RENDER ────────────────────────────────────────────────

  return (
    <div className="cp-root">
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          profile={profile}
          onChange={s => {
            setSettings(s); saveSettings(s)
            audioRef.current?.setOutputDevice(s.outputDeviceId)
          }}
          onProfileChange={p => {
            saveProfile(p); setProfile(p)
            signalingRef.current?.announce(p.nickname, p.avatar || undefined)
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {profileCard && (
        <ProfileCard
          peer={profileCard.peer}
          stream={undefined}
          anchor={profileCard.anchor}
          onWatch={() => setProfileCard(null)}
          onClose={() => setProfileCard(null)}
        />
      )}

      {/* Per-user volume popup */}
      {peerVolPopup && (() => {
        const vol = peerVolumes.get(peerVolPopup.peer.id) ?? 100
        const rect = peerVolPopup.anchor
        return (
          <div
            className="peer-vol-popup"
            style={{ top: rect.top, left: rect.right + 8 }}
            onMouseLeave={() => setPeerVolPopup(null)}
          >
            <div className="peer-vol-popup-header">
              <AvatarImg src={peerVolPopup.peer.avatar} initial={peerVolPopup.peer.nickname[0] ?? '?'} size={22} />
              <span className="peer-vol-popup-name">{peerVolPopup.peer.nickname}</span>
            </div>
            <div className="peer-vol-row">
              <span className="peer-vol-icon">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                </svg>
              </span>
              <input
                className="peer-vol-slider"
                type="range" min={0} max={200} step={1} value={vol}
                onChange={e => {
                  const v = parseInt(e.target.value)
                  setPeerVolumes(prev => new Map(prev).set(peerVolPopup.peer.id, v))
                  audioRef.current?.setPeerVolume(peerVolPopup.peer.id, v)
                }}
              />
              <span className="peer-vol-value">{vol}%</span>
            </div>
          </div>
        )
      })()}

      {/* ── IDLE ── */}
      {appState === 'idle' && (
        <div className="cp-home">
          <div className="cp-home-inner">
            <div className="cp-home-logo">R</div>
            <h1 className="cp-home-title">Rawcord</h1>
            <p className="cp-home-sub">Self-hosted голосовой чат</p>

            <div className="cp-home-actions">
              <div className="cp-action-card create-server-card">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3l-1 1v2h12v-2l-1-1h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/></svg>
                <span className="cp-action-label">Создать сервер</span>
                <span className="cp-action-desc">Открой один порт — друзья подключатся</span>
                <div className="connect-input-row">
                  <span className="port-label">Порт:</span>
                  <input
                    className="server-url-input port-input"
                    type="number" min="1024" max="65535" placeholder="3001"
                    value={serverPort}
                    onChange={e => setServerPort(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleStartServer() }}
                  />
                  <button className="connect-submit-btn" onClick={handleStartServer}>Создать</button>
                </div>
              </div>

              <div className="cp-action-card connect-card">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                <span className="cp-action-label">Подключиться</span>
                <span className="cp-action-desc">Ввести IP:Порт сервера</span>
                <div className="connect-input-row">
                  <input
                    className="server-url-input"
                    type="text" placeholder="192.168.1.100:3001"
                    value={serverInput}
                    onChange={e => setServerInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleConnectToServer() }}
                  />
                  <button
                    className="connect-submit-btn"
                    disabled={!serverInput.trim()}
                    onClick={() => handleConnectToServer()}
                  >Подкл.</button>
                </div>
                {recentServers.length > 0 && (
                  <div className="cp-recent-servers">
                    <div className="cp-recent-label">Недавние</div>
                    {recentServers.map(s => (
                      <div key={s.url} className="cp-recent-entry">
                        <button className="cp-recent-connect" onClick={() => handleConnectToServer(s.url)} title={s.url}>
                          <span className="cp-recent-url">{s.url.replace('ws://', '')}</span>
                          <span className="cp-recent-time">{formatRelativeTime(s.lastConnected)}</span>
                        </button>
                        <button className="cp-recent-remove" title="Удалить"
                          onClick={() => { removeRecentServer(s.url); setRecentServers(loadRecentServers()) }}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <button className="cp-settings-btn" onClick={() => setSettingsOpen(true)}>
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
          </button>
          <div className="cp-user-badge">
            <AvatarImg src={profile.avatar || undefined} initial={profile.nickname[0]} size={28} />
            <span className="cp-user-name">{profile.nickname}</span>
          </div>
        </div>
      )}

      {/* ── CONNECTING ── */}
      {appState === 'connecting' && (
        <div className="cp-center">
          <div className="voice-icon pulse">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/>
            </svg>
          </div>
          <p className="voice-title">Подключение…</p>
        </div>
      )}

      {/* ── RECONNECTING ── */}
      {appState === 'reconnecting' && (
        <div className="cp-center">
          <div className="voice-icon pulse">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
            </svg>
          </div>
          <p className="voice-title">Переподключение…</p>
          <p className="voice-desc">Попытка {reconnectAttemptRef.current + 1} из {RECONNECT_DELAYS.length}{reconnectCountdown > 0 && ` · через ${reconnectCountdown} с`}</p>
          <button className="connect-btn" style={{ marginTop: 16 }} onClick={() => {
            cancelReconnect(); intentionalDisconnectRef.current = true
            setAppState('idle'); setServerUrl(''); lastConnectionRef.current = null
          }}>Отмена</button>
        </div>
      )}

      {/* ── ERROR ── */}
      {appState === 'error' && (
        <div className="cp-center">
          <div className="voice-icon" style={{ color: 'var(--red)' }}>
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          </div>
          <p className="voice-title" style={{ color: 'var(--red)' }}>Ошибка</p>
          <p className="voice-desc">{errorMsg}</p>
          <button className="connect-btn" onClick={() => setAppState('idle')}>← Назад</button>
        </div>
      )}

      {/* ── CONNECTED ── */}
      {appState === 'connected' && (
        <div className="cp-connected">
          <div className="cp-connected-body">
            {/* Left: participants */}
            <div className="cp-participants">
              <div className="cp-participants-label">В голосовом · {peers.length + 1}</div>

              {/* Self */}
              <div className={`cp-participant self${isSpeaking && !micMuted ? ' speaking' : ''}`}>
                <AvatarImg src={profile.avatar || undefined} initial={profile.nickname[0]} size={34} />
                <span className="cp-participant-name">{profile.nickname}</span>
                <div className="cp-participant-icons">
                  {micMuted
                    ? <svg className="vm-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>
                    : <span className={`vm-speaking${isSpeaking ? ' active' : ''}`} />
                  }
                </div>
              </div>

              {/* Peers */}
              {peers.map(peer => (
                <div
                  key={peer.id}
                  className={`cp-participant clickable${speakingPeers.has(peer.id) ? ' speaking' : ''}`}
                  onClick={(e) => setProfileCard({ peer, anchor: e.currentTarget.getBoundingClientRect() })}
                  onContextMenu={(e) => { e.preventDefault(); setPeerVolPopup({ peer, anchor: e.currentTarget.getBoundingClientRect() }) }}
                >
                  <AvatarImg src={peer.avatar} initial={peer.nickname[0] ?? '?'} size={34} />
                  <span className="cp-participant-name">{peer.nickname}</span>
                  <div className="cp-participant-icons">
                    <span className={`vm-speaking${speakingPeers.has(peer.id) ? ' active' : ''}`} />
                  </div>
                </div>
              ))}
            </div>

            {/* Center: voice active indicator */}
            <div className="cp-main">
              <div className="cp-voice-active">
                <div className="cp-voice-waves">
                  <div className="cp-wave" />
                  <div className="cp-wave" />
                  <div className="cp-wave" />
                </div>
                <p className="cp-voice-active-label">Голосовой чат активен</p>
                <p className="cp-voice-active-sub">
                  {peers.length === 0 ? 'Ожидание участников…' : `${peers.length + 1} участн. в канале`}
                </p>
              </div>
            </div>

            {/* Right: chat */}
            <div className="cp-chat">
              <div className="cp-chat-header">Чат</div>
              <div className="cp-chat-messages">
                {chatMessages.length === 0 && <div className="cp-chat-empty">Пока нет сообщений</div>}
                {chatMessages.map(msg => (
                  <div key={msg.id} className={`cp-chat-msg${msg.from === 'self' ? ' self' : ''}`}>
                    <AvatarImg src={msg.avatar} initial={msg.nickname[0] ?? '?'} size={24} />
                    <div className="cp-chat-msg-body">
                      <span className="cp-chat-msg-author">{msg.nickname}</span>
                      <span className="cp-chat-msg-text">{msg.text}</span>
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <div className="cp-chat-input-bar">
                <input
                  ref={chatInputRef}
                  className="cp-chat-input"
                  type="text" placeholder="Написать сообщение…"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSendChat() }}
                />
                <button className="cp-chat-send" onClick={handleSendChat} disabled={!chatInput.trim()}>
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                </button>
              </div>
            </div>
          </div>

          {/* Bottom bar */}
          <div className="cp-bottom-bar">
            <div className="cp-bar-user">
              <div className={`cp-bar-avatar-wrap${isSpeaking && !micMuted ? ' speaking' : ''}`}>
                <AvatarImg src={profile.avatar || undefined} initial={profile.nickname[0]} size={32} />
              </div>
              <div className="cp-bar-user-info">
                <span className="cp-bar-username">{profile.nickname}</span>
                <span className="cp-bar-status">
                  {deafened ? 'Заглушён' : micMuted ? 'Микрофон выкл.' : isSpeaking ? 'Говорит…' : 'В канале'}
                </span>
              </div>
            </div>

            <div className="cp-bar-controls">
              <button
                className={`cp-bar-btn${micMuted ? ' active-red' : ''}`}
                title={micMuted ? 'Включить микрофон' : 'Выключить микрофон'}
                onClick={toggleMic}
              >
                {micMuted ? <IconMicOff /> : <IconMic />}
                <span className="cp-bar-btn-label">{micMuted ? 'Вкл. mic' : 'Выкл. mic'}</span>
              </button>

              <button
                className={`cp-bar-btn${deafened ? ' active-red' : ''}`}
                title={deafened ? 'Включить звук' : 'Заглушить всех'}
                onClick={toggleDeafen}
              >
                {deafened ? <IconHeadphonesOff /> : <IconHeadphones />}
                <span className="cp-bar-btn-label">{deafened ? 'Вкл. звук' : 'Заглушить'}</span>
              </button>
            </div>

            <div className="cp-bar-right">
              {serverUrl && isOwner && (
                <button
                  className={`cp-copy-url-btn${copiedUrl ? ' copied' : ''}`}
                  title="Скопировать адрес"
                  onClick={copyServerUrl}
                >
                  {copiedUrl
                    ? <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                    : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                  }
                  <span className="cp-copy-url-label">{copiedUrl ? 'Скопировано!' : serverUrl.replace('ws://', '')}</span>
                </button>
              )}
              {serverUrl && !isOwner && (
                <span className="cp-server-info" title={serverUrl}>{serverUrl.replace('ws://', '')}</span>
              )}

              <button className="cp-bar-icon-btn" title="Настройки" onClick={() => setSettingsOpen(true)}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
              </button>

              <button className="cp-bar-leave-btn" title="Отключиться" onClick={handleDisconnect}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
