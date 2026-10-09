/**
 * appPaths.js - Rutas de datos del launcher
 *
 * Cuando la app está empaquetada (electron-builder), el código vive dentro
 * de un app.asar de solo lectura: escribir ahí falla con ENOTDIR.
 * En ese caso los datos de usuario van a %APPDATA%/BlockLauncher
 * (app.getPath('userData')). En desarrollo y en los tests se usan las
 * carpetas normales del proyecto.
 *
 * El require('electron') falla en Node puro (tests), así que se resuelve
 * de forma segura con fallback.
 */

const path = require('path');

/**
 * Devuelve la instancia app de Electron o null (Node puro / tests)
 * @private
 */
function getElectronApp() {
  try {
    return require('electron').app || null;
  } catch {
    return null;
  }
}

/**
 * ¿Está corriendo la app empaquetada (no con npm start)?
 */
function isPackaged() {
  const app = getElectronApp();
  return !!(app && app.isPackaged);
}

/**
 * Directorio de configuración (profiles, launcher.json, caches)
 */
function getConfigDir() {
  const app = getElectronApp();
  if (isPackaged()) {
    return path.join(app.getPath('userData'), 'config');
  }
  return path.join(__dirname, '..', '..', 'config');
}

/**
 * Directorio de Minecraft por defecto (.minecraft)
 */
function getDefaultMinecraftDir() {
  const app = getElectronApp();
  if (isPackaged()) {
    return path.join(app.getPath('userData'), '.minecraft');
  }
  return path.join(__dirname, '..', '..', '.minecraft');
}

module.exports = { getConfigDir, getDefaultMinecraftDir, isPackaged };
