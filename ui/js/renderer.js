/**
 * renderer.js - Lógica del lado del renderer (UI)
 * 
 * Maneja toda la interacción con el usuario:
 * - Renderizado de perfiles
 * - Selección y filtrado de versiones
 * - Instalación con barra de progreso
 * - Gestión de mods
 * - Lanzamiento del juego
 * - Modales de configuración y logs
 * 
 * Usa la API de Electron (window.electronAPI) para comunicarse
 * con el proceso main.
 */

// ============= ESTADO GLOBAL =============
const state = {
  profiles: [],
  activeProfileId: null,
  versions: [],
  selectedVersion: null,
  selectedModLoader: 'vanilla',
  selectedVersionType: 'release',
  installedVersions: [],
  mods: [],
  config: null,
  isInstalling: false,
  isGameRunning: false,
  logFilter: 'all',
  autoScroll: true,
  newsItems: [
    '🎉 Bienvenido a ADLauncher 1.0.0 - Tu launcher favorito ya está aquí',
    '🧩 Soporte completo para Forge, Fabric y OptiFine',
    '📦 Gestor de mods integrado con activación/desactivación',
    '🔒 Autenticación offline - Sin cuenta Mojang requerida',
    '⚡ Rendimiento optimizado con gestión de memoria 2-8 GB',
    '🎮 Compatible con todas las versiones desde 1.8 hasta 1.21',
    '💾 Tus perfiles se guardan localmente con UUID persistente',
    '🌙 Tema oscuro para sesiones nocturnas'
  ]
};

// ============= HELPERS =============
const $ = (id) => document.getElementById(id);

// Wrapper para invocar canales IPC del proceso main (via preload)
async function invoke(channel, ...args) {
  try {
    if (!window.electronAPI || !window.electronAPI.invoke) {
      throw new Error('IPC no disponible (preload no cargado)');
    }
    return await window.electronAPI.invoke(channel, ...args);
  } catch (err) {
    console.error(`[Renderer] Error en IPC ${channel}:`, err);
    return { success: false, error: err.message };
  }
}

// Suscribirse a eventos del main process (via preload)
function on(channel, callback) {
  try {
    if (window.electronAPI && window.electronAPI.on) {
      window.electronAPI.on(channel, callback);
    } else {
      console.error(`[Renderer] No se puede suscribir a ${channel}: preload no cargado`);
    }
  } catch (err) {
    console.error(`[Renderer] Error al suscribir a ${channel}:`, err);
  }
}

// ============= NOTIFICACIONES =============
function notify(message, type = 'success') {
  const n = document.createElement('div');
  n.className = `notification ${type}`;
  n.textContent = message;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 3000);
}

// ============= PERFILES =============
async function loadProfiles() {
  try {
    const result = await invoke('auth:get-profiles');
    if (result.success) {
      state.profiles = result.profiles || [];
      state.activeProfileId = result.activeProfileId;
      renderProfiles();
    }
  } catch (err) {
    console.error('[Renderer] Error al cargar perfiles:', err);
  }
}

function renderProfiles() {
  const container = $('profiles-list');
  
  if (!state.profiles || state.profiles.length === 0) {
    container.innerHTML = '<p class="empty-state">No hay perfiles. Crea uno con el botón "+".</p>';
    return;
  }

  container.innerHTML = state.profiles.map(p => `
    <div class="profile-item ${p.id === state.activeProfileId ? 'active' : ''}" 
         data-id="${p.id}">
      <div class="profile-avatar">${p.nickname.charAt(0).toUpperCase()}</div>
      <div class="profile-info">
        <div class="profile-name">${escapeHtml(p.nickname)}</div>
        <div class="profile-uuid">${p.uuid.substring(0, 8)}...</div>
      </div>
      <button class="profile-delete" data-id="${p.id}" title="Eliminar">🗑</button>
    </div>
  `).join('');

  // Event listeners para los items
  container.querySelectorAll('.profile-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('profile-delete')) return;
      selectProfile(item.dataset.id);
    });
  });

  container.querySelectorAll('.profile-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteProfile(btn.dataset.id);
    });
  });
}

