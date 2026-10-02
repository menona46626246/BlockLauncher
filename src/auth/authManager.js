/**
 * authManager.js - Gestor de autenticación offline
 *
 * Maneja:
 * - Creación de perfiles con nicknames personalizados
 * - Generación de UUIDs v4 persistentes (no premium)
 * - Almacenamiento de perfiles en ./config/profiles.json
 * - Selección del perfil activo
 * - Exportar/Importar perfiles a/desde archivo JSON
 *
 * No requiere autenticación con servidores de Mojang/Microsoft.
 */

const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class AuthManager {
  /**
   * Constructor del gestor de autenticación
   * @param {ConfigManager} configManager - Instancia del gestor de configuración
   */
  constructor(configManager) {
    this.configManager = configManager;
    this.profilesFile = path.join(__dirname, '..', '..', 'config', 'profiles.json');
    this.profiles = [];
    this.activeProfileId = null;

    // Versión del esquema de export para compatibilidad futura
    this.EXPORT_SCHEMA_VERSION = '1.0.0';
    // Aplicación que generó el archivo
    this.EXPORT_APP = 'ADLauncher';
  }

  /**
   * Carga los perfiles desde el archivo JSON
   * Si el archivo no existe, se crea con un perfil por defecto
   */
  async loadProfiles() {
    try {
      console.log('[Auth] Cargando perfiles desde:', this.profilesFile);

      // Verificar si existe el archivo de perfiles
      const exists = await this._fileExists(this.profilesFile);

      if (!exists) {
        // Crear archivo con perfil por defecto
        console.log('[Auth] Archivo de perfiles no existe, creando uno nuevo...');
        await this._saveProfiles();
        return { success: true, profiles: [] };
      }

      // Leer archivo existente
      const data = await fs.readFile(this.profilesFile, 'utf-8');
      const parsed = JSON.parse(data);

      this.profiles = parsed.profiles || [];
      this.activeProfileId = parsed.activeProfileId || null;

      console.log(`[Auth] Cargados ${this.profiles.length} perfiles`);
      return { success: true, profiles: this.profiles };
    } catch (error) {
      console.error('[Auth] Error al cargar perfiles:', error);
      // En caso de error, inicializamos con array vacío
      this.profiles = [];
      this.activeProfileId = null;
      return { success: false, error: error.message, profiles: [] };
    }
  }

  /**
   * Obtiene todos los perfiles guardados
   * @returns {Object} - Lista de perfiles y perfil activo
   */
  async getProfiles() {
    try {
      return {
        success: true,
        profiles: this.profiles,
        activeProfileId: this.activeProfileId
      };
    } catch (error) {
      console.error('[Auth] Error al obtener perfiles:', error);
      return { success: false, error: error.message, profiles: [] };
    }
  }

  /**
   * Crea un nuevo perfil con un nickname
   * Genera un UUID v4 aleatorio y persistente para este perfil
   * @param {string} nickname - Nombre del jugador (mínimo 3 caracteres)
   * @returns {Object} - Resultado de la operación
   */
  async createProfile(nickname) {
    try {
      // Validar el nickname
      if (!nickname || typeof nickname !== 'string') {
        throw new Error('El nickname es requerido');
      }

      const trimmedNick = nickname.trim();

      if (trimmedNick.length < 3) {
        throw new Error('El nickname debe tener al menos 3 caracteres');
      }

      if (trimmedNick.length > 16) {
        throw new Error('El nickname no puede tener más de 16 caracteres');
      }

      // Validar caracteres permitidos (solo letras, números y guión bajo)
      const validRegex = /^[a-zA-Z0-9_]+$/;
      if (!validRegex.test(trimmedNick)) {
        throw new Error('El nickname solo puede contener letras, números y guión bajo');
      }

      // Verificar si ya existe un perfil con ese nickname
      const existingProfile = this.profiles.find(
        p => p.nickname.toLowerCase() === trimmedNick.toLowerCase()
      );

      if (existingProfile) {
        throw new Error(`Ya existe un perfil con el nickname "${trimmedNick}"`);
      }

      // Crear el nuevo perfil con UUID v4 aleatorio
      const newProfile = {
        id: uuidv4(),
        nickname: trimmedNick,
        uuid: uuidv4(), // UUID persistente para este perfil
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        // Si es el primer perfil, lo marcamos como activo automáticamente
        isActive: this.profiles.length === 0
      };

      // Si es el primer perfil, lo activamos
      if (newProfile.isActive) {
        this.activeProfileId = newProfile.id;
      }

      // Agregar a la lista y guardar
      this.profiles.push(newProfile);
      await this._saveProfiles();

      console.log(`[Auth] Perfil creado: ${trimmedNick} (UUID: ${newProfile.uuid})`);

      return {
        success: true,
        profile: newProfile,
        message: `Perfil "${trimmedNick}" creado correctamente`
      };
    } catch (error) {
      console.error('[Auth] Error al crear perfil:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Elimina un perfil existente
   * @param {string} profileId - ID del perfil a eliminar
   * @returns {Object} - Resultado de la operación
   */
  async deleteProfile(profileId) {
    try {
      // Buscar el índice del perfil
      const index = this.profiles.findIndex(p => p.id === profileId);

      if (index === -1) {
        throw new Error('Perfil no encontrado');
      }

      const profile = this.profiles[index];
      const profileName = profile.nickname;

      // Eliminar el perfil del array
      this.profiles.splice(index, 1);

      // Si era el perfil activo, asignar otro o dejarlo null
      if (this.activeProfileId === profileId) {
        if (this.profiles.length > 0) {
          this.activeProfileId = this.profiles[0].id;
          this.profiles[0].isActive = true;
        } else {
          this.activeProfileId = null;
        }
      }

      // Guardar cambios
      await this._saveProfiles();

      console.log(`[Auth] Perfil eliminado: ${profileName}`);

      return {
        success: true,
        message: `Perfil "${profileName}" eliminado`,
        activeProfileId: this.activeProfileId
      };
    } catch (error) {
      console.error('[Auth] Error al eliminar perfil:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Marca un perfil como activo y actualiza su último uso
   * @param {string} profileId - ID del perfil a activar
   * @returns {Object} - Resultado de la operación
   */
  async selectProfile(profileId) {
    try {
      const profile = this.profiles.find(p => p.id === profileId);

      if (!profile) {
        throw new Error('Perfil no encontrado');
      }

      // Desactivar todos los perfiles
      this.profiles.forEach(p => p.isActive = false);

      // Activar el seleccionado
      profile.isActive = true;
      profile.lastUsed = new Date().toISOString();
      this.activeProfileId = profileId;

      await this._saveProfiles();

      console.log(`[Auth] Perfil activo: ${profile.nickname}`);

      return {
        success: true,
        profile: profile,
        message: `Perfil "${profile.nickname}" seleccionado`
      };
    } catch (error) {
      console.error('[Auth] Error al seleccionar perfil:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Obtiene el perfil activo actual
   * @returns {Object|null} - Perfil activo o null
   */
  getActiveProfile() {
    if (!this.activeProfileId) return null;
    return this.profiles.find(p => p.id === this.activeProfileId) || null;
  }

  /**
   * Genera el objeto de usuario en el formato esperado por adlauncher-core
   * para autenticación offline
   * @param {Object} profile - Perfil a convertir
   * @returns {Object} - Objeto user para el launcher
   */
  getUserForLauncher(profile) {
    if (!profile) return null;
    return {
      username: profile.nickname,
      uuid: profile.uuid,
      access_token: 'offline_' + profile.uuid,
      client_token: profile.id,
      user_type: 'offline'
    };
  }

  // ============================================================
  // EXPORTAR / IMPORTAR PERFILES
  // ============================================================

  /**
   * Exporta los perfiles a un objeto JSON formateado
   * El formato incluye metadata para validar al importar
   * @param {Object} options - { onlyActive: boolean, profileIds: string[] }
   * @returns {Object} - Datos exportables
   */
  async exportProfiles(options = {}) {
    try {
      const { onlyActive = false, profileIds = null } = options;

      // Determinar qué perfiles exportar
      let toExport;
      if (onlyActive && this.activeProfileId) {
        toExport = this.profiles.filter(p => p.id === this.activeProfileId);
      } else if (Array.isArray(profileIds) && profileIds.length > 0) {
        toExport = this.profiles.filter(p => profileIds.includes(p.id));
      } else {
        // Por defecto, exportar todos
        toExport = [...this.profiles];
      }

      if (toExport.length === 0) {
        throw new Error('No hay perfiles para exportar');
      }

      // Construir el objeto de exportación con metadata
      const exportData = {
        // Metadata del archivo
        schemaVersion: this.EXPORT_SCHEMA_VERSION,
        app: this.EXPORT_APP,
        exportType: onlyActive ? 'single' : (profileIds ? 'selection' : 'all'),
        exportedAt: new Date().toISOString(),

        // Datos de los perfiles
        profiles: toExport.map(p => ({
          id: p.id,
          nickname: p.nickname,
          uuid: p.uuid,
          createdAt: p.createdAt,
          lastUsed: p.lastUsed
        })),

        // Solo guardar activeProfileId si estamos exportando un set que lo contiene
        activeProfileId: toExport.find(p => p.id === this.activeProfileId)
          ? this.activeProfileId
          : null,

        // Stats útiles
        stats: {
          totalProfiles: toExport.length,
          totalInLauncher: this.profiles.length
        }
      };

      console.log(`[Auth] Exportando ${toExport.length} perfil(es)`);

      return {
        success: true,
        data: exportData,
        count: toExport.length,
        message: `${toExport.length} perfil(es) preparado(s) para exportar`
      };
    } catch (error) {
      console.error('[Auth] Error al exportar perfiles:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Escribe los perfiles exportados a un archivo en disco
   * @param {string} targetPath - Ruta donde escribir el archivo
   * @param {Object} options - Opciones de exportación
   * @returns {Object} - Resultado de la operación
   */
  async exportProfilesToFile(targetPath, options = {}) {
    try {
      if (!targetPath) {
        throw new Error('Se requiere una ruta de destino');
      }

      // Obtener los datos a exportar
      const exportResult = await this.exportProfiles(options);
      if (!exportResult.success) {
        return exportResult;
      }

      // Asegurar que la extensión sea .json
      let finalPath = targetPath;
      if (!finalPath.toLowerCase().endsWith('.json')) {
        finalPath += '.json';
      }

      // Escribir el archivo con formato bonito
      await fs.writeFile(
        finalPath,
        JSON.stringify(exportResult.data, null, 2),
        'utf-8'
      );

      console.log(`[Auth] Perfiles exportados a: ${finalPath}`);

      return {
        success: true,
        path: finalPath,
        count: exportResult.count,
        message: `${exportResult.count} perfil(es) exportado(s) correctamente`
      };
    } catch (error) {
      console.error('[Auth] Error al escribir archivo de export:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Importa perfiles desde un objeto JSON
   * Estrategia de merge: no sobrescribe perfiles existentes con el mismo nickname
   * @param {Object} importData - Datos a importar
   * @param {Object} options - { overwrite: boolean, replaceAll: boolean }
   * @returns {Object} - Resultado de la importación
   */
  async importProfiles(importData, options = {}) {
    try {
      const { overwrite = false, replaceAll = false } = options;

      // Validar estructura del archivo
      if (!importData || typeof importData !== 'object') {
        throw new Error('Datos de importación inválidos');
      }

      if (!Array.isArray(importData.profiles)) {
        throw new Error('El archivo no contiene una lista de perfiles válida');
      }

      // Validar schema version (por ahora solo advertimos si es diferente)
      if (importData.schemaVersion && importData.schemaVersion !== this.EXPORT_SCHEMA_VERSION) {
        console.warn(
          `[Auth] Versión de schema diferente: ${importData.schemaVersion} vs ${this.EXPORT_SCHEMA_VERSION}`
        );
      }

      // Si replaceAll, limpiamos los perfiles actuales
      if (replaceAll) {
        console.log('[Auth] Reemplazando todos los perfiles existentes');
        this.profiles = [];
        this.activeProfileId = null;
      }

      // Estadísticas de la importación
      const stats = {
        total: importData.profiles.length,
        imported: 0,
        skipped: 0,
        overwritten: 0,
        errors: []
      };

      // Iterar perfiles del archivo
      for (const importedProfile of importData.profiles) {
        try {
          // Validar campos mínimos
          if (!importedProfile.nickname || !importedProfile.uuid) {
            throw new Error('Perfil sin nickname o uuid');
          }

          // Buscar si ya existe por nickname (case-insensitive)
          const existingIndex = this.profiles.findIndex(
            p => p.nickname.toLowerCase() === importedProfile.nickname.toLowerCase()
          );

          if (existingIndex !== -1) {
            if (overwrite) {
              // Sobrescribir manteniendo el id interno si existía
              this.profiles[existingIndex] = {
                ...this.profiles[existingIndex],
                ...importedProfile,
                // Mantener el id original del launcher si existía
                id: this.profiles[existingIndex].id
              };
              stats.overwritten++;
              console.log(`[Auth] Perfil sobrescrito: ${importedProfile.nickname}`);
            } else {
              stats.skipped++;
              console.log(`[Auth] Perfil omitido (ya existe): ${importedProfile.nickname}`);
            }
          } else {
            // No existe, agregar como nuevo
            // Asegurar que tenga todos los campos necesarios
            const newProfile = {
              id: importedProfile.id || uuidv4(),
              nickname: importedProfile.nickname,
              uuid: importedProfile.uuid,
              createdAt: importedProfile.createdAt || new Date().toISOString(),
              lastUsed: importedProfile.lastUsed || new Date().toISOString(),
              isActive: false
            };

            this.profiles.push(newProfile);
            stats.imported++;
            console.log(`[Auth] Perfil importado: ${importedProfile.nickname}`);
          }
        } catch (profileErr) {
          stats.errors.push({
            nickname: importedProfile.nickname || 'desconocido',
            error: profileErr.message
          });
        }
      }

      // Manejar activeProfileId
      if (importData.activeProfileId) {
        const activeProfile = this.profiles.find(p => p.id === importData.activeProfileId);
        if (activeProfile) {
          // Desactivar todos y activar el importado
          this.profiles.forEach(p => p.isActive = false);
          activeProfile.isActive = true;
          this.activeProfileId = activeProfile.id;
        }
      }

      // Si no hay perfil activo después de la importación, activar el primero
      if (!this.activeProfileId && this.profiles.length > 0) {
        this.profiles[0].isActive = true;
        this.activeProfileId = this.profiles[0].id;
      }

      // Guardar cambios
      await this._saveProfiles();

      const summary = `${stats.imported} importados, ${stats.skipped} omitidos, ${stats.overwritten} sobrescritos`;
      console.log(`[Auth] Importación completada: ${summary}`);

      return {
        success: true,
        stats: stats,
        activeProfileId: this.activeProfileId,
        message: `Importación completada: ${summary}`
      };
    } catch (error) {
      console.error('[Auth] Error al importar perfiles:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Importa perfiles desde un archivo en disco
   * @param {string} sourcePath - Ruta del archivo a importar
   * @param {Object} options - Opciones de importación
   * @returns {Object} - Resultado de la operación
   */
  async importProfilesFromFile(sourcePath, options = {}) {
    try {
      if (!sourcePath) {
        throw new Error('Se requiere una ruta de origen');
      }

      // Verificar que el archivo existe
      const exists = await this._fileExists(sourcePath);
      if (!exists) {
        throw new Error(`El archivo no existe: ${sourcePath}`);
      }

      // Leer el archivo
      const fileContent = await fs.readFile(sourcePath, 'utf-8');
      const importData = JSON.parse(fileContent);

      // Llamar al importador en memoria
      const result = await this.importProfiles(importData, options);

      if (result.success) {
        result.sourcePath = sourcePath;
        result.message = `${result.message} (desde ${sourcePath})`;
      }

      return result;
    } catch (error) {
      console.error('[Auth] Error al importar desde archivo:', error);

      // Distinguir entre error de parseo y otros
      if (error instanceof SyntaxError) {
        return {
          success: false,
          error: 'El archivo no es un JSON válido: ' + error.message
        };
      }

      return { success: false, error: error.message };
    }
  }

  // ============================================================
  // FIN EXPORTAR / IMPORTAR
  // ============================================================

  /**
   * Guarda los perfiles en el archivo JSON
   * @private
   */
  async _saveProfiles() {
    try {
      const data = {
        profiles: this.profiles,
        activeProfileId: this.activeProfileId,
        lastUpdated: new Date().toISOString()
      };

      // Asegurar que el directorio existe
      const dir = path.dirname(this.profilesFile);
      await fs.mkdir(dir, { recursive: true });

      // Escribir el archivo con formato bonito
      await fs.writeFile(
        this.profilesFile,
        JSON.stringify(data, null, 2),
        'utf-8'
      );
    } catch (error) {
      console.error('[Auth] Error al guardar perfiles:', error);
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

module.exports = AuthManager;
