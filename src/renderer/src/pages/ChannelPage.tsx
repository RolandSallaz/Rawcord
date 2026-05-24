import { useState, useEffect, useRef, useCallback } from 'react'
import { SignalingClient, type PeerInfo } from '../lib/signaling'
import { PeerManager } from '../lib/webrtc'
import { loadSettings, saveSettings, type AudioSettings } from '../lib/settings'
import { loadProfile, saveProfile, type UserProfile } from '../lib/profile'
import { loadServers, saveServers, type SavedServer } from '../lib/servers'
import SettingsModal from './SettingsModal'
import AddServerModal from './AddServerModal'
import ScreenShareModal from './ScreenShareModal'
import ProfileCard from './ProfileCard'
import StreamViewer from './StreamViewer'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ipcRenderer } = (window as any).require('electron')

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error'

const CHANNELS = [
  { id: 'general', name: 'основной' },
  { id: 'gaming', name: 'игровой' },
]
type Channel = typeof CHANNELS[0]

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
  const [servers, setServers] = useState<SavedServer[]>(() => loadServers())
  const [selectedServerId, setSelectedServerId] = useState<string | null>(
    () => loadServers()[0]?.id ?? null
  )
  const [addServerOpen, setAddServerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const [activeChannel, setActiveChannel] = useState<Channel>(CHANNELS[0])
  const [connState, setConnState] = useState<ConnectionState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [micMuted, setMicMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [settings, setSettings] = useState<AudioSettings>(() => loadSettings())
  const [screenShareOpen, setScreenShareOpen] = useState(false)
  const [isSharing, setIsSharing] = useState(false)
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null)
  const [remoteSharingPeers, setRemoteSharingPeers] = useState<Set<string>>(new Set())
  const [remoteVideoStreams, setRemoteVideoStreams] = useState<Map<string, MediaStream>>(new Map())
  const [watchingPeerId, setWatchingPeerId] = useState<string | null>(null)
  const [profileCard, setProfileCard] = useState<{ peer: PeerInfo; anchor: DOMRect } | null>(null)

  const signalingRef = useRef<SignalingClient | null>(null)
  const peerManagerRef = useRef<PeerManager | null>(null)
  const hostedServerIdRef = useRef<string | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => { return () => { cleanup() } }, [])

  // Auto-exit StreamViewer when the watched peer stops sharing
  useEffect(() => {
    if (watchingPeerId && !remoteVideoStreams.has(watchingPeerId)) {
      setWatchingPeerId(null)
    }
  }, [remoteVideoStreams, watchingPeerId])

  // PTT key/mouse handlers
  useEffect(() => {
    if (settings.voiceMode !== 'ptt' || connState !== 'connected') return
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
  }, [settings.voiceMode, settings.pttKey, connState])

  function cleanup() {
    peerManagerRef.current?.destroy()
    peerManagerRef.current = null
    signalingRef.current?.disconnect()
    signalingRef.current = null
  }

  const handleConnect = useCallback(async (channel: Channel) => {
    const server = servers.find(s => s.id === selectedServerId)
    if (!server) return

    setConnState('connecting')
    setErrorMsg('')

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
      setConnState('error')
      return
    }

    const signaling = new SignalingClient(server.url)
    const peerManager = new PeerManager(signaling)
    peerManager.setStream(stream)
    peerManager.setOutputDevice(settings.outputDeviceId)

    const peerAvatars = new Map<string, string>()

    peerManager.onPeersChanged = () => {
      setPeers(
        peerManager.getPeerIds().map(id => ({
          id,
          nickname: peerAvatars.get(id) !== undefined
            ? (peers.find(p => p.id === id)?.nickname ?? id.slice(0, 8))
            : id.slice(0, 8),
          avatar: peerAvatars.get(id),
        }))
      )
    }

    peerManager.onSharingChanged = (set) => setRemoteSharingPeers(new Set(set))

    peerManager.onRemoteVideo = (peerId, track, streams) => {
      const videoStream = streams[0] ?? new MediaStream([track])
      setRemoteVideoStreams(prev => new Map(prev).set(peerId, videoStream))
      track.onended = () => setRemoteVideoStreams(prev => {
        const m = new Map(prev); m.delete(peerId); return m
      })
    }

    signaling.on('onPeers', (existingPeers) => {
      for (const p of existingPeers) {
        if (p.avatar) peerAvatars.set(p.id, p.avatar)
        peerManager.createPeer(p.id, p.nickname, true)
      }
      setPeers(existingPeers.map(p => ({ ...p })))
    })

    signaling.on('onPeerJoined', (peer) => {
      if (peer.avatar) peerAvatars.set(peer.id, peer.avatar)
      peerManager.createPeer(peer.id, peer.nickname, true)
      setPeers(prev => [...prev, peer])
    })

    signaling.on('onPeerLeft', (id) => {
      peerAvatars.delete(id)
      peerManager.removePeer(id)
      setPeers(prev => prev.filter(p => p.id !== id))
    })

    signaling.on('onRelay', (from, payload) => {
      if (!peerManager.getPeerIds().includes(from)) {
        const nick = peers.find(p => p.id === from)?.nickname ?? from.slice(0, 8)
        peerManager.createPeer(from, nick, false)
      }
      peerManager.signal(from, payload as object)
    })

    signaling.on('onClose', () => {
      cleanup()
      setConnState('idle')
      setPeers([])
    })

    if (server.isHost) {
      try { await ipcRenderer.invoke('server:start') } catch { /* already running */ }
    }

    try {
      await signaling.connect()
    } catch {
      stream.getTracks().forEach(t => t.stop())
      setErrorMsg('Не удалось подключиться к серверу')
      setConnState('error')
      return
    }

    signalingRef.current = signaling
    peerManagerRef.current = peerManager

    signaling.join(channel.id, profile.nickname, profile.avatar || undefined)
    setConnState('connected')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServerId, servers, profile, settings])

  function handleDisconnect() {
    if (isSharing) {
      peerManagerRef.current?.stopScreenShare()
      localScreenStream?.getTracks().forEach(t => t.stop())
      setLocalScreenStream(null)
      setIsSharing(false)
    }
    setRemoteVideoStreams(new Map())
    setRemoteSharingPeers(new Set())
    setWatchingPeerId(null)
    setProfileCard(null)
    cleanup()
    setPeers([])
    setConnState('idle')
    setMicMuted(false)
    setDeafened(false)
  }

  function handleChannelClick(ch: Channel) {
    if (connState === 'connected' && activeChannel.id === ch.id) return
    if (connState === 'connected' || connState === 'connecting') handleDisconnect()
    setActiveChannel(ch)
    handleConnect(ch)
  }

  function handleSelectServer(id: string) {
    if (id === selectedServerId) return
    if (connState === 'connected' || connState === 'connecting') handleDisconnect()
    setSelectedServerId(id)
  }

  function handleAddServer(srv: SavedServer) {
    const updated = [...servers, srv]
    setServers(updated)
    saveServers(updated)
    setSelectedServerId(srv.id)
    setAddServerOpen(false)
  }

  function handleRemoveServer(id: string) {
    if (selectedServerId === id && (connState === 'connected' || connState === 'connecting')) {
      handleDisconnect()
    }
    const updated = servers.filter(s => s.id !== id)
    setServers(updated)
    saveServers(updated)
    if (selectedServerId === id) {
      setSelectedServerId(updated[0]?.id ?? null)
    }
    const srv = servers.find(s => s.id === id)
    if (srv?.isHost && hostedServerIdRef.current === id) {
      ipcRenderer.invoke('server:stop')
      hostedServerIdRef.current = null
    }
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
    if (next) { setMicMuted(true); peerManagerRef.current?.setMicMuted(true) }
    peerManagerRef.current?.setDeafened(next)
  }

  async function handleStartScreenShare(stream: MediaStream) {
    setScreenShareOpen(false)
    try {
      await peerManagerRef.current?.startScreenShare(stream)
      setLocalScreenStream(stream)
      setIsSharing(true)
      setTimeout(() => { if (localVideoRef.current) localVideoRef.current.srcObject = stream }, 0)
    } catch {
      stream.getTracks().forEach(t => t.stop())
    }
  }

  function handleStopScreenShare() {
    peerManagerRef.current?.stopScreenShare()
    localScreenStream?.getTracks().forEach(t => t.stop())
    setLocalScreenStream(null)
    setIsSharing(false)
    if (localVideoRef.current) localVideoRef.current.srcObject = null
  }

  function handleSettingsChange(s: AudioSettings) {
    setSettings(s)
    saveSettings(s)
    peerManagerRef.current?.setOutputDevice(s.outputDeviceId)
  }

  function handleProfileChange(p: UserProfile) {
    setProfile(p)
    saveProfile(p)
  }

  const selectedServer = servers.find(s => s.id === selectedServerId) ?? null

  return (
    <div className="layout">
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          profile={profile}
          onChange={handleSettingsChange}
          onProfileChange={handleProfileChange}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {addServerOpen && (
        <AddServerModal onAdd={handleAddServer} onClose={() => setAddServerOpen(false)} />
      )}
      {screenShareOpen && (
        <ScreenShareModal onStart={handleStartScreenShare} onClose={() => setScreenShareOpen(false)} />
      )}
      {profileCard && (
        <ProfileCard
          peer={profileCard.peer}
          stream={remoteVideoStreams.get(profileCard.peer.id)}
          anchor={profileCard.anchor}
          onWatch={() => setWatchingPeerId(profileCard.peer.id)}
          onClose={() => setProfileCard(null)}
        />
      )}

      {/* server rail */}
      <div className="server-rail">
        {servers.map(srv => (
          <div
            key={srv.id}
            className={`server-btn-wrap${selectedServerId === srv.id ? ' selected' : ''}`}
          >
            <button
              className="server-btn"
              title={srv.name}
              onClick={() => handleSelectServer(srv.id)}
            >
              {srv.name.slice(0, 2).toUpperCase()}
            </button>
            <button
              className="server-remove"
              title="Удалить сервер"
              onClick={e => { e.stopPropagation(); handleRemoveServer(srv.id) }}
            >×</button>
          </div>
        ))}
        {servers.length > 0 && <div className="server-divider" />}
        <button className="server-btn add-btn" title="Добавить сервер" onClick={() => setAddServerOpen(true)}>+</button>
      </div>

      {/* channel sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          {selectedServer ? selectedServer.name : 'Rawcord'}
        </div>

        <div className="channel-section">
          {selectedServer ? (
            <>
              <div className="section-label">ГОЛОСОВЫЕ КАНАЛЫ</div>
              {CHANNELS.map(ch => (
                <div key={ch.id}>
                  <button
                    className={`channel-item ${activeChannel.id === ch.id && connState !== 'idle' ? 'active' : ''}`}
                    onClick={() => handleChannelClick(ch)}
                  >
                    <svg className="ch-icon" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
                    </svg>
                    <span className="ch-name">{ch.name}</span>
                    {connState === 'connected' && activeChannel.id === ch.id && (
                      <span className="live-dot" />
                    )}
                  </button>

                  {connState === 'connected' && activeChannel.id === ch.id && (
                    <div className="voice-members">
                      <div className="voice-member self">
                        <AvatarImg src={profile.avatar || undefined} initial={profile.nickname[0]} size={24} />
                        <span className="vm-name">{profile.nickname}</span>
                        {micMuted
                          ? <svg className="vm-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>
                          : <span className="vm-speaking" />
                        }
                        {isSharing && (
                          <svg className="vm-sharing-icon" viewBox="0 0 24 24" fill="currentColor" >
                            <path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3l-1 1v2h12v-2l-1-1h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/>
                          </svg>
                        )}
                      </div>
                      {peers.map(peer => (
                        <div
                          key={peer.id}
                          className="voice-member clickable"
                          onClick={(e) => setProfileCard({ peer, anchor: e.currentTarget.getBoundingClientRect() })}
                        >
                          <AvatarImg src={peer.avatar} initial={peer.nickname[0] ?? '?'} size={24} />
                          <span className="vm-name">{peer.nickname}</span>
                          {remoteSharingPeers.has(peer.id) && (
                            <span className="vm-live-badge">LIVE</span>
                          )}
                          {remoteSharingPeers.has(peer.id)
                            ? <svg className="vm-sharing-icon" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3l-1 1v2h12v-2l-1-1h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/>
                              </svg>
                            : <span className="vm-speaking" />
                          }
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </>
          ) : (
            <div className="no-server-hint">
              <p>Нажми «+» чтобы добавить сервер</p>
            </div>
          )}
        </div>

        <div className="user-panel">
          <AvatarImg src={profile.avatar || undefined} initial={profile.nickname[0]} size={32} />
          <div className="user-info">
            <div className="user-name">{profile.nickname}</div>
            <div className="user-status">
              {connState === 'connected' ? 'в канале' : 'не в канале'}
            </div>
          </div>
          <div className="user-controls">
            <button
              className={`uc-btn${micMuted ? ' active' : ''}`}
              title={micMuted ? 'Включить микрофон' : 'Выключить микрофон'}
              onClick={toggleMic}
            >
              {micMuted ? (
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
                </svg>
              )}
            </button>

            <button
              className={`uc-btn${deafened ? ' active' : ''}`}
              title={deafened ? 'Включить звук' : 'Выключить звук'}
              onClick={toggleDeafen}
            >
              {deafened ? (
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                </svg>
              )}
            </button>

            <button className="uc-btn" title="Настройки" onClick={() => setSettingsOpen(true)}>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* main area */}
      <div className="main">
        <div className="main-header">
          <svg className="ch-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
          </svg>
          <span>{activeChannel.name}</span>
          {connState === 'connected' && <span className="header-badge">LIVE</span>}
        </div>

        <div className={`voice-area${connState === 'connected' && watchingPeerId ? ' watching' : ''}`}>
          {connState === 'connected' && watchingPeerId && remoteVideoStreams.get(watchingPeerId) && (() => {
            const wp = peers.find(p => p.id === watchingPeerId)
            return (
              <StreamViewer
                stream={remoteVideoStreams.get(watchingPeerId)!}
                streamer={{ name: wp?.nickname ?? '?', avatar: wp?.avatar }}
                micMuted={micMuted}
                deafened={deafened}
                onToggleMic={toggleMic}
                onToggleDeafen={toggleDeafen}
                onExit={() => setWatchingPeerId(null)}
              />
            )
          })()}

          {!(connState === 'connected' && watchingPeerId) && connState === 'idle' && (
            <div className="voice-idle">
              <div className="voice-icon">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/>
                </svg>
              </div>
              <p className="voice-title">
                {selectedServer ? `Канал · ${activeChannel.name}` : 'Нет сервера'}
              </p>
              <p className="voice-desc">
                {selectedServer
                  ? 'Нажми на канал слева чтобы подключиться'
                  : 'Добавь сервер через «+» в левой панели'
                }
              </p>
            </div>
          )}

          {!(connState === 'connected' && watchingPeerId) && connState === 'connecting' && (
            <div className="voice-idle">
              <div className="voice-icon pulse">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/>
                </svg>
              </div>
              <p className="voice-title">Подключение…</p>
              <p className="voice-desc">Устанавливаем P2P соединение</p>
            </div>
          )}

          {!(connState === 'connected' && watchingPeerId) && connState === 'error' && (
            <div className="voice-idle">
              <div className="voice-icon" style={{ color: 'var(--red)' }}>
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
              </div>
              <p className="voice-title" style={{ color: 'var(--red)' }}>Ошибка</p>
              <p className="voice-desc">{errorMsg}</p>
              <button className="connect-btn" onClick={() => handleChannelClick(activeChannel)}>
                Попробовать снова
              </button>
            </div>
          )}

          {!(connState === 'connected' && watchingPeerId) && connState === 'connected' && (
            <div className="voice-connected">
              <div className="connected-header">
                <span className="connected-label">В КАНАЛЕ · {activeChannel.name.toUpperCase()}</span>
                <span className="connected-count">
                  {peers.length + 1} участник{peers.length === 0 ? '' : peers.length < 4 ? 'а' : 'ов'}
                </span>
              </div>

              {isSharing && (
                <div className="ss-preview-wrap">
                  <video ref={localVideoRef} className="ss-preview-video" autoPlay muted playsInline />
                  <div className="ss-preview-label">Вы транслируете экран</div>
                </div>
              )}

              {[...remoteVideoStreams.entries()].map(([peerId, stream]) => (
                <div key={peerId} className="ss-preview-wrap">
                  <video
                    className="ss-preview-video"
                    autoPlay
                    playsInline
                    ref={(el) => { if (el && el.srcObject !== stream) el.srcObject = stream }}
                  />
                  <div className="ss-preview-label">
                    {peers.find(p => p.id === peerId)?.nickname ?? peerId.slice(0, 8)} транслирует экран
                  </div>
                </div>
              ))}

              <div className="ss-action-row">
                {!isSharing
                  ? (
                    <button className="ss-share-btn" onClick={() => setScreenShareOpen(true)}>
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3l-1 1v2h12v-2l-1-1h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/>
                      </svg>
                      Трансляция
                    </button>
                  ) : (
                    <button className="ss-stop-btn" onClick={handleStopScreenShare}>
                      Остановить трансляцию
                    </button>
                  )
                }
                <button className="disconnect-btn" onClick={handleDisconnect}>
                  Отключиться
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
