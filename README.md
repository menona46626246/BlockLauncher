# 🎮 ADLauncher - Minecraft Launcher

Launcher de Minecraft offline construido con **Node.js** y **Electron**. Motor de instalación y lanzamiento 100% nativo (sin `adlauncher-core` obligatorio): descarga, instala y ejecuta Minecraft directamente desde los servidores oficiales de Mojang, con soporte para **Fabric, Forge y NeoForge**.

## ✨ Características

- 🔒 **Autenticación offline** con UUID v4 persistente por perfil
- 👥 **Múltiples perfiles** guardados en JSON local, con exportar/importar
- 📦 **Instalación completa desde Mojang**: version.json, librerías, assets, natives y JAR del cliente
- 🧩 **Tres mod loaders**: Fabric (meta.fabricmc.net), Forge y NeoForge (installers oficiales en modo headless)
- ☕ **Java autogestionado**: detecta el Java del sistema, verifica su versión contra la que exige cada versión de Minecraft y **descarga automáticamente un JRE de Eclipse Temurin** (Adoptium) si no es compatible
- 🗂️ **Gestión de versiones**: elimina versiones con su tamaño en disco, protección de dependencias (no puedes borrar la base de un Fabric/Forge) y sincronización con el disco
- 🧩 **Gestor de mods** en la carpeta estándar `.minecraft/mods` con activar/desactivar (`.jar.disabled`)
- ⏹ **Control del juego**: indicador de partida en curso y botón para detener el proceso
- 📊 Barra de progreso con porcentaje y estado real (descarga vs verificación)
- 📋 **Log de sesión** en tiempo real, con salida log4j parseada a líneas legibles, filtros por nivel, limpiar y auto-scroll
- ⚙️ **Configuración completa**: RAM limitada al 75% de la RAM real del sistema (tope 16 GB), ruta de Java, argumentos JVM, directorio de Minecraft
- 🕹️ Recordar la última versión jugada y restaurarla al abrir el launcher
- 🌙 **Interfaz oscura** de 3 paneles (perfiles | juego | mods) con botones funcionales de ventana
- 📰 Ticker de noticias construido con datos reales (perfil, versiones instaladas, últimas releases de Mojang)
- 🛡️ **Electron endurecido**: `contextIsolation`, sandbox, whitelist de canales IPC en el preload, CSP estricta y navegación externa bloqueada

## 📋 Requisitos

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- **Java**: opcional. Si no tienes uno compatible, el launcher descarga Eclipse Temurin automáticamente (lo cachea en `.minecraft/jdk/`)

## 🚀 Instalación

```bash
cd minecraft-launcher

# Instalar dependencias
npm install

# Iniciar el launcher
npm start

# Modo desarrollo (con DevTools abierto)
npm run dev
```

## 📁 Estructura del Proyecto

```
minecraft-launcher/
├── main.js                          # Entry point de Electron + handlers IPC
├── package.json                     # Dependencias y scripts
├── src/
│   ├── auth/
│   │   └── authManager.js           # Auth offline + perfiles + export/import
│   ├── versions/
│   │   ├── versionManager.js        # Lista de versiones, instalación, lanzamiento
│   │   ├── manualLauncher.js        # Motor nativo: descarga, args y spawn de java
│   │   └── javaRuntime.js           # Versiones de Java + descarga de Temurin
│   ├── mods/
│   │   └── modManager.js            # Gestión de mods .jar
│   └── ui/
│       ├── configManager.js         # Configuración persistente
│       └── preload.js               # Bridge IPC seguro (whitelist de canales)
├── ui/
│   ├── html/index.html              # Layout principal
│   ├── css/styles.css               # Tema oscuro
│   └── js/renderer.js               # Lógica de UI
├── assets/icons/                    # Iconos de la app
└── config/                          # Archivos generados automáticamente
    ├── profiles.json
    ├── launcher.json
    ├── installed_versions.json
    └── mods_state.json
```

