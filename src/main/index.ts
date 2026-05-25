import { app, BrowserWindow, ipcMain, desktopCapturer, session, screen } from 'electron'
import { join } from 'path'
import { networkInterfaces } from 'os'
import { autoUpdater } from 'electron-updater'
import { startServer, stopServer } from './signalingServer'
import { initSteam, setupSteamIPC } from './steam'

const isDev = process.env['NODE_ENV'] === 'development'
const SIGNAL_PORT = 3001

let borderOverlay: BrowserWindow | null = null
let pendingCaptureSourceId = ''
let updateWindow: BrowserWindow | null = null

function getLocalIp(): string {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return '127.0.0.1'
}

function createUpdateHtml(): string {
  const html = `<!DOCTYPE html>
<html>
<head>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#1e1f22;color:#dbdee1;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;user-select:none;-webkit-app-region:drag}
.logo{width:64px;height:64px;background:#5865f2;border-radius:16px;display:flex;align-items:center;justify-content:center;margin-bottom:16px}
.logo svg{width:36px;height:36px;fill:#fff}
.app-name{font-size:18px;font-weight:700;margin-bottom:8px}
.status{font-size:13px;color:#949ba4}
.progress-wrap{width:240px;height:4px;background:#2b2d31;border-radius:2px;margin-top:16px;overflow:hidden;display:none}
.progress-wrap.active{display:block}
.progress-bar{height:100%;background:#5865f2;border-radius:2px;width:0%;transition:width .2s}
.pct-text{font-size:12px;color:#949ba4;margin-top:6px;display:none}
.pct-text.active{display:block}
</style>
</head>
<body>
<div class="logo"><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg></div>
<div class="app-name">Rawcord</div>
<div class="status" id="status">Проверка обновлений...</div>
<div class="progress-wrap" id="progressWrap"><div class="progress-bar" id="progressBar"></div></div>
<div class="pct-text" id="pctText">0%</div>
<script>
function setStatus(s){var e=document.getElementById('status'),w=document.getElementById('progressWrap'),p=document.getElementById('pctText');switch(s){case'checking':e.textContent='Проверка обновлений...';w.classList.remove('active');p.classList.remove('active');break;case'downloading':e.textContent='Загрузка обновления...';w.classList.add('active');p.classList.add('active');break;case'ready':e.textContent='Готово';w.classList.remove('active');p.classList.remove('active');break;case'downloaded':e.textContent='Обновление загружено';w.classList.remove('active');p.classList.remove('active')}}
function setProgress(p){document.getElementById('progressBar').style.width=p+'%';document.getElementById('pctText').textContent=p+'%'}
</script>
</body>
</html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

function showUpdateWindow(): Promise<void> {
  return new Promise((resolve) => {
    updateWindow = new BrowserWindow({
      width: 400,
      height: 260,
      resizable: false,
      frame: false,
      show: false,
      backgroundColor: '#1e1f22',
      webPreferences: {
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    updateWindow.on('ready-to-show', () => {
      updateWindow?.show()
    })

    updateWindow.loadURL(createUpdateHtml())

    if (!app.isPackaged) {
      setTimeout(() => {
        updateWindow?.close()
        updateWindow = null
        resolve()
      }, 1500)
      return
    }

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    function send(js: string) {
      updateWindow?.webContents.executeJavaScript(js).catch(() => {})
    }

    autoUpdater.on('checking-for-update', () => send('setStatus("checking")'))
    autoUpdater.on('update-available', () => {
      send('setStatus("downloading")')
      autoUpdater.downloadUpdate().catch(() => {})
    })
    autoUpdater.on('update-not-available', () => {
      send('setStatus("ready")')
      setTimeout(() => {
        updateWindow?.close()
        updateWindow = null
        resolve()
      }, 1000)
    })
    autoUpdater.on('download-progress', (p) => {
      send(`setProgress(${Math.round(p.percent)})`)
    })
    autoUpdater.on('update-downloaded', () => {
      send('setStatus("downloaded")')
      setTimeout(() => {
        updateWindow?.close()
        updateWindow = null
        autoUpdater.quitAndInstall(true, true)
      }, 500)
    })
    autoUpdater.on('error', () => {
      updateWindow?.close()
      updateWindow = null
      resolve()
    })

    autoUpdater.checkForUpdates().catch(() => {
      updateWindow?.close()
      updateWindow = null
      resolve()
    })
  })
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

app.whenReady().then(async () => {
  initSteam()
  setupSteamIPC()

  await showUpdateWindow()
  createWindow()

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
