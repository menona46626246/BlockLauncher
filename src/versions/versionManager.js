/**
 * versionManager.js - Gestor de versiones de Minecraft
 *
 * Maneja:
 * - Listado de versiones disponibles (release y snapshot) desde la API oficial de Mojang
 * - Cache local con TTL para no saturar la API
 * - Fallback a lista estática si no hay conexión
 * - Instalación/descarga de versiones vanilla
 * - Soporte para versiones modificadas: Forge, Fabric, OptiFine
 * - Lanzamiento del juego con la versión seleccionada
 * - Seguimiento de progreso de descarga
 *
 * El motor principal es el ManualLauncher nativo; adlauncher-core
 * (opcional) solo se usa para instalar versiones vanilla.
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');

// Importación de adlauncher-core (la dependencia principal, opcional)
// Si está disponible se usa, si no, nuestro ManualLauncher hace el trabajo
let adlauncher;
try {
  adlauncher = require('adlauncher-core');
} catch (e) {
  console.warn('[Versions] adlauncher-core no encontrado, usando ManualLauncher nativo');
  adlauncher = null;
}

// Nuestro launcher manual nativo (no requiere dependencias externas)
const ManualLauncher = require('./manualLauncher');

/**
 * URLs de las APIs oficiales de Mojang
 * Documentación: https://wiki.vg/Mojang_API
 */
const MOJANG_API = {
  // Devuelve la lista completa de versiones con metadata
  manifest: 'https://launchermeta.mojang.com/mc/game/version_manifest.json',
  // Devuelve info de un jugador por UUID
  profile: 'https://sessionserver.mojang.com/session/minecraft/profile/'
};

class VersionManager {
  /**
   * Constructor del gestor de versiones
   * @param {ConfigManager} configManager - Instancia del gestor de configuración
   */
  constructor(configManager) {
    this.configManager = configManager;
    this.versions = [];
    this.installedVersions = [];
    this.supportedModLoaders = ['forge', 'fabric', 'optifine', 'vanilla'];
    this.manualLauncher = new ManualLauncher();
    this.activeChild = null; // proceso del juego en ejecución

    // Configuración de caché de versiones remotas
    this.cacheFile = path.join(__dirname, '..', '..', 'config', 'versions_cache.json');
    this.cacheTTL = 6 * 60 * 60 * 1000; // 6 horas en milisegundos
    this.remoteVersions = null; // Lista remota cacheada en memoria

    // Timeouts para las peticiones HTTP
    this.requestTimeout = 10000; // 10 segundos
  }

  /**
   * Inicializa el gestor cargando las versiones instaladas, sincronizando
   * con el disco y cargando la caché remota
   */
  async initialize() {
    try {
      console.log('[Versions] Inicializando gestor de versiones...');
      await this._loadInstalledVersions();
      await this._syncInstalledWithDisk();
      await this._loadRemoteCache();
      console.log('[Versions] Gestor inicializado correctamente');
    } catch (error) {
      console.error('[Versions] Error en inicialización:', error);
    }
  }

