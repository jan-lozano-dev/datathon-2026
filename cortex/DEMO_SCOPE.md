# Alcance de la demo: práctica M3Kang

Esta rama (`demo/m3kang-practice`) convierte LearnHarness en una web de práctica de matemáticas sencilla y offline. El alumno resuelve problemas del Canguro (M3Kang) con un entrenador adaptativo, puede abrir una explicación después de cada respuesta y repasa flashcards. Ningún paso necesita un modelo de lenguaje.

## Recorrido principal

1. **Iniciar o reanudar**: la app abre directamente en el problema del único perfil local (`local`), sin portada ni nombre (decisión del usuario, 15/11). Los problemas salen en inglés.
2. **Ver el problema**: enunciado en Markdown con fórmulas (KaTeX) y su figura, si la tiene.
3. **Elegir una sola letra A–E.**
4. **Indicar la confianza** con el control de siempre (0, 30, 50, 70, 90 o 100 %).
5. **Enviar** respuesta y confianza.
6. **Ver el resultado** (acierto o fallo) y el progreso. Un botón **Explain** muestra entonces una explicación breve escrita a mano, que sí da la solución.
7. **Continuar** con el problema que elige el entrenador.

La corrección y la elección del siguiente problema ocurren en el servidor, sin llamar a ningún modelo.

## Qué se conserva

| Pieza | Cómo queda |
|---|---|
| Test M3Kang | Página principal (`/`). Una sola letra A–E y opciones en su orden original, sin barajar. |
| Entrenador | `copilot/teach/trainer.py` del equipo, **sin modificar**. Lo importa `practice/bridge.py` (solo librería estándar), que añade la sesión, la confianza, los saltos y la idempotencia. |
| Confianza | El deslizador existente, en forma compacta. Se guarda en el mismo intento y en la misma transacción que la respuesta (tabla `lh_attempts`, enlazada con `attempts.n` del entrenador). **No entra en la estimación del nivel**: la fórmula sigue siendo la del entrenador. |
| Perfil e historial | SQLite en `<datos>/practice.db`: alumnos, intentos, confianza, saltos y el problema mostrado. Bastan para reanudar, estimar el nivel y no repetir problemas (tampoco el mismo `id` en otro idioma ni sus gemelos de otro nivel). |
| Imágenes | Desde la carpeta local `<datos>/m3kang/images/<id>_<idioma>.png`, con rutas validadas y sin red. |
| Fórmulas | Markdown con KaTeX y fuentes locales, igual que antes. El renderizado de Mermaid dentro del Markdown se conserva en modo solo lectura, aunque no se ha probado en el navegador. |
| Plan de aprendizaje | **Retirado a petición del usuario** (15/11). Hubo una primera versión con un mapa fijo de los niveles 0→7 dibujado con el diagrama del plan, pero no gustó. El nivel estimado sigue visible en la barra de progreso. |
| Explicaciones | Una explicación estática por problema, en Markdown con KaTeX, en `<datos>/explanations.json` (sus 50 ids cubren el banco demo, en inglés). El puente solo la envía en el resultado de una respuesta, nunca antes, y la interfaz la oculta tras el botón **Explain**. No interviene ningún modelo. |
| Flashcards | Plugin incorporado: mazos, creación manual, revisión FSRS-6, práctica sin calificación, estadísticas y progreso local. Se retiraron la generación desde el grafo y desde documentos. Las tarjetas que ya se generaron siguen activas y se pueden repasar. El mazo **Kangaroo toolkit** (20 tarjetas propias de fórmulas y técnicas, en `practice/decks/`) se carga con `npm run seed:flashcards`, y repetirlo no duplica tarjetas. |
| Host de plugins | Mínimo y solo para plugins incorporados (las flashcards): vistas, ajustes, widgets de UI, `call` y notificaciones. |
| Seguridad del API | Comprobación de host contra DNS rebinding y bloqueo de escrituras cross-site (`proxy.ts`). |
| Logs y errores | Mensajes claros de carga, error y reintento en la página. El servidor registra los fallos del puente y del plugin. |

## Qué se ha eliminado

Para cada función se han eliminado sus pantallas y también sus rutas, herramientas, agentes, trabajos, servicios, dependencias y tests. Los archivos se borraron por alcanzabilidad de los imports desde las entradas que se conservan (`scripts/reachability.mjs`), no por el nombre de la carpeta.

