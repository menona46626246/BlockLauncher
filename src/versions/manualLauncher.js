/**
 * manualLauncher.js - Lanzador manual de Minecraft (sin dependencias externas)
 *
 * Implementa desde cero el flujo completo de descarga y lanzamiento:
 * 1. Descarga del version.json específico desde Mojang
 * 2. Descarga de librerías (.jar) desde Maven (con evaluación de rules por OS)
 * 3. Descarga de assets (recursos) desde Mojang
 * 4. Extracción de natives (.so / .dll / .dylib) con adm-zip
 * 5. Selección automática de un Java compatible (descarga Temurin si hace falta)
 * 6. Construcción del classpath y argumentos JVM según el spec oficial
 *    (arguments.jvm / arguments.game / minecraftArguments con rules)
 * 7. Spawn del proceso java con todos los args correctos
 * 8. Auth offline (no contacta sessionserver.mojang.com)
 *
 * Referencia del formato de version.json:
 * https://minecraft.fandom.com/wiki/Client.json
 *
 * Esto es lo que hacen internamente TLauncher, MultiMC, Prism, etc.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { URL } = require('url');

const JavaRuntime = require('./javaRuntime');

/**
 * Metadatos de los mod loaders que se instalan con el installer oficial
 * (headless): NeoForge y Forge clásico.
 */
const INSTALLER_LOADERS = {
  neoforge: {
    name: 'NeoForge',
    metadataUrl: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
    versionPrefix: (mcVersion) => `${mcVersion}.`,
    installerUrl: (v) => `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/neoforge-${v}-installer.jar`
  },
  forge: {
    name: 'Forge',
    metadataUrl: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
    versionPrefix: (mcVersion) => `${mcVersion}-`,
    installerUrl: (v) => `https://maven.minecraftforge.net/net/minecraftforge/forge/${v}/forge-${v}-installer.jar`
  }
};

class ManualLauncher {
  constructor() {
    this.userAgent = 'ADLauncher/1.0.1';
    this.downloadTimeout = 60000; // 60 segundos por archivo
    this.maxConcurrentDownloads = 4; // descargas paralelas
    this.launcherName = 'ADLauncher';
    this.launcherVersion = '1.0.1';
    this.javaRuntime = new JavaRuntime();
  }

  /**
   * Punto de entrada principal: descarga e instala una versión completa
   * @param {Object} options
   * @param {string} options.versionId - ej: "1.20.4"
   * @param {string} options.root - directorio raíz de Minecraft (.minecraft)
   * @param {Function} options.onProgress - callback de progreso
   * @returns {Promise<Object>}
   */
  async installVersion(options) {
    const { versionId, root, modLoader = null, onProgress = () => {} } = options;

    try {
      console.log(`[ManualLauncher] Instalando versión ${versionId} (loader: ${modLoader || 'vanilla'}) en ${root}`);

      // 1. Asegurar estructura de directorios
      const dirs = this._getDirectoryStructure(root);
      await this._ensureDirs(dirs);

      onProgress({ percent: 1, status: 'Obteniendo metadata de versión...', stage: 'starting' });

      // 2. Obtener version.json (o manifest primero si no lo tenemos)
      const versionJson = await this._getVersionJson(versionId, root);

      onProgress({ percent: 5, status: 'Version.json descargado', stage: 'metadata' });

      // 3. Descargar librerías
      const libsTotal = (versionJson.libraries || []).length;
      onProgress({
        percent: 10,
        status: `Descargando ${libsTotal} librerías...`,
        stage: 'libraries',
        total: libsTotal
      });

      await this._downloadLibraries(versionJson.libraries || [], dirs.libraries, (current, total) => {
        const pct = 10 + Math.floor((current / total) * 35); // 10% → 45%
        onProgress({
          percent: pct,
          status: `Descargando librería ${current}/${total}...`,
          stage: 'libraries',
          total,
          current
        });
      });

      // 4. Descargar assets
      onProgress({ percent: 45, status: 'Descargando assets...', stage: 'assets' });
      await this._downloadAssets(versionJson, root, dirs.assets, (current, total, downloadedCount) => {
        const pct = 45 + Math.floor((current / total) * 35); // 45% → 80%
        const verb = (downloadedCount || 0) > 0
          ? `Descargando asset ${current}/${total}...`
          : `Verificando assets ${current}/${total}...`;
        onProgress({
          percent: pct,
          status: verb,
          stage: 'assets',
          total,
          current
        });
      });

      // 5. Descargar el JAR del cliente
      onProgress({ percent: 80, status: 'Descargando JAR del cliente...', stage: 'jar' });
      await this._downloadClientJar(versionJson, dirs.versions, versionId);

      // 6. Descargar y extraer natives
      onProgress({ percent: 88, status: 'Procesando natives...', stage: 'natives' });
      const nativesDir = path.join(root, 'versions', versionId, 'natives');
      await this._ensureNatives(versionJson, root, nativesDir, (msg) => {
        onProgress({ percent: 88, status: msg, stage: 'natives' });
      });

      onProgress({ percent: 95, status: 'Instalación vanilla completa', stage: 'completed' });

      // 7. Fabric: crear versión compuesta que hereda de la vanilla
      if (modLoader === 'fabric') {
        onProgress({ percent: 96, status: 'Instalando Fabric...', stage: 'modloader' });
        const fabricId = await this._installFabric(versionId, root, (msg) => {
          onProgress({ percent: 96, status: msg, stage: 'modloader' });
        });
        onProgress({ percent: 100, status: `Fabric instalado (${fabricId})`, stage: 'completed' });

        return {
          success: true,
          versionId,
          fabricVersion: fabricId,
          message: `Versión ${fabricId} instalada correctamente`
        };
      }

      // 7b. NeoForge / Forge clásico: ejecutar el installer oficial headless
      if (modLoader === 'neoforge' || modLoader === 'forge') {
        onProgress({ percent: 96, status: `Instalando ${INSTALLER_LOADERS[modLoader].name}...`, stage: 'modloader' });
        const loaderId = await this._installLoaderViaInstaller({
          mcVersion: versionId,
          loader: modLoader,
          root,
          onProgress: (msg) => onProgress({ percent: 96, status: msg, stage: 'modloader' })
        });
        onProgress({ percent: 100, status: `${INSTALLER_LOADERS[modLoader].name} instalado (${loaderId})`, stage: 'completed' });

        return {
          success: true,
          versionId,
          loaderVersion: loaderId,
          message: `Versión ${loaderId} instalada correctamente`
        };
      }

      onProgress({ percent: 100, status: 'Instalación completa', stage: 'completed' });

      return {
        success: true,
        versionId,
        nativesDir,
        message: `Versión ${versionId} instalada correctamente`
      };
    } catch (error) {
      console.error('[ManualLauncher] Error en instalación:', error);
      onProgress({ percent: 0, status: 'Error: ' + error.message, stage: 'error' });
      return { success: false, error: error.message };
    }
  }

