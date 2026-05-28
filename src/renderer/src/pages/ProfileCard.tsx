import { useEffect, useRef } from 'react'

interface ProfileCardPeer {
  id: string
  nickname: string
  avatar?: string
}

interface Props {
  peer: ProfileCardPeer
  stream?: MediaStream
  anchor: DOMRect
  onWatch: () => void
  onClose: () => void
}

export default function ProfileCard({ peer, stream, anchor, onWatch, onClose }: Props) {
  const cardRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
    }
  }, [stream])

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const top = Math.min(anchor.top, window.innerHeight - 260)
  const left = anchor.right + 10

  return (
    <div
      className="profile-card"
      ref={cardRef}
      style={{ top, left }}
    >
      <div className="pc-header">
        {peer.avatar
          ? <img src={peer.avatar} className="pc-avatar" alt={peer.nickname} />
          : <div className="pc-avatar-init">{peer.nickname[0]?.toUpperCase() ?? '?'}</div>
        }
        {stream && <span className="pc-live-badge">LIVE</span>}
      </div>

      <div className="pc-name">{peer.nickname}</div>

      {stream && (
        <>
          <video
            ref={videoRef}
            className="pc-stream-thumb"
            autoPlay
            muted
            playsInline
          />
          <button className="pc-watch-btn" onClick={() => { onClose(); onWatch() }}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            Смотреть трансляцию
          </button>
        </>
      )}
    </div>
  )
}