| Área | Eliminado |
|---|---|
| Diagnóstico inicial | Agente Prober y sus transiciones. |
| Tutor generativo | Agente profesor, prompts, lecciones y explicaciones generadas, y `plan_init`. |
| Práctica generativa | Problemas y soluciones del modelo, `conclude` y sus flujos de intentos. |
| Tipos de respuesta | Respuesta libre y selección múltiple. Solo queda una letra A–E. |
| Razonamiento del alumno | Campos de explicación, «pensando mientras lee» y borradores. |
| Conversaciones laterales | Chats por pregunta, ventanas flotantes, preguntas sobre texto seleccionado y citas. |
| Grafo de conocimiento | Vista, proposiciones, cadenas, edición, organización de fuentes y selector de conocimiento. |
| Extracción | Extractor, auditor, cobertura y trabajos manuales y automáticos. |
| Importación | Apuntes, PDF, carpetas, conversión a Markdown y colas. |
| Investigación | Búsqueda web, descarga de URLs (`safe-fetch`) y agente investigador. |
| Artefactos generados | Demos, ilustraciones, anotaciones, navegador auxiliar (puppeteer) y ciclos de inspección. |
| Archivos del usuario | Adjuntos, exploración de carpetas y herramientas de lectura del sistema. |
| Audio | Dictado, micrófono, worklet de audio, Deepgram y su endpoint. |
| Proveedores | Servicios cloud, claves, `auth.json`, suscripciones, OAuth, ChatGPT y Claude Code CLI. |
| Selección de modelos | Selectores Strong/Cheap/Vision y configuración de modelos por agente. |
| Escritorio | Electron, instaladores, actualizaciones, `electron-builder`, iconos y workflows de publicación. |
| Plugins descartados | Coding Questions, Drawing Pad y Rich Code Blocks, además de la galería `ui-showcase` y los ejemplos. |
| Extensiones externas | Carpeta de plugins de comunidad, instalación, reescaneo, activar/desactivar y skill de autoría. |
| Ajustes avanzados | Editores de prompts, caché, concurrencia y presupuestos de contexto. |
| Personalización | Temas, colores, fuentes y reasignación de atajos. Queda el tema por defecto, fijo. |
| Conversaciones | Gestor, búsqueda, renombrado, exportación y varios chats. |
| Paneles técnicos | Costes, herramientas, trabajos y estadísticas internas. |

Comprobaciones específicas del encargo:
- **Grafo**: se fue la vista y también la extracción, la auditoría, la importación de apuntes y las entradas manuales (rutas `/api/graph/*`, `src/agent/subagents/extraction.ts` y sus stores).
- **Búsqueda**: al retirar las claves se fue también la descarga directa de URLs (`safe-fetch`, `web.ts`).
- **Electron**: retirado junto con sus consumidores (preload, puentes IPC, `desktop-access`, `UpdateBanner` y el modo de secreto de escritorio en `proxy.ts`).
- **Trabajos**: no queda ningún trabajador. El servidor solo lanza un proceso Python por petición de práctica y mantiene un latido SSE por conexión abierta.

## Configuración (fija, sin selectores)

| Variable | Por defecto | Para qué |
|---|---|---|
| `LH_DATA_DIR` | `./data` | Datos mutables: `practice.db`, `core-plugin-data/flashcards/` y el enlace `m3kang/`. |
| `LH_M3KANG_DIR` | `<datos>/m3kang` | Carpeta con los `*.jsonl` del banco y `images/`. |
| `LH_TRAINER_PY` | `../copilot/teach/trainer.py` (repo del equipo), si no `../../wt-teach/copilot/teach/trainer.py` | El entrenador del equipo. |
| `LH_PYTHON` | `python3` | Intérprete para el puente. |
| `LH_EXPLANATIONS` | `<datos>/explanations.json` | Explicaciones escritas a mano por id de problema. Opcional. |
| `LH_ALLOWED_HOSTS` | (vacío) | Nombres de host extra, aparte de localhost y las IP. |

## Limitaciones

