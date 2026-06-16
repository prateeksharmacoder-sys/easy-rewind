/**
 * easy-rewind Desktop App — Main Process
 *
 * Windows system tray app with:
 * - Global shortcut (Win+Shift+Space / Ctrl+Shift+Space) → overlay window
 * - System tray icon with context menu
 * - Desktop notifications for due reminders
 * - Periodic reminder check (every 2 minutes)
 * - Quick capture + search without opening browser
 */

const { app, BrowserWindow, Tray, Menu, Notification, globalShortcut, nativeImage, clipboard, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const API_BASE = 'http://localhost:5000/api';
const REMINDER_CHECK_INTERVAL = 2 * 60 * 1000; // 2 minutes
const isDev = process.argv.includes('--dev');

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let tray = null;
let overlayWindow = null;
let reminderInterval = null;
let userId = null;
let desktopSettings = { apiBase: '', apiKey: '', aiModel: 'gemini-2.5-flash', reminderMinutes: 60 };

// Backend process management
let backendProcess = null;
let backendRunning = false;
const BACKEND_DIR = path.join(__dirname, '..', 'backend');

function getEffectiveApiBase() {
  return (desktopSettings.apiBase && desktopSettings.apiBase.trim())
    ? desktopSettings.apiBase.replace(/\/+$/, '')
    : 'http://localhost:5000';
}

const DESKTOP_SETTINGS_PATH = path.join(app.getPath('userData'), 'desktop-settings.json');

function loadDesktopSettings() {
  try {
    if (fs.existsSync(DESKTOP_SETTINGS_PATH)) {
      const raw = fs.readFileSync(DESKTOP_SETTINGS_PATH, 'utf8');
      const saved = JSON.parse(raw);
      desktopSettings = { ...desktopSettings, ...saved };
    }
  } catch (_) {}
}

function saveDesktopSettings() {
  try {
    const dir = path.dirname(DESKTOP_SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DESKTOP_SETTINGS_PATH, JSON.stringify(desktopSettings, null, 2));
  } catch (_) {}
}

// ─────────────────────────────────────────────
// BACKEND SERVER MANAGEMENT
// ─────────────────────────────────────────────

function startBackend() {
  if (backendProcess) {
    console.log('[Backend] Already running');
    return;
  }

  console.log('[Backend] Starting Node.js server...');

  const nodeExe = process.platform === 'win32' ? 'node.exe' : 'node';

  backendProcess = spawn(nodeExe, ['server.js'], {
    cwd: BACKEND_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    shell: process.platform === 'win32',
  });

  backendRunning = true;

  backendProcess.stdout.on('data', (data) => {
    console.log(`[Backend] ${data.toString().trim()}`);
  });

  backendProcess.stderr.on('data', (data) => {
    console.error(`[Backend] ${data.toString().trim()}`);
  });

  backendProcess.on('error', (err) => {
    console.error('[Backend] Failed to start:', err.message);
    backendRunning = false;
    backendProcess = null;
    if (typeof updateTrayMenu === 'function') updateTrayMenu();
  });

  backendProcess.on('exit', (code, signal) => {
    console.log(`[Backend] Exited (code=${code}, signal=${signal})`);
    backendRunning = false;
    backendProcess = null;
    if (typeof updateTrayMenu === 'function') updateTrayMenu();
  });

  waitForBackend();
  if (typeof updateTrayMenu === 'function') updateTrayMenu();
}

function stopBackend() {
  if (!backendProcess) {
    console.log('[Backend] Not running');
    return;
  }

  console.log('[Backend] Stopping server...');

  if (process.platform === 'win32') {
    try {
      require('child_process').execSync(
        `taskkill /PID ${backendProcess.pid} /T /F`,
        { stdio: 'ignore', timeout: 5000 }
      );
    } catch (_) {
      backendProcess.kill('SIGTERM');
    }
  } else {
    backendProcess.kill('SIGTERM');
  }

  backendRunning = false;
  backendProcess = null;
  if (typeof updateTrayMenu === 'function') updateTrayMenu();
}

function restartBackend() {
  stopBackend();
  setTimeout(startBackend, 1500);
}

async function waitForBackend() {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await apiCall('/health');
      console.log('[Backend] Server is ready');
      if (typeof updateTrayMenu === 'function') updateTrayMenu();
      return;
    } catch (_) {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.warn('[Backend] Server did not become ready within timeout');
  if (typeof updateTrayMenu === 'function') updateTrayMenu();
}

// ─────────────────────────────────────────────
// UTILITY: API Calls
// ─────────────────────────────────────────────
function apiCall(path, options = {}) {
  return new Promise((resolve, reject) => {
    const effectiveBase = getEffectiveApiBase() + '/api';
    const url = new URL(`${effectiveBase}${path}`);
    const httpOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userId || 'desktop-user',
        ...(options.headers || {}),
      },
    };

    const req = http.request(httpOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
        } catch {
          reject(new Error('Invalid response from server'));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Cannot reach server: ${err.message}`)));

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

// ─────────────────────────────────────────────
// CREATE OVERLAY WINDOW
// ─────────────────────────────────────────────
function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    overlayWindow.focus();
    return;
  }

  overlayWindow = new BrowserWindow({
    width: 420,
    height: 580,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    backgroundColor: '#0f0f1a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));

  // Show with fade-in
  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show();
    overlayWindow.focus();
  });

  // Hide on blur (click outside)
  overlayWindow.on('blur', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }
  });

  // Handle IPC from renderer
  ipcMain.on('hide-overlay', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }
  });

  ipcMain.on('open-in-browser', (event, url) => {
    if (url) require('electron').shell.openExternal(url);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }
  });

  ipcMain.handle('api-call', async (event, { path, method, body }) => {
    try {
      return await apiCall(path, { method, body });
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('get-settings', () => ({ ...desktopSettings }));
  ipcMain.handle('set-settings', (event, newSettings) => {
    desktopSettings = { ...desktopSettings, ...newSettings };
    saveDesktopSettings();
    return { ...desktopSettings };
  });
}

// ─────────────────────────────────────────────
// TOGGLE OVERLAY
// ─────────────────────────────────────────────
function toggleOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide();
  } else {
    createOverlayWindow();
  }
}

// ─────────────────────────────────────────────
// CHECK REMINDERS
// ─────────────────────────────────────────────
async function checkReminders() {
  try {
    const data = await apiCall('/reminders?due=true&limit=5');
    if (data.reminders && data.reminders.length > 0) {
      for (const reminder of data.reminders) {
        showDesktopNotification(reminder.title || 'Reminder', reminder.message || '', reminder);
        // Acknowledge
        await apiCall(`/reminders/${reminder.id}`, {
          method: 'PATCH',
          body: { reminded: true },
        });
      }
    }
  } catch (err) {
    // Silently fail — server might be offline
  }
  if (tray) updateTrayMenu();
}

// ─────────────────────────────────────────────
// DESKTOP NOTIFICATION
// ─────────────────────────────────────────────
function showDesktopNotification(title, body, data = {}) {
  const notification = new Notification({
    title: `⏪ ${title}`,
    body: body || 'You have a pending reminder in easy-rewind.',
    icon: path.join(__dirname, 'tray-icon.png'),
    silent: false,
    hasReply: false,
  });

  notification.on('click', () => {
    // Open the overlay when notification is clicked
    createOverlayWindow();
  });

  notification.show();
}

function updateTrayMenu() {
  if (!tray) return;

  const backendStatus = backendRunning
    ? '✅ Backend Running'
    : '❌ Backend Stopped';

  const template = [
    {
      label: '🔍 Quick Search & Capture',
      click: () => createOverlayWindow(),
    },
    { type: 'separator' },
    {
      label: backendStatus,
      enabled: false,
    },
    {
      label: backendRunning ? '🔄 Restart Backend' : '▶ Start Backend',
      click: () => {
        if (backendRunning) {
          restartBackend();
        } else {
          startBackend();
        }
      },
    },
    { type: 'separator' },
    {
      label: '📊 Open Dashboard',
      click: () => require('electron').shell.openExternal(`${getEffectiveApiBase()}/dashboard`),
    },
    { type: 'separator' },
    {
      label: 'Check Reminders Now',
      click: () => checkReminders(),
    },
    { type: 'separator' },
    {
      label: 'Quit easy-rewind',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

// ─────────────────────────────────────────────
// CREATE SYSTEM TRAY
// ─────────────────────────────────────────────
function createTray() {
  // Create a simple 16x16 tray icon from a nativeImage
  // We'll generate a small purple dot as fallback
  const iconSize = 16;
  const canvas = nativeImage.createEmpty();
  // Use a generated PNG icon
  let trayIcon;

  try {
    trayIcon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.svg'));
    if (trayIcon.isEmpty()) throw new Error('No icon file');
  } catch {
    // Create a minimal programmatic icon (16x16 purple square)
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      const offset = i * 4;
      buf[offset] = 124;     // R
      buf[offset + 1] = 58;  // G
      buf[offset + 2] = 237; // B
      buf[offset + 3] = 255; // A
    }
    trayIcon = nativeImage.createFromBuffer(buf, { width: size, height: size });
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('easy-rewind — Press Ctrl+Shift+Space to open');

  updateTrayMenu();

  // Double-click tray → open overlay
  tray.on('double-click', () => {
    createOverlayWindow();
  });
}

// ─────────────────────────────────────────────
// APP LIFECYCLE
// ─────────────────────────────────────────────
app.whenReady().then(() => {
  loadDesktopSettings();

  // Auto-start the backend server
  startBackend();
  // Register global shortcut
  const shortcut = globalShortcut.register('Ctrl+Shift+Space', () => {
    toggleOverlay();
  });

  if (!shortcut) {
    console.warn('Global shortcut registration failed (may conflict with another app)');
  }

  // Also register Alt+Space as alternative
  globalShortcut.register('Alt+Shift+E', () => {
    toggleOverlay();
  });

  // Create tray
  createTray();

  // Start reminder polling
  reminderInterval = setInterval(checkReminders, REMINDER_CHECK_INTERVAL);
  // Initial check after 5 seconds
  setTimeout(checkReminders, 5000);

  // Get or create user ID (simple JSON store — avoids electron-store ESM issues)
  const storePath = path.join(app.getPath('userData'), 'config.json');
  let config = {};
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    config = JSON.parse(raw);
  } catch { /* first run — empty config */ }
  userId = config.easy_rewind_user_id;
  if (!userId) {
    userId = 'desktop_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    config.easy_rewind_user_id = userId;
    try {
      const dir = path.dirname(storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify(config, null, 2));
    } catch (err) {
      console.warn('[Store] Could not save config:', err.message);
    }
  }

  console.log('✅ easy-rewind Desktop App running');
  console.log(`   User ID: ${userId.slice(0, 20)}...`);
  console.log('   Shortcut: Ctrl+Shift+Space to open overlay');

  // Resolve canonical shared user ID from the server
  fetch(`${getEffectiveApiBase()}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: userId, client_type: 'desktop' }),
  }).then(r => r.json()).then(session => {
    if (session.user_id && session.user_id !== userId) {
      userId = session.user_id;
      config.easy_rewind_user_id = userId;
      try {
        fs.writeFileSync(storePath, JSON.stringify(config, null, 2));
      } catch (err) {
        console.warn('[Store] Could not save session user_id:', err.message);
      }
      console.log(`   Canonical user_id resolved: ${userId.slice(0, 20)}...`);
    }
  }).catch(() => {
    console.log('[Session] Could not reach server, using local user ID.');
  });

  // Auto-open overlay on first launch
  if (isDev) {
    setTimeout(createOverlayWindow, 1000);
  }
});

app.on('window-all-closed', () => {
  // Don't quit — we're a tray app
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (reminderInterval) clearInterval(reminderInterval);
  stopBackend();
});
