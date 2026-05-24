import { parseGIF, decompressFrames } from 'gifuct-js'
import { GIFEncoder, quantize, applyPalette } from 'gifenc'

export interface UserProfile {
  nickname: string
  avatar: string
}

const KEY = 'rawcord_profile'
const GIF_MAX_INPUT = 15 * 1024 * 1024   // 15 MB
const AVATAR_SIZE = 128                   // max px per side after resize

export function loadProfile(): UserProfile | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    return JSON.parse(raw) as UserProfile
  } catch {
    return null
  }
}

export function saveProfile(p: UserProfile): void {
  localStorage.setItem(KEY, JSON.stringify(p))
}

// ─── Static image compression (jpg/png/webp/etc.) ─────────────────────────
async function compressStatic(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, AVATAR_SIZE / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', 0.8))
    }
    img.onerror = reject
    img.src = url
  })
}

// ─── GIF compression: decode frames → resize → re-encode ──────────────────
async function compressGif(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const gif = parseGIF(buffer)
  const frames = decompressFrames(gif, true)

  if (frames.length === 0) throw new Error('Не удалось прочитать GIF')

  const srcW = gif.lsd.width
  const srcH = gif.lsd.height
  const scale = Math.min(1, AVATAR_SIZE / Math.max(srcW, srcH))
  const dstW = Math.max(1, Math.round(srcW * scale))
  const dstH = Math.max(1, Math.round(srcH * scale))

  // Compositing canvas (full size, for disposal handling)
  const compCanvas = document.createElement('canvas')
  compCanvas.width = srcW
  compCanvas.height = srcH
  const compCtx = compCanvas.getContext('2d')!

  // Output canvas (scaled)
  const outCanvas = document.createElement('canvas')
  outCanvas.width = dstW
  outCanvas.height = dstH
  const outCtx = outCanvas.getContext('2d')!

  const encoder = GIFEncoder()

  let prevDisposal = 0

  for (const frame of frames) {
    const { dims, patch, delay, disposalType } = frame

    // Handle disposal before drawing
    if (prevDisposal === 2) {
      // Restore to background
      compCtx.clearRect(dims.left, dims.top, dims.width, dims.height)
    }

    // Draw current frame patch onto composite canvas
    const frameImageData = new ImageData(
      new Uint8ClampedArray(patch.buffer),
      dims.width,
      dims.height
    )
    compCtx.putImageData(frameImageData, dims.left, dims.top)

    // Scale down onto output canvas
    outCtx.clearRect(0, 0, dstW, dstH)
    outCtx.drawImage(compCanvas, 0, 0, dstW, dstH)

    const pixels = outCtx.getImageData(0, 0, dstW, dstH).data
    const palette = quantize(pixels, 256, { format: 'rgba4444' })
    const index = applyPalette(pixels, palette)

    encoder.writeFrame(index, dstW, dstH, {
      palette,
      delay: delay ?? 100,
      repeat: 0,
    })

    prevDisposal = disposalType ?? 0
  }

  encoder.finish()
  const bytes = encoder.bytes()

  const blob = new Blob([bytes], { type: 'image/gif' })
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// ─── Public API ────────────────────────────────────────────────────────────
export async function compressAvatar(file: File): Promise<string> {
  if (file.type === 'image/gif') {
    if (file.size > GIF_MAX_INPUT) {
      throw new Error(`GIF слишком большой (макс ${GIF_MAX_INPUT / 1024 / 1024} МБ)`)
    }
    return compressGif(file)
  }
  return compressStatic(file)
}
