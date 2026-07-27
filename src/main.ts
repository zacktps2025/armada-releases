import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BrowserWindow, Menu, app, dialog, ipcMain, session, shell } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * ARMADA, AS A PROGRAM YOU INSTALL.
 *
 * Deliberately a THIN SHELL around the deployed web client rather than a copy
 * of it. That one decision is what makes this cheap to own:
 *
 *   - The game updates the moment the web app deploys. There is no patch to
 *     ship, no version handshake, and no way for a player to be running last
 *     week's rules against this week's server.
 *   - The shell itself changes about once a quarter, so auto-update is a
 *     safety net rather than a treadmill.
 *   - There is exactly one client codebase. `packages/sim` was always the
 *     permanent artifact and the client always disposable; this keeps it that
 *     way instead of forking the renderer in two.
 *
 * What it is NOT is a browser with the chrome hidden. The four things a tab
 * cannot do are the whole reason this exists:
 *
 *   1. It picks the right GPU. On a hybrid-graphics handheld a browser will
 *      happily render on the integrated chip forever. See the switches below.
 *   2. It is never throttled. A backgrounded tab has its timers and rAF
 *      slashed; an always-on world watched on a second monitor is exactly the
 *      case browsers optimise against.
 *   3. It stays signed in. The session is a persistent partition on disk, so
 *      logging in is something you do once, not every time.
 *   4. It is an icon you double click, not a URL someone has to find.
 */

/**
 * Where the game lives, in order of preference.
 *
 * The domain first, because that is the name the game has. The Vercel host
 * second, because it is the same deployment and it cannot be broken by a DNS
 * record — and an installer already on somebody's machine is the worst possible
 * place to discover a nameserver problem.
 *
 * Resolved once at startup by asking each in turn, so a launcher shipped today
 * keeps working if the domain moves, lapses, or was never propagated where this
 * particular player is sitting.
 */
const SITES = process.env.ARMADA_SITE
  ? [process.env.ARMADA_SITE]
  : ['https://armadagame.io', 'https://armada-gray.vercel.app']

let SITE = SITES[0]!

/**
 * How the game recognises its own client.
 *
 * Armada is a game you install. The site will not open the world to a plain
 * browser, and this string is how it tells the difference. It is not a secret
 * and it is not security — anyone determined can forge a user agent. It is a
 * product boundary, and the only thing it has to survive is honesty.
 */
const CLIENT_UA = 'Armada-Desktop/1'
const HEALTH = process.env.ARMADA_HEALTH ?? 'https://armada-server-production.up.railway.app/health'

/**
 * Pick the first host that answers.
 *
 * Deliberately a HEAD against the download page rather than the game: /play
 * redirects to sign-in, and following that just to learn whether DNS resolves
 * is a round trip spent on nothing.
 */
async function resolveSite(): Promise<void> {
  for (const candidate of SITES) {
    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), 4000)
    try {
      const response = await fetch(`${candidate}/download`, {
        method: 'HEAD',
        signal: control.signal,
      })
      if (response.ok) {
        SITE = candidate
        return
      }
    } catch {
      // Unreachable. Try the next one.
    } finally {
      clearTimeout(timer)
    }
  }
  // Nothing answered. Keep the first and let the launcher report it honestly
  // rather than silently pointing somewhere that also will not work.
  console.error('[armada] No host answered; falling back to', SITE)
}

/**
 * GPU switches. These must be set before `app.whenReady`, which is why they are
 * at module scope rather than tucked into a function.
 *
 * `force_high_performance_gpu` is the load-bearing one and the single biggest
 * reason a packaged build can outrun the same code in a tab. A ROG Ally X, and
 * every laptop with switchable graphics, will default a browser to the power
 * saving adapter; this asks the platform for the fast one explicitly.
 *
 * Frame rate and vsync are deliberately left alone. Uncapping them on a
 * handheld buys tearing and fan noise, not smoothness.
 */
app.commandLine.appendSwitch('force_high_performance_gpu')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
// A world that keeps running deserves a client that keeps rendering. Without
// these, minimising the window quietly stops the game being watchable.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

let launcher: BrowserWindow | null = null
let game: BrowserWindow | null = null

// ---------------------------------------------------------------------------
// Window bounds, remembered
// ---------------------------------------------------------------------------

interface Bounds {
  width: number
  height: number
  x?: number
  y?: number
  fullscreen?: boolean
}

const boundsFile = (): string => join(app.getPath('userData'), 'window.json')

function loadBounds(): Bounds {
  try {
    const saved = JSON.parse(readFileSync(boundsFile(), 'utf8')) as Bounds
    if (typeof saved.width === 'number' && typeof saved.height === 'number') return saved
  } catch {
    // First run, or a file we wrote in an older shape. Either way, defaults.
  }
  return { width: 1440, height: 880 }
}

