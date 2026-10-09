/**
 * modManager.js - Gestor de mods
 * 
 * Maneja:
 * - Instalación de mods desde archivos .jar locales
 * - Listado de mods por versión de Minecraft
 * - Activación/desactivación de mods (renombrando .jar a .jar.disabled)
 * - Eliminación de mods
 * - Persistencia del estado en JSON
 */

const fs = require('fs').promises;
const path = require('path');
const { getConfigDir, getDefaultMinecraftDir } = require('../ui/appPaths');

class ModManager {
  /**
   * Constructor del gestor de mods
   * @param {ConfigManager} configManager - Instancia del gestor de configuración
   */
  constructor(configManager) {
    this.configManager = configManager;
    this.modsStateFile = path.join(getConfigDir(), 'mods_state.json');
    this.modsState = {}; // { versionId: [mod1, mod2, ...] }
  }

  /**
   * Inicializa el gestor cargando el estado guardado
   */
  async initialize() {
    try {
      console.log('[Mods] Inicializando gestor de mods...');
      await this._loadState();
      this._migrateState();
      console.log('[Mods] Gestor inicializado');
    } catch (error) {
      console.error('[Mods] Error en inicialización:', error);
    }
  }

  /**
   * Migra el estado guardado al formato actual.
   * Formato antiguo: { "<versionId>": [mods...] } (cuando cada versión
   * tenía su propia carpeta de mods).
   * Formato actual: { mods: [mods...] } (carpeta compartida .minecraft/mods).
   * @private
   */
  _migrateState() {
    if (this.modsState && Array.isArray(this.modsState.mods)) {
      return; // ya está en el formato actual
    }

    const merged = [];
    const seen = new Set();
    for (const [key, value] of Object.entries(this.modsState || {})) {
      if (key === 'mods' || !Array.isArray(value)) continue;
      for (const mod of value) {
        if (mod && mod.id && !seen.has(mod.id)) {
          seen.add(mod.id);
          merged.push(mod);
        }
      }
    }
    this.modsState = { mods: merged };
  }

  /**
   * Lista los mods instalados para una versión específica
   * @param {string} versionId - ID de la versión de Minecraft
   * @returns {Object} - Resultado con la lista de mods
   */
  async listMods(versionId) {
    try {
      if (!versionId) {
        throw new Error('Se requiere un ID de versión');
      }

      // Obtener directorio de mods para esta versión
      const modsDir = await this._getModsDirectory(versionId);
      
      // Asegurar que el directorio existe
      await fs.mkdir(modsDir, { recursive: true });

      // Leer todos los archivos del directorio
      const files = await fs.readdir(modsDir);
      
      // Filtrar solo archivos .jar y .jar.disabled
      const modFiles = files.filter(f => 
        f.endsWith('.jar') || f.endsWith('.jar.disabled')
      );

      // Construir la lista de mods con su información
      const mods = modFiles.map(fileName => {
        const isDisabled = fileName.endsWith('.jar.disabled');
        const realName = isDisabled ? fileName.replace('.disabled', '') : fileName;
        const modId = realName.replace('.jar', '');
        
        // Buscar info guardada
        const savedInfo = (this.modsState.mods || []).find(m => m.id === modId);
        
        return {
          id: modId,
          fileName: fileName,
          realName: realName,
          enabled: !isDisabled,
          path: path.join(modsDir, fileName),
          addedAt: savedInfo ? savedInfo.addedAt : null,
          size: savedInfo ? savedInfo.size : null
        };
      });

      // Ordenar: habilitados primero, luego por nombre
      mods.sort((a, b) => {
        if (a.enabled !== b.enabled) return b.enabled ? 1 : -1;
        return a.realName.localeCompare(b.realName);
      });

      return {
        success: true,
        versionId: versionId,
        mods: mods,
        count: mods.length,
        enabledCount: mods.filter(m => m.enabled).length,
        disabledCount: mods.filter(m => !m.enabled).length
      };
    } catch (error) {
      console.error('[Mods] Error al listar mods:', error);
      return { success: false, error: error.message, mods: [] };
    }
  }

