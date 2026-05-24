import { useState, useEffect, useRef, useCallback } from 'react'
import { SignalingClient, type PeerInfo } from '../lib/signaling'
import { PeerManager } from '../lib/webrtc'
import { loadSettings, saveSettings, type AudioSettings } from '../lib/settings'
import SettingsModal from './SettingsModal'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ipcRenderer } = (window as any).require('electron')

interface Props {
  nickname: string
  signalingUrl: string
  isHost: boolean
  onLeave: () => void
}

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error'

const CHANNELS = [
  { id: 'general', name: 'основной' },
  { id: 'gaming', name: 'игровой' },
]

export default function ChannelPage({ nickname, signalingUrl, isHost, onLeave }: Props) {
  const [activeChannel, setActiveChannel] = useState(CHANNELS[0])
  const [connState, setConnState] = useState<ConnectionState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [micMuted, setMicMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [settings, setSettings] = useState<AudioSettings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)

  const signalingRef = useRef<SignalingClient | null>(null)
  const peerManagerRef = useRef<PeerManager | null>(null)

  // cleanup on unmount
  useEffect(() => {
    return () => { cleanup() }
  }, [])

  // PTT key handlers
  useEffect(() => {
    if (settings.voiceMode !== 'ptt' || connState !== 'connected') return
    peerManagerRef.current?.setMicMuted(true)
    const onDown = (e: KeyboardEvent) => { if (e.code === settings.pttKey && !e.repeat) peerManagerRef.current?.setMicMuted(false) }
    const onUp   = (e: KeyboardEvent) => { if (e.code === settings.pttKey) peerManagerRef.current?.setMicMuted(true) }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
  }, [settings.voiceMode, settings.pttKey, connState])

  function cleanup() {
    peerManagerRef.current?.destroy()
    peerManagerRef.current = null
    signalingRef.current?.disconnect()
    signalingRef.current = null
  }

  const handleConnect = useCallback(async () => {
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

    const signaling = new SignalingClient(signalingUrl)
    const peerManager = new PeerManager(signaling)
    peerManager.setStream(stream)
    peerManager.setOutputDevice(settings.outputDeviceId)

    // track nicknames of connected peers
    const peerNicknames = new Map<string, string>()

    peerManager.onPeersChanged = () => {
      setPeers(
        peerManager.getPeerIds().map(id => ({
          id,
          nickname: peerNicknames.get(id) ?? id.slice(0, 8),
        }))
      )
    }

    signaling.on('onPeers', (existingPeers) => {
      for (const p of existingPeers) {
        peerNicknames.set(p.id, p.nickname)
        peerManager.createPeer(p.id, p.nickname, true)
      }
    })

    signaling.on('onPeerJoined', (peer) => {
      peerNicknames.set(peer.id, peer.nickname)
      peerManager.createPeer(peer.id, peer.nickname, true)
    })

    signaling.on('onPeerLeft', (id) => {
      peerNicknames.delete(id)
      peerManager.removePeer(id)
    })

    signaling.on('onRelay', (from, payload) => {
      // If we haven't created this peer yet (they sent an offer first), create as non-initiator
      if (!peerManager.getPeerIds().includes(from)) {
        const nick = peerNicknames.get(from) ?? from.slice(0, 8)
        peerManager.createPeer(from, nick, false)
      }
      peerManager.signal(from, payload as object)
    })

    signaling.on('onClose', () => {
      if (connState === 'connected') {
        cleanup()
        setConnState('idle')
        setPeers([])
      }
    })

    try {
      await signaling.connect()
    } catch {
      stream.getTracks().forEach(t => t.stop())
      setErrorMsg('Не удалось подключиться к сигналинг-серверу')
      setConnState('error')
      return
    }

    signalingRef.current = signaling
    peerManagerRef.current = peerManager

    signaling.join(activeChannel.id, nickname)
    setConnState('connected')
  }, [activeChannel, nickname, signalingUrl, settings])

  function handleSettingsChange(s: AudioSettings) {
    setSettings(s)
    saveSettings(s)
    peerManagerRef.current?.setOutputDevice(s.outputDeviceId)
  }

  function handleDisconnect() {
    cleanup()
    setPeers([])
    setConnState('idle')
    setMicMuted(false)
    setDeafened(false)
  }

  function handleChannelSwitch(ch: typeof CHANNELS[0]) {
    if (connState === 'connected') handleDisconnect()
    setActiveChannel(ch)
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

  return (
    <div className="layout">
      {settingsOpen && (
        <SettingsModal settings={settings} onChange={handleSettingsChange} onClose={() => setSettingsOpen(false)} />
      )}
      {/* server rail */}
      <div className="server-rail">
        <div className="server-btn active" title="disAnalog">
          <svg viewBox="0 0 24 24" fill="none">
            <polygon points="12,2 22,7 22,17 12,22 2,17 2,7" fill="#5865f2" opacity="0.85"/>
            <circle cx="12" cy="12" r="3" fill="#fff" opacity="0.9"/>
          </svg>
        </div>
        <div className="server-divider" />
        <button className="server-btn add-btn" title="Добавить сервер">+</button>
      </div>

      {/* channel sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">disAnalog</div>

        <div className="channel-section">
          <div className="section-label">ГОЛОСОВЫЕ КАНАЛЫ</div>
          {CHANNELS.map(ch => (
            <div key={ch.id}>
              <button
                className={`channel-item ${activeChannel.id === ch.id ? 'active' : ''}`}
                onClick={() => handleChannelSwitch(ch)}
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
                    <div className="vm-avatar">{nickname[0].toUpperCase()}</div>
                    <span className="vm-name">{nickname}</span>
                    {micMuted
                      ? <svg className="vm-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>
                      : <span className="vm-speaking" />
                    }
                  </div>
                  {peers.map(peer => (
                    <div key={peer.id} className="voice-member">
                      <div className="vm-avatar">{peer.nickname[0]?.toUpperCase() ?? '?'}</div>
                      <span className="vm-name">{peer.nickname}</span>
                      <span className="vm-speaking" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="user-panel">
          <div className="user-avatar">{nickname[0].toUpperCase()}</div>
          <div className="user-info">
            <div className="user-name">{nickname}</div>
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

            <button className="uc-btn leave" title="Выйти" onClick={() => { if (isHost) ipcRenderer.invoke('server:stop'); onLeave() }}>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>
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

        <div className="voice-area">
          {connState === 'idle' && (
            <div className="voice-idle">
              <div className="voice-icon">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"/>
                </svg>
              </div>
              <p className="voice-title">Голосовой канал · {activeChannel.name}</p>
              <p className="voice-desc">Нажми «Подключиться» чтобы войти в канал</p>
              <button className="connect-btn" onClick={handleConnect}>
                Подключиться
              </button>
            </div>
          )}

          {connState === 'connecting' && (
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

          {connState === 'error' && (
            <div className="voice-idle">
              <div className="voice-icon" style={{ color: 'var(--red)' }}>
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
              </div>
              <p className="voice-title" style={{ color: 'var(--red)' }}>Ошибка</p>
              <p className="voice-desc">{errorMsg}</p>
              <button className="connect-btn" onClick={handleConnect}>
                Попробовать снова
              </button>
            </div>
          )}

          {connState === 'connected' && (
            <div className="voice-connected">
              <div className="connected-header">
                <span className="connected-label">В КАНАЛЕ · {activeChannel.name.toUpperCase()}</span>
                <span className="connected-count">{peers.length + 1} участник{peers.length === 0 ? '' : peers.length < 4 ? 'а' : 'ов'}</span>
              </div>
              <button className="disconnect-btn" onClick={handleDisconnect}>
                Отключиться
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
