# Assets

Este directorio contiene los recursos gráficos del launcher.

## Iconos necesarios

Para que el launcher funcione completamente, necesitas colocar los siguientes
archivos en `assets/icons/`:

- `app-icon.png` - Icono principal de la aplicación (256x256 px recomendado)
- `app-icon.ico` - Icono para Windows (256x256 px)
- `app-icon.icns` - Icono para macOS

## Cómo crear los iconos

Puedes generar los iconos a partir de una imagen PNG usando:

```bash
# Para Windows (.ico)
npx png-to-ico assets/icons/app-icon.png > assets/icons/app-icon.ico

# Para macOS (.icns)
npx png2icns assets/icons/app-icon.icns assets/icons/app-icon.png
```

## Placeholder

Si no tienes iconos, el launcher seguirá funcionando pero mostrará
un placeholder. Puedes usar cualquier imagen PNG cuadrada.

## Imágenes

El directorio `assets/images/` está reservado para:
- Fondos de pantalla
- Imágenes de fondo de mods
- Imágenes de versiones
- Banners de noticias

## Notas

- Los iconos son opcionales al inicio, el launcher funcionará sin ellos
- Usa formato PNG con transparencia para mejores resultados
- Recomendado: 256x256 o 512x512 px para iconos de alta resolución