  /**
   * Lista todas las versiones disponibles de Minecraft
   * Estrategia:
   * 1. Si la caché es reciente (< TTL), usa la caché
   * 2. Si no, intenta fetch desde la API oficial de Mojang
   * 3. Si falla (sin internet), usa la lista estática de fallback
   * @param {Object} options - { forceRefresh: boolean }
   * @returns {Object} - Resultado con la lista de versiones
   */
  async listVersions(options = {}) {
    const { forceRefresh = false } = options;

    try {
      console.log('[Versions] Obteniendo lista de versiones...');

      let remoteVersions = null;

      // Decidir si usar caché o fetch
      if (!forceRefresh && this.remoteVersions && this._isCacheFresh()) {
        console.log('[Versions] Usando caché de versiones remotas');
        remoteVersions = this.remoteVersions;
      } else {
        // Intentar obtener versiones de la API de Mojang
        remoteVersions = await this._fetchRemoteVersions();

        // Si no se pudieron obtener, usar fallback
        if (!remoteVersions) {
          console.warn('[Versions] Usando lista estática de fallback');
          remoteVersions = this._getFallbackVersions();
        } else {
          // Guardar en caché
          this.remoteVersions = remoteVersions;
          await this._saveRemoteCache(remoteVersions);
        }
      }

      // Marcar cuáles están instaladas
      const versionsWithStatus = remoteVersions.map(v => ({
        ...v,
        installed: this.installedVersions.includes(v.id),
        // Agregar info de mod loaders disponibles por versión
        modLoaders: this._getModLoadersForVersion(v.id)
      }));

      // Incluir versiones locales compuestas (Fabric/Forge/NeoForge)
      this._appendLocalVersions(versionsWithStatus);

      this.versions = versionsWithStatus;

      return {
        success: true,
        versions: versionsWithStatus,
        installedCount: this.installedVersions.length,
        totalCount: versionsWithStatus.length,
        fromCache: !forceRefresh && this._isCacheFresh(),
        lastFetch: this._getCacheTimestamp()
      };
    } catch (error) {
      console.error('[Versions] Error al listar versiones:', error);

      // En caso de error total, devolver al menos el fallback
      const fallback = this._getFallbackVersions();
      const versionsWithStatus = fallback.map(v => ({
        ...v,
        installed: this.installedVersions.includes(v.id),
        modLoaders: this._getModLoadersForVersion(v.id)
      }));

      // No perder las compuestas aunque no haya conexión
      this._appendLocalVersions(versionsWithStatus);

      return {
        success: false,
        error: error.message,
        versions: versionsWithStatus,
        installedCount: this.installedVersions.length,
        totalCount: versionsWithStatus.length
      };
    }
  }

  /**
   * Añade a una lista de versiones las locales compuestas (creadas por los
   * installers de Fabric/Forge/NeoForge) que no aparecen en la lista de Mojang.
   * @private
   */
  _appendLocalVersions(list) {
    const existingIds = new Set(list.map(v => v.id));
    for (const localId of this.installedVersions) {
      if (!existingIds.has(localId)) {
        list.push({
          id: localId,
          type: 'release',
          releaseDate: null,
          installed: true,
          local: true,
          modLoaders: []
        });
      }
    }
  }

