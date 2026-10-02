# 🎮 ADLauncher - Minecraft Launcher

Launcher de Minecraft offline construido con **Node.js** y **Electron**, usando `adlauncher-core` como motor principal. Soporta autenticación offline, múltiples perfiles, gestión de versiones (vanilla, Forge, Fabric, OptiFine), instalador de mods y una interfaz oscura inspirada en TLauncher.

## ✨ Características

- 🔒 **Autenticación offline** con UUID v4 persistente por perfil
- 👥 **Múltiples perfiles** guardados en JSON local
- 📤 **Exportar / Importar perfiles** entre dispositivos con un solo click
- 🌐 **API de Mojang** integrada para listar versiones oficiales (con caché de 6h)
- 📦 **Gestión de versiones**: vanilla, Forge, Fabric, OptiFine
- 📊 **Barra de progreso** con porcentaje y velocidad de descarga
- 🧩 **Gestor de mods** por versión (.jar) con activar/desactivar
- ⚙️ **Configuración completa**: RAM 2-8 GB, ruta de Java, argumentos JVM
- 📋 **Log de sesión** en tiempo real para debugging
- 🌙 **Interfaz oscura** de 3 paneles (perfiles | juego | mods)
- 📰 **Barra de noticias** inferior con ticker animado

## 📋 Requisitos

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- **Java** 8 o superior instalado en el sistema

## 🚀 Instalación

```bash
# Clonar o descargar el proyecto
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
├── main.js                      # Entry point de Electron
├── package.json                 # Dependencias y scripts
├── src/
│   ├── auth/
│   │   └── authManager.js       # Auth offline + perfiles
│   ├── versions/
│   │   └── versionManager.js    # Lista, descarga, lanzamiento
│   ├── mods/
│   │   └── modManager.js        # Gestión de mods .jar
│   └── ui/
│       ├── configManager.js     # Configuración persistente
│       └── preload.js           # Bridge seguro IPC
├── ui/
│   ├── html/
│   │   └── index.html           # Layout principal
│   ├── css/
│   │   └── styles.css           # Tema oscuro
│   └── js/
│       └── renderer.js          # Lógica de UI
├── assets/
│   ├── icons/                   # Iconos de la app
│   └── images/                  # Otros recursos
└── config/                      # Archivos generados automáticamente
    ├── profiles.json
    ├── launcher.json
    ├── installed_versions.json
    └── mods_state.json
```

## 🎯 Uso

### 1. Crear un perfil

1. Click en **"+"** junto a "Perfiles" en el panel izquierdo
2. Ingresa un nickname (3-16 caracteres, solo letras, números y `_`)
3. Click en **"Guardar"**
4. Se generará un UUID v4 persistente para ese perfil

### 1b. Exportar / Importar perfiles

- **Exportar (📤)**: Guarda todos tus perfiles en un archivo JSON portable
- **Importar (📥)**: Carga perfiles desde un archivo. Opciones:
  - *Sobrescribir*: reemplaza perfiles con el mismo nickname
  - *Reemplazar todo*: ⚠️ elimina todos los perfiles actuales

### 1c. Actualizar versiones desde Mojang

Click en el botón **🔄** del panel central para forzar la actualización
desde `launchermeta.mojang.com`. Por defecto usa caché de 6 horas.

### 2. Instalar una versión

1. Selecciona el tipo (Releases / Snapshots)
2. Elige la versión del dropdown
3. Opcionalmente selecciona un mod loader (Forge / Fabric / OptiFine)
4. Click en **"Instalar / Descargar Versión"**
5. Espera a que la barra de progreso llegue a 100%

### 3. Añadir mods

1. Selecciona una versión instalada
2. Click en **"+"** junto a "Mods" en el panel derecho
3. Selecciona el archivo `.jar` del mod
4. Usa el toggle para activar/desactivar
5. Click en 🗑 para eliminar

### 4. Jugar

1. Asegúrate de tener un perfil activo y una versión instalada
2. Ajusta la RAM con el slider (2-8 GB)
3. Configura la ruta de Java (o usa detección automática)
4. (Opcional) Modifica los argumentos JVM
5. Click en **"▶ JUGAR"**

