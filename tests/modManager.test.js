/**
 * modManager.test.js - Tests de migración del estado de mods
 * (la carpeta de mods pasó de por-versión a compartida)
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ModManager = require(path.join(__dirname, '..', 'src', 'mods', 'modManager'));

const stub = {
  getConfig: async () => ({ success: true, config: { minecraftDirectory: 'C:\\mc' } })
};

test('migración: formato antiguo (por versión) a lista plana con dedupe', () => {
  const mm = new ModManager(stub);
  mm.modsState = {
    '26.3': [
      { id: 'mod-a', fileName: 'mod-a.jar', addedAt: '2026-01-01', size: 100 }
    ],
    '26.3-fabric': [
      { id: 'mod-a', fileName: 'mod-a.jar', addedAt: '2026-01-01', size: 100 },
      { id: 'mod-b', fileName: 'mod-b.jar', addedAt: '2026-01-02', size: 200 }
    ]
  };

  mm._migrateState();

  assert.ok(Array.isArray(mm.modsState.mods), 'formato nuevo: { mods: [...] }');
  assert.equal(mm.modsState.mods.length, 2, 'los duplicados se fusionan');
  assert.ok(mm.modsState.mods.some(m => m.id === 'mod-b'));
});

test('migración: idempotente (no duplica al re-ejecutar)', () => {
  const mm = new ModManager(stub);
  mm.modsState = { mods: [{ id: 'x', size: 1 }] };
  mm._migrateState();
  mm._migrateState();
  assert.equal(mm.modsState.mods.length, 1);
});

test('migración: estado vacío genera lista vacía', () => {
  const mm = new ModManager(stub);
  mm.modsState = {};
  mm._migrateState();
  assert.deepEqual(mm.modsState, { mods: [] });
});
