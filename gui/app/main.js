'use strict'

require('babel-polyfill')

const AutoLaunch = require('auto-launch-patched')
const Desktop = require('cozy-desktop').default
const electron = require('electron')
const notify = require('electron-main-notification')
const fs = require('fs')
const debounce = require('lodash.debounce')
const os = require('os')
const path = require('path')
const {spawn} = require('child_process')

const {app, BrowserWindow, dialog, ipcMain, Menu, shell, session} = electron
const autoUpdater = require('electron-updater').autoUpdater
const autoLauncher = new AutoLaunch({
  name: 'Cozy-Desktop',
  isHidden: true
})
const desktop = new Desktop(process.env.COZY_DESKTOP_DIR)
const lastFilesPath = path.join(desktop.basePath, 'last-files')

app.locale = 'en'
const setUpLocale = () => {
  const locale = app.getLocale()
  if (locale === 'fr' || locale.match(/^fr_/i)) {
    app.locale = 'fr'
  } else {
    app.locale = 'en'
  }
}

app.translations = {}
const setUpTranslations = () => {
  app.translations = require(`./locales/${app.locale}.json`)
}

const translate = key => app.translations[key] ||
  key.substr(key.indexOf(' ') + 1) // Key without prefix

const interpolate = (string, ...args) => {
  return string.replace(/{(\d+)}/g, (_, index) => args[parseInt(index)])
}

const platformName = () => {
  switch (process.platform) {
    case 'darwin': return 'macOS'
    case 'freebsd': return 'FreeBSD'
    case 'linux': return 'Linux'
    case 'sunos': return 'SunOS'
    case 'win32': return 'Windows'
    default: return process.platform
  }
}

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow
let tray
let diskTimeout

let state = 'not-configured'
let errorMessage = ''
let lastFiles = []
let newReleaseAvailable = false

const windowOptions = {
  width: 1024,
  height: 768,
  icon: `${__dirname}/images/icon.png`
}

const showWindow = () => {
  if (mainWindow) {
    mainWindow.focus()
  } else {
    createWindow()
  }
}

const sendToMainWindow = (...args) => {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send(...args)
  }
}

const sendErrorToMainWindow = (msg) => {
  if (msg === 'Client has been revoked') {
    msg = translate('Revoked It looks like you have revoked your client from your Cozy')
    sendToMainWindow('revoked')
  } else if (msg === 'Cozy is full' || msg === 'No more disk space') {
    msg = translate('Error ' + msg)
    sendToMainWindow('sync-error', msg)
  } else {
    sendToMainWindow('sync-error', msg)
  }
  notify('Cozy-Desktop', { body: msg })
}

const goToTab = (tab) => {
  const alreadyShown = !!mainWindow
  showWindow()
  if (alreadyShown) {
    sendToMainWindow('go-to-tab', tab)
  } else {
    mainWindow.webContents.once('dom-ready', () => {
      sendToMainWindow('go-to-tab', tab)
    })
  }
}

const goToMyCozy = () => {
  shell.openExternal(desktop.config.cozyUrl)
}

const openCozyFolder = () => {
  shell.openItem(desktop.config.syncPath)
}

