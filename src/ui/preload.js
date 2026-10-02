/**
 * preload.js - Bridge seguro entre el renderer y el proceso main
 *
 * Con contextIsolation activado este es el ÚNICO punto de contacto del
 * renderer con Electron. Solo se exponen los canales IPC permitidos
 * (whitelist), de modo que el contenido web no pueda invocar canales
 * arbitrarios aunque llegara código malicioso al renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Canales que el renderer puede invocar (ipcMain.handle)
const INVOKE_CHANNELS = [
  'auth:get-profiles',
  'auth:create-profile',
  'auth:delete-profile',
  'auth:export-profiles',
  'auth:import-profiles',
  'auth:select-profile',
  'versions:list',
  'versions:refresh',
  'versions:install',
  'versions:list-installed',
  'versions:delete',
  'launch:start',
  'launch:stop',
  'config:get',
  'config:set',
  'config:select-directory',
  'config:select-java',
  'config:detect-java',
  'config:system-info',
  'mods:list',
  'mods:install',
  'mods:toggle',
  'mods:delete',
  'mods:select-file'
];

// Canales que el renderer puede escuchar (webContents.send)
const LISTEN_CHANNELS = [
  'versions:install-progress',
  'launch:log'
];

// Exponer API al renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Invocar funciones IPC (solo canales permitidos)
  invoke: (channel, ...args) => {
    if (!INVOKE_CHANNELS.includes(channel)) {
      return Promise.resolve({ success: false, error: `Canal no permitido: ${channel}` });
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  // Suscribirse a eventos del main (solo canales permitidos)
  on: (channel, callback) => {
    if (!LISTEN_CHANNELS.includes(channel)) {
      return () => {};
    }
    const subscription = (event, ...args) => callback(...args);
    ipcRenderer.on(channel, subscription);
    // Retornar función para desuscribirse
    return () => ipcRenderer.removeListener(channel, subscription);
  },

  // Minimizar ventana
  minimize: () => ipcRenderer.send('window:minimize'),

  // Maximizar/restaurar ventana
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),

  // Cerrar ventana
  close: () => ipcRenderer.send('window:close'),

  // Obtener info de la plataforma
  platform: process.platform
});

// Log para confirmar que el preload se cargó
console.log('[Preload] electronAPI expuesto correctamente (contextIsolation + whitelist)');
