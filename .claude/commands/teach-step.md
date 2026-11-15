---
description: Construye o mejora UNA pieza del modo Teach (entrenador adaptativo / escalera de pistas) y mídela
argument-hint: <pieza a construir>
---
Pieza de Teach: $ARGUMENTS

Contexto: el modo Teach es un entrenador adaptativo con escalera de pistas (ver QUALCOMM_CONTEXT.md). Corre en la placa, offline, solo con la librería estándar. La UI es una web servida por la placa y la matriz LED (skill `unoq-hardware-ui`).

1. Propón en 5 líneas el diseño de la pieza y cómo se va a medir (por ejemplo: % de pistas que revelan la respuesta, tiempo por paso, simulación de alumnos).
2. Implementa la lógica en `copilot/teach/` como funciones puras con tests simples ejecutables en el portátil (`python3 -m copilot.teach.<modulo>`).
3. Reutiliza lo de Reason: embeddings (`copilot/embed.py`, `copilot/rag.py`), el clasificador de temas y los solvers.
4. Ejecuta la métrica y enséñame el número.
5. Commit: `teach: <pieza> <métrica>`.