  /**
   * Instala un mod desde un archivo .jar local
   * @param {Object} options - { sourcePath, versionId, modName }
   * @returns {Object} - Resultado de la instalación
   */
  async installMod(options) {
    try {
      const { sourcePath, versionId, modName = null } = options;

      if (!sourcePath) {
        throw new Error('Se requiere la ruta del archivo .jar');
      }

      if (!versionId) {
        throw new Error('Se requiere el ID de versión');
      }

      // Verificar que el archivo existe
      const exists = await this._fileExists(sourcePath);
      if (!exists) {
        throw new Error(`El archivo no existe: ${sourcePath}`);
      }

      // Verificar que es un .jar
      if (!sourcePath.toLowerCase().endsWith('.jar')) {
        throw new Error('El archivo debe tener extensión .jar');
      }

      // Obtener directorio de destino
      const modsDir = await this._getModsDirectory(versionId);
      await fs.mkdir(modsDir, { recursive: true });

      // Nombre del archivo final
      const fileName = modName || path.basename(sourcePath);
      const targetPath = path.join(modsDir, fileName);

      // Verificar si ya existe
      const targetExists = await this._fileExists(targetPath);
      if (targetExists) {
        throw new Error(`Ya existe un mod con el nombre "${fileName}" en esta versión`);
      }

      // Copiar archivo
      await fs.copyFile(sourcePath, targetPath);

      // Obtener stats del archivo
      const stats = await fs.stat(targetPath);

      // Guardar info en el estado
      if (!this.modsState.mods) {
        this.modsState.mods = [];
      }

      const modId = fileName.replace('.jar', '');
      this.modsState.mods.push({
        id: modId,
        fileName: fileName,
        addedAt: new Date().toISOString(),
        size: stats.size
      });

      await this._saveState();

      console.log(`[Mods] Mod instalado: ${fileName} en versión ${versionId}`);

      return {
        success: true,
        mod: {
          id: modId,
          fileName: fileName,
          enabled: true,
          size: stats.size
        },
        message: `Mod "${fileName}" instalado correctamente`
      };
    } catch (error) {
      console.error('[Mods] Error al instalar mod:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Activa o desactiva un mod
   * Para desactivar: renombra .jar a .jar.disabled
   * Para activar: renombra .jar.disabled a .jar
   * @param {Object} modData - { versionId, modId, enabled }
   * @returns {Object} - Resultado de la operación
   */
  async toggleMod(modData) {
    try {
      const { versionId, modId, enabled } = modData;

      if (!versionId || !modId) {
        throw new Error('versionId y modId son requeridos');
      }

      const modsDir = await this._getModsDirectory(versionId);
      
      // Buscar el archivo actual (.jar o .jar.disabled)
      const enabledPath = path.join(modsDir, `${modId}.jar`);
      const disabledPath = path.join(modsDir, `${modId}.jar.disabled`);

      let currentPath;
      let targetPath;
      let newState;

      if (enabled === true) {
        // Queremos activarlo: debe estar en disabledPath
        const existsDisabled = await this._fileExists(disabledPath);
        if (!existsDisabled) {
          throw new Error(`El mod no está desactivado: ${modId}`);
        }
        currentPath = disabledPath;
        targetPath = enabledPath;
        newState = true;
      } else {
        // Queremos desactivarlo: debe estar en enabledPath
        const existsEnabled = await this._fileExists(enabledPath);
        if (!existsEnabled) {
          throw new Error(`El mod no está activado: ${modId}`);
        }
        currentPath = enabledPath;
        targetPath = disabledPath;
        newState = false;
      }

      // Renombrar
      await fs.rename(currentPath, targetPath);

      console.log(`[Mods] Mod ${newState ? 'activado' : 'desactivado'}: ${modId}`);

      return {
        success: true,
        modId: modId,
        enabled: newState,
        message: `Mod ${newState ? 'activado' : 'desactivado'} correctamente`
      };
    } catch (error) {
      console.error('[Mods] Error al cambiar estado del mod:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Elimina un mod del sistema de archivos
   * @param {Object} modData - { versionId, modId }
   * @returns {Object} - Resultado de la eliminación
   */
  async deleteMod(modData) {
    try {
      const { versionId, modId } = modData;

      if (!versionId || !modId) {
        throw new Error('versionId y modId son requeridos');
      }

      const modsDir = await this._getModsDirectory(versionId);
      const enabledPath = path.join(modsDir, `${modId}.jar`);
      const disabledPath = path.join(modsDir, `${modId}.jar.disabled`);

      let deletedPath = null;

      // Intentar eliminar .jar
      if (await this._fileExists(enabledPath)) {
        await fs.unlink(enabledPath);
        deletedPath = enabledPath;
      }
      // Intentar eliminar .jar.disabled
      else if (await this._fileExists(disabledPath)) {
        await fs.unlink(disabledPath);
        deletedPath = disabledPath;
      } else {
        throw new Error(`No se encontró el mod: ${modId}`);
      }

      // Eliminar del estado guardado
      if (this.modsState.mods) {
        this.modsState.mods = this.modsState.mods.filter(m => m.id !== modId);
        await this._saveState();
      }

      console.log(`[Mods] Mod eliminado: ${deletedPath}`);

      return {
        success: true,
        modId: modId,
        message: `Mod eliminado correctamente`
      };
    } catch (error) {
      console.error('[Mods] Error al eliminar mod:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Obtiene la ruta del directorio de mods.
   * Carpeta estándar: el juego (Fabric/Forge) carga los mods de <gameDir>/mods.
   * @private
   */
  async _getModsDirectory(versionId) {
    const result = await this.configManager.getConfig();
    const mcRoot = (result && result.config ? result.config.minecraftDirectory : null) ||
      getDefaultMinecraftDir();
    return path.join(mcRoot, 'mods');
  }

  /**
   * Carga el estado de los mods desde el archivo JSON
   * @private
   */
  async _loadState() {
    try {
      const exists = await this._fileExists(this.modsStateFile);
      if (exists) {
        const data = await fs.readFile(this.modsStateFile, 'utf-8');
        this.modsState = JSON.parse(data);
      } else {
        this.modsState = {};
      }
    } catch (error) {
      console.error('[Mods] Error al cargar estado:', error);
      this.modsState = {};
    }
  }

  /**
   * Guarda el estado de los mods en JSON
   * @private
   */
  async _saveState() {
    try {
      await fs.mkdir(path.dirname(this.modsStateFile), { recursive: true });
      await fs.writeFile(
        this.modsStateFile,
        JSON.stringify(this.modsState, null, 2),
        'utf-8'
      );
    } catch (error) {
      console.error('[Mods] Error al guardar estado:', error);
    }
  }

  /**
   * Verifica si un archivo existe
   * @private
   */
  async _fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = ModManager;
