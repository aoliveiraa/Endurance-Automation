const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { fork } = require('child_process');
let mainWindow = null;
let enduranceProcess = null;
let automationCompleted = false;
function sendToUi(channel, payload) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload); }
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1600, height: 950, minWidth: 1100, minHeight: 700, show: false, resizable: true, autoHideMenuBar: true, backgroundColor: '#f4f7fb', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.maximize(); mainWindow.show(); });
  mainWindow.on('closed', () => { mainWindow = null; });
}
app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
ipcMain.handle('execute-endurance', (_event, url) => {
  if (enduranceProcess) return { ok: false, message: 'An automation is already running.' };
  automationCompleted = false;
  enduranceProcess = fork(path.join(__dirname, 'endurance.js'), [url], { env: { ...process.env, ENDURANCE_PROFILE_PATH: path.join(app.getPath('userData'), 'browser-profile') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const relay = level => chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(message => sendToUi('automation-log', { level, message }));
  enduranceProcess.stdout.on('data', relay('info'));
  enduranceProcess.stderr.on('data', relay('error'));
  enduranceProcess.on('message', message => { if (message?.type === 'completed') automationCompleted = true; sendToUi('automation-event', message); });
  enduranceProcess.on('error', error => sendToUi('automation-event', { type: 'error', message: error.message }));
  enduranceProcess.on('exit', (code, signal) => { sendToUi('automation-exit', { code, signal, completed: automationCompleted }); enduranceProcess = null; automationCompleted = false; });
  return { ok: true };
});
ipcMain.handle('focus-chart', (_event, tabId) => {
  if (!enduranceProcess?.connected) return { ok: false, message: 'Automation browser is not available.' };
  enduranceProcess.send({ type: 'focus-chart', tabId });
  return { ok: true };
});
ipcMain.handle('cancel-endurance', () => { if (!enduranceProcess) return { ok: false, message: 'No automation is running.' }; enduranceProcess.kill('SIGTERM'); return { ok: true }; });
app.on('window-all-closed', () => { if (enduranceProcess) enduranceProcess.kill('SIGTERM'); if (process.platform !== 'darwin') app.quit(); });
