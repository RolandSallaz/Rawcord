/**
 * Звуковые уведомления — синтез через Web Audio API (без файлов).
 * Звуки нарочно тихие и короткие, чтобы не мешать голосу.
 */

let _ctx: AudioContext | null = null

function ctx(): AudioContext {
  if (!_ctx || _ctx.state === 'closed') _ctx = new AudioContext()
  if (_ctx.state === 'suspended') _ctx.resume().catch(() => {})
  return _ctx
}

function tone(
  freq: number,
  startAt: number,
  duration: number,
  peakGain = 0.18,
  type: OscillatorType = 'sine',
) {
  try {
    const c = ctx()
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, c.currentTime + startAt)
    gain.gain.setValueAtTime(0, c.currentTime + startAt)
    gain.gain.linearRampToValueAtTime(peakGain, c.currentTime + startAt + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + startAt + duration)
    osc.connect(gain)
    gain.connect(c.destination)
    osc.start(c.currentTime + startAt)
    osc.stop(c.currentTime + startAt + duration + 0.01)
  } catch { /* best-effort */ }
}

/** Кто-то подключился — два восходящих тона */
export function playJoinSound(): void {
  tone(520, 0,    0.12)
  tone(780, 0.13, 0.14)
}

/** Кто-то отключился — два нисходящих тона */
export function playLeaveSound(): void {
  tone(780, 0,    0.12)
  tone(520, 0.13, 0.14)
}

/** Нажали кнопку «говорить» (PTT) — короткий восходящий бип */
export function playPttOnSound(): void {
  tone(660, 0, 0.06, 0.12, 'triangle')
}

/** Отпустили кнопку «говорить» (PTT) — короткий нисходящий бип */
export function playPttOffSound(): void {
  tone(440, 0, 0.06, 0.12, 'triangle')
}