async function selectProfile(profileId) {
  const result = await invoke('auth:select-profile', profileId);
  if (result.success) {
    state.activeProfileId = profileId;
    renderProfiles();
    notify(`Perfil "${result.profile.nickname}" seleccionado`, 'info');
  } else {
    notify('Error: ' + result.error, 'error');
  }
}

async function deleteProfile(profileId) {
  if (!confirm('¿Eliminar este perfil?')) return;
  const result = await invoke('auth:delete-profile', profileId);
  if (result.success) {
    await loadProfiles();
    notify(result.message, 'success');
  } else {
    notify('Error: ' + result.error, 'error');
  }
}

async function createProfile(nickname) {
  const result = await invoke('auth:create-profile', nickname);
  if (result.success) {
    await loadProfiles();
    $('new-profile-form').style.display = 'none';
    $('nickname-input').value = '';
    notify(result.message, 'success');
  } else {
    notify('Error: ' + result.error, 'error');
  }
}

// ============= EXPORTAR / IMPORTAR PERFILES =============

/**
 * Exporta los perfiles a un archivo JSON
 */
async function exportProfiles() {
  try {
    const result = await invoke('auth:export-profiles', {});
    if (result.success) {
      notify(result.message, 'success');
    } else if (result.canceled) {
      // Usuario canceló el dialog, no es error
    } else {
      notify('Error al exportar: ' + result.error, 'error');
    }
  } catch (err) {
    console.error('[Renderer] Error en export:', err);
    notify('Error al exportar perfiles', 'error');
  }
}

/**
 * Muestra el modal de importación
 */
function showImportModal() {
  $('import-modal').style.display = 'flex';
  // Resetear estado
  $('import-overwrite').checked = false;
  $('import-replace-all').checked = false;
  $('import-preview').style.display = 'none';
}

/**
 * Ejecuta la importación con las opciones del modal
 */
async function doImport() {
  try {
    const options = {
      overwrite: $('import-overwrite').checked,
      replaceAll: $('import-replace-all').checked
    };

    if (options.replaceAll && !confirm('⚠️ Esto eliminará TODOS tus perfiles actuales. ¿Continuar?')) {
      return;
    }

    const result = await invoke('auth:import-profiles', options);

    if (result.success) {
      // Recargar la lista de perfiles desde el server
      await loadProfiles();
      notify(result.message, 'success');

      // Mostrar resumen si hay stats
      if (result.stats) {
        const s = result.stats;
        console.log('[Import] Stats:', s);
        if (s.errors && s.errors.length > 0) {
          notify(`${s.errors.length} perfil(es) con errores`, 'error');
        }
      }

      // Cerrar modal
      $('import-modal').style.display = 'none';
    } else if (result.canceled) {
      // Usuario canceló
    } else {
      notify('Error al importar: ' + result.error, 'error');
    }
  } catch (err) {
    console.error('[Renderer] Error en import:', err);
    notify('Error al importar perfiles', 'error');
  }
}