  /**
   * Lanza el juego con la versión instalada
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async launch(options) {
    const {
      versionId,
      root,
      username,
      uuid,
      memory = { min: '2G', max: '4G' },
      java = null,
      jvmArgs = [],
      gameDirectory = null,
      onLog = () => {}
    } = options;

    try {
      // El versionManager ya agrega timestamps; aquí solo el mensaje
      const log = (msg) => onLog(msg);

      log(`Iniciando Minecraft ${versionId} como ${username}`);

      // 1. Cargar version.json resolviendo la cadena inheritsFrom (Fabric, etc.)
      const versionDir = path.join(root, 'versions', versionId);
      const { json: versionJson, clientJarId } = await this._resolveVersionJson(versionId, root);

      // 2. Asegurar el índice de assets
      if (versionJson.assets) {
        try {
          await this._ensureAssetsIndex(versionJson, root);
        } catch (e) {
          log(`Aviso: no se pudo resolver el assets index: ${e.message}`);
        }
      }

      // 3. Descargar librerías que falten (auto-reparación de instalaciones)
      await this._ensureLibraries(versionJson, root, log);

      // 4. Extraer natives (descarga los jars que falten)
      const nativesDir = path.join(versionDir, 'natives');
      await this._ensureNatives(versionJson, root, nativesDir, log);

      // 5. Construir classpath
      const classpath = await this._buildClasspath(versionJson, root, clientJarId);
      log(`Classpath construido (${classpath.split(path.delimiter).length} entradas)`);

      // 6. Resolver mainClass (puede heredar de inheritsFrom)
      const mainClass = await this._resolveMainClass(versionJson, root);
      log(`Main class: ${mainClass}`);

      // 7. Resolver un Java compatible con la versión
      const requiredMajor = this._getRequiredJavaMajor(versionJson, root);
      if (requiredMajor) {
        log(`Versión de Java requerida: Java ${requiredMajor}`);
      }

      let javaExe = java || null;
      if (javaExe) {
        const major = await this.javaRuntime.getMajorVersion(javaExe);
        if (major === null) {
          log(`Aviso: no se pudo verificar la versión de ${javaExe}`);
        } else if (requiredMajor && major < requiredMajor) {
          log(`Java configurado es versión ${major}, pero ${versionId} requiere Java ${requiredMajor}`);
          javaExe = null;
        } else {
          log(`Java del sistema: versión ${major}`);
        }
      }
      if (!javaExe) {
        const target = requiredMajor || 8;
        log(`Asegurando Java ${target} (se descargará solo si es necesario)...`);
        javaExe = await this.javaRuntime.ensureRuntime({
          root,
          majorVersion: target,
          onProgress: (p) => log(p.status)
        });
        log(`Java runtime: ${javaExe}`);
      }
      log(`Memoria: ${memory.min} - ${memory.max}`);

      // 8. Configuración de log4j del cliente
      const log4jArg = await this._ensureLogConfig(versionJson, versionDir);
      const gameDir = gameDirectory || root;

      // 9. Construir argumentos JVM según el spec de la versión
      const jvmArgsArray = this._buildJvmArgs({
        memory,
        nativesDir,
        classpath,
        mainClass,
        versionJson,
        gameDir,
        root,
        username,
        uuid,
        jvmArgs,
        log4jArg
      });

      log(`Spawn: java ${jvmArgsArray.slice(0, 4).join(' ')} ...`);

      // 10. Spawn del proceso
      const child = spawn(javaExe, jvmArgsArray, {
        cwd: gameDir,
        env: {
          ...process.env,
          MINECRAFT_VERSION: versionId
        }
      });

      log(`Proceso iniciado con PID: ${child.pid}`);

      // Formatear la salida log4j XML del juego a líneas legibles
      let stdoutBuffer = '';
      child.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();

        // Extraer eventos log4j completos: <log4j:Event ...>...</log4j:Event>
        const eventRe = /<log4j:Event[\s\S]*?<\/log4j:Event>/g;
        let consumed = 0;
        let match;
        while ((match = eventRe.exec(stdoutBuffer)) !== null) {
          consumed = eventRe.lastIndex;
          const evt = match[0];
          const level = (evt.match(/level="(\w+)"/) || [])[1] || 'INFO';
          const msg = evt.match(/<log4j:Message><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Message>/);
          if (msg) {
            log(`[${level}] ${msg[1].trim()}`);
          }
        }
        if (consumed > 0) {
          stdoutBuffer = stdoutBuffer.slice(consumed);
        }

        // Emitir las líneas sueltas que no forman parte de eventos XML
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (t && !t.startsWith('<')) {
            log(t);
          }
        }
      });

      child.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        lines.forEach(line => log('[STDERR] ' + line));
      });

      child.on('error', (err) => {
        log(`ERROR al iniciar: ${err.message}`);
      });

      child.on('exit', (code, signal) => {
        log(`Proceso terminado (code=${code}, signal=${signal})`);
      });

      return {
        success: true,
        pid: child.pid,
        child,
        message: 'Juego iniciado correctamente'
      };
    } catch (error) {
      console.error('[ManualLauncher] Error al lanzar:', error);
      return { success: false, error: error.message };
    }
  }

  // ============================================================
  // MÉTODOS PRIVADOS - DESCARGA
  // ============================================================

  _getDirectoryStructure(root) {
    return {
      root,
      versions: path.join(root, 'versions'),
      libraries: path.join(root, 'libraries'),
      assets: path.join(root, 'assets'),
      assetsObjects: path.join(root, 'assets', 'objects'),
      assetsIndexes: path.join(root, 'assets', 'indexes'),
      mods: path.join(root, 'mods')
    };
  }

  async _ensureDirs(dirs) {
    for (const dir of Object.values(dirs)) {
      await fsp.mkdir(dir, { recursive: true });
    }
  }

  /**
   * Obtiene el version.json: del manifest o del archivo local
   */
  async _getVersionJson(versionId, root) {
    const localPath = path.join(root, 'versions', versionId, `${versionId}.json`);

    // Si ya existe local, usarlo
    if (fs.existsSync(localPath)) {
      console.log(`[ManualLauncher] version.json ya existe local: ${localPath}`);
      return JSON.parse(await fsp.readFile(localPath, 'utf-8'));
    }

    // Si no, consultar el manifest de Mojang
    console.log(`[ManualLauncher] Descargando manifest de Mojang...`);
    const manifestUrl = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
    const manifest = await this._httpGetJson(manifestUrl);

    const versionEntry = manifest.versions.find(v => v.id === versionId);
    if (!versionEntry) {
      throw new Error(`Versión "${versionId}" no encontrada en el manifest de Mojang`);
    }

    // Descargar el version.json específico
    console.log(`[ManualLauncher] Descargando version.json desde ${versionEntry.url}`);
    const versionJson = await this._httpGetJson(versionEntry.url);

    // Guardar local
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    await fsp.writeFile(localPath, JSON.stringify(versionJson, null, 2), 'utf-8');

    return versionJson;
  }

