/**
 * main.js - Punto de entrada principal del launcher
 * 
 * Este archivo se encarga de:
 * - Inicializar la aplicación Electron
 * - Crear la ventana principal
 * - Configurar el IPC (comunicación entre procesos)
 * - Cargar los módulos de auth, versiones, mods y UI
 * 
 * Nota: Se usa CommonJS (require) en lugar de ES modules.
 */

// Importación de dependencias principales
let app, BrowserWindow, ipcMain, dialog;
try {
  ({ app, BrowserWindow, ipcMain, dialog } = require('electron'));
} catch (err) {
  console.error('\n❌ ERROR: Este archivo debe ejecutarse con ELECTRON, no con Node.js puro.\n');
  console.error('💡 Usa: npm start');
  console.error('   (Esto ejecuta "electron ." que carga main.js con el runtime de Electron)\n');
  console.error('   Si npm start falla, asegúrate de haber ejecutado "npm install" primero.\n');
  process.exit(1);
}

const path = require('path');
const fs = require('fs');

// Importación de módulos propios
const AuthManager = require('./src/auth/authManager');
const VersionManager = require('./src/versions/versionManager');
const ModManager = require('./src/mods/modManager');
const ConfigManager = require('./src/ui/configManager');

// Variable global para la ventana principal
let mainWindow = null;

// Instancias singleton de los gestores
let authManager = null;
let versionManager = null;
let modManager = null;
let configManager = null;

/**
 * Función que crea la ventana principal del launcher
 * Configura el tamaño, título, iconos y carga el HTML
 */
function createMainWindow() {
  try {
    // Crear instancia de la ventana del navegador
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 1024,
      minHeight: 700,
      title: 'ADLauncher - Minecraft Launcher',
      icon: path.join(__dirname, 'assets', 'icons', 'app-icon.png'),
      backgroundColor: '#1a1a1a',
      webPreferences: {
        // Configuración segura recomendada por Electron:
        // el renderer no tiene acceso a Node y solo puede hablar con el
        // proceso main a través del preload (contextBridge con whitelist)
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, 'src', 'ui', 'preload.js')
      },
      // Quitamos el menú por defecto para un look más limpio
      autoHideMenuBar: true
    });

    // Cargar el HTML principal
    mainWindow.loadFile(path.join(__dirname, 'ui', 'html', 'index.html'));

    // Evento cuando la ventana está lista para mostrarse
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      console.log('[Main] Ventana principal mostrada correctamente');
    });

    // Evento al cerrar la ventana
    mainWindow.on('closed', () => {
      mainWindow = null;
      console.log('[Main] Ventana principal cerrada');
    });

    // Abrir DevTools si estamos en modo desarrollo
    if (process.argv.includes('--dev')) {
      mainWindow.webContents.openDevTools();
      console.log('[Main] Modo desarrollo - DevTools abierto');
    }
  } catch (error) {
    console.error('[Main] Error al crear la ventana principal:', error);
    dialog.showErrorBox('Error Fatal', `No se pudo crear la ventana: ${error.message}`);
  }
}

/**
 * Función que inicializa todos los gestores del launcher
 * Se ejecuta antes de crear la ventana
 */
async function initializeManagers() {
  try {
    console.log('[Main] Inicializando gestores...');
    
    // Inicializar el gestor de configuración
    configManager = new ConfigManager();
    await configManager.load();
    
    // Inicializar el gestor de autenticación
    authManager = new AuthManager(configManager);
    await authManager.loadProfiles();
    
    // Inicializar el gestor de versiones
    versionManager = new VersionManager(configManager);
    await versionManager.initialize();
    
    // Inicializar el gestor de mods
    modManager = new ModManager(configManager);
    await modManager.initialize();
    
    console.log('[Main] Todos los gestores inicializados correctamente');
  } catch (error) {
    console.error('[Main] Error al inicializar gestores:', error);
    throw error;
  }
}

/**
 * Configuración de todos los handlers IPC
 * Maneja la comunicación entre el renderer (HTML/JS) y el main process (Node)
 */
