export interface AudioSettings {
  inputDeviceId: string
  outputDeviceId: string
  noiseSuppression: boolean
  voiceMode: 'always' | 'ptt'
  pttKey: string
}

export const defaultSettings: AudioSettings = {
  inputDeviceId: '',
  outputDeviceId: '',
  noiseSuppression: true,
  voiceMode: 'always',
  pttKey: 'Space',
}

const STORAGE_KEY = 'rawcord_audio_settings'

export function loadSettings(): AudioSettings {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') }
  } catch {
    return { ...defaultSettings }
  }
}

export function saveSettings(s: AudioSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}
