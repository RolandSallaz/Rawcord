import { useState, useEffect, useRef, useCallback } from 'react'
import { SteamSignalingClient } from '../lib/steamSignaling'
import { SignalingClient, type PeerInfo } from '../lib/signaling'
import { PeerManager } from '../lib/webrtc'
import { loadSettings, saveSettings, type AudioSettings } from '../lib/settings'
import { loadProfile, saveProfile, type UserProfile } from '../lib/profile'
import SettingsModal from './SettingsModal'
import ScreenShareModal from './ScreenShareModal'
import ProfileCard from './ProfileCard'
import StreamViewer from './StreamViewer'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ipcRenderer } = (window as any).require('electron')

type AppState = 'idle' | 'browsing' | 'connecting' | 'connected' | 'error'
type ConnectionMode = 'steam' | 'server'

interface ISignalingClient {
  on(event: string, handler: (...args: unknown[]) => void): void
  connect(): Promise<void>
  join(channel: string, nickname: string, avatar?: string): void
  relay(to: string, payload: object): void
  sendChat(text: string): void
  updateProfile(nickname: string, avatar?: string): void
  disconnect(): void
}

interface ChatMessage {
  id: string
  from: string
  text: string
  nickname: string
  avatar?: string
  timestamp: number
}

interface LobbyEntry {
  lobbyId: string
  owner: string
  members: number
  maxMembers: number
}

function AvatarImg({ src, initial, size = 32 }: { src?: string; initial: string; size?: number }) {
  if (src) return <img src={src} alt="av" className="avatar-img" style={{ width: size, height: size }} />
  return (
    <div className="avatar-initials" style={{ width: size, height: size, fontSize: size * 0.44 }}>
      {initial.toUpperCase()}
    </div>
  )
}