  /**
   * Instala Fabric para una versión de Minecraft vanilla.
   * Consulta meta.fabricmc.net, descarga el profile del loader y crea la
   * versión compuesta "<mc>-fabric" que hereda (inheritsFrom) de la vanilla.
   * @private
   * @returns {Promise<string>} - El id de la versión compuesta (ej: "26.3-fabric")
   */
  async _installFabric(mcVersion, root, onProgress = () => {}) {
    onProgress(`Consultando loaders de Fabric para ${mcVersion}...`);

    const loaders = await this._httpGetJson(
      `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`
    );
    if (!Array.isArray(loaders) || loaders.length === 0) {
      throw new Error(`No hay Fabric disponible para Minecraft ${mcVersion}`);
    }

    const stable = loaders.find(l => l.loader && l.loader.stable) || loaders[0];
    const loaderVersion = stable.loader.version;
    onProgress(`Usando Fabric Loader ${loaderVersion}`);

    const profile = await this._httpGetJson(
      `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${loaderVersion}/profile/json`
    );

    const fabricId = `${mcVersion}-fabric`;
    const versionDir = path.join(root, 'versions', fabricId);
    const jsonPath = path.join(versionDir, `${fabricId}.json`);

    // Normalizar el id para que directorio y json coincidan
    const profileJson = { ...profile, id: fabricId };

    await fsp.mkdir(versionDir, { recursive: true });
    await fsp.writeFile(jsonPath, JSON.stringify(profileJson, null, 2), 'utf-8');

    // Descargar las librerías de Fabric (loader, intermediary, asm, etc.)
    const librariesDir = path.join(root, 'libraries');
    await this._downloadLibraries(profileJson.libraries || [], librariesDir, (current, total) => {
      onProgress(`Descargando librerías de Fabric ${current}/${total}...`);
    });

    console.log(`[ManualLauncher] Fabric ${loaderVersion} instalado como ${fabricId}`);
    return fabricId;
  }

  /**
   * Instala NeoForge o Forge clásico ejecutando el installer oficial en
   * modo headless (--installClient). El installer se encarga de descargar
   * librerías, ejecutar sus processors y crear la versión compuesta con
   * inheritsFrom. El Java para ejecutarlo es el mismo que correrá el juego.
   *
   * @private
   * @returns {Promise<string>} - El id de la versión creada (ej: "neoforge-26.3.0.39-beta")
   */
  async _installLoaderViaInstaller({ mcVersion, loader, root, onProgress = () => {} }) {
    const meta = INSTALLER_LOADERS[loader];
    if (!meta) {
      throw new Error(`Mod loader desconocido: ${loader}`);
    }

    // 1. Buscar la versión del loader disponible para este Minecraft
    onProgress(`Consultando versiones de ${meta.name} para Minecraft ${mcVersion}...`);
    const xml = await this._httpGetText(meta.metadataUrl);
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
      .map(m => m[1].trim())
      .filter(v => v.length > 0);
    const prefix = meta.versionPrefix(mcVersion);
    const candidates = versions.filter(v => v.startsWith(prefix));

    if (candidates.length === 0) {
      throw new Error(`No hay ${meta.name} disponible para Minecraft ${mcVersion}`);
    }

    // Elegir la de build más alto (comparación numérica por partes)
    const best = candidates.reduce((a, b) =>
      this._compareNumericVersions(b, a) > 0 ? b : a
    );
    onProgress(`Instalando ${meta.name} ${best}`);

    // 2. Descargar el installer jar
    const installerPath = path.join(root, 'cache', `${loader}-${best}-installer.jar`);
    await fsp.mkdir(path.dirname(installerPath), { recursive: true });
    await this._downloadFile(meta.installerUrl(best), installerPath);

    // 3. Leer el id de versión que creará (install_profile.json dentro del jar)
    let expectedId = `${loader}-${best}`;
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(installerPath);
      const entry = zip.getEntry('install_profile.json');
      if (entry) {
        const profile = JSON.parse(entry.getData());
        if (profile.version) {
          expectedId = profile.version;
        }
      }
    } catch (err) {
      console.warn(`[ManualLauncher] No se pudo leer install_profile: ${err.message}`);
    }

