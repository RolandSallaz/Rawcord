/**
 * OS-level global push-to-talk hook.
 *
 * Uses uiohook-napi to capture key/mouse down+up even when the Rawcord window
 * is minimized or unfocused, and forwards them to the renderer as 'ptt:down' /
 * 'ptt:up' IPC events.
 *
 * The native module is loaded lazily and failures are swallowed, so the app
 * still runs (with focus-only PTT) if uiohook-napi isn't installed/built.
 */
import type { WebContents } from 'electron'

// uiohook-napi types are optional; require lazily.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UiohookModule = any

let uiohook: UiohookModule | null = null
let started = false
let listeners: { keydown?: (e: unknown) => void; keyup?: (e: unknown) => void; mousedown?: (e: unknown) => void; mouseup?: (e: unknown) => void } = {}

/** DOM mouse button (e.button) → uiohook mouse button number. */
const MOUSE_MAP: Record<number, number> = { 0: 1, 1: 3, 2: 2, 3: 4, 4: 5 }

/**
 * Map a DOM KeyboardEvent.code to a uiohook keycode using the module's
 * UiohookKey table. Returns null if unmappable.
 */
function domCodeToUiohook(code: string, UiohookKey: Record<string, number>): number | null {
  if (code.startsWith('Key')) return UiohookKey[code.slice(3)] ?? null          // KeyA → A
  if (code.startsWith('Digit')) return UiohookKey[code.slice(5)] ?? null        // Digit1 → 1
  if (code.startsWith('Numpad')) return UiohookKey['Numpad' + code.slice(6)] ?? null
  const special: Record<string, string> = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace',
    CapsLock: 'CapsLock', ControlLeft: 'Ctrl', ControlRight: 'CtrlRight',
    ShiftLeft: 'Shift', ShiftRight: 'ShiftRight', AltLeft: 'Alt', AltRight: 'AltRight',
    MetaLeft: 'Meta', MetaRight: 'MetaRight',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Insert: 'Insert', Delete: 'Delete',
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
    F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
    Backquote: 'Backquote', Minus: 'Minus', Equal: 'Equal',
    BracketLeft: 'BracketLeft', BracketRight: 'BracketRight', Backslash: 'Backslash',
    Semicolon: 'Semicolon', Quote: 'Quote', Comma: 'Comma', Period: 'Period', Slash: 'Slash',
  }
  const name = special[code]
  return name ? (UiohookKey[name] ?? null) : null
}

function loadUiohook(): UiohookModule | null {
  if (uiohook) return uiohook
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    uiohook = require('uiohook-napi')
    return uiohook
  } catch (e) {
    console.warn('[pttHook] uiohook-napi not available — global PTT disabled:', (e as Error)?.message)
    return null
  }
}

/** Register a global hook for the given DOM key/mouse code. */
export function registerPtt(code: string, wc: WebContents): boolean {
  unregisterPtt()
  const mod = loadUiohook()
  if (!mod) return false
  const { uIOhook, UiohookKey } = mod

  const send = (channel: 'ptt:down' | 'ptt:up') => {
    if (!wc.isDestroyed()) wc.send(channel)
  }

  if (code.startsWith('Mouse')) {
    const domBtn = parseInt(code.replace('Mouse', ''), 10)
    const target = MOUSE_MAP[domBtn]
    listeners.mousedown = (e: unknown) => { if ((e as { button: number }).button === target) send('ptt:down') }
    listeners.mouseup   = (e: unknown) => { if ((e as { button: number }).button === target) send('ptt:up') }
    uIOhook.on('mousedown', listeners.mousedown)
    uIOhook.on('mouseup', listeners.mouseup)
  } else {
    const target = domCodeToUiohook(code, UiohookKey)
    if (target == null) { console.warn('[pttHook] unmappable PTT key:', code); return false }
    listeners.keydown = (e: unknown) => { if ((e as { keycode: number }).keycode === target) send('ptt:down') }
    listeners.keyup   = (e: unknown) => { if ((e as { keycode: number }).keycode === target) send('ptt:up') }
    uIOhook.on('keydown', listeners.keydown)
    uIOhook.on('keyup', listeners.keyup)
  }

  if (!started) {
    try { uIOhook.start(); started = true } catch (e) { console.warn('[pttHook] start failed:', e); return false }
  }
  return true
}

/** Remove the active global hook listeners (keeps the hook engine running). */
export function unregisterPtt(): void {
  const mod = uiohook
  if (mod) {
    const { uIOhook } = mod
    try {
      if (listeners.keydown) uIOhook.off('keydown', listeners.keydown)
      if (listeners.keyup) uIOhook.off('keyup', listeners.keyup)
      if (listeners.mousedown) uIOhook.off('mousedown', listeners.mousedown)
      if (listeners.mouseup) uIOhook.off('mouseup', listeners.mouseup)
    } catch {}
  }
  listeners = {}
}

/** Fully stop the hook engine (on app quit). */
export function stopPtt(): void {
  unregisterPtt()
  if (uiohook && started) {
    try { uiohook.uIOhook.stop() } catch {}
    started = false
  }
}
