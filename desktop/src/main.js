const { app, BrowserWindow, Tray, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const fs = require('fs');

// Determine if running in development or packaged
const isDev = process.argv.includes('--dev');
const isPackaged = app.isPackaged;

// Paths
const getBackendPath = () => {
  if (isDev) return path.join(__dirname, '..', '..');  // backend repo root
  if (isPackaged) return path.join(process.resourcesPath, 'backend');
  return path.join(__dirname, '..', 'bundled', 'backend');
};

const BACKEND_PATH = getBackendPath();
const BACKEND_ENTRY = path.join(BACKEND_PATH, 'src', 'server.js');
const DEFAULT_PORT = 3000;

let mainWindow = null;
let tray = null;
let backendProcess = null;
let serverPort = DEFAULT_PORT;
let serverStatus = 'stopped'; // stopped | starting | running | error

// ─── Backend Process Management ────────────────────────────────────────────

function startBackend() {
  if (backendProcess) return;

  serverStatus = 'starting';
  sendStatusToWindow();

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(serverPort),
    DEPLOYMENT_MODE: 'local',
  };

  // Load .env file from backend if exists
  const envFile = path.join(BACKEND_PATH, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        env[key] = value;
      }
    }
  }

  try {
    backendProcess = fork(BACKEND_ENTRY, [], {
      cwd: BACKEND_PATH,
      env,
      silent: true,
    });

    backendProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      log('backend', msg.trim());
      if (msg.includes('Server running') || msg.includes('listening')) {
        serverStatus = 'running';
        sendStatusToWindow();
      }
    });

    backendProcess.stderr.on('data', (data) => {
      log('backend:err', data.toString().trim());
    });

    backendProcess.on('exit', (code) => {
      log('system', `Backend exited with code ${code}`);
      backendProcess = null;
      serverStatus = code === 0 ? 'stopped' : 'error';
      sendStatusToWindow();
    });

    backendProcess.on('error', (err) => {
      log('system', `Backend error: ${err.message}`);
      backendProcess = null;
      serverStatus = 'error';
      sendStatusToWindow();
    });

    // Give it a moment then assume running if no crash
    setTimeout(() => {
      if (serverStatus === 'starting') {
        serverStatus = 'running';
        sendStatusToWindow();
      }
    }, 5000);

  } catch (err) {
    log('system', `Failed to start backend: ${err.message}`);
    serverStatus = 'error';
    sendStatusToWindow();
  }
}

function stopBackend() {
  if (!backendProcess) return;
  backendProcess.kill('SIGTERM');
  setTimeout(() => {
    if (backendProcess) {
      backendProcess.kill('SIGKILL');
      backendProcess = null;
    }
  }, 5000);
  serverStatus = 'stopped';
  sendStatusToWindow();
}

// ─── Logging ───────────────────────────────────────────────────────────────

const logLines = [];
const MAX_LOG_LINES = 500;

function log(source, message) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = `[${timestamp}] [${source}] ${message}`;
  logLines.push(entry);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', entry);
  }
}

// ─── Window ────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    title: 'ParkingPro Server',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    autoHideMenuBar: true,
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of closing
    if (serverStatus === 'running') {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── System Tray ───────────────────────────────────────────────────────────

function createTray() {
  // Use a simple approach — no icon file needed for now
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Abrir Panel', click: () => { if (mainWindow) mainWindow.show(); else createWindow(); } },
    { type: 'separator' },
    { label: 'Abrir PWA (Operador)', click: () => shell.openExternal(`http://localhost:${serverPort}`) },
    { label: 'Abrir Admin Panel', click: () => shell.openExternal(`http://localhost:${serverPort}/admin`) },
    { type: 'separator' },
    { label: 'Reiniciar Servidor', click: () => { stopBackend(); setTimeout(startBackend, 1000); } },
    { label: 'Detener Servidor', click: () => stopBackend() },
    { type: 'separator' },
    { label: 'Salir', click: () => { stopBackend(); app.quit(); } },
  ]);

  try {
    tray = new Tray(path.join(__dirname, 'ui', 'tray-icon.png'));
    tray.setToolTip('ParkingPro Server');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
      if (mainWindow) mainWindow.show();
      else createWindow();
    });
  } catch {
    // Tray icon not available — continue without it
    log('system', 'System tray not available');
  }
}

// ─── IPC Handlers ──────────────────────────────────────────────────────────

function setupIPC() {
  ipcMain.handle('get-status', () => ({
    status: serverStatus,
    port: serverPort,
    logs: logLines.slice(-100),
    backendPath: BACKEND_PATH,
    isDev,
  }));

  ipcMain.handle('start-server', () => {
    startBackend();
    return { ok: true };
  });

  ipcMain.handle('stop-server', () => {
    stopBackend();
    return { ok: true };
  });

  ipcMain.handle('restart-server', () => {
    stopBackend();
    setTimeout(startBackend, 1000);
    return { ok: true };
  });

  ipcMain.handle('open-pwa', () => {
    shell.openExternal(`http://localhost:${serverPort}`);
    return { ok: true };
  });

  ipcMain.handle('open-admin', () => {
    shell.openExternal(`http://localhost:${serverPort}/admin`);
    return { ok: true };
  });

  ipcMain.handle('open-backend-folder', () => {
    shell.openPath(BACKEND_PATH);
    return { ok: true };
  });

  ipcMain.handle('set-port', (_, port) => {
    serverPort = port;
    return { ok: true };
  });
}

function sendStatusToWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-changed', {
      status: serverStatus,
      port: serverPort,
    });
  }
}

// ─── App Lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(() => {
  setupIPC();
  createWindow();
  createTray();

  log('system', `ParkingPro Desktop v${app.getVersion()}`);
  log('system', `Backend path: ${BACKEND_PATH}`);
  log('system', `Port: ${serverPort}`);

  // Auto-start backend
  startBackend();
});

app.on('window-all-closed', () => {
  // Don't quit — keep running in tray
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', () => {
  stopBackend();
});
