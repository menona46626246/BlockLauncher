/**
 * configManager.js - Gestor de configuración del launcher
 * 
 * Maneja:
 * - Carga y guardado de configuración en ./config/launcher.json
 * - Configuración por defecto
 * - Detección automática de Java
 * - Validación de valores
 */

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const { getConfigDir, getDefaultMinecraftDir } = require('./appPaths');

class ConfigManager {
  constructor() {
    this.configFile = path.join(getConfigDir(), 'launcher.json');
    this.defaultConfig = {
      // Memoria RAM asignada (en GB)
      memory: 4,
      // Ruta al ejecutable de Java
      javaPath: null,
      // Argumentos JVM personalizados
      jvmArgs: '-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC',
      // Directorio raíz de Minecraft
      minecraftDirectory: null,
      // Versión por defecto al iniciar
      defaultVersion: null,
      // Mod loader por defecto
      defaultModLoader: 'vanilla',
      // Cerrar launcher al iniciar juego
      closeOnLaunch: false,
      // Mostrar logs al lanzar
      showLogs: true,
      // Tema de la UI
      theme: 'dark',
      // Noticias (feed falso)
      enableNews: true,
      // Última actualización
      lastUpdated: null
    };
    this.config = { ...this.defaultConfig };
  }

  /**
   * Carga la configuración desde el archivo
   * Si no existe, crea uno con valores por defecto
   */
  async load() {
    try {
      console.log('[Config] Cargando configuración desde:', this.configFile);
      
      const exists = await this._fileExists(this.configFile);
      
      if (!exists) {
        console.log('[Config] Archivo no existe, creando con valores por defecto...');
        // Establecer el directorio de Minecraft por defecto
        this.config.minecraftDirectory = getDefaultMinecraftDir();
        // Intentar auto-detectar Java
        const javaResult = await this.detectJava();
        if (javaResult.success) {
          this.config.javaPath = javaResult.path;
        }
        await this._save();
        return { success: true, config: this.config };
      }

      // Leer archivo existente
      const data = await fs.readFile(this.configFile, 'utf-8');
      const parsed = JSON.parse(data);
      
      // Mezclar con defaults para asegurar todas las keys
      this.config = { ...this.defaultConfig, ...parsed };
      
      console.log('[Config] Configuración cargada');
      return { success: true, config: this.config };
    } catch (error) {
      console.error('[Config] Error al cargar configuración:', error);
      // En caso de error, usar defaults
      this.config = { ...this.defaultConfig };
      return { success: false, error: error.message };
    }
  }

  /**
   * Obtiene la configuración actual
   */
  async getConfig() {
    return { success: true, config: this.config };
  }

  /**
   * Actualiza y guarda la configuración
   * @param {Object} newConfig - Nueva configuración (parcial)
   */
  async setConfig(newConfig) {
    try {
      // Validar valores críticos
      if (newConfig.memory !== undefined) {
        const memory = parseInt(newConfig.memory);
        if (isNaN(memory) || memory < 2 || memory > 16) {
          throw new Error('La memoria debe estar entre 2 y 16 GB');
        }
        newConfig.memory = memory;
      }

      // Mezclar la nueva config con la existente
      this.config = {
        ...this.config,
        ...newConfig,
        lastUpdated: new Date().toISOString()
      };

      await this._save();

      console.log('[Config] Configuración actualizada');
      return { success: true, config: this.config };
    } catch (error) {
      console.error('[Config] Error al guardar configuración:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Intenta detectar automáticamente la ruta de Java en el sistema
   */
  async detectJava() {
    try {
      console.log('[Config] Auto-detectando Java...');
      
      let command;
      if (process.platform === 'win32') {
        command = 'where java';
      } else if (process.platform === 'darwin') {
        // En macOS, buscar en ubicaciones comunes
        command = '/usr/libexec/java_home 2>/dev/null || which java';
      } else {
        command = 'which java';
      }

      const result = execSync(command, { encoding: 'utf-8', timeout: 5000 });
      const javaPath = result.trim().split('\n')[0].trim();

      if (javaPath && javaPath.length > 0) {
        console.log(`[Config] Java detectado en: ${javaPath}`);
        return {
          success: true,
          path: javaPath,
          message: 'Java detectado correctamente'
        };
      }

      throw new Error('No se encontró Java en el sistema');
    } catch (error) {
      console.warn('[Config] No se pudo detectar Java automáticamente:', error.message);
      return {
        success: false,
        error: 'No se pudo detectar Java automáticamente. Configúralo manualmente.',
        path: null
      };
    }
  }

  /**
   * Guarda la configuración en el archivo JSON
   * @private
   */
  async _save() {
    try {
      const dir = path.dirname(this.configFile);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        this.configFile,
        JSON.stringify(this.config, null, 2),
        'utf-8'
      );
    } catch (error) {
      console.error('[Config] Error al guardar archivo:', error);
      throw error;
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

module.exports = ConfigManager;
