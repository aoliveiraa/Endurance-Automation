const { contextBridge, ipcRenderer } = require('electron');
function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback function is required.');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('electronAPI', {
  execute: url => ipcRenderer.invoke('execute-endurance', url),
  cancel: () => ipcRenderer.invoke('cancel-endurance'),
  focusChart: tabId => ipcRenderer.invoke('focus-chart', tabId),
  onAutomationEvent: callback => subscribe('automation-event', callback),
  onAutomationLog: callback => subscribe('automation-log', callback),
  onAutomationExit: callback => subscribe('automation-exit', callback)
});