function saveBounds(window: BrowserWindow): void {
  try {
    const bounds = window.isFullScreen() ? loadBounds() : window.getBounds()
    writeFileSync(boundsFile(), JSON.stringify({ ...bounds, fullscreen: window.isFullScreen() }))
  } catch {
    // Losing the remembered size is not worth interrupting anyone over.
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function createLauncher(): void {
  launcher = new BrowserWindow({
    width: 480,
    height: 620,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#070A14',
    show: false,
    autoHideMenuBar: true,
    title: 'Armada',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  void launcher.loadFile(join(__dirname, '..', 'launcher', 'index.html'))
  launcher.once('ready-to-show', () => launcher?.show())
  launcher.on('closed', () => {
    launcher = null
    // Closing the launcher before the game has opened means "I changed my mind".
    if (!game) app.quit()
  })
}

function createGame(): void {
  const saved = loadBounds()

  game = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#070A14',
    show: false,
    autoHideMenuBar: true,
    title: 'Armada',
    webPreferences: {
      // A persistent partition is what makes signing in a once-ever thing.
      partition: 'persist:armada',
      contextIsolation: true,
      nodeIntegration: false,
      // The world is always on and often watched rather than played. Never let
      // Chromium decide this window has stopped mattering.
      backgroundThrottling: false,
    },
  })

  if (saved.fullscreen) game.setFullScreen(true)

  // Sent on the navigation AND pinned on the session, so every later request —
  // the reconnect, the ticket fetch, an auth redirect — carries it too. Setting
  // it only on the first load is the classic way this breaks the moment
  // somebody signs in.
  game.webContents.setUserAgent(`${game.webContents.getUserAgent()} ${CLIENT_UA}`)
  void game.loadURL(`${SITE}/play`, { userAgent: game.webContents.getUserAgent() })

  game.once('ready-to-show', () => {
    game?.show()
    // The launcher has done its job. Keep it alive but out of the way so the
    // taskbar shows one Armada, not two.
    launcher?.hide()
  })

  /**
   * F11 toggles fullscreen. Escape deliberately does NOT leave it: Escape is
   * the game's own "cancel what I was placing", and stealing it would make the
   * build flow feel broken in the packaged app but fine in a browser.
   */
  game.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const toggle = input.key === 'F11' || (input.alt && input.key === 'Enter')
    if (toggle) {
      event.preventDefault()
      game?.setFullScreen(!game.isFullScreen())
    }
  })

  // Links to anywhere else are the operating system's business, not ours. This
  // is also the rule that stops a stray link turning the game window into a
  // browser with no way back.
  game.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  game.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(SITE)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  /**
   * The server being unreachable must look like a server being unreachable.
   * Without this the player gets Chromium's error page inside a frameless
   * window, which reads as the game being broken.
   */
  game.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 is an aborted navigation, not a failure
    game?.hide()
    launcher?.show()
    launcher?.webContents.send('armada:offline', { description, url })
  })

  game.on('close', () => {
    if (game) saveBounds(game)
  })
  game.on('closed', () => {
    game = null
    app.quit()
  })
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

ipcMain.handle('armada:version', () => app.getVersion())

/**
 * Is there a world to join?
 *
 * The launcher asks before it offers a Play button, because the honest failure
 * is "the sky is down, try again shortly" and the dishonest one is a white
 * window. Short timeout: this is a liveness check, not a download.
 */
ipcMain.handle('armada:status', async () => {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), 6000)
  try {
    const response = await fetch(HEALTH, { signal: control.signal })
    if (!response.ok) return { online: false }
    const body = (await response.json()) as { ok?: boolean; players?: number; tick?: number }
    return { online: body.ok === true, players: body.players ?? 0, tick: body.tick ?? 0 }
  } catch {
    return { online: false }
  } finally {
    clearTimeout(timer)
  }
})

ipcMain.handle('armada:play', () => {
  if (game) {
    game.show()
    game.focus()
    return
  }
  createGame()
})

ipcMain.handle('armada:quit', () => app.quit())

ipcMain.handle('armada:signOut', async () => {
  // The one thing a persistent session needs: a way out of it. Without this a
  // shared handheld has no way to hand the game to someone else.
  await session.fromPartition('persist:armada').clearStorageData()
  return true
})

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/**
 * The shell patches itself; the game never needs to.
 *
 * Because the client is served, an update here is only ever about the window
 * around it — a GPU flag, a new key binding, a fixed crash. That is why this is
 * allowed to be quiet: download in the background, install on the next launch,
 * and never interrupt a night that is already running.
 */
function checkForUpdates(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', (info) => {
    launcher?.webContents.send('armada:updateReady', { version: info.version })
  })
  autoUpdater.on('error', (error) => {
    // An update that cannot be fetched must never block playing.
    console.error('[armada] update check failed:', error?.message ?? error)
  })

  void autoUpdater.checkForUpdates()
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Two copies of an always-on client would fight over one account's session.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = game ?? launcher
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.whenReady().then(() => {
    // No File/Edit/View menu. This is a game.
    Menu.setApplicationMenu(null)
    // Before any window: the launcher's Play button opens SITE, so it has to be
    // decided before there is a button to press.
    void resolveSite().finally(() => createLauncher())
    checkForUpdates()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createLauncher()
    })
  })

  app.on('window-all-closed', () => app.quit())
}

/** Surfaced rather than swallowed: a silent crash is the worst kind. */
process.on('uncaughtException', (error) => {
  dialog.showErrorBox('Armada', error.stack ?? String(error))
})
