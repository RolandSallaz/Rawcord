import { app, BrowserWindow, ipcMain, desktopCapturer, session, screen } from 'electron'
import { join } from 'path'
import { networkInterfaces } from 'os'
import { autoUpdater } from 'electron-updater'
import { startServer, stopServer } from './signalingServer'

const isDev = process.env['NODE_ENV'] === 'development'
const SIGNAL_PORT = 3001

let borderOverlay: BrowserWindow | null = null
let pendingCaptureSourceId = ''

function getLocalIp(): string {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return '127.0.0.1'
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', () => autoUpdater.quitAndInstall(true, true))
  autoUpdater.checkForUpdates().catch(() => {})
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1f22',
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
    if (isDev) win.webContents.openDevTools({ mode: 'detach' })
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Window controls
ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
ipcMain.on('win:maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (win) win.isMaximized() ? win.unmaximize() : win.maximize()
})
ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

// Signaling server
ipcMain.handle('server:start', async (_event, port?: number) => {
  const p = port ?? SIGNAL_PORT
  await startServer(p)
  return { port: p, ip: getLocalIp() }
})

ipcMain.handle('server:stop', async () => {
  stopServer()
})

// Screen capture sources (for picker UI)
ipcMain.handle('screen:getSources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  })
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    type: s.id.startsWith('screen:') ? 'screen' : 'window',
  }))
})

// Store pending source ID; renderer calls this then immediately calls getDisplayMedia()
ipcMain.handle('screen:capture', async (_event, sourceId: string) => {
  pendingCaptureSourceId = sourceId
})

// Yellow border overlay for the captured screen
ipcMain.handle('screen:showBorder', async (_event, sourceId: string) => {
  borderOverlay?.close()
  borderOverlay = null

  if (!sourceId.startsWith('screen:')) return  // windows: skip for now

  const displays = screen.getAllDisplays()
  // desktopCapturer screen IDs: "screen:DISPLAY_ID:0"
  const rawId = parseInt(sourceId.split(':')[1] ?? '0', 10)
  const display = displays.find(d => d.id === rawId) ?? displays[0]
  if (!display) return

  borderOverlay = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  borderOverlay.setIgnoreMouseEvents(true)
  await borderOverlay.loadURL(
    'data:text/html,<!DOCTYPE html><html><head><style>' +
    'html,body{margin:0;overflow:hidden;background:transparent;}' +
    '.b{position:fixed;inset:0;border:3px solid #f0b429;box-sizing:border-box;pointer-events:none;border-radius:2px;}' +
    '</style></head><body><div class="b"></div></body></html>'
  )
})

ipcMain.handle('screen:hideBorder', async () => {
  borderOverlay?.close()
  borderOverlay = null
})

app.whenReady().then(() => {
  createWindow()

  // Electron 17+ recommended: use setDisplayMediaRequestHandler so getDisplayMedia()
  // captures the specific source chosen in the UI (avoids WGC "not capturable" errors).
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    if (!pendingCaptureSourceId) { callback({}); return }
    const id = pendingCaptureSourceId
    pendingCaptureSourceId = ''
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      })
      const source = sources.find(s => s.id === id)
      if (source) callback({ video: source })
      else callback({})
    } catch {
      callback({})
    }
  })

  if (app.isPackaged) setupAutoUpdater()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopServer()
  borderOverlay?.close()
  borderOverlay = null
  if (process.platform !== 'darwin') app.quit()
})
