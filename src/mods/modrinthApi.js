/**
 * modrinthApi.js - Integración con Modrinth (api.modrinth.com)
 *
 * Permite buscar mods e instalarlos directamente en la carpeta de mods.
 * API pública sin autenticación; usa un User-Agent descriptivo como
 * pide Modrinth. Sin dependencias externas.
 *
 * Docs: https://docs.modrinth.com/
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const MODRINTH_API = 'https://api.modrinth.com/v2';

class ModrinthApi {
  constructor() {
    // Modrinth pide un User-Agent identificable
    this.userAgent = 'BlockLauncher/1.1.0 (github.com/menona46626246/BlockLauncher)';
    this.timeout = 15000;
  }

  /**
   * Busca mods filtrando por versión de Minecraft y loader.
   * @param {Object} opts - { query, loader, mcVersion, limit }
   */
  async search(opts) {
    try {
      const { query, loader, mcVersion } = opts;
      if (!query || !String(query).trim()) {
        throw new Error('Escribe algo para buscar');
      }

      const url = this.buildSearchUrl({ query, loader, mcVersion, limit: opts.limit || 20 });
      const data = await this._getJson(url);

      if (!data || !Array.isArray(data.hits)) {
        throw new Error('Respuesta inválida de Modrinth');
      }

      return {
        success: true,
        hits: data.hits.map(h => ({
          projectId: h.project_id,
          slug: h.slug,
          title: h.title,
          description: h.description || '',
          author: h.author,
          downloads: h.downloads || 0,
          follows: h.follows || 0,
          iconUrl: h.icon_url || null,
          categories: h.categories || []
        })),
        loader,
        mcVersion
      };
    } catch (error) {
      return { success: false, error: error.message, hits: [] };
    }
  }

  /**
   * Busca la versión compatible del mod y la descarga a la carpeta de mods.
   * @param {Object} opts - { projectId, title, loader, mcVersion, modsDir }
   */
  async install(opts) {
    try {
      const { projectId, title, loader, mcVersion, modsDir } = opts;
      if (!projectId) {
        throw new Error('Se requiere el ID del proyecto');
      }

      // 1. Versiones del proyecto compatibles con el juego/loader
      const versionsUrl = this.buildVersionsUrl({ projectId, loader, mcVersion });
      const versions = await this._getJson(versionsUrl);

      if (!Array.isArray(versions) || versions.length === 0) {
        throw new Error(
          `Sin versiones compatibles con Minecraft ${mcVersion || '?'}${loader ? ` (${loader})` : ''}`
        );
      }

      // 2. Elegir la mejor versión (la más reciente con archivos)
      const best = this.pickBestVersion(versions);
      if (!best) {
        throw new Error('Ninguna versión del mod tiene archivos descargables');
      }

      // 3. Archivo principal del jar
      const file = this.pickVersionFile(best);
      if (!file) {
        throw new Error('La versión del mod no tiene archivos');
      }

      // 4. Evitar duplicados en la carpeta de mods
      const target = path.join(modsDir, file.filename);
      if (fs.existsSync(target)) {
        return {
          success: false,
          alreadyInstalled: true,
          fileName: file.filename,
          error: `"${file.filename}" ya está en tu carpeta de mods`
        };
      }

      // 5. Descargar
      await fsp.mkdir(modsDir, { recursive: true });
      await this._downloadFile(file.url, target);

      const sizeMB = ((file.size || 0) / (1024 * 1024)).toFixed(1);
      console.log(`[Modrinth] Mod instalado: ${file.filename} (${sizeMB} MB)`);

      return {
        success: true,
        fileName: file.filename,
        version: best.version_number,
        size: file.size,
        message: `"${title || file.filename}" instalado (${sizeMB} MB)`
      };
    } catch (error) {
      console.error('[Modrinth] Error al instalar mod:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ============================================================
  // LÓGICA PURA (testeable)
  // ============================================================

  /**
   * URL de búsqueda con facets por versión/loader
   * @private
   */
  buildSearchUrl({ query, loader, mcVersion, limit = 20 }) {
    const facets = [['project_type:mod']];
    if (mcVersion) facets.push([`versions:${mcVersion}`]);
    if (loader) facets.push([`categories:${loader}`]);

    const params = new URLSearchParams({
      query: String(query).trim(),
      limit: String(limit),
      facets: JSON.stringify(facets)
    });
    return `${MODRINTH_API}/search?${params.toString()}`;
  }

  /**
   * URL de versiones de un proyecto filtradas por juego/loader
   * @private
   */
  buildVersionsUrl({ projectId, loader, mcVersion }) {
    const params = new URLSearchParams();
    if (mcVersion) params.set('game_versions', JSON.stringify([mcVersion]));
    if (loader) params.set('loaders', JSON.stringify([loader]));
    const qs = params.toString();
    return `${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version${qs ? `?${qs}` : ''}`;
  }

  /**
   * Elige la versión más reciente que tenga archivos
   * @private
   */
  pickBestVersion(versions) {
    const withFiles = versions.filter(v => v.files && v.files.length > 0);
    if (withFiles.length === 0) return null;
    const sorted = [...withFiles].sort(
      (a, b) => new Date(b.date_published) - new Date(a.date_published)
    );
    return sorted[0];
  }

  /**
   * Elige el archivo principal de una versión (prefiere el primario)
   * @private
   */
  pickVersionFile(version) {
    if (!version || !Array.isArray(version.files) || version.files.length === 0) {
      return null;
    }
    return version.files.find(f => f.primary && f.url) || version.files.find(f => f.url) || null;
  }

  // ============================================================
  // HELPERS DE RED
  // ============================================================

  _getJson(url, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
      if (redirectsLeft <= 0) return reject(new Error('Demasiadas redirecciones'));

      const req = https.get(url, {
        timeout: this.timeout,
        headers: { 'User-Agent': this.userAgent }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return this._getJson(new URL(res.headers.location, url).href, redirectsLeft - 1)
            .then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Modrinth HTTP ${res.statusCode}`));
        }
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error('JSON inválido de Modrinth'));
          }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout consultando Modrinth')); });
      req.on('error', reject);
    });
  }

  _downloadFile(url, targetPath, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      if (redirectsLeft <= 0) return reject(new Error('Demasiadas redirecciones'));

      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, {
        timeout: 60000,
        headers: { 'User-Agent': this.userAgent }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return this._downloadFile(new URL(res.headers.location, url).href, targetPath, redirectsLeft - 1)
            .then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} descargando el mod`));
        }
        fsp.mkdir(path.dirname(targetPath), { recursive: true }).then(() => {
          const file = fs.createWriteStream(targetPath);
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve(targetPath)));
          file.on('error', (err) => {
            fs.unlink(targetPath, () => {});
            reject(err);
          });
        }).catch(reject);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout descargando el mod')); });
      req.on('error', reject);
    });
  }
}

module.exports = ModrinthApi;