function setupIpcHandlers() {
  try {
    console.log('[Main] Configurando handlers IPC...');

    // ========== HANDLERS DE AUTENTICACIÓN ==========
    
    // Obtener todos los perfiles guardados
    ipcMain.handle('auth:get-profiles', async () => {
      try {
        return await authManager.getProfiles();
      } catch (error) {
        console.error('[IPC auth:get-profiles]', error);
        return { success: false, error: error.message };
      }
    });

    // Crear un nuevo perfil con nickname
    ipcMain.handle('auth:create-profile', async (event, nickname) => {
      try {
        return await authManager.createProfile(nickname);
      } catch (error) {
        console.error('[IPC auth:create-profile]', error);
        return { success: false, error: error.message };
      }
    });

    // Eliminar un perfil existente
    ipcMain.handle('auth:delete-profile', async (event, profileId) => {
      try {
        return await authManager.deleteProfile(profileId);
      } catch (error) {
        console.error('[IPC auth:delete-profile]', error);
        return { success: false, error: error.message };
      }
    });

    // Exportar perfiles a archivo
    ipcMain.handle('auth:export-profiles', async (event, options = {}) => {
      try {
        // Si no nos pasan ruta, mostramos dialog para elegir destino
        let targetPath = options.targetPath;
        if (!targetPath) {
          const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Exportar perfiles',
            defaultPath: `adlauncher-profiles-${Date.now()}.json`,
            filters: [
              { name: 'Archivos JSON', extensions: ['json'] },
              { name: 'Todos los archivos', extensions: ['*'] }
            ]
          });
          if (result.canceled || !result.filePath) {
            return { success: false, canceled: true };
          }
          targetPath = result.filePath;
        }

        // Separar targetPath de las opciones reales de export
        const exportOptions = { ...options };
        delete exportOptions.targetPath;

        return await authManager.exportProfilesToFile(targetPath, exportOptions);
      } catch (error) {
        console.error('[IPC auth:export-profiles]', error);
        return { success: false, error: error.message };
      }
    });

    // Importar perfiles desde archivo
    ipcMain.handle('auth:import-profiles', async (event, options = {}) => {
      try {
        // Si no nos pasan ruta, mostramos dialog para elegir origen
        let sourcePath = options.sourcePath;
        if (!sourcePath) {
          const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Importar perfiles',
            properties: ['openFile'],
            filters: [
              { name: 'Archivos JSON', extensions: ['json'] },
              { name: 'Todos los archivos', extensions: ['*'] }
            ]
          });
          if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
            return { success: false, canceled: true };
          }
          sourcePath = result.filePaths[0];
        }

        // Separar sourcePath de las opciones reales
        const importOptions = { ...options };
        delete importOptions.sourcePath;

        const importResult = await authManager.importProfilesFromFile(sourcePath, importOptions);

        // Si la importación fue exitosa, recargar perfiles en el cliente
        if (importResult.success) {
          const profilesResult = await authManager.getProfiles();
          importResult.profiles = profilesResult.profiles;
          importResult.activeProfileId = profilesResult.activeProfileId;
        }

        return importResult;
      } catch (error) {
        console.error('[IPC auth:import-profiles]', error);
        return { success: false, error: error.message };
      }
    });

    // Seleccionar perfil activo
    ipcMain.handle('auth:select-profile', async (event, profileId) => {
      try {
        return await authManager.selectProfile(profileId);
      } catch (error) {
        console.error('[IPC auth:select-profile]', error);
        return { success: false, error: error.message };
      }
    });

    // ========== HANDLERS DE VERSIONES ==========

    // Obtener lista de versiones disponibles
    ipcMain.handle('versions:list', async (event, options = {}) => {
      try {
        return await versionManager.listVersions(options);
      } catch (error) {
        console.error('[IPC versions:list]', error);
        return { success: false, error: error.message };
      }
    });

    // Forzar refresh de versiones desde la API de Mojang
    ipcMain.handle('versions:refresh', async () => {
      try {
        return await versionManager.refreshVersions();
      } catch (error) {
        console.error('[IPC versions:refresh]', error);
        return { success: false, error: error.message };
      }
    });

    // Instalar/descargar una versión específica
    ipcMain.handle('versions:install', async (event, versionData) => {
      try {
        return await versionManager.installVersion(versionData, (progress) => {
          // Enviar progreso al renderer en tiempo real
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('versions:install-progress', progress);
          }
        });
      } catch (error) {
        console.error('[IPC versions:install]', error);
        return { success: false, error: error.message };
      }
    });

    // ========== HANDLERS DE LANZAMIENTO ==========

    // Lanzar el juego
    ipcMain.handle('launch:start', async (event, launchOptions) => {
      try {
        const result = await versionManager.launchGame(launchOptions, (logLine) => {
          // Enviar logs al renderer en tiempo real
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('launch:log', logLine);
          }
        });

        // Cerrar el launcher tras arrancar el juego si la config lo pide
        if (result.success && mainWindow && !mainWindow.isDestroyed()) {
          const configResult = await configManager.getConfig();
          if (configResult.config && configResult.config.closeOnLaunch) {
            console.log('[Main] closeOnLaunch activo: cerrando launcher en 1s');
            setTimeout(() => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.close();
              }
            }, 1000);
          }
        }

        return result;
      } catch (error) {
        console.error('[IPC launch:start]', error);
        return { success: false, error: error.message };
      }
    });

    // ========== HANDLERS DE CONFIGURACIÓN ==========

    // Obtener configuración actual
    ipcMain.handle('config:get', async () => {
      try {
        return await configManager.getConfig();
      } catch (error) {
        console.error('[IPC config:get]', error);
        return { success: false, error: error.message };
      }
    });

    // Guardar configuración
    ipcMain.handle('config:set', async (event, newConfig) => {
      try {
        return await configManager.setConfig(newConfig);
      } catch (error) {
        console.error('[IPC config:set]', error);
        return { success: false, error: error.message };
      }
    });

    // Seleccionar directorio personalizado
    ipcMain.handle('config:select-directory', async () => {
      try {
        const result = await dialog.showOpenDialog(mainWindow, {
          properties: ['openDirectory'],
          title: 'Seleccionar directorio'
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, canceled: true };
        }
        return { success: true, path: result.filePaths[0] };
      } catch (error) {
        console.error('[IPC config:select-directory]', error);
        return { success: false, error: error.message };
      }
    });

    // Seleccionar archivo Java ejecutable
    ipcMain.handle('config:select-java', async () => {
      try {
        const result = await dialog.showOpenDialog(mainWindow, {
          properties: ['openFile'],
          title: 'Seleccionar ejecutable de Java',
          filters: [
            { name: 'Ejecutables', extensions: ['exe', 'app', 'sh'] },
            { name: 'Todos los archivos', extensions: ['*'] }
          ]
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, canceled: true };
        }
        return { success: true, path: result.filePaths[0] };
      } catch (error) {
        console.error('[IPC config:select-java]', error);
        return { success: false, error: error.message };
      }
    });

    // Detectar Java automáticamente
    ipcMain.handle('config:detect-java', async () => {
      try {
        return await configManager.detectJava();
      } catch (error) {
        console.error('[IPC config:detect-java]', error);
        return { success: false, error: error.message };
      }
    });

    // Información del sistema (RAM total, para limitar el slider)
    ipcMain.handle('config:system-info', async () => {
      try {
        const os = require('os');
        const totalBytes = os.totalmem();
        return {
          success: true,
          totalMemoryGb: Math.round(totalBytes / (1024 * 1024 * 1024))
        };
      } catch (error) {
        console.error('[IPC config:system-info]', error);
        return { success: false, error: error.message };
      }
    });

    // ========== HANDLERS DE MODS ==========

    // Listar mods instalados para una versión
    ipcMain.handle('mods:list', async (event, versionId) => {
      try {
        return await modManager.listMods(versionId);
      } catch (error) {
        console.error('[IPC mods:list]', error);
        return { success: false, error: error.message };
      }
    });

    // Instalar un mod desde archivo local
    ipcMain.handle('mods:install', async (event, options) => {
      try {
        return await modManager.installMod(options);
      } catch (error) {
        console.error('[IPC mods:install]', error);
        return { success: false, error: error.message };
      }
    });

    // Activar o desactivar un mod
    ipcMain.handle('mods:toggle', async (event, modData) => {
      try {
        return await modManager.toggleMod(modData);
      } catch (error) {
        console.error('[IPC mods:toggle]', error);
        return { success: false, error: error.message };
      }
    });

    // Eliminar un mod
    ipcMain.handle('mods:delete', async (event, modData) => {
      try {
        return await modManager.deleteMod(modData);
      } catch (error) {
        console.error('[IPC mods:delete]', error);
        return { success: false, error: error.message };
      }
    });

    // Seleccionar archivo .jar para instalar como mod
    ipcMain.handle('mods:select-file', async () => {
      try {
        const result = await dialog.showOpenDialog(mainWindow, {
          properties: ['openFile'],
          title: 'Seleccionar archivo .jar del mod',
          filters: [
            { name: 'Archivos JAR', extensions: ['jar'] },
            { name: 'Todos los archivos', extensions: ['*'] }
          ]
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, canceled: true };
        }
        return { success: true, path: result.filePaths[0] };
      } catch (error) {
        console.error('[IPC mods:select-file]', error);
        return { success: false, error: error.message };
      }
    });

    // ========== HANDLERS DE VENTANA ==========

    // Minimizar / maximizar / cerrar (enviados por preload.js)
    ipcMain.on('window:minimize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    });

    ipcMain.on('window:toggle-maximize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize();
        } else {
          mainWindow.maximize();
        }
      }
    });

    ipcMain.on('window:close', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });

    // ========== HANDLERS ADICIONALES DE LANZAMIENTO ==========

    // Detener el juego en ejecución
    ipcMain.handle('launch:stop', async () => {
      try {
        return versionManager.stopGame();
      } catch (error) {
        console.error('[IPC launch:stop]', error);
        return { success: false, error: error.message };
      }
    });

    // ========== HANDLERS DE GESTIÓN DE VERSIONES ==========

    // Listar versiones instaladas con detalles (tamaño, dependencias)
    ipcMain.handle('versions:list-installed', async () => {
      try {
        // Sincronizar con el disco antes de listar
        await versionManager._syncInstalledWithDisk();
        return await versionManager.listInstalledVersions();
      } catch (error) {
        console.error('[IPC versions:list-installed]', error);
        return { success: false, error: error.message, installed: [] };
      }
    });

    // Eliminar una versión instalada
    ipcMain.handle('versions:delete', async (event, versionId) => {
      try {
        return await versionManager.deleteVersion(versionId);
      } catch (error) {
        console.error('[IPC versions:delete]', error);
        return { success: false, error: error.message };
      }
    });

    console.log('[Main] Handlers IPC configurados');
  } catch (error) {
    console.error('[Main] Error al configurar IPC handlers:', error);
  }
}

/**
 * Evento: Cuando Electron está listo, creamos la ventana
 */
app.whenReady().then(async () => {
  try {
    console.log('[Main] App lista, inicializando...');
    await initializeManagers();
    setupIpcHandlers();
    createMainWindow();

    // macOS: Recrear ventana si se hace clic en el dock
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  } catch (error) {
    console.error('[Main] Error fatal en inicialización:', error);
    dialog.showErrorBox('Error Fatal', `La aplicación no pudo iniciarse: ${error.message}`);
    app.quit();
  }
});

/**
 * Evento: Cerrar la app cuando se cierran todas las ventanas
 * (excepto en macOS)
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Manejo de errores no capturados para evitar crashes silenciosos
 */
process.on('uncaughtException', (error) => {
  console.error('[Main] Excepción no capturada:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Main] Promise rechazada no manejada:', reason);
});