- **Datos M3Kang**: no se incluyen ni se suben al repo (`data/` está en `.gitignore`). Hay que enlazar el banco localmente. Solo el lote `data/demo` (50 problemas en inglés y catalán) trae imágenes. M3Kang train y val no tienen imágenes en local.
- **Problemas sin opciones en texto**: entran en el banco y se responden por letra, leyendo las opciones en la figura. Si además falta la figura, se pueden saltar sin penalización: no se registra ningún intento y el nivel no cambia.
- **Confianza**: se guarda, pero no ajusta el nivel. Cambiar la fórmula necesita una decisión aparte.
- **Explicaciones**: están escritas a mano en inglés para el banco demo (50 problemas), y la sesión en catalán muestra la inglesa. Se guardan fuera de Git, en `data/`, porque describen problemas del lote restringido. Los problemas sin entrada no muestran el botón **Explain**.
- **Una sola persona por servidor**: hay un único perfil local, sin autenticación, y quien llegue al servidor lo comparte. El banco en catalán sigue cargado, pero no hay forma de elegirlo desde la interfaz.
- **Build**: `next/font` descarga las dos fuentes de Google **al compilar**. La app en marcha no hace peticiones externas, pero un build sin red falla salvo que las fuentes ya estén en caché.
- **Despliegue standalone**: `.next/standalone` incluye el puente, pero no copia `core-plugins/` ni el entrenador. Se ha probado `next start` desde el repo.
- **Interfaz en inglés**, como el resto de LearnHarness. Los problemas pueden estar en inglés o en catalán.
- **Placa**: no se ha probado en la Arduino UNO Q. Todos los tiempos y tamaños que siguen son del portátil.

## Verificación

Ejecutado en el portátil (WSL, Node 24.11, Python 3.12):

| Comprobación | Resultado |
|---|---|
| `npm run typecheck` | sin errores |
| `npm run lint` | sin errores |
| `npm test` (app) | 200/200 |
| `npm run test:practice` (puente, banco sintético) | 13/13: sesión completa con aciertos y fallos, confianza guardada con el intento, etiquetas ausentes, imagen presente y ausente con salto, reanudación, doble envío secuencial y concurrente, envío obsoleto, otro idioma del mismo `id`, explicación solo después de responder (también en la respuesta repetida), por idioma y ausente |
| `npm run test:flashcards` | 132/132 |
| `npm run build` | correcto, sin avisos de trazado |
| `scripts/browser-checks/practice.mjs` (Edge headless, banco demo real, sin Internet) | 19/19 (versión con el plan; ahora comprueba que no hay gráfico): inicio, problema y 5 opciones, sin `label` en la respuesta, confianza, resultado, siguiente problema, reanudación tras recargar, doble envío en paralelo (1 intento), envío obsoleto (409), imagen local y 404, rutas retiradas (404), sin instalar ni activar plugins (405), flashcard creada con KaTeX y calificada, sin estado de generación, ajustes sin modelo, **ninguna petición fuera de la máquina**, sin errores de página |
| `scripts/browser-checks/missing-image.mjs` (banco de fixture) | 7/7: fórmulas en el enunciado y en las opciones, aviso de figura ausente, salto sin intento ni cambio de nivel, salto rechazado si la imagen existe, sin red y sin errores |

Tras los cambios del 15/11 por la tarde (sin gráfico, explicaciones, mazo), una tercera comprobación en Edge sobre una copia aislada dio 9/9: no hay gráfico, no hay explicación ni botón antes de responder, la explicación está oculta hasta pulsar **Explain**, se ve con KaTeX y se vuelve a ocultar, el mazo tiene sus 20 tarjetas y se repasa con KaTeX, ninguna petición sale de la máquina y no hay errores de página.

Banco de fixture para `missing-image.mjs`: copia de `data/demo/train.jsonl` en inglés sin las imágenes de los problemas con figura, más un problema sintético de nivel 4 con LaTeX (`lvl-4_2099_1`) que sale el primero.

Medidas (solo portátil, no placa):
- `node_modules`: 1,4 GB → 711 MB (455 paquetes menos).
- `npm run build`: unos 16 s.
- Una llamada al puente (banco demo): unos 0,2 s, casi todo arranque de Python.
- No se ha medido la memoria del navegador ni del servidor.
- No hay modelo en ningún paso, así que no hay coste de modelo que medir.