## 🎯 Uso

### 1. Crear un perfil

1. Click en **"+"** junto a "Perfiles" en el panel izquierdo
2. Ingresa un nickname (3-16 caracteres, solo letras, números y `_`)
3. Se generará un UUID v4 persistente para ese perfil
4. Con **📤 / 📥** puedes exportar e importar perfiles entre dispositivos

### 2. Instalar una versión

1. Elige la versión del dropdown (Releases / Snapshots) y el botón **🔄** fuerza la actualización desde Mojang
2. Opcionalmente elige un mod loader: **Vanilla / Forge / Fabric / NeoForge**
3. Click en **"📥 Instalar / Descargar Versión"**
4. Con un loader seleccionado se crea una **versión compuesta** que hereda de la vanilla:
   - Fabric → `26.3-fabric`
   - Forge → `26.3-forge-66.0.9`
   - NeoForge → `neoforge-26.3.0.39-beta`
5. La compuesta aparece en el dropdown con ✓ y queda seleccionada automáticamente

### 3. Añadir mods

1. Selecciona una versión con loader instalado
2. Click en **"+"** junto a "Mods" en el panel derecho
3. Selecciona el archivo `.jar` del mod → se copia a `.minecraft/mods`
4. Usa el toggle para activar/desactivar, 🗑 para eliminar
5. Vanilla ignora los mods: solo Fabric/Forge/NeoForge los cargan

### 4. Jugar

1. Asegúrate de tener un perfil activo y una versión instalada
2. Ajusta la RAM con el slider (limitado al 75% de tu RAM real)
3. Si tu Java no es compatible con la versión, el launcher descarga uno que sí lo sea
4. Click en **"▶ JUGAR"** — aparece el botón **⏹ DETENER** mientras el juego corre
5. El launcher recuerda la última versión jugada y la restaura al abrir

### 5. Gestionar versiones instaladas

Click en **🗂️** en el panel central:
- Tamaño en disco real de cada versión (JAR + natives + metadata)
- Badge del loader de cada compuesta (Fabric/Forge/NeoForge)
- **Eliminar** versión con confirmación; las librerías y assets compartidos no se tocan
- Bloqueo automático: no puedes borrar una versión de la que depende otra (la base de un loader), ni borrar nada con el juego en ejecución
- La lista se sincroniza automáticamente con el contenido real de `versions/`

## ⚙️ Configuración

Toda la configuración se guarda en `./config/launcher.json`:

```json
{
  "memory": 4,
  "javaPath": "C:\\...\\java.exe",
  "jvmArgs": "-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC",
  "minecraftDirectory": "./.minecraft",
  "defaultVersion": "26.3",
  "defaultModLoader": "vanilla",
  "closeOnLaunch": false,
  "showLogs": true,
  "theme": "dark",
  "enableNews": true,
  "lastUpdated": null
}
```

- `memory`: 2-16 GB (el slider se limita a tu RAM real)
- `defaultVersion`: la última versión jugada; se restaura al abrir el launcher
- `closeOnLaunch`: si es `true`, el launcher se cierra 1 segundo después de arrancar el juego
- `javaPath`: si no sirve para la versión elegida (p.ej. Java 8 para la 26.3), se ignora y se usa/descarga un Java compatible

Los perfiles se guardan en `./config/profiles.json`:

```json
{
  "profiles": [
    {
      "id": "uuid-del-perfil",
      "nickname": "Steve",
      "uuid": "uuid-v4-persistente",
      "createdAt": "2026-01-15T10:30:00.000Z",
      "lastUsed": "2026-01-20T15:45:00.000Z",
      "isActive": true
    }
  ],
  "activeProfileId": "uuid-del-perfil"
}
```

### Formato de Export de perfiles