    // 4. Resolver el Java con el que ejecutar el installer
    //    (el mismo que correrá el juego: javaVersion del vanilla base)
    let javaExe = 'java';
    const vanillaJsonPath = path.join(root, 'versions', mcVersion, `${mcVersion}.json`);
    if (fs.existsSync(vanillaJsonPath)) {
      const vanillaJson = JSON.parse(await fsp.readFile(vanillaJsonPath, 'utf-8'));
      const requiredMajor = this._getRequiredJavaMajor(vanillaJson, root) || 8;
      javaExe = await this.javaRuntime.ensureRuntime({
        root,
        majorVersion: requiredMajor,
        onProgress: (p) => p.status && onProgress(p.status)
      });
    }
    onProgress(`Ejecutando el installer de ${meta.name} con Java...`);

    // 5. Ejecutar el installer headless y seguir su salida
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(javaExe, ['-jar', installerPath, '--installClient', root], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      child.stdout.on('data', (data) => {
        for (const line of data.toString().split('\n')) {
          const t = line.trim();
          // Filtrar líneas muy largas o irrelevantes para no saturar la UI
          if (t && t.length < 100 && !t.startsWith('Host:')) {
            onProgress(t);
          }
        }
      });

      child.stderr.on('data', (data) => {
        for (const line of data.toString().split('\n')) {
          const t = line.trim();
          if (t && t.length < 100) {
            onProgress(`[installer] ${t}`);
          }
        }
      });

      child.on('error', reject);
      child.on('exit', (code) => resolve(code));
    });

    if (exitCode !== 0) {
      throw new Error(`El installer de ${meta.name} terminó con código ${exitCode}`);
    }

    // 6. Verificar que la versión quedó creada
    const resultJson = path.join(root, 'versions', expectedId, `${expectedId}.json`);
    if (!fs.existsSync(resultJson)) {
      throw new Error(`El installer terminó pero no se encontró la versión ${expectedId}`);
    }

    // 7. Limpiar installer y su log
    await fsp.unlink(installerPath).catch(() => {});
    await fsp.unlink(`${installerPath}.log`).catch(() => {});

    console.log(`[ManualLauncher] ${meta.name} ${best} instalado como ${expectedId}`);
    return expectedId;
  }

  /**
   * Compara dos strings de versión por sus componentes numéricos.
   * Ej: "26.3.0.39-beta" vs "26.3.0.38-beta" → > 0
   * @private
   */
  _compareNumericVersions(a, b) {
    const na = (String(a).match(/\d+/g) || []).map(Number);
    const nb = (String(b).match(/\d+/g) || []).map(Number);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
      const da = na[i] || 0;
      const db = nb[i] || 0;
      if (da !== db) return da - db;
    }
    return 0;
  }

  /**
   * Carga el version.json de una versión y resuelve la cadena inheritsFrom
   * devolviendo un JSON fusionado (como hacen los launchers oficiales):
   * - libraries: se concatenan (padre + hijo)
   * - arguments.jvm / arguments.game: se concatenan (padre + hijo)
   * - el resto de campos: el hijo pisa al padre
   *
   * También devuelve el id de la versión que aporta el JAR del cliente
   * (la base vanilla cuando es una versión compuesta tipo Fabric).
   * @private
   * @returns {Promise<{json: Object, clientJarId: string}>}
   */
  async _resolveVersionJson(versionId, root) {
    const versionPath = path.join(root, 'versions', versionId, `${versionId}.json`);
    if (!fs.existsSync(versionPath)) {
      throw new Error(`No se encontró ${versionId}.json en ${path.dirname(versionPath)}. ¿Está instalada la versión?`);
    }
    const child = JSON.parse(await fsp.readFile(versionPath, 'utf-8'));

    if (!child.inheritsFrom) {
      return { json: child, clientJarId: versionId };
    }

    // Cargar la cadena de padres: [hijo, padre, abuelo...]
    const stack = [child];
    let current = child;
    while (current.inheritsFrom && stack.length < 6) {
      const parentId = current.inheritsFrom;
      const parentPath = path.join(root, 'versions', parentId, `${parentId}.json`);
      if (!fs.existsSync(parentPath)) {
        throw new Error(`La versión padre "${parentId}" no está instalada (requerida por ${versionId})`);
      }
      const parent = JSON.parse(await fsp.readFile(parentPath, 'utf-8'));
      stack.push(parent);
      current = parent;
    }

    // Aplicar desde la base (vanilla) hacia el hijo
    const ordered = stack.slice().reverse();
    let merged = JSON.parse(JSON.stringify(ordered[0]));
    delete merged.inheritsFrom;

    for (const layer of ordered.slice(1)) {
      for (const [key, value] of Object.entries(layer)) {
        if (key === 'inheritsFrom') continue;

        if (key === 'libraries') {
          merged.libraries = (merged.libraries || []).concat(value);
          continue;
        }

        if (key === 'arguments' && value && typeof value === 'object') {
          merged.arguments = merged.arguments || {};
          for (const section of Object.keys(value)) {
            const incoming = value[section];
            if (Array.isArray(incoming) && Array.isArray(merged.arguments[section])) {
              merged.arguments[section] = merged.arguments[section].concat(incoming);
            } else {
              merged.arguments[section] = incoming;
            }
          }
          continue;
        }

        merged[key] = value;
      }
    }

    merged.id = child.id;

    // ¿Qué versión aporta el JAR del cliente? La primera con downloads.client
    let clientJarId = versionId;
    for (const layer of ordered) {
      if (layer.downloads && layer.downloads.client) {
        clientJarId = layer.id;
        break;
      }
    }

    return { json: merged, clientJarId };
  }

  /**
   * Descarga las librerías (.jar) referenciadas en version.json
   * Soporta classifiers (natives) marcándolas
   */
  async _downloadLibraries(libraries, librariesDir, onProgress) {
    // Solo descargar las librerías permitidas para este OS/arquitectura
    const allowed = libraries.filter(l => this._evaluateRules(l.rules));
    let completed = 0;
    const total = allowed.length;

    // Descargar en paralelo pero limitado
    const queue = [...allowed];
    const workers = [];

    for (let i = 0; i < this.maxConcurrentDownloads; i++) {
      workers.push(this._worker(queue, librariesDir, () => {
        completed++;
        onProgress(completed, total);
      }));
    }

    await Promise.all(workers);
  }

  /**
   * Resuelve la ruta relativa y URL del artifact de una librería.
   * Soporta los dos formatos que hay en version.json:
   * - Mojang: downloads.artifact.{path,url}
   * - Maven (Fabric): {name, url} → ruta derivada de la coordenada Maven
   * @private
   * @returns {{path: string, url: string}|null}
   */
  _libArtifact(lib) {
    if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) {
      return {
        path: lib.downloads.artifact.path,
        url: lib.downloads.artifact.url
      };
    }
    if (lib.name && lib.url) {
      const parts = lib.name.split(':');
      if (parts.length >= 3) {
        const [group, artifact, version, classifier] = parts;
        const file = classifier
          ? `${artifact}-${version}-${classifier}.jar`
          : `${artifact}-${version}.jar`;
        const relPath = `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
        return {
          path: relPath,
          url: lib.url.replace(/\/?$/, '/') + relPath
        };
      }
    }
    return null;
  }

  async _worker(queue, librariesDir, onComplete) {
    while (queue.length > 0) {
      const lib = queue.shift();
      if (!lib) break;

      try {
        const artifact = this._libArtifact(lib);
        if (artifact) {
          const targetPath = path.join(librariesDir, artifact.path);

          if (!fs.existsSync(targetPath)) {
            await this._downloadFile(artifact.url, targetPath);
          }
        }
      } catch (err) {
        console.warn(`[ManualLauncher] No se pudo descargar lib: ${err.message}`);
      }

      onComplete();
    }
  }

  /**
   * Descarga los assets (recursos) usando el índice
   */
  async _downloadAssets(versionJson, root, assetsDir, onProgress) {
    const assetsIndexId = versionJson.assets;
    const indexUrl = versionJson.assetIndex && versionJson.assetIndex.url;

    if (!assetsIndexId || !indexUrl) {
      console.log('[ManualLauncher] Sin assets para esta versión');
      onProgress(1, 1);
      return;
    }

    // Descargar el índice de assets
    const indexPath = path.join(root, 'assets', 'indexes', `${assetsIndexId}.json`);
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });

    if (!fs.existsSync(indexPath)) {
      console.log(`[ManualLauncher] Descargando assets index: ${assetsIndexId}`);
      await this._downloadFile(indexUrl, indexPath);
    }

    const assetsIndex = JSON.parse(await fsp.readFile(indexPath, 'utf-8'));
    const objects = assetsIndex.objects || {};
    const entries = Object.entries(objects);

    console.log(`[ManualLauncher] ${entries.length} assets a verificar`);

    let completed = 0;
    let downloaded = 0;
    const total = entries.length;

    // Descargar assets faltantes
    const queue = [...entries];
    const workers = [];

    for (let i = 0; i < this.maxConcurrentDownloads; i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const [name, info] = queue.shift();
          if (!name) break;

          const hash = info.hash;
          const prefix = hash.substring(0, 2);
          const targetPath = path.join(root, 'assets', 'objects', prefix, hash);

          if (!fs.existsSync(targetPath)) {
            const url = `https://resources.download.minecraft.net/${prefix}/${hash}`;
            try {
              await this._downloadFile(url, targetPath);
              downloaded++;
            } catch (err) {
              console.warn(`[ManualLauncher] No se pudo descargar asset ${name}: ${err.message}`);
            }
          }
          completed++;
          onProgress(completed, total, downloaded);
        }
      })());
    }

    await Promise.all(workers);
  }

  /**
   * Descarga el JAR del cliente
   */
  async _downloadClientJar(versionJson, versionsDir, versionId) {
    const versionDir = path.join(versionsDir, versionId);
    await fsp.mkdir(versionDir, { recursive: true });

    const targetPath = path.join(versionDir, `${versionId}.jar`);

    if (fs.existsSync(targetPath)) {
      console.log(`[ManualLauncher] JAR ya existe: ${targetPath}`);
      return;
    }

    const download = versionJson.downloads && versionJson.downloads.client;
    if (!download || !download.url) {
      throw new Error('No se encontró URL para el JAR del cliente en version.json');
    }

    console.log(`[ManualLauncher] Descargando JAR: ${download.url}`);
    await this._downloadFile(download.url, targetPath);
  }

  /**
   * Extrae los natives (.dll / .so / .dylib) de las librerías de la versión.
   *
   * Soporta los dos esquemas que ha usado Mojang:
   * - Moderno (1.19+ / 26.x): natives como artifacts normales con nombre
   *   "...:natives-<os>" seleccionados por `rules`. Se extraen en subdirectorios
   *   natives/{java,jna,lwjgl,netty} según los -Djava.library.path oficiales.
   * - Legacy (≤1.12): mapa `natives` + `downloads.classifiers`. Se extraen
   *   directamente en el directorio de natives.
   *
   * @private
   */
  async _ensureNatives(versionJson, root, nativesDir, log) {
    const legacyMode = !(versionJson.arguments && Array.isArray(versionJson.arguments.jvm));
    await fsp.mkdir(nativesDir, { recursive: true });

    // Fast-path: si ya se extrajeron natives para esta versión, no repetir
    const marker = path.join(nativesDir, '.natives-extracted');
    if (fs.existsSync(marker)) {
      log('Natives ya extraídos, omitiendo');
      if (!legacyMode) {
        for (const sub of ['java', 'jna', 'lwjgl', 'netty']) {
          try { await fsp.mkdir(path.join(nativesDir, sub), { recursive: true }); } catch {}
        }
      }
      return;
    }

    const candidates = [];

    for (const lib of (versionJson.libraries || [])) {
      if (!this._evaluateRules(lib.rules)) continue;

      // Esquema moderno: artifact con sufijo :natives-*
      if (lib.name && lib.name.includes(':natives-') && lib.downloads && lib.downloads.artifact) {
        if (this._nativesJarMatchesArch(lib.name)) {
          candidates.push({
            name: lib.name,
            jarPath: path.join(root, 'libraries', lib.downloads.artifact.path),
            url: lib.downloads.artifact.url,
            category: this._nativesCategory(lib.name)
          });
        }
        continue;
      }

      // Esquema legacy: mapa natives + classifiers
      if (lib.natives && lib.downloads && lib.downloads.classifiers) {
        const classifierKey = lib.natives[this._getOSKey()];
        const dl = classifierKey && lib.downloads.classifiers[classifierKey];
        if (dl && dl.url) {
          const relPath = dl.path || `${lib.name.replace(/:/g, '/')}-${classifierKey}.jar`;
          candidates.push({
            name: `${lib.name} (${classifierKey})`,
            jarPath: path.join(root, 'libraries', relPath),
            url: dl.url,
            category: 'legacy'
          });
        }
      }
    }

    let extracted = 0;
    for (const cand of candidates) {
      try {
        if (!fs.existsSync(cand.jarPath)) {
          await fsp.mkdir(path.dirname(cand.jarPath), { recursive: true });
          log(`Descargando natives: ${cand.name}`);
          await this._downloadFile(cand.url, cand.jarPath);
        }
        const targetDir = legacyMode ? nativesDir : path.join(nativesDir, cand.category);
        await this._extractNativesJar(cand.jarPath, targetDir);
        extracted++;
      } catch (err) {
        log(`Aviso: no se pudieron extraer natives de ${cand.name}: ${err.message}`);
      }
    }

    if (!legacyMode) {
      for (const sub of ['java', 'jna', 'lwjgl', 'netty']) {
        try { await fsp.mkdir(path.join(nativesDir, sub), { recursive: true }); } catch {}
      }
    }

    if (candidates.length > 0) {
      // Marcar como extraído para saltar el trabajo en el próximo lanzamiento
      try {
        await fsp.writeFile(marker, `${extracted}/${candidates.length}`);
      } catch {}
      log(`Natives listos: ${extracted}/${candidates.length} jars extraídos en ${nativesDir}`);
    }
  }

  /**
   * Determina a qué subdirectorio de natives pertenece una librería
   * (coincide con los -Djava.library.path / SharedLibraryExtractPath oficiales)
   * @private
   */
  _nativesCategory(libName) {
    const n = libName.toLowerCase();
    if (n.startsWith('org.lwjgl')) return 'lwjgl';
    if (n.startsWith('net.java.dev.jna')) return 'jna';
    if (n.startsWith('io.netty')) return 'netty';
    return 'java'; // com.mojang:jtracy, ca.weblite:java-objc-bridge, etc.
  }

  /**
   * Verifica que un jar de natives corresponda a la arquitectura actual.
   * Evita extraer natives-arm64 en x64 y viceversa (crítico para jtracy,
   * que se carga vía java.library.path).
   * @private
   */
  _nativesJarMatchesArch(libName) {
    const n = libName.toLowerCase();
    const arm64 = n.endsWith(':natives-windows-arm64') ||
                  n.endsWith(':natives-macos-arm64') ||
                  n.endsWith(':natives-linux-aarch_64');
    if (arm64) return process.arch === 'arm64';

    const x86 = n.endsWith(':natives-windows-x86') ||
                n.endsWith(':natives-linux-x86') ||
                n.endsWith(':natives-macos-x86');
    if (x86) return process.arch === 'ia32';

    return true;
  }

  /**
   * Extrae un jar de natives con adm-zip, omitiendo META-INF y firmas.
   * @private
   */
  async _extractNativesJar(jarPath, targetDir) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(jarPath);
    const safeRoot = path.resolve(targetDir);
    await fsp.mkdir(safeRoot, { recursive: true });

    for (const entry of zip.getEntries()) {
      const entryName = entry.entryName.replace(/\\/g, '/');
      if (entryName.startsWith('META-INF/')) continue;
      if (/\.(rsa|sf|dsa)$/i.test(entryName)) continue;

      const dest = path.resolve(targetDir, entryName);
      // Protección contra path traversal
      if (dest !== safeRoot && !dest.startsWith(safeRoot + path.sep)) continue;

      if (entry.isDirectory) {
        await fsp.mkdir(dest, { recursive: true });
        continue;
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, entry.getData());
    }
  }

  /**
   * Resuelve la main class (puede venir de inheritsFrom en versiones modernas)
   */
  async _resolveMainClass(versionJson, root) {
    if (versionJson.mainClass) {
      return versionJson.mainClass;
    }

    // Si tiene inheritsFrom, buscar recursivamente
    if (versionJson.inheritsFrom) {
      const parentPath = path.join(root, 'versions', versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`);
      if (fs.existsSync(parentPath)) {
        const parent = JSON.parse(await fsp.readFile(parentPath, 'utf-8'));
        return this._resolveMainClass(parent, root);
      }
    }

    // Default conocido
    return 'net.minecraft.client.main.Main';
  }

  /**
   * Determina la versión mayor de Java requerida por la versión de Minecraft.
   * Las versiones modernas lo declaran en javaVersion.majorVersion; las legacy
   * (≤1.16) funcionan con Java 8. Devuelve null si no hay requisito explícito.
   * @private
   */
  _getRequiredJavaMajor(versionJson, root) {
    let current = versionJson;
    let depth = 0;

    while (current && depth < 5) {
      if (current.javaVersion && current.javaVersion.majorVersion) {
        return parseInt(current.javaVersion.majorVersion, 10);
      }
      if (current.inheritsFrom) {
        const parentPath = path.join(root, 'versions', current.inheritsFrom, `${current.inheritsFrom}.json`);
        if (fs.existsSync(parentPath)) {
          current = JSON.parse(fs.readFileSync(parentPath, 'utf-8'));
          depth++;
          continue;
        }
      }
      break;
    }

    return null;
  }

  /**
   * Descarga las librerías (permitidas por rules) que falten en disco.
   * Permite lanzar instalaciones incompletas o hechas por terceros.
   * @private
   */
  async _ensureLibraries(versionJson, root, log) {
    let downloaded = 0;

    for (const lib of (versionJson.libraries || [])) {
      if (!this._evaluateRules(lib.rules)) continue;

      const artifact = this._libArtifact(lib);
      if (!artifact || !artifact.path || !artifact.url) continue;

      const target = path.join(root, 'libraries', artifact.path);
      if (fs.existsSync(target)) continue;

      try {
        log(`Descargando librería faltante: ${lib.name}`);
        await this._downloadFile(artifact.url, target);
        downloaded++;
      } catch (err) {
        log(`Aviso: no se pudo descargar ${lib.name}: ${err.message}`);
      }
    }

    if (downloaded > 0) {
      log(`${downloaded} librerías descargadas`);
    }
    return downloaded;
  }

  /**
   * Descarga la configuración de log4j del cliente si el version.json la declara
   * y devuelve el argumento JVM correspondiente.
   * @private
   */
  async _ensureLogConfig(versionJson, versionDir) {
    const logging = versionJson.logging && versionJson.logging.client;
    if (!logging || !logging.file || !logging.file.url || !logging.argument) {
      return null;
    }

    try {
      const target = path.join(versionDir, logging.file.id);
      if (!fs.existsSync(target)) {
        await this._downloadFile(logging.file.url, target);
      }
      return logging.argument.replace('${path}', target);
    } catch {
      return null;
    }
  }

  /**
   * Evalúa las rules de Mojang (action/os/features) contra el sistema actual.
   * Semántica oficial: la última regla que coincide gana; si hay alguna regla
   * "allow", el estado por defecto es "disallowed".
   * @private
   */
  _evaluateRules(rules, features = {}) {
    if (!Array.isArray(rules) || rules.length === 0) return true;

    let allowed = !rules.some(r => r && r.action === 'allow');
    for (const rule of rules) {
      if (!this._ruleMatches(rule, features)) continue;
      allowed = (rule.action === 'allow');
    }
    return allowed;
  }

  _ruleMatches(rule, features = {}) {
    if (!rule) return false;

    if (rule.os) {
      if (rule.os.name && rule.os.name !== this._getOSKey()) return false;
      if (rule.os.arch && rule.os.arch !== this._getArchKey()) return false;
    }
    if (rule.features) {
      for (const [key, expected] of Object.entries(rule.features)) {
        if (features[key] !== expected) return false;
      }
    }
    return true;
  }

  /**
   * Arquitectura en el formato de las rules de Mojang
   * @private
   */
  _getArchKey() {
    if (process.arch === 'ia32') return 'x86';
    if (process.arch === 'arm64') return 'arm64';
    return 'x86_64';
  }

  /**
   * Asegura que el assets index esté descargado
   */
  async _ensureAssetsIndex(versionJson, root) {
    const indexId = versionJson.assets;
    if (!indexId) return;

    const indexPath = path.join(root, 'assets', 'indexes', `${indexId}.json`);
    if (fs.existsSync(indexPath)) return;

    const url = versionJson.assetIndex && versionJson.assetIndex.url;
    if (!url) return;

    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
    await this._downloadFile(url, indexPath);
  }

  /**
   * Construye el classpath con todas las librerías
   */
  async _buildClasspath(versionJson, root, clientJarId) {
    const separator = path.delimiter; // ';' en Windows, ':' en Unix
    const entries = [];

    // 1. JAR del cliente (en versiones compuestas lo aporta la base vanilla)
    const clientJar = path.join(root, 'versions', clientJarId, `${clientJarId}.jar`);
    if (fs.existsSync(clientJar)) {
      entries.push(clientJar);
    }

    // 2. Todas las librerías permitidas para este OS/arquitectura
    const libraries = versionJson.libraries || [];
    for (const lib of libraries) {
      if (!this._evaluateRules(lib.rules)) continue;
      const artifact = this._libArtifact(lib);
      if (!artifact) continue;
      const libPath = path.join(root, 'libraries', artifact.path);
      if (fs.existsSync(libPath)) {
        entries.push(libPath);
      }
    }

    return entries.join(separator);
  }

  /**
   * Construye los argumentos JVM y de Minecraft.
   *
   * Versiones modernas: evalúa versionJson.arguments.jvm / arguments.game con
   * sus rules y tokens oficiales (igual que el launcher oficial de Mojang).
   * Versiones legacy: usa minecraftArguments.
   */
  _buildJvmArgs({ memory, nativesDir, classpath, mainClass, versionJson, gameDir, root, username, uuid, jvmArgs = [], log4jArg = null }) {
    const args = [];

    // Memoria y argumentos personalizados del usuario siempre primero
    args.push(`-Xms${memory.min}`);
    args.push(`-Xmx${memory.max}`);
    const userArgs = (Array.isArray(jvmArgs) ? jvmArgs : [])
      .map(a => String(a || '').trim())
      .filter(a => a.length > 0);
    args.push(...userArgs);

    const assetsDir = path.join(root, 'assets');

    // Tabla de tokens oficiales de Mojang
    const tokens = {
      natives_directory: nativesDir,
      launcher_name: this.launcherName,
      launcher_version: this.launcherVersion,
      classpath: classpath,
      // Usado por NeoForge/Forge (-DlibraryDirectory)
      library_directory: path.join(root, 'libraries'),
      auth_player_name: username,
      auth_uuid: uuid,
      auth_access_token: '0',
      auth_session: '0',
      auth_xuid: '0',
      clientid: '0',
      user_type: 'offline',
      user_properties: '{}',
      version_name: versionJson.id || '',
      version_type: versionJson.type || 'release',
      game_directory: gameDir,
      assets_root: assetsDir,
      assets_index_name: versionJson.assets || 'legacy',
      resolution_width: '854',
      resolution_height: '480',
      quickPlayPath: '',
      quickPlaySingleplayer: '',
      quickPlayMultiplayer: '',
      quickPlayRealms: ''
    };

    const interpolate = (str) =>
      String(str).replace(/\$\{([^}]+)\}/g, (m, key) => (key in tokens ? tokens[key] : m));

    const hasModernJvm = versionJson.arguments && Array.isArray(versionJson.arguments.jvm);

    // === MODERNO: 1.13+ / 26.x ===
    if (hasModernJvm) {
      // Subdirectorios de natives referenciados por los argumentos oficiales
      for (const sub of ['java', 'jna', 'lwjgl', 'netty']) {
        try { fs.mkdirSync(path.join(nativesDir, sub), { recursive: true }); } catch {}
      }

      if (log4jArg) args.push(log4jArg);

      // Features del launcher: resolución estándar 854x480, sin demo ni quick play
      const features = {
        is_demo_user: false,
        has_custom_resolution: true,
        has_quick_plays_support: false,
        is_quick_play_singleplayer: false,
        is_quick_play_multiplayer: false,
        is_quick_play_realms: false
      };

      // Argumentos JVM del spec
      for (const item of versionJson.arguments.jvm) {
        let value = item;
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          value = this._evaluateRules(item.rules, features) ? item.value : null;
        }
        if (value === null || value === undefined) continue;
        for (const v of (Array.isArray(value) ? value : [value])) {
          args.push(interpolate(v));
        }
      }

      // Main class
      args.push(mainClass);

      // Argumentos de juego del spec
      if (versionJson.arguments && Array.isArray(versionJson.arguments.game)) {
        for (const item of versionJson.arguments.game) {
          let value = item;
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            value = this._evaluateRules(item.rules, features) ? item.value : null;
          }
          if (value === null || value === undefined) continue;
          for (const v of (Array.isArray(value) ? value : [value])) {
            args.push(interpolate(v));
          }
        }
      }

      return args;
    }

    // === LEGACY: minecraftArguments ===
    if (log4jArg) args.push(log4jArg);
    args.push(`-Djava.library.path=${nativesDir}`);
    args.push(`-Djna.tmpdir=${nativesDir}`);
    args.push(`-Dorg.lwjgl.system.SharedLibraryExtractPath=${nativesDir}`);
    args.push(`-Dio.netty.native.workdir=${nativesDir}`);
    args.push(`-Dminecraft.launcher.brand=${this.launcherName}`);
    args.push(`-Dminecraft.launcher.version=${this.launcherVersion}`);
    args.push('-cp');
    args.push(classpath);
    args.push(mainClass);

    if (versionJson.minecraftArguments) {
      const formatted = versionJson.minecraftArguments
        .split(' ')
        .filter(t => t.length > 0)
        .map(interpolate);
      return args.concat(formatted);
    }

    // Sin arguments ni minecraftArguments: argumentos genéricos conocidos
    return args.concat([
      '--username', username,
      '--uuid', uuid,
      '--accessToken', '0',
      '--version', versionJson.id || '',
      '--gameDir', gameDir,
      '--assetsDir', assetsDir,
      '--assetIndex', versionJson.assets || 'legacy',
      '--userType', 'offline',
      '--versionType', versionJson.type || 'release',
      '--width', '854',
      '--height', '480'
    ]);
  }

  _getOSKey() {
    if (process.platform === 'win32') return 'windows';
    if (process.platform === 'darwin') return 'osx';
    return 'linux';
  }

  // ============================================================
  // HELPERS DE RED
  // ============================================================

  /**
   * HTTP GET que devuelve JSON parseado
   */
  _httpGetJson(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      this._httpGet(url, maxRedirects, (err, data) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(data));
        } catch (parseErr) {
          reject(new Error(`JSON inválido desde ${url}: ${parseErr.message}`));
        }
      });
    });
  }

  /**
   * HTTP GET que devuelve texto plano (para XML, etc.)
   */
  _httpGetText(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      this._httpGet(url, maxRedirects, (err, data) => {
        if (err) return reject(err);
        resolve(data.toString('utf-8'));
      });
    });
  }

  /**
   * HTTP GET genérico con buffer
   */
  _httpGet(url, maxRedirects, callback) {
    if (maxRedirects <= 0) {
      return callback(new Error('Demasiadas redirecciones'));
    }

    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      timeout: this.downloadTimeout,
      headers: { 'User-Agent': this.userAgent }
    }, (res) => {
      // Manejar redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const newUrl = new URL(res.headers.location, url).href;
        return this._httpGet(newUrl, maxRedirects - 1, callback);
      }

      if (res.statusCode !== 200) {
        return callback(new Error(`HTTP ${res.statusCode} para ${url}`));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
      res.on('error', callback);
    });

    req.on('timeout', () => {
      req.destroy();
      callback(new Error(`Timeout en ${url}`));
    });
    req.on('error', callback);
  }

  /**
   * Descarga un archivo de URL a una ruta local
   */
  _downloadFile(url, targetPath, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        return reject(new Error('Demasiadas redirecciones'));
      }

      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, {
        timeout: this.downloadTimeout,
        headers: { 'User-Agent': this.userAgent }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const newUrl = new URL(res.headers.location, url).href;
          return this._downloadFile(newUrl, targetPath, maxRedirects - 1).then(resolve, reject);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} para ${url}`));
        }

        // Asegurar directorio destino
        fsp.mkdir(path.dirname(targetPath), { recursive: true }).then(() => {
          const file = fs.createWriteStream(targetPath);
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve(targetPath);
          });
          file.on('error', (err) => {
            fs.unlink(targetPath, () => {}); // limpiar
            reject(err);
          });
        }).catch(reject);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout en ${url}`));
      });
      req.on('error', reject);
    });
  }
}

module.exports = ManualLauncher;
