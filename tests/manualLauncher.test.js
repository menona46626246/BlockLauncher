/**
 * manualLauncher.test.js - Tests del motor nativo (lógica pura)
 * Rules de Mojang, comparador de versiones, natives, librerías y argumentos JVM.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ManualLauncher = require(path.join(__dirname, '..', 'src', 'versions', 'manualLauncher'));
const ml = new ManualLauncher();

// ============ _evaluateRules ============
test('rules: sin rules se permite', () => {
  assert.equal(ml._evaluateRules(undefined), true);
  assert.equal(ml._evaluateRules([]), true);
});

test('rules: allow para el OS actual', () => {
  const myOs = ml._getOSKey();
  assert.equal(ml._evaluateRules([{ action: 'allow', os: { name: myOs } }]), true);
});

test('rules: allow para otro OS se deniega', () => {
  const otherOs = ml._getOSKey() === 'windows' ? 'osx' : 'windows';
  assert.equal(ml._evaluateRules([{ action: 'allow', os: { name: otherOs } }]), false);
});

test('rules: disallow para el OS actual se deniega', () => {
  const myOs = ml._getOSKey();
  assert.equal(ml._evaluateRules([
    { action: 'allow' },
    { action: 'disallow', os: { name: myOs } }
  ]), false);
});

test('rules: features (has_custom_resolution) se evalúan contra las del launcher', () => {
  const features = { has_custom_resolution: true };
  assert.equal(ml._evaluateRules(
    [{ action: 'allow', features: { has_custom_resolution: true } }], features), true);
  assert.equal(ml._evaluateRules(
    [{ action: 'allow', features: { is_demo_user: true } }], features), false);
});

// ============ _compareNumericVersions ============
test('comparador: build más alto gana (formato NeoForge)', () => {
  assert.ok(ml._compareNumericVersions('26.3.0.39-beta', '26.3.0.38-beta') > 0);
  assert.ok(ml._compareNumericVersions('26.3.0.38-beta', '26.3.0.39-beta') < 0);
});

test('comparador: build más alto gana (formato Forge)', () => {
  assert.ok(ml._compareNumericVersions('26.3-66.0.9', '26.3-66.0.8') > 0);
});

test('comparador: versiones iguales', () => {
  assert.equal(ml._compareNumericVersions('26.3.0.39-beta', '26.3.0.39-beta'), 0);
});

// ============ _nativesCategory ============
test('natives: categoría por librería', () => {
  assert.equal(ml._nativesCategory('org.lwjgl:lwjgl:3.4.3:natives-windows'), 'lwjgl');
  assert.equal(ml._nativesCategory('net.java.dev.jna:jna:5.13.0'), 'jna');
  assert.equal(ml._nativesCategory('io.netty:netty-transport-native-epoll:4.2.16.Final'), 'netty');
  assert.equal(ml._nativesCategory('com.mojang:jtracy:1.14.38:natives-windows'), 'java');
});

// ============ _nativesJarMatchesArch ============
test('natives: jars arm64 se excluyen en x64', () => {
  const isArm = process.arch === 'arm64';
  assert.equal(ml._nativesJarMatchesArch('org.lwjgl:lwjgl:3.4.3:natives-windows-arm64'), isArm);
  assert.equal(ml._nativesJarMatchesArch('org.lwjgl:lwjgl:3.4.3:natives-windows'), !isArm);
});

// ============ _libArtifact ============
test('librerías: formato Mojang (downloads.artifact)', () => {
  const lib = {
    downloads: { artifact: { path: 'com/mojang/brigadier/1.0/brigadier-1.0.jar', url: 'https://libraries.minecraft.net/com/mojang/brigadier/1.0/brigadier-1.0.jar' } }
  };
  const art = ml._libArtifact(lib);
  assert.equal(art.path, 'com/mojang/brigadier/1.0/brigadier-1.0.jar');
  assert.ok(art.url.includes('libraries.minecraft.net'));
});

test('librerías: formato Maven de Fabric (name+url)', () => {
  const lib = {
    name: 'net.fabricmc:fabric-loader:0.19.5',
    url: 'https://maven.fabricmc.net/'
  };
  const art = ml._libArtifact(lib);
  assert.equal(art.path, 'net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar');
  assert.equal(art.url, 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar');
});

test('librerías: sin artifact devuelve null', () => {
  assert.equal(ml._libArtifact({ name: 'sin:urls' }), null);
});

// ============ _buildJvmArgs: moderno ============
test('args modernos: interpola tokens y evalúa rules', () => {
  const versionJson = {
    id: '26.3-fake',
    type: 'release',
    assets: '34',
    arguments: {
      jvm: [
        { rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] },
        { rules: [{ action: 'allow', os: { name: ml._getOSKey() } }], value: '-Dlocal.os=ok' },
        '-DlibraryDirectory=${library_directory}',
        '-cp', '${classpath}'
      ],
      game: [
        '--username', '${auth_player_name}',
        '--assetsDir', '${assets_root}',
        { rules: [{ action: 'allow', features: { has_custom_resolution: true } }],
          value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] },
        { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' }
      ]
    }
  };

  const args = ml._buildJvmArgs({
    memory: { min: '2G', max: '4G' },
    nativesDir: 'C:\\mc\\natives',
    classpath: 'C:\\a.jar;C:\\b.jar',
    mainClass: 'net.minecraft.client.main.Main',
    versionJson,
    gameDir: 'C:\\mc',
    root: 'C:\\mc',
    username: 'menona',
    uuid: 'b6b52663-dbef-41b4-a7de-414158106464',
    jvmArgs: [],
    log4jArg: '-Dlog4j.configurationFile=client.xml'
  });

  const joined = args.join(' ');
  // Memoria primero
  assert.equal(args[0], '-Xms2G');
  assert.equal(args[1], '-Xmx4G');
  // Tokens interpolados
  assert.ok(joined.includes('--username menona'));
  assert.ok(joined.includes('C:\\mc\\assets'), 'assets_root debe ser root/assets');
  assert.ok(joined.includes('C:\\mc\\libraries'), 'library_directory debe ser root/libraries');
  assert.ok(joined.includes('-DlibraryDirectory=C:\\mc\\libraries'));
  // Rule de OS: la de osx se excluye, la del OS actual entra
  assert.ok(!joined.includes('-XstartOnFirstThread'));
  assert.ok(joined.includes('-Dlocal.os=ok'));
  // Features: resolución sí, demo no
  assert.ok(joined.includes('--width 854') && joined.includes('--height 480'));
  assert.ok(!joined.includes('--demo'));
  // Main class presente
  assert.ok(joined.includes('net.minecraft.client.main.Main'));
});

// ============ _buildJvmArgs: legacy ============
test('args legacy: minecraftArguments se interpolan con assets corregido', () => {
  const versionJson = {
    id: '1.12.2-fake',
    type: 'release',
    assets: 'legacy',
    minecraftArguments: '--username ${auth_player_name} --gameDir ${game_directory} --assetsDir ${assets_root} --userType ${user_type}'
  };

  const args = ml._buildJvmArgs({
    memory: { min: '1G', max: '2G' },
    nativesDir: 'C:\\mc\\natives',
    classpath: 'C:\\client.jar',
    mainClass: 'net.minecraft.client.main.Main',
    versionJson,
    gameDir: 'C:\\mc',
    root: 'C:\\mc',
    username: 'Steve',
    uuid: '0000',
    jvmArgs: []
  });

  const joined = args.join(' ');
  assert.ok(joined.includes('--username Steve'));
  assert.ok(joined.includes('--assetsDir C:\\mc\\assets'), 'assets_root debe ser root/assets');
  assert.ok(joined.includes('--userType offline'));
  assert.ok(joined.includes('-cp'));
});

// ============ _resolveVersionJson (merge inheritsFrom) ============
test('merge: versión compuesta hereda de la vanilla', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-test-'));
  try {
    // Padre vanilla
    fs.mkdirSync(path.join(root, 'versions', '26.3'), { recursive: true });
    fs.writeFileSync(path.join(root, 'versions', '26.3', '26.3.json'), JSON.stringify({
      id: '26.3',
      mainClass: 'net.minecraft.client.main.Main',
      assets: '34',
      javaVersion: { majorVersion: 25 },
      downloads: { client: { url: 'x' } },
      libraries: [{ name: 'vanilla:lib:1.0' }],
      logging: { client: { argument: '-Dlog4j' } },
      arguments: { jvm: ['-cp', '${classpath}'], game: ['--username', '${auth_player_name}'] }
    }));

    // Hijo Fabric
    fs.mkdirSync(path.join(root, 'versions', '26.3-fabric'), { recursive: true });
    fs.writeFileSync(path.join(root, 'versions', '26.3-fabric', '26.3-fabric.json'), JSON.stringify({
      id: '26.3-fabric',
      inheritsFrom: '26.3',
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      libraries: [{ name: 'fabric:loader:0.19.5' }],
      arguments: { jvm: ['-DFabricMcEmu=x'], game: [] }
    }));

    const { json, clientJarId } = await ml._resolveVersionJson('26.3-fabric', root);

    // El mainClass del hijo gana
    assert.equal(json.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
    // Librerías concatenadas
    assert.equal(json.libraries.length, 2);
    // Args concat por sección (jvm), game del padre + hijo vacío
    assert.ok(json.arguments.jvm.includes('-cp'));
    assert.ok(json.arguments.jvm.includes('-DFabricMcEmu=x'));
    assert.equal(json.arguments.game.length, 2);
    // Campos que el hijo no define vienen del padre
    assert.equal(json.assets, '34');
    assert.equal(json.javaVersion.majorVersion, 25);
    // El JAR del cliente lo aporta la base
    assert.equal(clientJarId, '26.3');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('merge: versión sin inheritsFrom se devuelve tal cual', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-test-'));
  try {
    fs.mkdirSync(path.join(root, 'versions', '26.3'), { recursive: true });
    fs.writeFileSync(path.join(root, 'versions', '26.3', '26.3.json'), JSON.stringify({
      id: '26.3', mainClass: 'a.B'
    }));
    const { json, clientJarId } = await ml._resolveVersionJson('26.3', root);
    assert.equal(json.mainClass, 'a.B');
    assert.equal(clientJarId, '26.3');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
