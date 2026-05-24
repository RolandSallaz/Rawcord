import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { networkInterfaces } from 'os'
import { autoUpdater } from 'electron-updater'
import { startServer, stopServer } from './signalingServer'

const isDev = process.env['NODE_ENV'] === 'development'
const SIGNAL_PORT = 3001

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
ipcMain.handle('server:start', async () => {
  await startServer(SIGNAL_PORT)
  return { port: SIGNAL_PORT, ip: getLocalIp() }
})

ipcMain.handle('server:stop', async () => {
  stopServer()
})

app.whenReady().then(() => {
  createWindow()
  if (app.isPackaged) setupAutoUpdater()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopServer()
  if (process.platform !== 'darwin') app.quit()
})
