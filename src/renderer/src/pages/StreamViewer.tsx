import { useEffect, useRef, useState } from 'react'

interface Streamer {
  name: string
  avatar?: string
}

interface Props {
  stream: MediaStream
  streamer: Streamer
  isLocal?: boolean
  micMuted: boolean
  deafened: boolean
  onToggleMic: () => void
  onToggleDeafen: () => void
  onExit: () => void
}

export default function StreamViewer({
  stream, streamer, isLocal,
  micMuted, deafened,
  onToggleMic, onToggleDeafen, onExit,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const wrapRef  = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const [showControls, setShowControls] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream
  }, [stream])

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // Auto-hide controls after 3 s of inactivity
  useEffect(() => {
    scheduleHide()
    return () => clearTimeout(timerRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function scheduleHide() {
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setShowControls(false), 3000)
  }

  function handleMouseMove() {
    setShowControls(true)
    scheduleHide()
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      wrapRef.current?.requestFullscreen()
    } else {
      document.exitFullscreen()
    }
  }

  return (
    <div
      className={`sv-wrap${showControls ? ' controls-visible' : ''}`}
      ref={wrapRef}
      onMouseMove={handleMouseMove}
      onClick={() => { setShowControls(true); scheduleHide() }}
    >
      <video
        ref={videoRef}
        className="sv-video"
        autoPlay
        muted={!!isLocal}
        playsInline
      />

      <div className="sv-controls">
        {/* Left: streamer info */}
        <div className="sv-ctrl-left">
          {streamer.avatar
            ? <img src={streamer.avatar} className="sv-ctrl-avatar" alt={streamer.name} />
            : <div className="sv-ctrl-avatar-init">{streamer.name[0]?.toUpperCase() ?? '?'}</div>
          }
          <span className="sv-ctrl-name">{streamer.name}</span>
          <span className="sv-live-badge">LIVE</span>
        </div>

        {/* Center: mic + deafen */}
        <div className="sv-ctrl-center">
          <button
            className={`sv-ctrl-btn${micMuted ? ' active' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggleMic() }}
            title={micMuted ? 'Включить микрофон' : 'Выключить микрофон'}
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
            className={`sv-ctrl-btn${deafened ? ' active' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggleDeafen() }}
            title={deafened ? 'Включить звук' : 'Выключить звук'}
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
        </div>

        {/* Right: fullscreen + exit */}
        <div className="sv-ctrl-right">
          <button
            className="sv-ctrl-btn"
            onClick={(e) => { e.stopPropagation(); toggleFullscreen() }}
            title={isFullscreen ? 'Выйти из полного экрана' : 'Полный экран'}
          >
            {isFullscreen ? (
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
              </svg>
            )}
          </button>

          <button
            className="sv-ctrl-btn sv-exit-btn"
            onClick={(e) => { e.stopPropagation(); onExit() }}
            title="Выйти из трансляции"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
            Выйти
          </button>
        </div>
      </div>
    </div>
  )
}