const buildAppMenu = () => {
  const template = [
    {
      label: translate('AppMenu Edit'),
      submenu: [
        { label: translate('AppMenu Undo'), accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: translate('AppMenu Redo'), accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
        { type: 'separator' },
        { label: translate('AppMenu Select All'), accelerator: 'CmdOrCtrl+A', role: 'selectall' },
        { type: 'separator' },
        { label: translate('AppMenu Cut'), accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: translate('AppMenu Copy'), accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: translate('AppMenu Paste'), accelerator: 'CmdOrCtrl+V', role: 'paste' }
      ]
    },
    {
      label: translate('AppMenu Window'),
      role: 'window',
      submenu: [
        { label: translate('AppMenu Minimize'), accelerator: 'CmdOrCtrl+M', role: 'minimize' },
        { label: translate('AppMenu Close'), accelerator: 'CmdOrCtrl+W', role: 'close' }
      ]
    }
  ]

  if (process.platform === 'darwin') {
    template.unshift({
      label: 'Cozy Desktop',
      submenu: [
        { label: translate('AppMenu Hide Cozy Desktop'), accelerator: 'Command+H', role: 'hide' },
        { label: translate('AppMenu Hide Others'), accelerator: 'Command+Alt+H', role: 'hideothers' },
        { label: translate('AppMenu Show All'), role: 'unhide' },
        { type: 'separator' },
        { label: translate('AppMenu Quit'), accelerator: 'Command+Q', click () { app.quit() } }
      ]
    })
    template[2].submenu.push({ type: 'separator' })
    template[2].submenu.push({ label: translate('AppMenu Bring All to Front'), role: 'front' })
  }

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

const setTrayIcon = (state) => {
  if (process.platform === 'darwin') {
    tray.setImage(`${__dirname}/images/tray-icon-osx/${state}Template.png`)
    tray.setPressedImage(`${__dirname}/images/tray-icon-osx/${state}Highlight.png`)
  } else {
    tray.setImage(`${__dirname}/images/tray-icon-linux/${state}.png`)
  }
}

const checkForNewRelease = () => {
  const platform = os.platform()
  if (platform !== 'darwin' && platform !== 'win32') {
    return
  }
  autoUpdater.addListener('update-downloaded', (updateInfo) => {
    const releaseName = updateInfo.version || 'unknown'
    const releaseNotes = updateInfo.releaseName || `New version ${releaseName} available`
    newReleaseAvailable = true
    sendToMainWindow('new-release-available', releaseNotes, releaseName)
  })
  autoUpdater.addListener('error', (err) => console.error(err))
  autoUpdater.checkForUpdates()
  setInterval(() => {
    autoUpdater.checkForUpdates()
  }, 1000 * 60 * 60 * 24) // Check if a new release is available once per day
}

const updateState = (newState, filename) => {
  if (state === 'error' && newState === 'offline') {
    return
  }
  state = newState
  let statusLabel = ''
  if (state === 'error') {
    setTrayIcon('error')
    statusLabel = errorMessage = filename
  } else if (filename) {
    setTrayIcon('sync')
    statusLabel = `${translate('Tray Syncing')} ‟${filename}“`
  } else if (state === 'up-to-date' || state === 'online') {
    setTrayIcon('idle')
    statusLabel = translate('Tray Your cozy is up to date')
  } else if (state === 'syncing') {
    setTrayIcon('sync')
    statusLabel = translate('Tray Syncing') + '…'
  } else if (state === 'offline') {
    setTrayIcon('pause')
    statusLabel = translate('Tray Offline')
  }
  const menu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    { label: translate('Tray Open Cozy folder'), click: openCozyFolder },
    { label: translate('Tray Go to my Cozy'), click: goToMyCozy },
    { type: 'separator' },
    { label: translate('Tray Help'), click: goToTab.bind(null, 'help') },
    { label: translate('Tray Settings'), click: goToTab.bind(null, 'settings') },
    { type: 'separator' },
    { label: translate('Tray Quit application'), click: app.quit }
  ])
  if (!mainWindow) {
    menu.insert(2, new electron.MenuItem({
      label: translate('Tray Show application'), click: showWindow
    }))
  }
  if (state === 'error') {
    menu.insert(2, new electron.MenuItem({
      label: translate('Tray Relaunch synchronization'), click: () => { startSync(true) }
    }))
  }
  if (newReleaseAvailable) {
    menu.insert(2, new electron.MenuItem({
      label: translate('Tray A new release is available'), click: goToTab.bind(null, 'settings')
    }))
  }
  tray.setContextMenu(menu)
  tray.setToolTip(statusLabel)
}

