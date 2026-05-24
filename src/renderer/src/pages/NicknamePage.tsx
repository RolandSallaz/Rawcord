import { useState, FormEvent } from 'react'

interface Props {
  onJoin: (nick: string) => void
}

export default function NicknamePage({ onJoin }: Props) {
  const [value, setValue] = useState('')
  const valid = value.trim().length >= 2

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (valid) onJoin(value.trim())
  }

  return (
    <div className="nickname-page">
      <div className="nickname-card">
        <div className="brand">
          <svg className="brand-icon" viewBox="0 0 24 24" fill="none">
            <polygon points="12,2 22,7 22,17 12,22 2,17 2,7" fill="#5865f2" opacity="0.9"/>
            <polygon points="12,5 19,8.5 19,15.5 12,19 5,15.5 5,8.5" fill="#5865f2"/>
            <circle cx="12" cy="12" r="3" fill="#fff" opacity="0.9"/>
          </svg>
          <span className="brand-name">disAnalog</span>
        </div>

        <h1 className="nickname-title">Добро пожаловать</h1>
        <p className="nickname-sub">Введи ник перед входом в канал</p>

        <form className="nickname-form" onSubmit={handleSubmit}>
          <label className="input-label">ВАШ НИК</label>
          <input
            autoFocus
            className="nickname-input"
            type="text"
            placeholder="крутой_ник"
            value={value}
            onChange={e => setValue(e.target.value)}
            maxLength={32}
            spellCheck={false}
          />
          <button className="join-btn" type="submit" disabled={!valid}>
            Войти в канал
          </button>
        </form>

        <p className="nickname-hint">минимум 2 символа</p>
      </div>
    </div>
  )
}
