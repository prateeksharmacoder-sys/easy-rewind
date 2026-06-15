/**
 * easy-rewind Desktop App — Preload Script
 *
 * Exposes safe API bridge to the overlay renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('easyRewind', {
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  openInBrowser: (url) => ipcRenderer.send('open-in-browser', url),
  apiCall: (path, options = {}) => ipcRenderer.invoke('api-call', { path, ...options }),
});