const selectIcon = (info) => {
  if (['image', 'video'].indexOf(info.class) !== -1) {
    return info.class
  } else if (info.class === 'music') {
    return 'audio'
  } else if (info.mime === 'application/pdf') {
    return 'pdf'
  } else if (info.mime === 'application/x-binary') {
    return 'binary'
  } else if (!info.mime) {
    return 'file'
  } else if (info.mime.match(/[/-][bg]?zip2?$/)) {
    return 'archive'
  } else if (info.mime.match(/^(text|application)\/(html|xml)/)) {
    return 'code'
  } else if (info.mime.match(/^text\//)) {
    return 'text'
  } else if (info.mime.match(/^application\/.*rtf/)) {
    return 'text'
  } else if (info.mime.match(/word/)) {
    return 'text'
  } else if (info.mime.match(/powerpoint/)) {
    return 'presentation'
  } else if (info.mime.match(/excel/)) {
    return 'spreadsheet'
  }
  return 'file'
}

const loadLastFiles = () => {
  fs.readFile(lastFilesPath, 'utf-8', (err, data) => {
    if (!err && data) {
      try {
        lastFiles = JSON.parse(data)
      } catch (err) {}
    }
  })
}

const persistLastFiles = () => {
  const data = JSON.stringify(lastFiles)
  fs.writeFile(lastFilesPath, data, (err) => {
    if (err) {
      console.log(err)
    }
  })
}

const addFile = (info) => {
  const file = {
    filename: path.basename(info.path),
    path: info.path,
    icon: selectIcon(info),
    size: info.size || 0,
    updated: +new Date()
  }
  updateState('syncing', file.filename)
  lastFiles.push(file)
  lastFiles = lastFiles.slice(-250)
  sendToMainWindow('transfer', file)
  persistLastFiles()
}

const removeFile = (info) => {
  const file = {
    filename: path.basename(info.path),
    path: info.path,
    icon: '',
    size: 0,
    updated: 0
  }
  lastFiles = lastFiles.filter((f) => f.path !== file.path)
  sendToMainWindow('delete-file', file)
  persistLastFiles()
}

const sendDiskUsage = () => {
  if (diskTimeout) {
    clearTimeout(diskTimeout)
    diskTimeout = null
  }
  if (mainWindow) {
    diskTimeout = setTimeout(sendDiskUsage, 10 * 60 * 1000)  // every 10 minutes
    desktop.diskUsage().then(
      (res) => {
        const space = {
          used: +res.attributes.used,
          quota: +res.attributes.quota
        }
        sendToMainWindow('disk-space', space)
      },
      (err) => console.error(err)
    )
  }
}

const chooseSyncPath = () => {
  sendToMainWindow('registration-done')
}

const incompatibilitiesErrorMessage = (i) => {
  const reasons = []
  const docType = translate(`Helpers ${i.docType}`)
  if (i.reservedChars) {
    reasons.push(
      interpolate(
        translate('Error {0} names cannot include characters {1}'),
        docType,
        Array.from(i.reservedChars).join(' ')
      )
    )
  }
  if (i.reservedName) {
    reasons.push(
      interpolate(
        translate('Error the “{0}” name is reserved'),
        i.reservedName
      )
    )
  }
  if (i.forbiddenLastChar) {
    reasons.push(
      interpolate(
        translate('Error {0} names cannot end with character {1}'),
        docType,
        i.forbiddenLastChar
      )
    )
  }
  if (i.pathMaxBytes) {
    reasons.push(interpolate(
      translate('Error it exceeds the path size limit'),
      docType
    ))
  }
  if (i.nameMaxBytes) {
    reasons.push(interpolate(
      translate('Error it exceeds the name size limit'),
      docType
    ))
  }
  if (i.dirNameMaxBytes) {
    reasons.push(interpolate(
      translate('Error it exceeds the folder name size limit'),
      docType
    ))
  }
  return interpolate(
    translate(
      'Error The “{0}” {1} cannot be synchronized locally because ' +
      '{2} on the {3} system.'
    ),
    i.name,
    docType,
    reasons.join(` ${translate('Helpers and')} `),
    platformName()
  ) + '\n\n' + translate('Error You should rename it in your Cozy.')
}

const startSync = (force) => {
  sendToMainWindow('synchronization', desktop.config.cozyUrl, desktop.config.deviceName)
  for (let file of lastFiles) {
    sendToMainWindow('transfer', file)
  }
  if (desktop.sync && !force) {
    if (state === 'up-to-date' || state === 'online') {
      sendToMainWindow('up-to-date')
    } else if (state === 'offline') {
      sendToMainWindow('offline')
    } else if (state === 'error') {
      sendErrorToMainWindow(errorMessage)
    }
    sendDiskUsage()
  } else {
    updateState('syncing')
    desktop.events.on('up-to-date', () => {
      updateState('up-to-date')
      sendToMainWindow('up-to-date')
    })
    desktop.events.on('online', () => {
      updateState('online')
      sendToMainWindow('up-to-date')
    })
    desktop.events.on('offline', () => {
      updateState('offline')
      sendToMainWindow('offline')
    })
    desktop.events.on('transfer-started', addFile)
    desktop.events.on('transfer-copy', addFile)
    desktop.events.on('transfer-move', (info, old) => {
      addFile(info)
      removeFile(old)
    })
    const notifyIncompatibilities = debounce(
      (incompatibilities) => {
        sendErrorToMainWindow(incompatibilitiesErrorMessage(incompatibilities))
      },
      5000,
      {leading: true}
    )
    desktop.events.on('platform-incompatibilities', incompatibilitiesList => {
      incompatibilitiesList.forEach(incompatibilities => {
        notifyIncompatibilities(incompatibilities)
      })
    })
    desktop.events.on('delete-file', removeFile)
    desktop.synchronize('full')
      .then(() => sendErrorToMainWindow('stopped'))
      .catch((err) => {
        console.error(err)
        updateState('error', err.message)
        sendDiskUsage()
        sendErrorToMainWindow(err.message)
      })
    sendDiskUsage()
  }
  autoLauncher.isEnabled().then((enabled) => {
    sendToMainWindow('auto-launch', enabled)
  })
}

const appLoaded = () => {
  if (!desktop.config.isValid()) {
    return
  }
  if (desktop.config.syncPath) {
    setTimeout(startSync, 20)
  } else {
    setTimeout(chooseSyncPath, 20)
  }
}

const createWindow = () => {
  mainWindow = new BrowserWindow(windowOptions)
  mainWindow.loadURL(`file://${__dirname}/index.html`)
  if (process.env.WATCH === 'true' || process.env.DEBUG === 'true') {
    mainWindow.setBounds({ x: 0, y: 0, width: 1600, height: 768 })
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.setMenu(null)
  }
  mainWindow.on('closed', () => {
    if (process.platform === 'darwin') { app.dock.hide() }
    mainWindow = null
  })
  mainWindow.webContents.on('dom-ready', appLoaded)
  if (process.platform === 'darwin') { app.dock.show() }
}

loadLastFiles()

const shouldExit = app.makeSingleInstance(showWindow)
if (shouldExit) {
  console.log('Cozy Desktop is already running. Exiting...')
  app.exit()
}

app.on('ready', () => {
  setUpLocale()
  setUpTranslations()
  if (process.argv.indexOf('--hidden') === -1) {
    createWindow()
  } else {
    appLoaded()
  }
  tray = new electron.Tray(`${__dirname}/images/tray-icon-linux/idle.png`)
  setTrayIcon('idle')
  const menu = electron.Menu.buildFromTemplate([
    { label: translate('Tray Show application'), click: showWindow },
    { label: translate('Tray Quit application'), click: app.quit }
  ])
  tray.setContextMenu(menu)
  tray.on('click', showWindow)

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', showWindow)
})

// Don't quit the app when all windows are closed, keep the tray icon
// See http://electron.atom.io/docs/api/app/#event-window-all-closed
app.on('window-all-closed', () => {})

ipcMain.on('register-remote', (event, arg) => {
  const cozyUrl = desktop.checkCozyUrl(arg.cozyUrl)
  desktop.config.cozyUrl = cozyUrl
  const onRegistered = (client, url) => {
    let resolveP
    const promise = new Promise((resolve) => { resolveP = resolve })
    mainWindow.loadURL(url)
    mainWindow.webContents.on('did-get-redirect-request', (event, oldUrl, newUrl) => {
      if (newUrl.match('file://')) {
        resolveP(newUrl)
      }
    })
    return promise
  }
  desktop.registerRemote(cozyUrl, arg.location, onRegistered)
    .then(
      (reg) => {
        session.defaultSession.clearStorageData()
        mainWindow.loadURL(reg.client.redirectURI)
      },
      (err) => {
        console.error(err)
        event.sender.send('registration-error', 'No cozy instance at this address!')
      }
    )
})

ipcMain.on('choose-folder', (event) => {
  let folders = dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  })
  if (folders && folders.length > 0) {
    event.sender.send('folder-chosen', folders[0])
  }
})

