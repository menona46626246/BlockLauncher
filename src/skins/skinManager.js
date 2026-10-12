/**
 * skinManager.js - Gestión de skins para perfiles offline
 *
 * En Minecraft offline la skin por defecto es Steve/Alex: para usar skins
 * personalizadas hace falta un mod cliente (el launcher instala Quick Skin,
 * que soporta Fabric/Forge/NeoForge y tiene biblioteca de skins).
 *
 * Este módulo:
 * - Resuelve la skin de CUALQUIER jugador premium por su nombre, usando la
 *   cadena pública de Mojang: nombre -> UUID -> texturas -> PNG
 * - Guarda el PNG en <mcRoot>/skins/<jugador>.png (biblioteca local que el
 *   mod puede importar)
 * - Devuelve un data URL para previsualizarla en el launcher
 *
 * La instalación del mod de soporte la hace el ModrinthApi (Quick Skin).
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const MOJANG_API = {
  profile: 'https://api.mojang.com/users/profiles/minecraft/',
  session: 'https://sessionserver.mojang.com/session/minecraft/profile/'
};

class SkinManager {
  constructor() {
    this.userAgent = 'BlockLauncher/1.1.0 (github.com/menona46626246/BlockLauncher)';
    this.timeout = 15000;
  }

  /**
   * Busca la skin de un jugador por su nombre, la descarga y la guarda
   * en la biblioteca local de skins (<mcRoot>/skins).
   * @param {Object} opts - { username, mcRoot }
   * @returns {Promise<Object>} - { success, dataUrl, model, playerName, savedPath }
   */
  async fetchSkin(opts) {
    try {
      const mcRoot = opts.mcRoot;
      if (!mcRoot) {
        throw new Error('Falta el directorio de Minecraft');
      }

      const name = this._validateUsername(opts.username);

      // 1. Resolver UUID del jugador (204 = no existe)
      const profile = await this._getJson(`${MOJANG_API.profile}${name}`, true);
      if (!profile) {
        throw new Error(`No se encontró el jugador "${name}"`);
      }

      // 2. Texturas del perfil
      const session = await this._getJson(`${MOJANG_API.session}${profile.id}`, false);
      const prop = session.properties && session.properties.find(p => p.name === 'textures');
      if (!prop) {
        throw new Error(`"${profile.name}" no tiene texturas públicas`);
      }

      const decoded = this._parseTexturesValue(prop.value);
      if (!decoded.skinUrl) {
        throw new Error(`"${profile.name}" no tiene skin`);
      }

      // 3. Descargar el PNG
      const png = await this._downloadBuffer(decoded.skinUrl);

      // 4. Guardar en la biblioteca de skins
      const skinsDir = path.join(mcRoot, 'skins');
      await fsp.mkdir(skinsDir, { recursive: true });
      const fileName = `${this._sanitizeFileName(profile.name)}.png`;
      const savedPath = path.join(skinsDir, fileName);
      await fsp.writeFile(savedPath, png);

      console.log(`[Skins] Skin de ${profile.name} (${decoded.model}) guardada en ${savedPath}`);

      return {
        success: true,
        playerName: profile.name,
        model: decoded.model,
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        savedPath,
        fileName,
        message: `Skin de ${profile.name} guardada en skins/${fileName}`
      };
    } catch (error) {
      console.error('[Skins] Error al buscar skin:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ============================================================
  // LÓGICA PURA (testeable)
  // ============================================================

  /**
   * Valida el formato de un nombre de jugador de Minecraft
   * @private
   */
  _validateUsername(username) {
    const trimmed = String(username || '').trim();
    if (!/^[A-Za-z0-9_]{2,16}$/.test(trimmed)) {
      throw new Error('Nombre de jugador inválido (2-16 letras, números y _)');
    }
    return trimmed;
  }

  /**
   * Decodifica el payload base64 de texturas de Mojang
   * @private
   * @returns {{ profileName: string, skinUrl: string|null, model: 'classic'|'slim' }}
   */
  _parseTexturesValue(base64Value) {
    const json = JSON.parse(Buffer.from(base64Value, 'base64').toString('utf-8'));
    const skin = json.textures && json.textures.SKIN;
    return {
      profileName: json.profileName || null,
      skinUrl: skin && skin.url ? skin.url : null,
      model: skin && skin.metadata && skin.metadata.model === 'slim' ? 'slim' : 'classic'
    };
  }

  /**
   * Sanitiza un nombre para usarlo como archivo
   * @private
   */
  _sanitizeFileName(name) {
    return String(name || 'skin').replace(/[^A-Za-z0-9_.-]/g, '_');
  }

  // ============================================================
  // HELPERS DE RED
  // ============================================================

  /**
   * GET JSON. Con allowEmpty=true devuelve null si el servidor responde
   * 204 o 404 (las formas en que Mojang indica "jugador no encontrado").
   * @private
   */
  _getJson(url, allowEmpty, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
      if (redirectsLeft <= 0) return reject(new Error('Demasiadas redirecciones'));

      const req = https.get(url, {
        timeout: this.timeout,
        headers: { 'User-Agent': this.userAgent }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return this._getJson(new URL(res.headers.location, url).href, allowEmpty, redirectsLeft - 1)
            .then(resolve, reject);
        }
        if (allowEmpty && (res.statusCode === 204 || res.statusCode === 404)) {
          res.resume();
          return resolve(null);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} consultando Mojang`));
        }
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error('JSON inválido de Mojang'));
          }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout consultando Mojang')); });
      req.on('error', reject);
    });
  }

  /**
   * Descarga un binario a memoria (siguiendo redirecciones)
   * @private
   */
  _downloadBuffer(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      if (redirectsLeft <= 0) return reject(new Error('Demasiadas redirecciones'));

      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, {
        timeout: 20000,
        headers: { 'User-Agent': this.userAgent }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return this._downloadBuffer(new URL(res.headers.location, url).href, redirectsLeft - 1)
            .then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} descargando la skin`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout descargando la skin')); });
      req.on('error', reject);
    });
  }
}

module.exports = SkinManager;
