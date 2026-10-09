/**
 * javaRuntime.js - Gestión de runtimes de Java
 *
 * Maneja:
 * - Verificación de la versión de un ejecutable de Java existente
 * - Descarga automática de un JRE de Eclipse Temurin (Adoptium API)
 *   cuando el Java del sistema no es compatible con la versión de Minecraft
 * - Caché de runtimes en <root>/jdk/temurin-<majorVersion>/
 *
 * La API de Adoptium entrega binarios GA estables:
 * https://api.adoptium.net/v3/binary/latest/<major>/ga/<os>/<arch>/jre/hotspot/normal/eclipse
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const ADOPTIUM_BASE = 'https://api.adoptium.net/v3/binary/latest';

class JavaRuntime {
  constructor() {
    this.userAgent = 'BlockLauncher/1.1.0';
    this.downloadTimeout = 300000; // 5 min: un JRE pesa ~50 MB
    // Caché de versiones verificadas: javaPath -> major (evita re-ejecutar
    // `java -version`, que puede tardar varios segundos)
    this._majorVersionCache = new Map();
  }

  /**
   * Ejecuta `java -version` y devuelve la versión mayor (8, 11, 17, 21, 25...)
   * o null si no se pudo ejecutar/determinar. El resultado se cachea por ruta.
   * @param {string} javaPath - Ruta al ejecutable de Java
   * @returns {Promise<number|null>}
   */
  async getMajorVersion(javaPath) {
    const cached = this._majorVersionCache.get(javaPath);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const { stdout, stderr } = await execFileAsync(javaPath, ['-version'], {
        timeout: 15000,
        windowsHide: true
      });
      const output = `${stderr || ''}\n${stdout || ''}`;
      const match = output.match(/version "([^"]+)"/);
      if (!match) return null;

      const raw = match[1];
      let major;
      // Formato antiguo: "1.8.0_503" → major 8
      if (raw.startsWith('1.')) {
        major = parseInt(raw.split('.')[1], 10);
      } else {
        // Formato moderno: "25.0.4" o "17.0.12" → major 25 / 17
        major = parseInt(raw.split(/[._]/)[0], 10);
      }

      this._majorVersionCache.set(javaPath, major);
      return major;
    } catch (error) {
      console.warn(`[JavaRuntime] No se pudo verificar versión de ${javaPath}: ${error.message}`);
      return null;
    }
  }

  /**
   * Garantiza que exista un runtime de Java <majorVersion> y devuelve la ruta
   * al ejecutable. Si no está cacheado, lo descarga de Adoptium y lo extrae.
   * @param {Object} options
   * @param {string} options.root - Directorio raíz de Minecraft (.minecraft)
   * @param {number} options.majorVersion - Versión mayor requerida (ej: 25)
   * @param {Function} [options.onProgress] - Callback de progreso ({status, percent})
   * @returns {Promise<string>} - Ruta al ejecutable java
   */
  async ensureRuntime({ root, majorVersion, onProgress = () => {} }) {
    const runtimeDir = path.join(root, 'jdk', `temurin-${majorVersion}`);
    const exe = path.join(runtimeDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');

    // Ya está descargado de una ejecución anterior
    if (fs.existsSync(exe)) {
      onProgress({ status: `Java ${majorVersion} ya disponible en ${runtimeDir}` });
      return exe;
    }

    const url = `${ADOPTIUM_BASE}/${majorVersion}/ga/${this._adoptiumOs()}/${this._adoptiumArch()}/jre/hotspot/normal/eclipse`;
    const tmpFile = path.join(root, 'jdk', `temurin-${majorVersion}${process.platform === 'darwin' ? '.tar.gz' : '.zip'}`);

    await fsp.mkdir(path.dirname(tmpFile), { recursive: true });

    onProgress({ status: `Descargando Java ${majorVersion} (Eclipse Temurin)...` });
    await this._downloadWithProgress(url, tmpFile, onProgress);

    onProgress({ status: `Extrayendo Java ${majorVersion}...` });
    await fsp.mkdir(runtimeDir, { recursive: true });

    if (process.platform === 'darwin') {
      // macOS entrega .tar.gz; usar tar del sistema
      await execFileAsync('tar', ['-xzf', tmpFile, '-C', runtimeDir, '--strip-components=1']);
    } else {
      await this._extractZip(tmpFile, runtimeDir);
    }

    // Limpiar el instalador temporal
    await fsp.unlink(tmpFile).catch(() => {});

    if (!fs.existsSync(exe)) {
      throw new Error(`El runtime descargado no contiene el ejecutable de Java en ${exe}`);
    }

    onProgress({ status: `Java ${majorVersion} instalado en ${runtimeDir}` });
    return exe;
  }

  // ============================================================
  // MÉTODOS PRIVADOS
  // ============================================================

  /**
   * Descarga con seguimiento de redirecciones y reporte de progreso
   * @private
   */
  _downloadWithProgress(url, targetPath, onProgress, redirectsLeft = 10) {
    return new Promise((resolve, reject) => {
      if (redirectsLeft <= 0) {
        return reject(new Error('Demasiadas redirecciones'));
      }

      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, {
        timeout: this.downloadTimeout,
        headers: { 'User-Agent': this.userAgent }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const newUrl = new URL(res.headers.location, url).href;
          return this._downloadWithProgress(newUrl, targetPath, onProgress, redirectsLeft - 1)
            .then(resolve, reject);
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} descargando Java`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        let lastReport = 0;

        fsp.mkdir(path.dirname(targetPath), { recursive: true }).then(() => {
          const file = fs.createWriteStream(targetPath);

          res.on('data', (chunk) => {
            received += chunk.length;
            // Reportar como máximo una vez por segundo
            if (total && Date.now() - lastReport > 1000) {
              lastReport = Date.now();
              const percent = Math.floor((received / total) * 100);
              onProgress({
                percent,
                status: `Descargando Java... ${percent}% (${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`
              });
            }
          });

          res.pipe(file);
          file.on('finish', () => file.close(() => resolve(targetPath)));
          file.on('error', (err) => {
            fs.unlink(targetPath, () => {});
            reject(err);
          });
        }).catch(reject);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout descargando Java'));
      });
      req.on('error', reject);
    });
  }

  /**
   * Extrae un zip de Temurin (un único directorio raíz: jdk-25.x.y-jre/)
   * @private
   */
  async _extractZip(zipPath, targetDir) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();

    if (entries.length === 0) {
      throw new Error('El archivo de Java descargado está vacío');
    }

    // Detectar el directorio raíz dentro del zip (ej: "jdk-25.0.4.1+1-jre")
    const firstName = entries[0].entryName.replace(/\\/g, '/');
    const topDir = firstName.includes('/') ? firstName.split('/')[0] : null;
    const safeRoot = path.resolve(targetDir);

    for (const entry of entries) {
      let rel = entry.entryName.replace(/\\/g, '/');

      // Quitar el prefijo del directorio raíz
      if (topDir) {
        if (rel === topDir) continue;
        if (rel.startsWith(topDir + '/')) {
          rel = rel.substring(topDir.length + 1);
        }
      }
      if (!rel) continue;

      const dest = path.resolve(targetDir, rel);
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
   * Mapea process.platform al identificador de OS de la API de Adoptium
   * @private
   */
  _adoptiumOs() {
    if (process.platform === 'win32') return 'windows';
    if (process.platform === 'darwin') return 'mac';
    return 'linux';
  }

  /**
   * Mapea process.arch al identificador de arquitectura de Adoptium
   * @private
   */
  _adoptiumArch() {
    if (process.arch === 'arm64') return 'aarch64';
    if (process.arch === 'ia32') return 'x32';
    return 'x64';
  }
}

module.exports = JavaRuntime;