ipcMain.on('start-sync', (event, arg) => {
  if (!desktop.config.isValid()) {
    console.error('No client!')
    return
  }
  try {
    desktop.saveConfig(desktop.config.cozyUrl, arg)
    startSync()
  } catch (err) {
    event.sender.send('folder-error', translate('Error Invalid path'))
  }
})

ipcMain.on('quit-and-install', () => {
  autoUpdater.quitAndInstall()
})

ipcMain.on('auto-launcher', (event, enabled) => {
  autoLauncher.isEnabled().then((was) => {
    if (was !== enabled) {
      if (enabled) {
        autoLauncher.enable()
      } else {
        autoLauncher.disable()
      }
    }
  })
})

ipcMain.on('logout', () => {
  desktop.removeConfig()
  sendToMainWindow('unlinked')
})

ipcMain.on('unlink-cozy', () => {
  if (!desktop.config.isValid()) {
    console.error('No client!')
    return
  }
  const options = {
    type: 'question',
    title: translate('Unlink Title'),
    message: translate('Unlink Message'),
    detail: translate('Unlink Detail'),
    buttons: [translate('Unlink Cancel'), translate('Unlink OK')],
    cancelId: 0,
    defaultId: 1
  }
  dialog.showMessageBox(mainWindow, options, (response) => {
    if (response === 0) {
      sendToMainWindow('cancel-unlink')
      return
    }
    desktop.stopSync().then(() => {
      desktop.removeRemote()
        .then(() => console.log('removed'))
        .then(() => sendToMainWindow('unlinked'))
        .catch((err) => console.error('err', err))
    })
  })
})

ipcMain.on('send-mail', (event, body) => {
  desktop.sendMailToSupport(body, (err) => {
    event.sender.send('mail-sent', err)
  })
})

ipcMain.on('restart', () => {
  setTimeout(app.quit, 50)
  const args = process.argv.slice(1).filter(a => a !== '--isHidden')
  spawn(process.argv[0], args, { detached: true })
})

// On watch mode, automatically reload the window when sources are updated
if (process.env.WATCH === 'true') {
  const chokidar = require('chokidar')
  chokidar.watch(['*.{html,js,css}'], { cwd: __dirname })
    .on('change', () => {
      if (mainWindow) {
        mainWindow.reload()
      }
    })
} else {
  app.once('ready', () => {
    buildAppMenu()
    checkForNewRelease()
  })
}

// Network requests can be stuck with Electron on Linux inside the event loop.
// A hack to deblock them is push some events in the event loop.
// See https://github.com/electron/electron/issues/7083#issuecomment-262038387
// And https://github.com/electron/electron/issues/1833
if (process.platform === 'linux') {
  setInterval(() => {}, 1000)
}
