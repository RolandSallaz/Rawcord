export const SIGNALING_URL = import.meta.env.DEV
  ? 'ws://localhost:3001'
  : 'wss://rawcord-signaling.up.railway.app'
