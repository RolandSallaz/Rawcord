import { useState, useEffect, useRef } from 'react'
import type { AudioSettings } from '../lib/settings'

interface Props {
  settings: AudioSettings
  onChange: (s: AudioSettings) => void
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

function keyLabel(code: string): string {
  if (KEY_LABELS[code]) return KEY_LABELS[code]
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return `Num${code.slice(6)}`
  if (code.startsWith('F') && !isNaN(Number(code.slice(1)))) return code
  return code
}

export default function SettingsModal({ settings, onChange, onClose }: Props) {
  const [inputs, setInputs] = useState<DeviceInfo[]>([])
  const [outputs, setOutputs] = useState<DeviceInfo[]>([])
  const [listeningPtt, setListeningPtt] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)

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
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [listeningPtt, settings, onChange])

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose()
  }

  function set<K extends keyof AudioSettings>(key: K, value: AudioSettings[K]) {
    onChange({ ...settings, [key]: value })
  }

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">Настройки аудио</span>
          <button className="modal-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <div className="modal-section">
          <div className="modal-section-title">УСТРОЙСТВА</div>

          <div className="settings-row">
            <span className="settings-label">Микрофон</span>
            <select
              className="settings-select"
              value={settings.inputDeviceId}
              onChange={e => set('inputDeviceId', e.target.value)}
            >
              <option value="">По умолчанию</option>
              {inputs.map(d => (
                <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
              ))}
            </select>
          </div>

          <div className="settings-row">
            <span className="settings-label">Вывод звука</span>
            <select
              className="settings-select"
              value={settings.outputDeviceId}
              onChange={e => set('outputDeviceId', e.target.value)}
            >
              <option value="">По умолчанию</option>
              {outputs.map(d => (
                <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
              ))}
            </select>
          </div>

          <div className="settings-row">
            <span className="settings-label">Подавление шума</span>
            <label className="toggle-wrap">
              <input
                type="checkbox"
                checked={settings.noiseSuppression}
                onChange={e => set('noiseSuppression', e.target.checked)}
              />
              <span className="toggle-track">
                <span className="toggle-thumb" />
              </span>
            </label>
          </div>

          <p className="settings-hint">Смена устройств применяется при следующем подключении к каналу</p>
        </div>

        <div className="modal-section">
          <div className="modal-section-title">РЕЖИМ МИКРОФОНА</div>

          <div className="radio-group">
            <label className="radio-row">
              <input
                type="radio"
                className="radio-input"
                checked={settings.voiceMode === 'always'}
                onChange={() => set('voiceMode', 'always')}
              />
              <span className="radio-dot" />
              <span className="settings-label">Всегда включён</span>
            </label>

            <label className="radio-row">
              <input
                type="radio"
                className="radio-input"
                checked={settings.voiceMode === 'ptt'}
                onChange={() => set('voiceMode', 'ptt')}
              />
              <span className="radio-dot" />
              <span className="settings-label">Push to Talk</span>
            </label>
          </div>

          {settings.voiceMode === 'ptt' && (
            <div className="ptt-row">
              <span className="settings-label">Клавиша</span>
              <span className="ptt-key">{keyLabel(settings.pttKey)}</span>
              <button
                className={`ptt-bind-btn${listeningPtt ? ' listening' : ''}`}
                onClick={() => setListeningPtt(true)}
              >
                {listeningPtt ? 'Нажми клавишу…' : 'Изменить'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