## ⚙️ Configuración

Toda la configuración se guarda en `./config/launcher.json`:

```json
{
  "memory": 4,
  "javaPath": "/usr/bin/java",
  "jvmArgs": "-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC",
  "minecraftDirectory": "./.minecraft",
  "closeOnLaunch": false,
  "showLogs": true,
  "theme": "dark"
}
```

Los perfiles se guardan en `./config/profiles.json`:

```json
{
  "profiles": [
    {
      "id": "uuid-del-perfil",
      "nickname": "Steve",
      "uuid": "uuid-v4-persistente",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "lastUsed": "2024-01-20T15:45:00.000Z",
      "isActive": true
    }
  ],
  "activeProfileId": "uuid-del-perfil"
}
```

### Formato de Export

Cuando exportas perfiles se genera un JSON con metadata:

```json
{
  "schemaVersion": "1.0.0",
  "app": "ADLauncher",
  "exportType": "all",
  "exportedAt": "2024-01-20T16:00:00.000Z",
  "profiles": [...],
  "activeProfileId": "uuid-del-perfil",
  "stats": { "totalProfiles": 1, "totalInLauncher": 1 }
}
```

Esto te permite transferir tus perfiles entre computadoras, hacer backups
o compartir setups con amigos.

## 🔌 Lanzamiento Manual (sin dependencias externas)

A partir de la versión 1.0.0, el launcher incluye su propio motor de instalación
y lanzamiento nativo (`src/versions/manualLauncher.js`), lo que significa que
**NO requiere `adlauncher-core`** para funcionar. Descarga e instala Minecraft
directamente desde los servidores oficiales de Mojang.

### ¿Qué hace el ManualLauncher?

1. Descarga el `version.json` desde `launchermeta.mojang.com`
2. Descarga las **librerías** (.jar) desde los repositorios Maven
3. Descarga los **assets** (texturas, sonidos) desde `resources.download.minecraft.net`
4. Descarga el **JAR del cliente**
5. Descarga y extrae los **natives** (.so / .dll / .dylib)
6. Construye el classpath y los argumentos JVM correctamente
7. Hace `spawn` del proceso `java` con todo configurado

### Compatibilidad con `adlauncher-core`

Si tienes `adlauncher-core` instalado, el launcher lo usa automáticamente.
Si no, usa el `ManualLauncher` nativo. La API es transparente para el usuario.

### Auth offline

El launcher usa autenticación **offline** (como TLauncher):
- `user_type: 'offline'`
- `access_token: '0'` (fake, no se valida)
- UUID v4 generado localmente
- Sin contacto con `sessionserver.mojang.com`

Esto te permite jugar Minecraft en modo singleplayer sin cuenta premium.

### Test verificado

En pruebas reales, el ManualLauncher descargó e instaló **Minecraft 1.8.9 completo**:
- 88 librerías detectadas en version.json
- 35 librerías descargadas
- 722 assets descargados
- JAR del cliente (5.4 MB)
- Natives extraídos correctamente
- Classpath construido con todas las entradas
- Args JVM generados con todos los flags estándar de Minecraft

## 🐛 Debugging

Los logs de sesión se muestran en tiempo real al lanzar el juego. Para activar logs adicionales, ejecuta en modo desarrollo:

```bash
npm run dev
```

Esto abrirá DevTools (F12) donde puedes inspeccionar la consola.

## 📝 Notas

- **Autenticación offline**: No requiere cuenta Mojang/Microsoft. Los perfiles se generan localmente con UUID v4.
- **Mods**: Los mods desactivados se renombran a `.jar.disabled`, técnica estándar y reversible.
- **Java**: Si no detecta Java automáticamente, puedes configurarlo manualmente en ⚙️ Configuración.
- **Multiplataforma**: Funciona en Windows, macOS y Linux.

## 📄 Licencia

MIT

## 🤝 Contribuciones

Las contribuciones son bienvenidas. Por favor abre un issue primero para discutir los cambios.

---

Hecho con ❤️ por la comunidad Minecraft offline
