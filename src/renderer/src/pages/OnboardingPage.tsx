import { useState, useRef, FormEvent } from 'react'
import { saveProfile, compressAvatar } from '../lib/profile'

interface Props {
  onDone: () => void
}

export default function OnboardingPage({ onDone }: Props) {
  const [nickname, setNickname] = useState('')
  const [avatar, setAvatar] = useState('')
  const [avatarError, setAvatarError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setAvatarError('')
    try {
      const dataUrl = await compressAvatar(file)
      setAvatar(dataUrl)
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Ошибка загрузки')
    }
    e.target.value = ''
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const nick = nickname.trim()
    if (nick.length < 2) return
    saveProfile({ nickname: nick, avatar })
    onDone()
  }

  const initials = nickname.trim()[0]?.toUpperCase() ?? '?'

  return (
    <div className="onboarding-page">
      <div className="onboarding-card">
        <div className="brand">
          <svg className="brand-icon" viewBox="0 0 24 24" fill="none">
            <polygon points="12,2 22,7 22,17 12,22 2,17 2,7" fill="#5865f2" opacity="0.9"/>
            <circle cx="12" cy="12" r="3" fill="#fff" opacity="0.9"/>
          </svg>
          <span className="brand-name">Rawcord</span>
        </div>

        <p className="onboarding-title">Как тебя зовут?</p>
        <p className="onboarding-sub">Это увидят другие участники</p>

        <div className="avatar-upload-area">
          <div className="avatar-preview-wrap" onClick={() => fileRef.current?.click()}>
            {avatar
              ? <img src={avatar} alt="avatar" className="avatar-preview-img" />
              : <div className="avatar-preview-initials">{initials}</div>
            }
            <div className="avatar-preview-overlay">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 4V1h2v3h3v2H5v3H3V6H0V4zm3 6V7h3V4h7l1.83 2H21c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V10h3zm7 9c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm-3.2-5c0 1.77 1.43 3.2 3.2 3.2 1.77 0 3.2-1.43 3.2-3.2 0-1.77-1.43-3.2-3.2-3.2-1.77 0-3.2 1.43-3.2 3.2z"/>
              </svg>
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,.gif"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          {avatarError && <p className="avatar-error">{avatarError}</p>}
          <p className="avatar-hint">Нажми чтобы загрузить фото или GIF</p>
        </div>

        <form className="nickname-form" onSubmit={handleSubmit}>
          <label className="input-label">НИКНЕЙМ</label>
          <input
            autoFocus
            className="nickname-input"
            type="text"
            placeholder="от 2 до 32 символов"
            maxLength={32}
            value={nickname}
            onChange={e => setNickname(e.target.value)}
            spellCheck={false}
          />
          <button
            className="join-btn"
            type="submit"
            disabled={nickname.trim().length < 2}
          >
            Войти в Rawcord
          </button>
        </form>
      </div>
    </div>
  )
}