```json
{
  "schemaVersion": "1.0.0",
  "app": "ADLauncher",
  "exportType": "all",
  "exportedAt": "2026-01-20T16:00:00.000Z",
  "profiles": [...],
  "activeProfileId": "uuid-del-perfil",
  "stats": { "totalProfiles": 1, "totalInLauncher": 1 }
}
```

## 🔌 Cómo funciona el motor nativo

El `ManualLauncher` (`src/versions/manualLauncher.js`) implementa desde cero lo que hacen TLauncher, Prism o el launcher oficial:

1. **Descarga e instala**: version.json desde `launchermeta.mojang.com` → librerías Maven → assets (`resources.download.minecraft.net`) → JAR del cliente → natives extraídos con `adm-zip` a los subdirectorios oficiales (`natives/{java,jna,lwjgl,netty}`, con filtro por arquitectura)
2. **Resuelve `inheritsFrom`**: las versiones compuestas de Fabric/Forge/NeoForge se fusionan con su base vanilla (librerías y argumentos se concatenan, el resto pisa el padre)
3. **Construye los argumentos JVM según el spec oficial**: evalúa `arguments.jvm` / `arguments.game` con sus `rules` (OS, arquitectura, features) e interpola todos los tokens (`${classpath}`, `${natives_directory}`, `${library_directory}`, `${assets_root}`…)
4. **Gestiona Java**: lee `javaVersion.majorVersion` del version.json, verifica el Java configurado con `java -version` (con caché por ruta) y descarga un JRE de **Eclipse Temurin** vía la API de Adoptium si no es compatible. Se cachea en `.minecraft/jdk/temurin-<major>/`
5. **Auto-reparación**: antes de lanzar, descarga cualquier librería o índice de assets que falte
6. **Auth offline**: `user_type: 'offline'`, token fake, UUID local, sin contacto con `sessionserver.mojang.com`
7. **Log4j**: descarga el config de log del cliente y parsea su salida XML a líneas `[INFO]/[WARN]/[ERROR]` legibles

### Mod loaders

| Loader | Fuente | Versión compuesta | Método |
|--------|--------|-------------------|--------|
| Fabric | `meta.fabricmc.net` | `<mc>-fabric` | Profile JSON directo |
| Forge | `maven.minecraftforge.net` | `<mc>-forge-<build>` | Installer oficial headless |
| NeoForge | `maven.neoforged.net` | `neoforge-<versión>` | Installer oficial headless |

Los installers de Forge/NeoForge se ejecutan con el mismo Java que correrá el juego (`java -jar installer.jar --installClient .minecraft`), lo que garantiza procesado de binpatches idéntico al oficial. Los errores de Realms/propiedades de usuario en el log (HTTP 401) son normales en modo offline.

## 🗑️ Notas sobre versiones y mods

- **Los natives se extraen una sola vez** por versión (marcador `.natives-extracted`); si borras la carpeta, se auto-repara al siguiente lanzamiento
- **Mods**: carpeta estándar `<gameDir>/mods`, compartida entre versiones; el estado se guarda en `config/mods_state.json` (lista plana con migración automática del formato antiguo)
- **Sin conexión**: el dropdown muestra la lista de respaldo + tus versiones instaladas/compuestas
- **Multiplataforma**: Windows, macOS y Linux (natives y arquitecturas ARM64 se manejan por `rules`)

## 🐛 Debugging

Los logs de la sesión se muestran en tiempo real al lanzar el juego, con filtros por nivel. Para DevTools:

```bash
npm run dev
```

## 🔒 Seguridad

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- El preload expone solo canales IPC con **whitelist** (24 canales `invoke` + 2 de escucha)
- CSP estricta: `script-src 'self'` (sin scripts inline)
- Navegación externa y ventanas emergentes bloqueadas
- Extracción de ZIP con protección contra path traversal

## 📄 Licencia

MIT

## 🤝 Contribuciones

Las contribuciones son bienvenidas. Por favor abre un issue primero para discutir los cambios.

---

Hecho con ❤️ por la comunidad Minecraft offline
