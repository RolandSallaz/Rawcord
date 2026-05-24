import { useState, useEffect, useRef, useCallback } from 'react'
import { SignalingClient, type PeerInfo } from '../lib/signaling'
import { PeerManager } from '../lib/webrtc'

interface Props {
  nickname: string
  onLeave: () => void
}

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error'

const CHANNELS = [
  { id: 'general', name: 'основной' },
  { id: 'gaming', name: 'игровой' },
]

export default function ChannelPage({ nickname, onLeave }: Props) {
  const [activeChannel, setActiveChannel] = useState(CHANNELS[0])
  const [connState, setConnState] = useState<ConnectionState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [peers, setPeers] = useState<PeerInfo[]>([])

  const signalingRef = useRef<SignalingClient | null>(null)
  const peerManagerRef = useRef<PeerManager | null>(null)

  // cleanup on unmount
  useEffect(() => {
    return () => { cleanup() }
  }, [])

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
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    } catch {
      setErrorMsg('Нет доступа к микрофону')
      setConnState('error')
      return
    }

    const signaling = new SignalingClient()
    const peerManager = new PeerManager(signaling)
    peerManager.setStream(stream)

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
  }, [activeChannel, nickname])

  function handleDisconnect() {
    cleanup()
    setPeers([])
    setConnState('idle')
  }

  function handleChannelSwitch(ch: typeof CHANNELS[0]) {
    if (connState === 'connected') handleDisconnect()
    setActiveChannel(ch)
  }

  return (
    <div className="layout">
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
            <button
              key={ch.id}
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
          <button className="leave-btn" title="Выйти" onClick={onLeave}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>
            </svg>
          </button>
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
              </div>

              <div className="participants">
                {/* self */}
                <div className="participant self">
                  <div className="participant-avatar">{nickname[0].toUpperCase()}</div>
                  <span className="participant-name">{nickname} (ты)</span>
                  <span className="participant-status speaking" />
                </div>

                {/* remote peers */}
                {peers.map(peer => (
                  <div key={peer.id} className="participant">
                    <div className="participant-avatar">{peer.nickname[0]?.toUpperCase() ?? '?'}</div>
                    <span className="participant-name">{peer.nickname}</span>
                    <span className="participant-status speaking" />
                  </div>
                ))}

                {peers.length === 0 && (
                  <p className="waiting-peer">Ожидаем других участников…</p>
                )}
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
