/**
 * modrinth.test.js - Tests de la lógica pura de la API de Modrinth
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ModrinthApi = require(path.join(__dirname, '..', 'src', 'mods', 'modrinthApi'));
const api = new ModrinthApi();

// ============ buildSearchUrl ============
test('búsqueda: URL con facets de versión, loader y tipo', () => {
  const url = api.buildSearchUrl({ query: 'sodium', loader: 'fabric', mcVersion: '26.3' });
  assert.ok(url.startsWith('https://api.modrinth.com/v2/search?'));
  const decoded = decodeURIComponent(url.split('?')[1]);
  assert.ok(decoded.includes('query=sodium'));
  assert.ok(decoded.includes('"project_type:mod"'));
  assert.ok(decoded.includes('"versions:26.3"'));
  assert.ok(decoded.includes('"categories:fabric"'));
});

test('búsqueda: sin loader/version solo filtra por tipo de proyecto', () => {
  const url = api.buildSearchUrl({ query: 'x' });
  const decoded = decodeURIComponent(url.split('?')[1]);
  assert.ok(decoded.includes('"project_type:mod"'));
  assert.ok(!decoded.includes('versions:'));
  assert.ok(!decoded.includes('categories:'));
});

// ============ buildVersionsUrl ============
test('versiones: URL con game_versions y loaders como arrays', () => {
  const url = api.buildVersionsUrl({ projectId: 'proj-1', loader: 'neoforge', mcVersion: '26.3' });
  assert.ok(url.includes('/project/proj-1/version?'));
  const decoded = decodeURIComponent(url.split('?')[1]);
  assert.ok(decoded.includes('game_versions=["26.3"]'));
  assert.ok(decoded.includes('loaders=["neoforge"]'));
});

test('versiones: sin filtros no lleva query string', () => {
  const url = api.buildVersionsUrl({ projectId: 'proj-1' });
  assert.equal(url, 'https://api.modrinth.com/v2/project/proj-1/version');
});

// ============ pickBestVersion ============
test('versiones: elige la más reciente con archivos', () => {
  const versions = [
    { version_number: '1.0', date_published: '2026-01-01T00:00:00Z', files: [{ url: 'a' }] },
    { version_number: '2.0', date_published: '2026-05-01T00:00:00Z', files: [{ url: 'b' }] },
    { version_number: '1.5', date_published: '2026-03-01T00:00:00Z', files: [{ url: 'c' }] }
  ];
  assert.equal(api.pickBestVersion(versions).version_number, '2.0');
});

test('versiones: ignora las que no tienen archivos', () => {
  const versions = [
    { version_number: '9.9', date_published: '2026-09-01T00:00:00Z', files: [] },
    { version_number: '1.0', date_published: '2026-01-01T00:00:00Z', files: [{ url: 'a' }] }
  ];
  assert.equal(api.pickBestVersion(versions).version_number, '1.0');
});

test('versiones: todas sin archivos devuelve null', () => {
  assert.equal(api.pickBestVersion([{ files: [] }, { files: null }]), null);
});

// ============ pickVersionFile ============
test('archivo: prefiere el marcado como primary', () => {
  const version = {
    files: [
      { url: 'https://x/secondary.jar', primary: false },
      { url: 'https://x/primary.jar', primary: true }
    ]
  };
  assert.equal(api.pickVersionFile(version).url, 'https://x/primary.jar');
});

test('archivo: sin primary toma el primero con url', () => {
  const version = {
    files: [
      { url: 'https://x/a.jar' },
      { url: 'https://x/b.jar' }
    ]
  };
  assert.equal(api.pickVersionFile(version).url, 'https://x/a.jar');
});

test('archivo: sin archivos válidos devuelve null', () => {
  assert.equal(api.pickVersionFile({ files: [] }), null);
  assert.equal(api.pickVersionFile(null), null);
});

// ============ search: validación de entrada ============
test('search: query vacío devuelve error controlado', async () => {
  const result = await api.search({ query: '   ' });
  assert.equal(result.success, false);
  assert.ok(result.error.includes('Escribe'));
});
