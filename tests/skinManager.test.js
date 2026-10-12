/**
 * skinManager.test.js - Tests de la lógica pura del gestor de skins
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SkinManager = require(path.join(__dirname, '..', 'src', 'skins', 'skinManager'));
const sm = new SkinManager();

// ============ _validateUsername ============
test('skins: nombres de jugador válidos', () => {
  assert.equal(sm._validateUsername('Notch'), 'Notch');
  assert.equal(sm._validateUsername('  menona '), 'menona');
  assert.equal(sm._validateUsername('Player_123'), 'Player_123');
  assert.equal(sm._validateUsername('ab'), 'ab');
});

test('skins: nombres inválidos lanzan error claro', () => {
  assert.throws(() => sm._validateUsername(''), /inválido/i);
  assert.throws(() => sm._validateUsername('a'), /inválido/i);
  assert.throws(() => sm._validateUsername('nombre-demasiado-largo-123456'), /inválido/i);
  assert.throws(() => sm._validateUsername('con espacios'), /inválido/i);
  assert.throws(() => sm._validateUsername('símbolos!'), /inválido/i);
});

// ============ _parseTexturesValue ============
function makeTexturePayload({ skinUrl, model } = {}) {
  const textures = {};
  if (skinUrl) {
    textures.SKIN = model
      ? { url: skinUrl, metadata: { model } }
      : { url: skinUrl };
  }
  return Buffer.from(JSON.stringify({
    profileName: 'Notch',
    textures
  })).toString('base64');
}

test('skins: payload con skin y modelo slim', () => {
  const decoded = sm._parseTexturesValue(makeTexturePayload({ skinUrl: 'http://x/s.png', model: 'slim' }));
  assert.equal(decoded.skinUrl, 'http://x/s.png');
  assert.equal(decoded.model, 'slim');
  assert.equal(decoded.profileName, 'Notch');
});

test('skins: payload sin metadata de modelo → clásico', () => {
  const decoded = sm._parseTexturesValue(makeTexturePayload({ skinUrl: 'http://x/s.png' }));
  assert.equal(decoded.model, 'classic');
});

test('skins: payload sin skin → null', () => {
  const decoded = sm._parseTexturesValue(makeTexturePayload({}));
  assert.equal(decoded.skinUrl, null);
});

// ============ _sanitizeFileName ============
test('skins: sanitiza nombres de archivo', () => {
  assert.equal(sm._sanitizeFileName('Notch'), 'Notch');
  assert.equal(sm._sanitizeFileName('Player 123'), 'Player_123');
  assert.equal(sm._sanitizeFileName('a/b\\c'), 'a_b_c');
});