  /**
   * Fuerza una actualización desde la API de Mojang
   * @returns {Object} - Resultado con metadata
   */
  async refreshVersions() {
    try {
      console.log('[Versions] Forzando refresh de versiones remotas...');
      const result = await this.listVersions({ forceRefresh: true });

      if (result.success) {
        return {
          success: true,
          count: result.totalCount,
          fromCache: false,
          message: `Se actualizaron ${result.totalCount} versiones desde la API de Mojang`
        };
      } else {
        return {
          success: false,
          error: result.error,
          message: 'No se pudo actualizar desde la API, usando fallback'
        };
      }
    } catch (error) {
      console.error('[Versions] Error en refresh:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Hace fetch de las versiones desde la API oficial de Mojang
   * @private
   * @returns {Array|null} - Array de versiones o null si falla
   */
  async _fetchRemoteVersions() {
    try {
      console.log('[Versions] Fetching desde Mojang API:', MOJANG_API.manifest);

      const data = await this._httpsGet(MOJANG_API.manifest, this.requestTimeout);

      if (!data || !data.versions || !Array.isArray(data.versions)) {
        throw new Error('Respuesta inválida de la API de Mojang');
      }

      // Mapear al formato interno
      // La API devuelve: { id, type, url, time, releaseTime }
      const versions = data.versions.map(v => ({
        id: v.id,
        type: v.type, // 'release' o 'snapshot'
        releaseDate: v.releaseTime,
        // Guardamos también la URL del JSON específico de la versión
        manifestUrl: v.url,
        // Guardamos también el ID del assets index si lo necesitamos
        assetsIndexUrl: undefined
      }));

      console.log(`[Versions] Obtenidas ${versions.length} versiones desde Mojang`);
      return versions;
    } catch (error) {
      console.error('[Versions] Error al hacer fetch remoto:', error.message);
      return null;
    }
  }

  /**
   * Wrapper para hacer GET HTTPS con timeout y parsing JSON
   * @private
   * @param {string} url - URL a la que hacer GET
   * @param {number} timeout - Timeout en ms
   * @returns {Promise<Object>} - Objeto parseado del JSON
   */
  _httpsGet(url, timeout = 10000) {
    return new Promise((resolve, reject) => {
      try {
        const req = https.get(url, { timeout }, (res) => {
          // Manejar redirecciones (3xx)
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            console.log(`[Versions] Redirect a: ${res.headers.location}`);
            this._httpsGet(res.headers.location, timeout).then(resolve).catch(reject);
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (parseErr) {
              reject(new Error('JSON inválido: ' + parseErr.message));
            }
          });
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Timeout en la petición'));
        });

        req.on('error', (err) => {
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Lista estática de fallback cuando no hay internet
   * @private
   */
  _getFallbackVersions() {
    return [
      // Releases recientes
      { id: '1.21.1', type: 'release', releaseDate: '2024-08-08' },
      { id: '1.21', type: 'release', releaseDate: '2024-06-13' },
      { id: '1.20.6', type: 'release', releaseDate: '2024-04-23' },
      { id: '1.20.4', type: 'release', releaseDate: '2024-01-12' },
      { id: '1.20.2', type: 'release', releaseDate: '2023-09-21' },
      { id: '1.20.1', type: 'release', releaseDate: '2023-06-12' },
      { id: '1.20', type: 'release', releaseDate: '2023-06-07' },
      { id: '1.19.4', type: 'release', releaseDate: '2023-03-14' },
      { id: '1.19.2', type: 'release', releaseDate: '2022-08-05' },
      { id: '1.19', type: 'release', releaseDate: '2022-06-07' },
      { id: '1.18.2', type: 'release', releaseDate: '2022-02-28' },
      { id: '1.18.1', type: 'release', releaseDate: '2021-12-10' },
      { id: '1.18', type: 'release', releaseDate: '2021-11-30' },
      { id: '1.17.1', type: 'release', releaseDate: '2021-07-06' },
      { id: '1.17', type: 'release', releaseDate: '2021-06-08' },
      { id: '1.16.5', type: 'release', releaseDate: '2021-01-15' },
      { id: '1.16.4', type: 'release', releaseDate: '2020-11-03' },
      { id: '1.16.3', type: 'release', releaseDate: '2020-09-10' },
      { id: '1.16.2', type: 'release', releaseDate: '2020-08-11' },
      { id: '1.16.1', type: 'release', releaseDate: '2020-06-24' },
      { id: '1.15.2', type: 'release', releaseDate: '2020-01-21' },
      { id: '1.14.4', type: 'release', releaseDate: '2019-07-19' },
      { id: '1.13.2', type: 'release', releaseDate: '2018-07-18' },
      { id: '1.12.2', type: 'release', releaseDate: '2017-09-18' },
      { id: '1.11.2', type: 'release', releaseDate: '2016-12-21' },
      { id: '1.10.2', type: 'release', releaseDate: '2016-06-23' },
      { id: '1.9.4', type: 'release', releaseDate: '2016-05-10' },
      { id: '1.8.9', type: 'release', releaseDate: '2016-01-14' },
      // Snapshots
      { id: '1.21.2-snapshot', type: 'snapshot', releaseDate: '2024-09-12' },
      { id: '1.21.1-snapshot', type: 'snapshot', releaseDate: '2024-08-08' },
      { id: '1.21-snapshot', type: 'snapshot', releaseDate: '2024-05-31' }
    ];
  }

  /**
   * Instala/descarga una versión específica
   * @param {Object} versionData - { id, type, modLoader }
   * @param {Function} progressCallback - Callback para reportar progreso
   * @returns {Object} - Resultado de la instalación
   */
  async installVersion(versionData, progressCallback) {
    try {
      const { id, type = 'release', modLoader = null } = versionData;

      if (!id) {
        throw new Error('ID de versión requerido');
      }

      console.log(`[Versions] Iniciando instalación de ${id}${modLoader ? ' con ' + modLoader : ''}...`);

      // Notificar inicio
      if (progressCallback) {
        progressCallback({
          version: id,
          modLoader: modLoader,
          percent: 0,
          speed: '0 MB/s',
          status: 'Iniciando descarga...',
          stage: 'starting'
        });
      }

      // Obtener la ruta raíz de Minecraft desde la configuración
      const minecraftRoot = await this._getMinecraftRoot();

      // Fabric requiere el motor nativo (adlauncher-core solo instala vanilla)
      if (modLoader === 'fabric') {
        const fabricResult = await this.manualLauncher.installVersion({
          versionId: id,
          root: minecraftRoot,
          modLoader: 'fabric',
          onProgress: (p) => {
            if (progressCallback) {
              progressCallback({
                version: id,
                modLoader: modLoader,
                percent: p.percent || 0,
                speed: '',
                status: p.status || '',
                stage: p.stage || 'modloader'
              });
            }
          }
        });

        if (!fabricResult.success) {
          throw new Error(fabricResult.error);
        }

        const fabricId = fabricResult.fabricVersion;

        // Registrar la versión compuesta (y la base vanilla por si acaso)
        for (const versionToAdd of [id, fabricId]) {
          if (!this.installedVersions.includes(versionToAdd)) {
            this.installedVersions.push(versionToAdd);
          }
        }
        await this._saveInstalledVersions();

        if (progressCallback) {
          progressCallback({
            version: fabricId,
            modLoader: modLoader,
            percent: 100,
            speed: 'Completado',
            status: `Fabric instalado como ${fabricId}`,
            stage: 'completed'
          });
        }

        console.log(`[Versions] Instalación completada: ${fabricId}`);

        return {
          success: true,
          version: fabricId,
          modLoader: modLoader,
          message: `Fabric instalado como ${fabricId}`
        };
      }

      // NeoForge / Forge clásico: también requiere el motor nativo
      if (modLoader === 'neoforge' || modLoader === 'forge') {
        const loaderName = modLoader === 'neoforge' ? 'NeoForge' : 'Forge';
        const loaderResult = await this.manualLauncher.installVersion({
          versionId: id,
          root: minecraftRoot,
          modLoader: modLoader,
          onProgress: (p) => {
            if (progressCallback) {
              progressCallback({
                version: id,
                modLoader: modLoader,
                percent: p.percent || 0,
                speed: '',
                status: p.status || '',
                stage: p.stage || 'modloader'
              });
            }
          }
        });

        if (!loaderResult.success) {
          throw new Error(loaderResult.error);
        }

        const loaderId = loaderResult.loaderVersion;

        // Registrar la versión compuesta (y la base vanilla por si acaso)
        for (const versionToAdd of [id, loaderId]) {
          if (!this.installedVersions.includes(versionToAdd)) {
            this.installedVersions.push(versionToAdd);
          }
        }
        await this._saveInstalledVersions();

        if (progressCallback) {
          progressCallback({
            version: loaderId,
            modLoader: modLoader,
            percent: 100,
            speed: 'Completado',
            status: `${loaderName} instalado como ${loaderId}`,
            stage: 'completed'
          });
        }

        console.log(`[Versions] Instalación completada: ${loaderId}`);

        return {
          success: true,
          version: loaderId,
          modLoader: modLoader,
          message: `${loaderName} instalado como ${loaderId}`
        };
      }

      // Intentar usar adlauncher-core si está disponible
      if (adlauncher && typeof adlauncher.downloadMinecraft === 'function') {
        try {
          await adlauncher.downloadMinecraft({
            root: minecraftRoot,
            version: id,
            type: type,
            modLoader: modLoader,
            onProgress: (progress) => {
              if (progressCallback) {
                progressCallback({
                  version: id,
                  modLoader: modLoader,
                  percent: progress.percent || 0,
                  speed: progress.speed || 'N/A',
                  status: progress.status || 'Descargando...',
                  stage: 'downloading'
                });
              }
            }
          });
        } catch (adError) {
          console.warn('[Versions] Error en adlauncher-core, usando ManualLauncher:', adError.message);
          await this._installWithManualLauncher(id, minecraftRoot, modLoader, progressCallback);
        }
      } else {
        // Usar ManualLauncher nativo (no requiere dependencias externas)
        await this._installWithManualLauncher(id, minecraftRoot, modLoader, progressCallback);
      }

      // Marcar como instalada
      if (!this.installedVersions.includes(id)) {
        this.installedVersions.push(id);
      }

      // Guardar lista de versiones instaladas
      await this._saveInstalledVersions();

      // Notificar finalización
      if (progressCallback) {
        progressCallback({
          version: id,
          modLoader: modLoader,
          percent: 100,
          speed: 'Completado',
          status: 'Instalación completada',
          stage: 'completed'
        });
      }

      console.log(`[Versions] Instalación completada: ${id}`);

      return {
        success: true,
        version: id,
        modLoader: modLoader,
        message: `Versión ${id} instalada correctamente`
      };
    } catch (error) {
      console.error('[Versions] Error al instalar versión:', error);

      if (progressCallback) {
        progressCallback({
          percent: 0,
          status: 'Error: ' + error.message,
          stage: 'error'
        });
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Lanza el juego con la configuración especificada
   * @param {Object} launchOptions - Opciones de lanzamiento
   * @param {Function} logCallback - Callback para logs en tiempo real
   * @returns {Object} - Resultado del lanzamiento
   */
  async launchGame(launchOptions, logCallback) {
    try {
      const {
        profile,
        version,
        modLoader = null,
        memory = 4,
        javaPath = null,
        jvmArgs = ''
      } = launchOptions;

      if (!profile) {
        throw new Error('Se requiere un perfil activo');
      }

      if (!version) {
        throw new Error('Se requiere una versión');
      }

      if (memory < 2 || memory > 16) {
        throw new Error('La memoria debe estar entre 2 y 16 GB');
      }

      console.log(`[Versions] Lanzando Minecraft ${version} para ${profile.nickname}...`);
      this._log(logCallback, `[Launcher] Iniciando Minecraft ${version}`);
      this._log(logCallback, `[Launcher] Usuario: ${profile.nickname}`);
      this._log(logCallback, `[Launcher] Memoria asignada: ${memory} GB`);

      // Verificar que la versión esté instalada
      if (!this.installedVersions.includes(version)) {
        throw new Error(`La versión ${version} no está instalada. Instálala primero.`);
      }

      // Obtener configuración
      const gameDirectory = await this._getMinecraftRoot();

      // Java configurado (el ManualLauncher verifica compatibilidad y descarga
      // un Java adecuado automáticamente si no sirve para esta versión)
      const configResult = await this.configManager.getConfig();
      const savedJava = configResult && configResult.config ? configResult.config.javaPath : null;
      const configuredJava = (javaPath && javaPath !== 'No detectada')
        ? javaPath
        : (savedJava || null);

      if (modLoader && modLoader !== 'vanilla' && !this._isCompositeVersion(version)) {
        this._log(logCallback, `[Launcher] Aviso: el motor nativo ejecuta vanilla. El mod loader "${modLoader}" será ignorado.`);
      }

      this._log(logCallback, `[Launcher] Java configurado: ${configuredJava || 'No detectado (se descargará uno compatible si es necesario)'}`);

      // Lanzar con el motor nativo: maneja librerías, natives, assets,
      // Java compatible y argumentos según el spec oficial
      return await this._launchWithManualLauncher(launchOptions, logCallback, configuredJava, gameDirectory);
    } catch (error) {
      console.error('[Versions] Error al lanzar juego:', error);
      this._log(logCallback, `[ERROR] ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Detecta los mod loaders disponibles para una versión
   * @private
   */
  _getModLoadersForVersion(versionId) {
    // Todas las versiones recientes soportan Forge, Fabric y OptiFine
    return ['forge', 'fabric', 'optifine'];
  }

  /**
   * Instala una versión usando el ManualLauncher nativo (sin dependencias externas)
   * @private
   */
  async _installWithManualLauncher(versionId, minecraftRoot, modLoader, progressCallback) {
    try {
      console.log(`[Versions] Usando ManualLauncher para instalar ${versionId}`);

      const result = await this.manualLauncher.installVersion({
        versionId,
        root: minecraftRoot,
        onProgress: (progress) => {
          if (progressCallback) {
            progressCallback({
              version: versionId,
              modLoader: modLoader,
              percent: progress.percent || 0,
              speed: progress.speed || '',
              status: progress.status || '',
              stage: progress.stage || 'downloading',
              current: progress.current,
              total: progress.total
            });
          }
        }
      });

      return result;
    } catch (error) {
      console.error('[Versions] Error en ManualLauncher.install:', error);
      throw error;
    }
  }

  /**
   * Lanza el juego usando el ManualLauncher nativo
   * @private
   */
  async _launchWithManualLauncher(launchOptions, logCallback, java, gameDirectory) {
    try {
      this._log(logCallback, `[Launcher] Iniciando con ManualLauncher nativo...`);

      const jvmArgsArray = launchOptions.jvmArgs
        ? launchOptions.jvmArgs.split(' ').filter(a => a.trim())
        : [];

      const result = await this.manualLauncher.launch({
        versionId: launchOptions.version,
        root: gameDirectory,
        username: launchOptions.profile.nickname,
        uuid: launchOptions.profile.uuid,
        memory: {
          min: `${Math.max(1, launchOptions.memory - 1)}G`,
          max: `${launchOptions.memory}G`
        },
        java: java || null,
        jvmArgs: jvmArgsArray,
        gameDirectory: gameDirectory,
        onLog: (msg) => this._log(logCallback, msg)
      });

      if (result.success) {
        // Guardar referencia del proceso para poder detenerlo desde la UI
        this.activeChild = result.child || null;
        if (this.activeChild) {
          // 'close' siempre se emite (también si el spawn falló)
          this.activeChild.once('close', () => {
            this.activeChild = null;
          });
        }

        this._log(logCallback, `[Launcher] ✓ Juego iniciado (PID: ${result.pid})`);
        this._log(logCallback, `[Launcher] Disfruta tu partida!`);
        return {
          success: true,
          pid: result.pid,
          message: 'Juego iniciado correctamente'
        };
      } else {
        this._log(logCallback, `[ERROR] ${result.error}`);
        return result;
      }
    } catch (error) {
      console.error('[Versions] Error en ManualLauncher.launch:', error);
      this._log(logCallback, `[ERROR] ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Detiene el juego en ejecución (si hay)
   */
  stopGame() {
    if (this.activeChild) {
      try {
        const pid = this.activeChild.pid;
        this.activeChild.kill();
        this.activeChild = null;
        console.log(`[Versions] Señal de cierre enviada al juego (PID: ${pid})`);
        return { success: true, pid, message: 'Señal de cierre enviada al juego' };
      } catch (error) {
        console.error('[Versions] Error al detener el juego:', error);
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'No hay ningún juego en ejecución' };
  }

  /**
   * Determina si un id de versión corresponde a una versión compuesta
   * de un mod loader (creada por este launcher o por sus installers)
   */
  _isCompositeVersion(versionId) {
    return typeof versionId === 'string' && (
      versionId.includes('-fabric') ||
      versionId.includes('-forge') ||
      versionId.startsWith('neoforge') ||
      versionId.startsWith('forge-')
    );
  }

  // ============================================================
  // GESTIÓN DE VERSIONES INSTALADAS
  // ============================================================

  /**
   * Sincroniza la lista de versiones instaladas con el contenido real del
   * directorio versions/: añade las que estén en disco y quita las que no.
   */
  async _syncInstalledWithDisk() {
    try {
      const root = await this._getMinecraftRoot();
      const versionsDir = path.join(root, 'versions');

      let entries = [];
      try {
        entries = await fs.readdir(versionsDir, { withFileTypes: true });
      } catch {
        return; // el directorio versions aún no existe
      }

      // Una versión instalada = carpeta con su <id>.json dentro
      const onDisk = new Set();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const jsonPath = path.join(versionsDir, entry.name, `${entry.name}.json`);
        if (await this._fileExists(jsonPath)) {
          onDisk.add(entry.name);
        }
      }

      const before = [...this.installedVersions];
      const synced = before.filter(v => onDisk.has(v));
      for (const id of onDisk) {
        if (!synced.includes(id)) synced.push(id);
      }
      this.installedVersions = synced;

      const added = synced.filter(v => !before.includes(v));
      const removed = before.filter(v => !synced.includes(v));

      if (added.length > 0 || removed.length > 0) {
        if (added.length > 0) console.log(`[Versions] Detectadas en disco: ${added.join(', ')}`);
        if (removed.length > 0) console.log(`[Versions] Ya no están en disco: ${removed.join(', ')}`);
        await this._saveInstalledVersions();
      }

      return { added, removed };
    } catch (error) {
      console.warn('[Versions] No se pudo sincronizar con el disco:', error.message);
      return { added: [], removed: [] };
    }
  }

  /**
   * Lista las versiones instaladas con metadatos: tamaño en disco,
   * versión padre (inheritsFrom) y qué versiones dependen de ella.
   */
  async listInstalledVersions() {
    try {
      const root = await this._getMinecraftRoot();
      const installed = [];

      for (const versionId of this.installedVersions) {
        const versionDir = path.join(root, 'versions', versionId);
        const jsonPath = path.join(versionDir, `${versionId}.json`);
        const onDisk = await this._fileExists(jsonPath);

        let parent = null;
        let sizeBytes = 0;
        if (onDisk) {
          try {
            const json = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
            parent = json.inheritsFrom || null;
          } catch { /* json corrupto: se trata como instalada sin padre */ }
          sizeBytes = await this._dirSize(versionDir);
        }

        installed.push({
          id: versionId,
          onDisk,
          parent,
          sizeBytes,
          loader: versionId.includes('-fabric') ? 'Fabric'
            : versionId.startsWith('neoforge') ? 'NeoForge'
            : (versionId.includes('-forge') || versionId.startsWith('forge-')) ? 'Forge'
            : null
        });
      }

      // Mapear dependientes (versiones que heredan de esta)
      for (const v of installed) {
        v.dependents = installed
          .filter(o => o.id !== v.id && o.parent === v.id)
          .map(o => o.id);
      }

      installed.sort((a, b) => a.id.localeCompare(b.id));

      return { success: true, installed };
    } catch (error) {
      console.error('[Versions] Error al listar versiones instaladas:', error);
      return { success: false, error: error.message, installed: [] };
    }
  }

  /**
   * Elimina una versión instalada: borra su carpeta (JAR, natives,
   * metadata) y la quita del registro. Bloquea el borrado si otra
   * versión instalada hereda de ella (p.ej. la base de un Fabric).
   */
  async deleteVersion(versionId) {
    try {
      if (!versionId || typeof versionId !== 'string') {
        throw new Error('Se requiere un ID de versión');
      }

      // No borrar archivos que el juego podría estar usando
      if (this.activeChild) {
        throw new Error('Detén el juego antes de eliminar versiones');
      }

      const root = await this._getMinecraftRoot();

      // 1. Verificar dependencias: versiones cuyo inheritsFrom apunta aquí
      const dependents = [];
      for (const otherId of this.installedVersions) {
        if (otherId === versionId) continue;
        const otherJson = path.join(root, 'versions', otherId, `${otherId}.json`);
        if (await this._fileExists(otherJson)) {
          try {
            const json = JSON.parse(await fs.readFile(otherJson, 'utf-8'));
            if (json.inheritsFrom === versionId) dependents.push(otherId);
          } catch { /* ignorar json corrupto */ }
        }
      }
      if (dependents.length > 0) {
        throw new Error(
          `No se puede eliminar "${versionId}": ${dependents.join(', ')} depende de ella. Elimínalas primero.`
        );
      }

      // 2. Calcular el espacio que se liberará
      const versionDir = path.join(root, 'versions', versionId);
      const sizeBytes = await this._fileExists(versionDir) ? await this._dirSize(versionDir) : 0;

      // 3. Borrar la carpeta de la versión
      if (await this._fileExists(versionDir)) {
        await fs.rm(versionDir, { recursive: true, force: true });
      }

      // 4. Quitar del registro y guardar
      this.installedVersions = this.installedVersions.filter(v => v !== versionId);
      await this._saveInstalledVersions();

      const freedMB = (sizeBytes / (1024 * 1024)).toFixed(1);
      console.log(`[Versions] Versión ${versionId} eliminada (${freedMB} MB liberados)`);

      return {
        success: true,
        versionId,
        freedBytes: sizeBytes,
        message: `Versión ${versionId} eliminada (${freedMB} MB liberados)`
      };
    } catch (error) {
      console.error('[Versions] Error al eliminar versión:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Obtiene el directorio raíz de Minecraft desde la configuración
   * @private
   */
  async _getMinecraftRoot() {
    const result = await this.configManager.getConfig();
    const dir = result && result.config ? result.config.minecraftDirectory : null;
    return dir || path.join(__dirname, '..', '..', '.minecraft');
  }

  /**
   * Calcula recursivamente el tamaño en bytes de un directorio
   * @private
   */
  async _dirSize(dirPath) {
    let total = 0;
    let entries = [];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await this._dirSize(full);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null);
        if (stat) total += stat.size;
      }
    }
    return total;
  }

  /**
   * Auto-detecta la ruta de Java en el sistema
   * @private
   */
  async _autoDetectJava() {
    try {
      const { execSync } = require('child_process');
      let command;

      if (process.platform === 'win32') {
        command = 'where java';
      } else {
        command = 'which java';
      }

      const result = execSync(command, { encoding: 'utf-8' });
      const javaPath = result.trim().split('\n')[0];

      console.log(`[Versions] Java detectado en: ${javaPath}`);
      return javaPath;
    } catch (error) {
      console.warn('[Versions] No se pudo auto-detectar Java:', error.message);
      return null;
    }
  }

  /**
   * Carga la lista de versiones instaladas desde el archivo
   * @private
   */
  async _loadInstalledVersions() {
    try {
      const installedFile = path.join(__dirname, '..', '..', 'config', 'installed_versions.json');
      const exists = await this._fileExists(installedFile);

      if (exists) {
        const data = await fs.readFile(installedFile, 'utf-8');
        const parsed = JSON.parse(data);
        this.installedVersions = parsed.versions || [];
      } else {
        this.installedVersions = [];
      }
    } catch (error) {
      console.error('[Versions] Error al cargar versiones instaladas:', error);
      this.installedVersions = [];
    }
  }

  /**
   * Carga la caché de versiones remotas
   * @private
   */
  async _loadRemoteCache() {
    try {
      const exists = await this._fileExists(this.cacheFile);
      if (exists) {
        const data = await fs.readFile(this.cacheFile, 'utf-8');
        const parsed = JSON.parse(data);
        this.remoteVersions = parsed.versions || null;
        console.log(`[Versions] Caché cargada con ${this.remoteVersions ? this.remoteVersions.length : 0} versiones`);
      } else {
        this.remoteVersions = null;
      }
    } catch (error) {
      console.error('[Versions] Error al cargar caché remota:', error);
      this.remoteVersions = null;
    }
  }

  /**
   * Guarda la caché de versiones remotas con timestamp
   * @private
   */
  async _saveRemoteCache(versions) {
    try {
      const data = {
        versions: versions,
        cachedAt: new Date().toISOString(),
        ttl: this.cacheTTL
      };
      await fs.writeFile(this.cacheFile, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`[Versions] Caché guardada con ${versions.length} versiones`);
    } catch (error) {
      console.error('[Versions] Error al guardar caché remota:', error);
    }
  }

  /**
   * Verifica si la caché en disco aún es fresca (dentro del TTL)
   * @private
   */
  _isCacheFresh() {
    try {
      if (!this.remoteVersions) return false;
      // Leer timestamp del archivo de caché
      const stats = require('fs').statSync(this.cacheFile);
      const ageMs = Date.now() - stats.mtimeMs;
      return ageMs < this.cacheTTL;
    } catch {
      return false;
    }
  }

  /**
   * Obtiene el timestamp del último fetch (de la caché)
   * @private
   */
  _getCacheTimestamp() {
    try {
      const stats = require('fs').statSync(this.cacheFile);
      return new Date(stats.mtimeMs).toISOString();
    } catch {
      return null;
    }
  }

  /**
   * Guarda la configuración en el archivo JSON
   * @private
   */
  async _saveInstalledVersions() {
    try {
      const installedFile = path.join(__dirname, '..', '..', 'config', 'installed_versions.json');
      const data = {
        versions: this.installedVersions,
        lastUpdated: new Date().toISOString()
      };
      await fs.writeFile(installedFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.error('[Versions] Error al guardar versiones instaladas:', error);
    }
  }

  /**
   * Envía un log al callback
   * @private
   */
  _log(callback, message) {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${message}`;
    if (callback) callback(formatted);
    console.log(formatted);
  }

  /**
   * Sleep helper
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

module.exports = VersionManager;
