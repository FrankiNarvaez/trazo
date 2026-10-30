# Trazo

Dibuja y anota sobre cualquier pantalla, en **macOS y Windows**. Una barra compacta que se pega al borde que elijas (vertical u horizontal), lápiz con presión, resaltador, puntero láser, flechas y formas, números, cualquier color, y un modo puntero que deja tus trazos visibles mientras sigues usando las apps de abajo.

## Qué hace

| Función | Detalle |
|---|---|
| Barra acoplable | Vertical a la derecha por defecto. Arrástrala por el asa a donde quieras; ⋯ → Posición la pega a cualquier borde (vertical en los laterales, horizontal arriba y abajo) |
| Barra contraíble | Un clic en el asa la reduce a un botón de "dibujar / soltar" |
| Lápiz y resaltador | Trazos suaves que se afinan con la velocidad; presión real con tableta o lápiz digital |
| Puntero láser | Estela brillante que sigue al ratón y se desvanece sola; nunca queda como tinta |
| Formas | Al elegir Formas se despliegan flecha, rectángulo, elipse y línea; al cambiar de herramienta se pliegan. Mayús: ángulos de 15°, cuadrados y círculos |
| Texto | Clic para escribir con el color y el tamaño elegidos; si los cambias mientras escribes, el texto los toma. Enter guarda, ⌘Enter (Ctrl+Enter en Windows) pasa a otra línea, Esc o Deshacer cancelan y un clic fuera también guarda. Clic en un texto para editarlo; deshacer devuelve la versión anterior |
| Números | Cada clic pone el siguiente: 1, 2, 3… con el color y el tamaño elegidos. El botón muestra qué número sigue; deshacer lo devuelve y borrar todo vuelve a 1 |
| Recolorear | Toca o arrastra sobre un trazo, una forma o un número para darle el color elegido. Solo cambia lo que está encima (la tinta, no el resaltado de abajo) y se deshace en un paso |
| Tamaño libre | Clic derecho en una herramienta abre sus ajustes: un deslizador para elegir el tamaño exacto, que cada herramienta recuerda. El botón de grosor o [ ] vuelven a fino, medio y grueso |
| Colores | Doble clic o clic derecho en un color de la paleta para cambiarlo: queda guardado y sigue en su tecla. El arcoíris abre el mismo panel para usar cualquier color. ⋯ → Restablecer colores vuelve a los originales |
| Borrador | Quita trazos completos; el borrador trasero de un lápiz digital también borra |
| Modo puntero | Los trazos quedan a la vista y los clics pasan a las apps de abajo |
| Varios monitores | Un lienzo por pantalla; deshacer sigue el orden real entre pantallas |
| Presentaciones | Funciona sobre la barra de menús, el Dock y apps en pantalla completa en macOS |
| Compartir pantalla | Opción para ocultar la barra en capturas y en Zoom/Meet/Teams |

## Atajos

| Tecla | Acción |
|---|---|
| ⌃⌥D (Ctrl+Alt+D en Windows) | Dibujar / soltar, desde cualquier app |
| Esc | Cerrar el panel de color o cancelar el texto que escribes; si no hay nada abierto, volver al modo puntero |
| V · P · H · L · T · N · C · E | Puntero · lápiz · resaltador · láser · texto · números · recolorear · borrador |
| A · R · O · S | Flecha · rectángulo · elipse · siguiente forma |
| 1 a 6 | Los seis colores de la paleta (al principio rojo, amarillo, verde, azul, negro y blanco) |
| [ · ] | Más fino · más grueso |
| ⌘Z · ⇧⌘Z (Ctrl en Windows) | Deshacer · rehacer |
| ⌫ / Supr | Borrar todo (se puede deshacer) |

Las teclas de herramienta funcionan mientras dibujas. El icono de la barra de menús (bandeja del sistema en Windows) también permite dibujar, ocultar la barra o los trazos, borrar y salir.

## Instaladores

Cada cambio en `main` compila Trazo en GitHub Actions y publica los instaladores como artefactos. En la pestaña **Actions**, filtra por la rama `main`, abre la última ejecución de **build** y baja sus artefactos:

| Artefacto | Contenido |
|---|---|
| `trazo-macos` | `.dmg` universal (Apple Silicon e Intel) |
| `trazo-windows` | Instalador `.msi` y `-setup.exe` |

Los pull requests también se compilan, para comprobarlos, pero nunca publican instaladores: solo el código que llegó a `main` termina en algo descargable. Las actions del workflow están fijadas a un commit exacto (SHA), así que nadie puede cambiar en silencio lo que arma los instaladores.

Los instaladores no llevan firma de desarrollador:

- **macOS:** abre el `.dmg` y arrastra **Trazo** a **Aplicaciones**. Al abrir Trazo, macOS avisará que no puede verificarlo: pulsa **OK**. Luego, en **Ajustes del Sistema → Privacidad y seguridad**, baja hasta el aviso de Trazo y pulsa **Abrir igualmente**.
- **Windows:** si SmartScreen avisa, Más información → Ejecutar de todas formas.

## Desarrollo

Requisitos: [Rust](https://rustup.rs), Node 20+ y pnpm. En macOS bastan las Command Line Tools de Xcode.

```bash
pnpm install
```

```bash
pnpm tauri dev
```

Para generar el instalador (`.app` y `.dmg` en macOS, `.msi`/`.exe` en Windows):

```bash
pnpm tauri build
```

Comprobaciones rápidas:

```bash
pnpm typecheck
```

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

**Vista previa sin compilar Rust.** Con `pnpm dev` corriendo, abre `http://localhost:1420/dev/index.html`: un escritorio falso donde el lienzo y la barra viven en iframes y `dev/fake-tauri.ts` hace de backend. Sirve para iterar la interfaz y el dibujo en segundos.

**Depurar con herramientas de automatización.** Trazo no tiene icono en el Dock, y algunas herramientas solo ven apps normales. En builds de depuración, `TRAZO_DOCK=1` lo mantiene en el Dock.

## Cómo está hecho

| Parte | Archivos |
|---|---|
| Ventanas, monitores y foco (Rust) | `src-tauri/src/overlay.rs`, `focus.rs`, `macos.rs` |
| Atajo global y bandeja (Rust) | `src-tauri/src/shortcuts.rs`, `tray.rs` |
| Barra: estado, acoplamiento, vista, menú | `src/toolbar/` |
| Panel de color | `src/panel/` |
| Lienzo: trazos, historial, láser, cursor | `src/canvas/` |
| Mensajes entre ventanas | `src/shared/protocol.ts` |

## Documentación

| Documento | Contenido |
|---|---|
| [Diseño](implementation/trazo-diseno.md) | Cada decisión técnica y el fallo que evita |
| [Cambios](CHANGELOG.md) | Historial de versiones |

## Licencia

MIT. Ver [LICENSE](LICENSE).
