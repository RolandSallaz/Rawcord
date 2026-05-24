import { useState, useEffect, useRef } from 'react'
import type { AudioSettings } from '../lib/settings'
import type { UserProfile } from '../lib/profile'
import { compressAvatar } from '../lib/profile'

interface Props {
  settings: AudioSettings
  profile: UserProfile
  onChange: (s: AudioSettings) => void
  onProfileChange: (p: UserProfile) => void
  onClose: () => void
}

interface DeviceInfo {
  deviceId: string
  label: string
}

const KEY_LABELS: Record<string, string> = {
  Space: 'Пробел', Enter: 'Enter', Tab: 'Tab',
  ControlLeft: 'Ctrl L', ControlRight: 'Ctrl R',
  AltLeft: 'Alt L', AltRight: 'Alt R',
  ShiftLeft: 'Shift L', ShiftRight: 'Shift R',
  CapsLock: 'Caps Lock',
}
const MOUSE_LABELS: Record<string, string> = {
  Mouse1: 'Колёсико', Mouse3: 'Мышь ←', Mouse4: 'Мышь →',
}

function pttLabel(key: string): string {
  if (MOUSE_LABELS[key]) return MOUSE_LABELS[key]
  if (KEY_LABELS[key]) return KEY_LABELS[key]
  if (key.startsWith('Mouse')) return `Мышь ${key.replace('Mouse', '')}`
  if (key.startsWith('Key')) return key.slice(3)
  if (key.startsWith('Digit')) return key.slice(5)
  if (key.startsWith('Numpad')) return `Num${key.slice(6)}`
  return key
}