// ============= VERSIONES =============
async function loadVersions(options = {}) {
  try {
    const result = await invoke('versions:list', options);
    if (result.success) {
      state.versions = result.versions || [];
      state.installedVersions = result.versions.filter(v => v.installed).map(v => v.id);
      renderVersions();
      return result;
    } else {
      notify('Error al cargar versiones: ' + result.error, 'error');
      return result;
    }
  } catch (err) {
    console.error('[Renderer] Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Fuerza la actualización desde la API de Mojang
 */
async function refreshVersions() {
  const btn = $('btn-refresh-versions');
  if (btn) {
    btn.classList.add('refreshing');
    btn.disabled = true;
  }

  try {
    const result = await invoke('versions:refresh');
    if (result.success) {
      notify(result.message, 'success');
      // Recargar la lista con los datos frescos
      await loadVersions({ forceRefresh: true });
    } else {
      notify('Error al actualizar: ' + (result.error || 'desconocido'), 'error');
      // Aún así recargar para mostrar lo que tengamos
      await loadVersions();
    }
  } catch (err) {
    console.error('[Renderer] Error en refresh:', err);
    notify('Error al actualizar versiones', 'error');
  } finally {
    if (btn) {
      btn.classList.remove('refreshing');
      btn.disabled = false;
    }
  }
}

function renderVersions() {
  const select = $('version-select');
  const filtered = state.versions.filter(v => v.type === state.selectedVersionType);
  
  select.innerHTML = '<option value="">-- Selecciona versión --</option>' +
    filtered.map(v => {
      const installedTag = v.installed ? ' ✓' : '';
      return `<option value="${v.id}">${v.id}${installedTag}</option>`;
    }).join('');

  // Restaurar selección si existe
  if (state.selectedVersion) {
    select.value = state.selectedVersion;
  }
}

async function installVersion() {
  const versionId = $('version-select').value;
  if (!versionId) {
    notify('Selecciona una versión primero', 'error');
    return;
  }

  if (state.isInstalling) {
    notify('Ya hay una instalación en curso', 'error');
    return;
  }

  state.isInstalling = true;
  $('btn-install').disabled = true;
  $('progress-container').style.display = 'block';
  $('btn-play').disabled = true;

  const result = await invoke('versions:install', {
    id: versionId,
    type: state.selectedVersionType,
    modLoader: state.selectedModLoader
  });

  state.isInstalling = false;
  $('btn-install').disabled = false;
  $('btn-play').disabled = false;

  if (result.success) {
    notify(result.message, 'success');
    // Si instalamos un mod loader, seleccionar automáticamente la versión compuesta
    if (state.selectedModLoader !== 'vanilla' && result.version && result.version !== versionId) {
      state.selectedVersion = result.version;
      $('current-version').textContent = result.version;
    }
    await loadVersions();
    // Si era la versión seleccionada, recargar mods
    if (versionId === state.selectedVersion) {
      await loadMods(versionId);
    }
  } else {
    notify('Error: ' + result.error, 'error');
  }
}

// ============= MODS =============
async function loadMods(versionId) {
  if (!versionId) {
    state.mods = [];
    renderMods();
    return;
  }

  const result = await invoke('mods:list', versionId);
  if (result.success) {
    state.mods = result.mods || [];
    renderMods();
  } else {
    notify('Error al cargar mods: ' + result.error, 'error');
  }
}

function renderMods() {
  const container = $('mods-list');
  
  if (!state.mods || state.mods.length === 0) {
    container.innerHTML = '<p class="empty-state">No hay mods instalados para esta versión.</p>';
    return;
  }

  container.innerHTML = state.mods.map(mod => `
    <div class="mod-item ${mod.enabled ? '' : 'disabled'}" data-id="${mod.id}">
      <div class="mod-icon">🧩</div>
      <div class="mod-info">
        <div class="mod-name" title="${escapeHtml(mod.realName)}">${escapeHtml(mod.realName)}</div>
        <div class="mod-size">${formatBytes(mod.size || 0)}</div>
      </div>
      <button class="mod-toggle ${mod.enabled ? 'enabled' : ''}" 
              data-id="${mod.id}" 
              data-enabled="${mod.enabled}"></button>
      <button class="mod-delete" data-id="${mod.id}" title="Eliminar">🗑</button>
    </div>
  `).join('');

  // Event listeners
  container.querySelectorAll('.mod-toggle').forEach(btn => {
    btn.addEventListener('click', () => toggleMod(btn.dataset.id, btn.dataset.enabled === 'true'));
  });
  container.querySelectorAll('.mod-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteMod(btn.dataset.id));
  });
}

async function toggleMod(modId, currentlyEnabled) {
  const result = await invoke('mods:toggle', {
    versionId: state.selectedVersion,
    modId: modId,
    enabled: !currentlyEnabled
  });
  if (result.success) {
    await loadMods(state.selectedVersion);
    notify(result.message, 'info');
  } else {
    notify('Error: ' + result.error, 'error');
  }
}

async function deleteMod(modId) {
  if (!confirm('¿Eliminar este mod?')) return;
  const result = await invoke('mods:delete', {
    versionId: state.selectedVersion,
    modId: modId
  });
  if (result.success) {
    await loadMods(state.selectedVersion);
    notify(result.message, 'success');
  } else {
    notify('Error: ' + result.error, 'error');
  }
}

async function addMod() {
  if (!state.selectedVersion) {
    notify('Selecciona una versión primero', 'error');
    return;
  }
  if (!state.installedVersions.includes(state.selectedVersion)) {
    notify('Instala la versión antes de añadir mods', 'error');
    return;
  }

  const result = await invoke('mods:select-file');
  if (!result.success) {
    if (!result.canceled) notify('Error: ' + result.error, 'error');
    return;
  }

  const installResult = await invoke('mods:install', {
    sourcePath: result.path,
    versionId: state.selectedVersion
  });

  if (installResult.success) {
    await loadMods(state.selectedVersion);
    notify(installResult.message, 'success');
  } else {
    notify('Error: ' + installResult.error, 'error');
  }
}

// ============= LANZAMIENTO =============

/**
 * Determina si un id de versión es una compuesta de un mod loader
 */
function isCompositeVersion(versionId) {
  return typeof versionId === 'string' && (
    versionId.includes('-fabric') ||
    versionId.includes('-forge') ||
    versionId.startsWith('neoforge') ||
    versionId.startsWith('forge-')
  );
}

/**
 * Busca la versión compuesta instalada para un loader y una base vanilla
 */
function findCompositeFor(loader, mcVersion) {
  const installed = state.installedVersions;
  if (loader === 'fabric') {
    return installed.find(v => v === `${mcVersion}-fabric`) || null;
  }
  if (loader === 'neoforge') {
    return installed.find(v => v.startsWith('neoforge') && v.includes(mcVersion)) || null;
  }
  if (loader === 'forge') {
    return installed.find(v =>
      v !== mcVersion && !v.startsWith('neoforge') &&
      v.includes(mcVersion) && v.includes('forge')
    ) || null;
  }
  return null;
}

/**
 * Actualiza la UI según si hay un juego en ejecución
 */
function updateGameRunningUI() {
  const playBtn = $('btn-play');
  const stopBtn = $('btn-stop-game');
  if (state.isGameRunning) {
    playBtn.disabled = true;
    if (stopBtn) stopBtn.style.display = 'flex';
  } else {
    playBtn.disabled = false;
    if (stopBtn) stopBtn.style.display = 'none';
  }
}

async function launchGame() {
  if (state.isGameRunning) {
    notify('Ya hay un juego en ejecución', 'error');
    return;
  }
  if (!state.activeProfileId) {
    notify('Crea y selecciona un perfil primero', 'error');
    return;
  }
  if (!state.selectedVersion) {
    notify('Selecciona una versión', 'error');
    return;
  }
  if (!state.installedVersions.includes(state.selectedVersion)) {
    notify('Instala la versión antes de jugar', 'error');
    return;
  }

  const profile = state.profiles.find(p => p.id === state.activeProfileId);
  if (!profile) {
    notify('Perfil no encontrado', 'error');
    return;
  }

  // Mod loaders: lanzar la versión compuesta si está instalada
  let versionToLaunch = state.selectedVersion;
  let modLoaderToUse = state.selectedModLoader;
  if (modLoaderToUse && modLoaderToUse !== 'vanilla' && !isCompositeVersion(versionToLaunch)) {
    const composite = findCompositeFor(modLoaderToUse, versionToLaunch);
    if (composite) {
      versionToLaunch = composite;
      notify(`Lanzando ${composite}`, 'info');
    } else {
      notify('El mod loader no está instalado para esta versión; se lanzará vanilla', 'error');
    }
    modLoaderToUse = null;
  }
  // Las versiones compuestas ya incluyen su loader
  if (isCompositeVersion(versionToLaunch)) {
    modLoaderToUse = null;
  }

  const memory = parseInt($('memory-slider').value);
  const jvmArgs = $('jvm-args').value;
  const javaPathRaw = $('java-path').value.trim();
  const javaPath = (javaPathRaw && javaPathRaw !== 'No detectada') ? javaPathRaw : null;

  state.isGameRunning = true;
  updateGameRunningUI();
  $('logs-modal').style.display = 'flex';
  $('logs-content').innerHTML = '';

  const result = await invoke('launch:start', {
    profile: profile,
    version: versionToLaunch,
    modLoader: modLoaderToUse,
    memory: memory,
    javaPath: javaPath,
    jvmArgs: jvmArgs
  });

  if (!result.success) {
    state.isGameRunning = false;
    updateGameRunningUI();
    notify('Error al lanzar: ' + result.error, 'error');
  } else {
    // Recordar la última versión jugada
    invoke('config:set', { defaultVersion: versionToLaunch });
  }
}

/**
 * Detiene el juego en ejecución
 */
async function stopGame() {
  const result = await invoke('launch:stop');
  if (result.success) {
    notify('Cerrando el juego...', 'info');
  } else {
    notify(result.error || 'No hay juego en ejecución', 'error');
  }
}

// ============= GESTIÓN DE VERSIONES INSTALADAS =============

/**
 * Abre el modal de gestión de versiones
 */
async function openVersionsManager() {
  $('versions-modal').style.display = 'flex';
  await renderInstalledVersions();
}

/**
 * Renderiza la lista de versiones instaladas con tamaño y botones de borrado
 */
async function renderInstalledVersions() {
  const container = $('installed-versions-list');
  container.innerHTML = '<p class="empty-state">Cargando...</p>';

  const result = await invoke('versions:list-installed');
  if (!result.success) {
    container.innerHTML = '<p class="empty-state">Error: ' + escapeHtml(result.error || 'desconocido') + '</p>';
    return;
  }

  const installed = result.installed || [];
  if (installed.length === 0) {
    container.innerHTML = '<p class="empty-state">No hay versiones instaladas.</p>';
    return;
  }

  container.innerHTML = installed.map(v => {
    const sizeText = v.onDisk
      ? '💾 ' + formatBytes(v.sizeBytes || 0)
      : '⚠️ no está en disco';
    const depsText = (v.dependents && v.dependents.length > 0)
      ? ' · requerida por: ' + escapeHtml(v.dependents.join(', '))
      : '';
    const fabricBadge = v.loader ? `<span class="badge-loader">${escapeHtml(v.loader)}</span>` : '';
    return `
      <div class="installed-version-item">
        <div class="version-item-info">
          <div class="version-item-name">${escapeHtml(v.id)}${fabricBadge}</div>
          <div class="version-item-size">${sizeText}${depsText}</div>
        </div>
        <button class="btn btn-secondary btn-delete-version" data-id="${escapeHtml(v.id)}">🗑 Eliminar</button>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.btn-delete-version').forEach(btn => {
    btn.addEventListener('click', () => deleteVersionFlow(btn.dataset.id));
  });
}

/**
 * Flujo de eliminación de una versión con confirmación
 */
async function deleteVersionFlow(versionId) {
  const confirmed = confirm(
    `¿Eliminar la versión "${versionId}"?\n\n` +
    'Se borra su carpeta (JAR, natives, metadata). ' +
    'Las librerías y assets compartidos NO se tocan.'
  );
  if (!confirmed) return;

  const result = await invoke('versions:delete', versionId);
  if (result.success) {
    notify(result.message, 'success');
    // Si era la versión seleccionada, deseleccionarla
    if (state.selectedVersion === versionId) {
      state.selectedVersion = null;
      $('current-version').textContent = '-';
      $('mods-list').innerHTML = '<p class="empty-state">Selecciona una versión para ver sus mods.</p>';
    }
    await Promise.all([renderInstalledVersions(), loadVersions()]);
  } else {
    notify('Error: ' + result.error, 'error');
  }
}

// ============= CONFIGURACIÓN =============
async function loadConfig() {
  const result = await invoke('config:get');
  if (result.success) {
    state.config = result.config;
    applyConfig();
  }
}

function applyConfig() {
  if (!state.config) return;
  $('memory-slider').value = state.config.memory || 4;
  $('memory-display').textContent = state.config.memory || 4;
  $('java-path').value = state.config.javaPath || 'No detectada';
  $('jvm-args').value = state.config.jvmArgs || '';
  $('minecraft-dir').value = state.config.minecraftDirectory || '';
  $('close-on-launch').checked = state.config.closeOnLaunch || false;
  $('show-logs').checked = state.config.showLogs !== false;
}

async function saveSettings() {
  const newConfig = {
    memory: parseInt($('memory-slider').value),
    javaPath: $('java-path').value === 'No detectada' ? null : $('java-path').value,
    jvmArgs: $('jvm-args').value,
    minecraftDirectory: $('minecraft-dir').value,
    closeOnLaunch: $('close-on-launch').checked,
    showLogs: $('show-logs').checked
  };

  const result = await invoke('config:set', newConfig);
  if (result.success) {
    state.config = result.config;
    notify('Configuración guardada', 'success');
    $('settings-modal').style.display = 'none';
  } else {
    notify('Error: ' + result.error, 'error');
  }
}

async function detectJava() {
  const result = await invoke('config:detect-java');
  if (result.success) {
    $('java-path').value = result.path;
    notify('Java detectado: ' + result.path, 'success');
  } else {
    notify(result.error, 'error');
  }
}

async function selectJava() {
  const result = await invoke('config:select-java');
  if (result.success) {
    $('java-path').value = result.path;
  }
}

async function selectMinecraftDir() {
  const result = await invoke('config:select-directory');
  if (result.success) {
    $('minecraft-dir').value = result.path;
  }
}

// ============= PROGRESO EN TIEMPO REAL =============
function handleInstallProgress(progress) {
  $('progress-container').style.display = 'block';
  $('progress-percent').textContent = (progress.percent || 0) + '%';
  $('progress-speed').textContent = progress.speed || '';
  $('progress-status').textContent = progress.status || '';
  $('progress-fill').style.width = (progress.percent || 0) + '%';
  
  if (progress.stage === 'completed' || progress.stage === 'error') {
    setTimeout(() => {
      $('progress-container').style.display = 'none';
    }, 3000);
  }
}

function handleLaunchLog(line) {
  // Detectar el fin del proceso del juego para restaurar la UI
  if (/Proceso terminado/i.test(line)) {
    state.isGameRunning = false;
    updateGameRunningUI();
  }

  const logLine = document.createElement('div');
  logLine.className = 'log-line';
  if (line.includes('[ERROR]')) logLine.classList.add('error');
  else if (line.includes('[INFO]')) logLine.classList.add('info');
  else if (line.includes('correctamente') || line.includes('completada')) logLine.classList.add('success');
  logLine.textContent = line;
  
  const logs = $('logs-content');
  logs.appendChild(logLine);
  if (state.autoScroll) {
    logs.scrollTop = logs.scrollHeight;
  }
}

// ============= AJUSTES DINÁMICOS DE LA UI =============

/**
 * Limita el slider de RAM según la RAM real del sistema
 * (máximo recomendado: 75% de la RAM, con tope de 16 GB)
 */
async function applyRamLimits() {
  const info = await invoke('config:system-info');
  if (!info.success || !info.totalMemoryGb) return;

  const totalGb = info.totalMemoryGb;
  let maxGb = Math.floor(totalGb * 0.75);
  if (maxGb > 16) maxGb = 16;
  if (maxGb < 2) maxGb = 2;

  const slider = $('memory-slider');
  slider.max = maxGb;
  $('mem-max-label').textContent = `${maxGb} GB`;

  // Ajustar el valor actual si se pasa del nuevo máximo
  let val = parseInt(slider.value) || 2;
  if (val > maxGb) {
    val = maxGb;
    slider.value = val;
    $('memory-display').textContent = val;
  }

  console.log(`[Renderer] RAM del sistema: ${totalGb} GB, slider limitado a ${maxGb} GB`);
}

/**
 * Restaura la última versión jugada (guardada en config.defaultVersion)
 */
function restoreLastVersion() {
  const last = state.config && state.config.defaultVersion;
  if (!last) return;

  const version = state.versions.find(v => v.id === last);
  if (!version) return;

  // Cambiar el filtro (Releases/Snapshots) si la versión está en el otro
  if (version.type && version.type !== state.selectedVersionType) {
    state.selectedVersionType = version.type;
    $('version-type').value = version.type;
    renderVersions();
  }

  state.selectedVersion = last;
  $('version-select').value = last;
  $('current-version').textContent = last;
  loadMods(last);
  console.log(`[Renderer] Última versión restaurada: ${last}`);
}

/**
 * Construye las noticias del ticker con datos reales del launcher
 */
function buildNewsItems() {
  const items = [];

  const profile = state.profiles.find(p => p.id === state.activeProfileId);
  if (profile) {
    items.push(`👋 ¡Hola de nuevo, ${profile.nickname}! Listo para jugar`);
  }

  if (state.installedVersions.length > 0) {
    items.push(`💾 ${state.installedVersions.length} versión(es) instaladas: ${state.installedVersions.join(', ')}`);
  }

  const latestRelease = state.versions.find(v => v.type === 'release');
  if (latestRelease) {
    items.push(`🆕 Última release de Mojang: ${latestRelease.id}`);
  }

  const latestSnapshot = state.versions.find(v => v.type === 'snapshot');
  if (latestSnapshot) {
    items.push(`🧪 Último snapshot disponible: ${latestSnapshot.id}`);
  }

  items.push('🧩 Añade soporte de mods instalando Fabric para tu versión favorita');
  items.push('🔒 Autenticación offline - Sin cuenta Mojang requerida');

  if (items.length > 0) {
    state.newsItems = items;
    $('news-text').textContent = items[0];
  }
}

// ============= NOTICIAS =============
function startNewsTicker() {
  let currentIndex = 0;
  const newsEl = $('news-text');
  setInterval(() => {
    currentIndex = (currentIndex + 1) % state.newsItems.length;
    newsEl.textContent = state.newsItems[currentIndex];
    // Reiniciar animación
    newsEl.style.animation = 'none';
    setTimeout(() => {
      newsEl.style.animation = 'ticker 30s linear infinite';
    }, 50);
  }, 8000);
}

// ============= UTILIDADES =============
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ============= EVENT LISTENERS =============
function setupEventListeners() {
  // Botones de header
  $('btn-settings').addEventListener('click', () => {
    $('settings-modal').style.display = 'flex';
  });
  $('btn-close').addEventListener('click', () => {
    if (confirm('¿Cerrar el launcher?')) window.close();
  });
  $('btn-minimize').addEventListener('click', () => {
    // La función de minimizar requiere acceso a la ventana de Electron
    if (window.electronAPI && window.electronAPI.minimize) {
      window.electronAPI.minimize();
    }
  });

  // Perfiles
  $('btn-new-profile').addEventListener('click', () => {
    $('new-profile-form').style.display = 'block';
    $('nickname-input').focus();
  });
  $('btn-save-profile').addEventListener('click', () => {
    const nick = $('nickname-input').value.trim();
    if (nick) createProfile(nick);
  });
  $('btn-cancel-profile').addEventListener('click', () => {
    $('new-profile-form').style.display = 'none';
    $('nickname-input').value = '';
  });
  $('nickname-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') $('btn-save-profile').click();
  });

  // Exportar / Importar perfiles
  $('btn-export-profile').addEventListener('click', exportProfiles);
  $('btn-import-profile').addEventListener('click', showImportModal);
  $('btn-do-import').addEventListener('click', doImport);
  $('btn-close-import').addEventListener('click', () => {
    $('import-modal').style.display = 'none';
  });

  // Refresh de versiones
  $('btn-refresh-versions').addEventListener('click', refreshVersions);

  // Gestión de versiones instaladas
  $('btn-manage-versions').addEventListener('click', openVersionsManager);
  $('btn-close-versions').addEventListener('click', () => {
    $('versions-modal').style.display = 'none';
  });

  // Versiones
  $('version-type').addEventListener('change', (e) => {
    state.selectedVersionType = e.target.value;
    renderVersions();
  });
  $('version-select').addEventListener('change', (e) => {
    state.selectedVersion = e.target.value;
    $('current-version').textContent = e.target.value || '-';
    loadMods(e.target.value);
  });
  $('btn-install').addEventListener('click', installVersion);

  // Mod loaders
  document.querySelectorAll('.loader-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.loader-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedModLoader = btn.dataset.loader;
    });
  });

  // Configuración
  $('memory-slider').addEventListener('input', (e) => {
    $('memory-display').textContent = e.target.value;
  });
  $('btn-select-java').addEventListener('click', selectJava);
  $('btn-detect-java').addEventListener('click', detectJava);

  // Mods
  $('btn-add-mod').addEventListener('click', addMod);

  // Botones de juego
  $('btn-play').addEventListener('click', launchGame);
  $('btn-stop-game').addEventListener('click', stopGame);

  // Modales
  $('btn-close-logs').addEventListener('click', () => {
    $('logs-modal').style.display = 'none';
  });

  // Toolbar del modal de logs
  document.querySelectorAll('.log-filter-btn[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.log-filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.logFilter = btn.dataset.filter;
      const logs = $('logs-content');
      logs.className = 'logs-content' + (state.logFilter !== 'all' ? ' filter-' + state.logFilter : '');
    });
  });

  $('btn-clear-logs').addEventListener('click', () => {
    $('logs-content').innerHTML = '';
  });

  $('chk-autoscroll').addEventListener('change', (e) => {
    state.autoScroll = e.target.checked;
  });
  $('btn-close-settings').addEventListener('click', () => {
    $('settings-modal').style.display = 'none';
  });
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-select-dir').addEventListener('click', selectMinecraftDir);

  // Cerrar modales al hacer clic fuera
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
      }
    });
  });
}

// ============= INICIALIZACIÓN =============
async function init() {
  try {
    console.log('[Renderer] Inicializando UI...');
    
    setupEventListeners();
    
    // Suscribirse a eventos del main process
    on('versions:install-progress', handleInstallProgress);
    on('launch:log', handleLaunchLog);
    
    // Cargar datos iniciales en paralelo
    await Promise.all([
      loadProfiles(),
      loadVersions(),
      loadConfig()
    ]);

    // Ajustes que dependen de los datos cargados
    await applyRamLimits();
    restoreLastVersion();
    buildNewsItems();

    // Iniciar ticker de noticias
    startNewsTicker();
    
    console.log('[Renderer] UI inicializada correctamente');
  } catch (err) {
    console.error('[Renderer] Error en inicialización:', err);
    notify('Error al inicializar la interfaz', 'error');
  }
}

// Iniciar cuando el DOM esté listo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