export default function ChannelPage() {
  const [profile, setProfile] = useState<UserProfile>(() => loadProfile()!)
  const [settings, setSettings] = useState<AudioSettings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [screenShareOpen, setScreenShareOpen] = useState(false)

  const [appState, setAppState] = useState<AppState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [mode, setMode] = useState<ConnectionMode>('steam')
  const [isOwner, setIsOwner] = useState(false)
  const [currentLobbyId, setCurrentLobbyId] = useState<string | null>(null)

  const [lobbies, setLobbies] = useState<LobbyEntry[]>([])
  const [loadingLobbies, setLoadingLobbies] = useState(false)

  const [serverUrl, setServerUrl] = useState('')
  const [serverInput, setServerInput] = useState('')
  const [serverPort, setServerPort] = useState('3001')

  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [micMuted, setMicMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [isSharing, setIsSharing] = useState(false)
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null)
  const [remoteSharingPeers, setRemoteSharingPeers] = useState<Set<string>>(new Set())
  const [remoteVideoStreams, setRemoteVideoStreams] = useState<Map<string, MediaStream>>(new Map())
  const [watchingPeerId, setWatchingPeerId] = useState<string | null>(null)
  const [profileCard, setProfileCard] = useState<{ peer: PeerInfo; anchor: DOMRect } | null>(null)
  const [speakingPeers, setSpeakingPeers] = useState<Set<string>>(new Set())
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLInputElement>(null)

  const signalingRef = useRef<SteamSignalingClient | null>(null)
  const peerManagerRef = useRef<PeerManager | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const prevMicMutedRef = useRef(false)
  const localVadRef = useRef<{ ctx: AudioContext; interval: ReturnType<typeof setInterval> } | null>(null)

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chatMessages])

  useEffect(() => { return () => { cleanup() } }, [])

  useEffect(() => {
    if (watchingPeerId && !remoteVideoStreams.has(watchingPeerId)) {
      setWatchingPeerId(null)
    }
  }, [remoteVideoStreams, watchingPeerId])

  useEffect(() => {
    if (settings.voiceMode !== 'ptt' || appState !== 'connected') return
    peerManagerRef.current?.setMicMuted(true)

    if (settings.pttKey.startsWith('Mouse')) {
      const btn = parseInt(settings.pttKey.replace('Mouse', ''))
      const onDown = (e: MouseEvent) => { if (e.button === btn) peerManagerRef.current?.setMicMuted(false) }
      const onUp   = (e: MouseEvent) => { if (e.button === btn) peerManagerRef.current?.setMicMuted(true) }
      window.addEventListener('mousedown', onDown)
      window.addEventListener('mouseup', onUp)
      return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('mouseup', onUp) }
    } else {
      const onDown = (e: KeyboardEvent) => { if (e.code === settings.pttKey && !e.repeat) peerManagerRef.current?.setMicMuted(false) }
      const onUp   = (e: KeyboardEvent) => { if (e.code === settings.pttKey) peerManagerRef.current?.setMicMuted(true) }
      window.addEventListener('keydown', onDown)
      window.addEventListener('keyup', onUp)
      return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
    }
  }, [settings.voiceMode, settings.pttKey, appState])

  // Steam Rich Presence join (friend clicks "Join Game")
  useEffect(() => {
    const handler = (_e: unknown, lobbyId: string) => {
      handleJoinLobby(lobbyId)
    }
    ipcRenderer.on('steam:join-requested', handler)
    return () => ipcRenderer.removeListener('steam:join-requested', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function cleanup() {
    if (localVadRef.current) {
      clearInterval(localVadRef.current.interval)
      localVadRef.current.ctx.close()
      localVadRef.current = null
    }
    setIsSpeaking(false)
    setSpeakingPeers(new Set())
    peerManagerRef.current?.destroy()
    peerManagerRef.current = null
    signalingRef.current?.disconnect()
    signalingRef.current = null
  }

  async function fetchLobbies() {
    setLoadingLobbies(true)
    try {
      const list: LobbyEntry[] = await ipcRenderer.invoke('steam:getLobbies')
      setLobbies(list)
    } catch {
      setLobbies([])
    } finally {
      setLoadingLobbies(false)
    }
  }

  async function handleCreateLobby() {
    setAppState('connecting')
    setErrorMsg('')
    try {
      const lobbyId: string = await ipcRenderer.invoke('steam:createLobby')
      setCurrentLobbyId(lobbyId)
      setIsOwner(true)
      await connectToChannel(lobbyId, true, (_id) => new SteamSignalingClient(lobbyId, true))
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Не удалось создать лобби')
      setAppState('error')
    }
  }

  const handleJoinLobby = useCallback(async (lobbyId: string) => {
    setAppState('connecting')
    setErrorMsg('')
    setCurrentLobbyId(lobbyId)
    setIsOwner(false)
    await connectToChannel(lobbyId, false, (_id) => new SteamSignalingClient(lobbyId, false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, profile])

  const connectToChannel = useCallback(async (lobbyId: string | null, owner: boolean, factory: (lobbyId: string | null) => ISignalingClient) => {
    let stream: MediaStream
    try {
      const audioConstraints: MediaTrackConstraints = {
        deviceId: settings.inputDeviceId ? { exact: settings.inputDeviceId } : undefined,
        noiseSuppression: settings.noiseSuppression,
        echoCancellation: true,
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false })
    } catch {
      setErrorMsg('Нет доступа к микрофону')
      setAppState('error')
      if (mode === 'steam' && !owner) ipcRenderer.invoke('steam:leaveLobby', false).catch(() => {})
      return
    }

    // Local VAD
    try {
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      const mute = ctx.createGain(); mute.gain.value = 0
      src.connect(analyser); src.connect(mute); mute.connect(ctx.destination)
      const buf = new Float32Array(512)
      const interval = setInterval(() => {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0; for (const v of buf) sum += v * v
        setIsSpeaking(Math.sqrt(sum / buf.length) > 0.01)
      }, 80)
      localVadRef.current = { ctx, interval }
    } catch { /* optional */ }

    const signaling = factory(lobbyId)
    const peerManager = new PeerManager(signaling)
    peerManager.setStream(stream)
    peerManager.setOutputDevice(settings.outputDeviceId)

    const peerInfo = new Map<string, PeerInfo>()

    peerManager.onPeersChanged = () => {
      setPeers(prev =>
        peerManager.getPeerIds().map(id => {
          const info = peerInfo.get(id)
          return {
            id,
            nickname: info?.nickname ?? (prev.find(p => p.id === id)?.nickname ?? id.slice(0, 8)),
            avatar: info?.avatar,
          }
        })
      )
    }
    peerManager.onSharingChanged = (set) => setRemoteSharingPeers(new Set(set))
    peerManager.onSpeakingChanged = (set) => setSpeakingPeers(new Set(set))
    peerManager.onRemoteVideo = (peerId, track, streams) => {
      const videoStream = streams[0] ?? new MediaStream([track])
      setRemoteVideoStreams(prev => new Map(prev).set(peerId, videoStream))
      track.onended = () => setRemoteVideoStreams(prev => { const m = new Map(prev); m.delete(peerId); return m })
    }

    signaling.on('onPeers', (existingPeers: PeerInfo[]) => {
      for (const p of existingPeers) {
        peerInfo.set(p.id, p)
        peerManager.createPeer(p.id, p.nickname, false)
      }
      setPeers(existingPeers.map(p => ({ ...p })))
    })
    signaling.on('onPeerJoined', (peer: PeerInfo) => {
      peerInfo.set(peer.id, peer)
      peerManager.createPeer(peer.id, peer.nickname, true)
      setPeers(prev => prev.some(p => p.id === peer.id) ? prev : [...prev, peer])
    })
    signaling.on('onPeerUpdated', (peer: PeerInfo) => {
      peerInfo.set(peer.id, peer)
      peerManager.updatePeerNickname(peer.id, peer.nickname)
      setPeers(prev => prev.map(p => p.id === peer.id ? { ...p, ...peer } : p))
    })
    signaling.on('onPeerLeft', (id: string) => {
      peerInfo.delete(id)
      peerManager.removePeer(id)
      setPeers(prev => prev.filter(p => p.id !== id))
    })
    signaling.on('onRelay', (from: string, payload: object) => {
      if (!peerManager.getPeerIds().includes(from)) {
        const info = peerInfo.get(from)
        peerManager.createPeer(from, info?.nickname ?? from.slice(0, 8), false)
      }
      peerManager.signal(from, payload as object)
    })
    signaling.on('onChat', (from: string, text: string, nickname: string, avatar?: string) => {
      setChatMessages(prev => [...prev, {
        id: `${from}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        from,
        text,
        nickname,
        avatar,
        timestamp: Date.now(),
      }])
    })
    signaling.on('onClose', () => {
      cleanup()
      setAppState('idle')
      setPeers([])
      setCurrentLobbyId(null)
      setChatMessages([])
      setServerUrl('')
    })

    try {
      await signaling.connect()
    } catch {
      stream.getTracks().forEach(t => t.stop())
      cleanup()
      const errMsg = mode === 'steam' ? 'Не удалось подключиться к лобби Steam' : 'Не удалось подключиться к серверу'
      setErrorMsg(errMsg)
      setAppState('error')
      return
    }

    signalingRef.current = signaling
    peerManagerRef.current = peerManager
    signaling.join('', profile.nickname, profile.avatar || undefined)
    setAppState('connected')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, profile, mode])

  function handleDisconnect() {
    if (isSharing) {
      peerManagerRef.current?.stopScreenShare()
      localScreenStream?.getTracks().forEach(t => t.stop())
      setLocalScreenStream(null)
      setIsSharing(false)
      ipcRenderer.invoke('screen:hideBorder').catch(() => {})
    }
    setRemoteVideoStreams(new Map())
    setRemoteSharingPeers(new Set())
    setWatchingPeerId(null)
    setProfileCard(null)
    cleanup()
    setPeers([])
    setMicMuted(false)
    setDeafened(false)
    prevMicMutedRef.current = false
    setCurrentLobbyId(null)
    setIsOwner(false)
    setServerUrl('')
    if (mode === 'server' && isOwner) ipcRenderer.invoke('server:stop').catch(() => {})
    setAppState('idle')
  }

  function toggleMic() {
    const next = !micMuted
    setMicMuted(next)
    if (deafened && !next) { setDeafened(false); peerManagerRef.current?.setDeafened(false) }
    peerManagerRef.current?.setMicMuted(next)
  }

  function toggleDeafen() {
    const next = !deafened
    setDeafened(next)
    if (next) {
      prevMicMutedRef.current = micMuted
      setMicMuted(true); peerManagerRef.current?.setMicMuted(true)
    } else {
      setMicMuted(prevMicMutedRef.current)
      peerManagerRef.current?.setMicMuted(prevMicMutedRef.current)
    }
    peerManagerRef.current?.setDeafened(next)
  }

  async function handleStartServer() {
    setAppState('connecting')
    setErrorMsg('')
    setServerUrl('')
    const port = parseInt(serverPort, 10)
    if (isNaN(port) || port < 1024 || port > 65535) {
      setErrorMsg('Укажите порт от 1024 до 65535')
      setAppState('error')
      return
    }
    try {
      const result: { port: number; ip: string } = await ipcRenderer.invoke('server:start', port)
      const url = `ws://127.0.0.1:${result.port}`
      setServerUrl(`ws://${result.ip}:${result.port}`)
      setIsOwner(true)
      await connectToChannel(null, true, () => new SignalingClient(url))
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('EADDRINUSE') || msg.includes('already in use') || msg.includes('listen')) {
        setErrorMsg(`Порт ${serverPort} уже занят. Укажите другой порт.`)
      } else {
        setErrorMsg(msg || 'Не удалось запустить сервер')
      }
      setAppState('error')
    }
  }

  function handleConnectToServer() {
    let input = serverInput.trim()
    if (!input) return
    if (!input.startsWith('ws://') && !input.startsWith('wss://')) {
      input = `ws://${input}`
    }
    setAppState('connecting')
    setErrorMsg('')
    setServerUrl(input)
    setIsOwner(false)
    connectToChannel(null, false, () => new SignalingClient(input))
  }

  async function handleStartScreenShare(stream: MediaStream, sourceId: string) {
    setScreenShareOpen(false)
    try {
      await peerManagerRef.current?.startScreenShare(stream)
      setLocalScreenStream(stream)
      setIsSharing(true)
      setTimeout(() => { if (localVideoRef.current) localVideoRef.current.srcObject = stream }, 0)
      ipcRenderer.invoke('screen:showBorder', sourceId).catch(() => {})
    } catch { stream.getTracks().forEach(t => t.stop()) }
  }

  function handleSendChat() {
    const text = chatInput.trim()
    if (!text) return
    signalingRef.current?.sendChat(text)
    setChatMessages(prev => [...prev, {
      id: `self-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from: 'self',
      text,
      nickname: profile.nickname,
      avatar: profile.avatar || undefined,
      timestamp: Date.now(),
    }])
    setChatInput('')
  }

  function handleStopScreenShare() {
    peerManagerRef.current?.stopScreenShare()
    localScreenStream?.getTracks().forEach(t => t.stop())
    setLocalScreenStream(null)
    setIsSharing(false)
    if (localVideoRef.current) localVideoRef.current.srcObject = null
    ipcRenderer.invoke('screen:hideBorder').catch(() => {})
  }

  // ─── RENDER ────────────────────────────────────────────────

  const watchedPeer = peers.find(p => p.id === watchingPeerId)

  return (
    <div className="cp-root">
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          profile={profile}
          onChange={s => { setSettings(s); saveSettings(s); peerManagerRef.current?.setOutputDevice(s.outputDeviceId) }}
          onProfileChange={p => { saveProfile(p); setProfile(p); signalingRef.current?.updateProfile(p.nickname, p.avatar || undefined) }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {screenShareOpen && (
        <ScreenShareModal onStart={handleStartScreenShare} onClose={() => setScreenShareOpen(false)} />
      )}
      {profileCard && (
        <ProfileCard
          peer={profileCard.peer}
          stream={remoteVideoStreams.get(profileCard.peer.id)}
          anchor={profileCard.anchor}
          onWatch={() => { setWatchingPeerId(profileCard.peer.id); setProfileCard(null) }}
          onClose={() => setProfileCard(null)}
        />
      )}

      {/* Full-screen stream viewer overlay */}
      {appState === 'connected' && watchingPeerId && watchedPeer && remoteVideoStreams.get(watchingPeerId) && (
        <StreamViewer
          stream={remoteVideoStreams.get(watchingPeerId)!}
          streamer={{ name: watchedPeer.nickname, avatar: watchedPeer.avatar }}
          micMuted={micMuted}
          deafened={deafened}
          onToggleMic={toggleMic}
          onToggleDeafen={toggleDeafen}
          onExit={() => setWatchingPeerId(null)}
        />
      )}

      {/* ── IDLE ── */}
      {appState === 'idle' && (
        <div className="cp-home">
          <div className="cp-home-inner">
            <div className="cp-home-logo">R</div>
            <h1 className="cp-home-title">Rawcord</h1>
            <p className="cp-home-sub">P2P голосовой чат</p>

            {/* Mode toggle */}
            <div className="cp-mode-toggle">
              <button
                className={`cp-mode-btn${mode === 'steam' ? ' active' : ''}`}
                onClick={() => setMode('steam')}
              >Через Steam</button>
              <button
                className={`cp-mode-btn${mode === 'server' ? ' active' : ''}`}
                onClick={() => setMode('server')}
              >Выделенный сервер</button>
            </div>

            {mode === 'steam' ? (
              <div className="cp-home-actions">
                <button className="cp-action-card" onClick={handleCreateLobby}>
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                  </svg>
                  <span className="cp-action-label">Создать лобби</span>
                  <span className="cp-action-desc">Друзья подключатся к тебе</span>
                </button>
                <button className="cp-action-card" onClick={() => { setAppState('browsing'); fetchLobbies() }}>
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                  </svg>
                  <span className="cp-action-label">Найти лобби</span>
                  <span className="cp-action-desc">Войти к другу</span>
                </button>
              </div>
            ) : (
              <div className="cp-home-actions">
                <div className="cp-action-card create-server-card">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3l-1 1v2h12v-2l-1-1h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/>
                  </svg>
                  <span className="cp-action-label">Создать сервер</span>
                  <span className="cp-action-desc">Запустить сервер и ждать подключений</span>
                  <div className="connect-input-row">
                    <span className="port-label">Порт:</span>
                    <input
                      className="server-url-input port-input"
                      type="number"
                      min="1024"
                      max="65535"
                      placeholder="3001"
                      value={serverPort}
                      onChange={e => setServerPort(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleStartServer() }}
                    />
                    <button className="connect-submit-btn" onClick={handleStartServer}>Создать</button>
                  </div>
                </div>
                <div className="cp-action-card connect-card">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                  </svg>
                  <span className="cp-action-label">Подключиться</span>
                  <span className="cp-action-desc">Ввести IP:Порт сервера</span>
                  <div className="connect-input-row">
                    <input
                      className="server-url-input"
                      type="text"
                      placeholder="192.168.1.100:3001"
                      value={serverInput}
                      onChange={e => setServerInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleConnectToServer() }}
                    />
                    <button
                      className="connect-submit-btn"
                      disabled={!serverInput.trim()}
                      onClick={handleConnectToServer}
                    >Подкл.</button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <button className="cp-settings-btn" onClick={() => setSettingsOpen(true)}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
          </button>
          <div className="cp-user-badge">
            <AvatarImg src={profile.avatar || undefined} initial={profile.nickname[0]} size={28} />
            <span className="cp-user-name">{profile.nickname}</span>
          </div>
        </div>
      )}

      {/* ── BROWSING ── */}
      {appState === 'browsing' && (
        <div className="cp-browse">
          <div className="cp-browse-header">
            <button className="lobby-back-btn" onClick={() => setAppState('idle')}>← Назад</button>
            <span className="cp-browse-title">Активные лобби</span>
            <button className="lobby-refresh-btn" onClick={fetchLobbies} disabled={loadingLobbies}>
              <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 16, height: 16 }}>
                <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
              </svg>
            </button>
          </div>
          <div className="cp-browse-body">
            {loadingLobbies && <p className="settings-hint">Поиск лобби…</p>}
            {!loadingLobbies && lobbies.length === 0 && (
              <p className="settings-hint">Активных лобби не найдено. Попроси друга создать лобби.</p>
            )}
            {!loadingLobbies && lobbies.map(entry => (
              <div key={entry.lobbyId} className="lobby-entry">
                <div className="lobby-entry-info">
                  <span className="lobby-entry-owner">{entry.owner}</span>
                  <span className="lobby-entry-count">{entry.members} / {entry.maxMembers}</span>
                </div>
                <button
                  className="connect-btn"
                  style={{ marginTop: 0, padding: '6px 20px', fontSize: 13 }}
                  onClick={() => handleJoinLobby(entry.lobbyId)}
                >
                  Войти
                </button>
              </div>
            ))}
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

      {/* ── ERROR ── */}
      {appState === 'error' && (
        <div className="cp-center">
          <div className="voice-icon" style={{ color: 'var(--red)' }}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
            </svg>
          </div>
          <p className="voice-title" style={{ color: 'var(--red)' }}>Ошибка</p>
          <p className="voice-desc">{errorMsg}</p>
          <button className="connect-btn" onClick={() => setAppState('idle')}>← Назад</button>
        </div>
      )}

      {/* ── CONNECTED ── */}
      {appState === 'connected' && !watchingPeerId && (
        <div className="cp-connected">
          {/* Participants */}
          <div className="cp-participants">
            <div className="cp-participants-label">В ГОЛОСОВОМ</div>

            {/* Self */}
            <div className={`cp-participant self${isSpeaking && !micMuted ? ' speaking' : ''}`}>
              <AvatarImg src={profile.avatar || undefined} initial={profile.nickname[0]} size={36} />
              <span className="cp-participant-name">{profile.nickname}</span>
              <div className="cp-participant-icons">
                {isSharing && (
                  <svg className="vm-sharing-icon" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3l-1 1v2h12v-2l-1-1h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/>
                  </svg>
                )}
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
              >
                <AvatarImg src={peer.avatar} initial={peer.nickname[0] ?? '?'} size={36} />
                <span className="cp-participant-name">{peer.nickname}</span>
                <div className="cp-participant-icons">
                  {remoteSharingPeers.has(peer.id)
                    ? <svg className="vm-sharing-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3l-1 1v2h12v-2l-1-1h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/></svg>
                    : <span className={`vm-speaking${speakingPeers.has(peer.id) ? ' active' : ''}`} />
                  }
                </div>
              </div>
            ))}
          </div>

          {/* Center: screen share previews + controls */}
          <div className="cp-main">
            {(isSharing || remoteVideoStreams.size > 0) && (
              <div className="cp-previews">
                {isSharing && (
                  <div className="ss-preview-wrap">
                    <video ref={localVideoRef} className="ss-preview-video" autoPlay muted playsInline />
                    <div className="ss-preview-label">Вы транслируете экран</div>
                  </div>
                )}
                {[...remoteVideoStreams.entries()].map(([peerId, stream]) => (
                  <div key={peerId} className="ss-preview-wrap">
                    <video
                      className="ss-preview-video" autoPlay playsInline
                      ref={(el) => { if (el && el.srcObject !== stream) el.srcObject = stream }}
                    />
                    <div className="ss-preview-label">
                      {peers.find(p => p.id === peerId)?.nickname ?? peerId.slice(0, 8)} транслирует
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Controls */}
            <div className="cp-controls">
              <button
                className={`uc-btn${micMuted ? ' active' : ''}`}
                title={micMuted ? 'Включить микрофон' : 'Выключить микрофон'}
                onClick={toggleMic}
              >
                {micMuted
                  ? <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>
                  : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
                }
              </button>

              <button
                className={`uc-btn${deafened ? ' active' : ''}`}
                title={deafened ? 'Включить звук' : 'Выключить звук'}
                onClick={toggleDeafen}
              >
                {deafened
                  ? <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                  : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                }
              </button>

              {!isSharing
                ? <button className="uc-btn" title="Трансляция экрана" onClick={() => setScreenShareOpen(true)}>
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3l-1 1v2h12v-2l-1-1h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/></svg>
                  </button>
                : <button className="uc-btn active" title="Остановить трансляцию" onClick={handleStopScreenShare}>
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3l-1 1v2h12v-2l-1-1h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/></svg>
                  </button>
              }

              {isOwner && (
                <button className="uc-btn" title="Пригласить друзей" onClick={() => ipcRenderer.invoke('steam:inviteFriends')}>
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
                </button>
              )}

              <button className="uc-btn settings-btn" title="Настройки" onClick={() => setSettingsOpen(true)}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
              </button>

              {serverUrl && (
                <span className="cp-server-info" title="Адрес сервера">{serverUrl}</span>
              )}
              <button className="disconnect-btn" onClick={handleDisconnect}>
                Отключиться
              </button>
            </div>
          </div>

          {/* Chat sidebar */}
          <div className="cp-chat">
            <div className="cp-chat-header">Текстовый чат</div>
            <div className="cp-chat-messages">
              {chatMessages.length === 0 && (
                <div className="cp-chat-empty">Пока нет сообщений</div>
              )}
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
                type="text"
                placeholder="Написать сообщение…"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSendChat() }}
              />
              <button className="cp-chat-send" onClick={handleSendChat} disabled={!chatInput.trim()}>
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}