export default function SettingsModal({ settings, profile, onChange, onProfileChange, onClose }: Props) {
  const [inputs, setInputs] = useState<DeviceInfo[]>([])
  const [outputs, setOutputs] = useState<DeviceInfo[]>([])
  const [listeningPtt, setListeningPtt] = useState(false)
  const [nickname, setNickname] = useState(profile.nickname)
  const [avatarError, setAvatarError] = useState('')
  const overlayRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    navigator.mediaDevices.enumerateDevices().then(devices => {
      setInputs(devices.filter(d => d.kind === 'audioinput').map(d => ({
        deviceId: d.deviceId,
        label: d.label || `Микрофон ${d.deviceId.slice(0, 6)}`,
      })))
      setOutputs(devices.filter(d => d.kind === 'audiooutput').map(d => ({
        deviceId: d.deviceId,
        label: d.label || `Динамик ${d.deviceId.slice(0, 6)}`,
      })))
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!listeningPtt) return
    function onKey(e: KeyboardEvent) {
      e.preventDefault()
      if (e.code === 'Escape') { setListeningPtt(false); return }
      onChange({ ...settings, pttKey: e.code })
      setListeningPtt(false)
    }
    function onMouse(e: MouseEvent) {
      if (e.button === 0 || e.button === 2) return
      e.preventDefault()
      onChange({ ...settings, pttKey: `Mouse${e.button}` })
      setListeningPtt(false)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    window.addEventListener('mousedown', onMouse, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      window.removeEventListener('mousedown', onMouse, { capture: true })
    }
  }, [listeningPtt, settings, onChange])

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose()
  }

  function setAudio<K extends keyof AudioSettings>(key: K, value: AudioSettings[K]) {
    onChange({ ...settings, [key]: value })
  }

  function handleNicknameBlur() {
    const nick = nickname.trim()
    if (nick.length >= 2) onProfileChange({ ...profile, nickname: nick })
    else setNickname(profile.nickname)
  }

  async function handleAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setAvatarError('')
    try {
      const dataUrl = await compressAvatar(file)
      onProfileChange({ ...profile, avatar: dataUrl })
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Ошибка загрузки')
    }
    e.target.value = ''
  }

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">Настройки</span>
          <button className="modal-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        {/* Profile section */}
        <div className="modal-section">
          <div className="modal-section-title">ПРОФИЛЬ</div>

          <div className="settings-row">
            <span className="settings-label">Никнейм</span>
            <input
              className="settings-input"
              type="text"
              value={nickname}
              maxLength={32}
              onChange={e => setNickname(e.target.value)}
              onBlur={handleNicknameBlur}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            />
          </div>

          <div className="settings-row">
            <span className="settings-label">Аватар</span>
            <div className="avatar-setting-row">
              <div className="avatar-setting-preview" onClick={() => fileRef.current?.click()}>
                {profile.avatar
                  ? <img src={profile.avatar} alt="av" className="avatar-img" style={{ width: 48, height: 48 }} />
                  : <div className="avatar-initials" style={{ width: 48, height: 48, fontSize: 20 }}>
                      {profile.nickname[0]?.toUpperCase()}
                    </div>
                }
                <div className="avatar-preview-overlay">
                  <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 16, height: 16 }}>
                    <path d="M3 4V1h2v3h3v2H5v3H3V6H0V4zm3 6V7h3V4h7l1.83 2H21c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V10h3zm7 9c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm-3.2-5c0 1.77 1.43 3.2 3.2 3.2 1.77 0 3.2-1.43 3.2-3.2 0-1.77-1.43-3.2-3.2-3.2-1.77 0-3.2 1.43-3.2 3.2z"/>
                  </svg>
                </div>
              </div>
              <input ref={fileRef} type="file" accept="image/*,.gif" style={{ display: 'none' }} onChange={handleAvatarFile} />
              {profile.avatar && (
                <button className="ptt-bind-btn" onClick={() => onProfileChange({ ...profile, avatar: '' })}>
                  Удалить
                </button>
              )}
            </div>
          </div>
          {avatarError && <p className="settings-hint" style={{ color: 'var(--red)' }}>{avatarError}</p>}
        </div>

        {/* Audio devices section */}
        <div className="modal-section">
          <div className="modal-section-title">УСТРОЙСТВА</div>

          <div className="settings-row">
            <span className="settings-label">Микрофон</span>
            <select
              className="settings-select"
              value={settings.inputDeviceId}
              onChange={e => setAudio('inputDeviceId', e.target.value)}
            >
              <option value="">По умолчанию</option>
              {inputs.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
            </select>
          </div>

          <div className="settings-row">
            <span className="settings-label">Вывод звука</span>
            <select
              className="settings-select"
              value={settings.outputDeviceId}
              onChange={e => setAudio('outputDeviceId', e.target.value)}
            >
              <option value="">По умолчанию</option>
              {outputs.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
            </select>
          </div>

          <div className="settings-row">
            <span className="settings-label">Подавление шума</span>
            <label className="toggle-wrap">
              <input type="checkbox" checked={settings.noiseSuppression} onChange={e => setAudio('noiseSuppression', e.target.checked)} />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
            </label>
          </div>

          <p className="settings-hint">Смена устройств применяется при следующем подключении</p>
        </div>

        {/* Voice mode section */}
        <div className="modal-section">
          <div className="modal-section-title">РЕЖИМ МИКРОФОНА</div>

          <div className="radio-group">
            <label className="radio-row">
              <input type="radio" className="radio-input" checked={settings.voiceMode === 'always'} onChange={() => setAudio('voiceMode', 'always')} />
              <span className="radio-dot" />
              <span className="settings-label">Всегда включён</span>
            </label>
            <label className="radio-row">
              <input type="radio" className="radio-input" checked={settings.voiceMode === 'ptt'} onChange={() => setAudio('voiceMode', 'ptt')} />
              <span className="radio-dot" />
              <span className="settings-label">Push to Talk</span>
            </label>
          </div>

          {settings.voiceMode === 'ptt' && (
            <div className="ptt-row">
              <span className="settings-label">Клавиша</span>
              <span className="ptt-key">{pttLabel(settings.pttKey)}</span>
              <button
                className={`ptt-bind-btn${listeningPtt ? ' listening' : ''}`}
                onClick={() => setListeningPtt(true)}
              >
                {listeningPtt ? 'Нажми кнопку…' : 'Изменить'}
              </button>
              {listeningPtt && <span className="settings-hint" style={{ marginTop: 0 }}>Мышь 3/4 или любая клавиша • Esc — отмена</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
