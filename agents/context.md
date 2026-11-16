# Contexto del reto Qualcomm (para agentes)

Datathon FME 2026 (UPC), reto *Math on the Edge* de Qualcomm. Repo oficial del kit: <https://github.com/mpous/datathon-UPC-maths-qualcomm-arduino-unoq>. El texto completo del reto está en el README del repo oficial.

## El reto

> Diseñar un copiloto de mates que funcione **entero en la Arduino UNO Q, offline**, y que use el dataset **M3Kang** de forma innovadora para ayudar a los estudiantes a razonar.

| Parte | Peso | Cómo se evalúa |
|---|---|---|
| **Reason** | 50 % | Acierto de `predict.py` en un test oculto de problemas tipo Canguro. |
| **Teach** | 50 % | Jurado: una experiencia que guíe al alumno **sin darle la respuesta**. |

Entregables: repositorio público, post en Arduino Project Hub (arquitectura, cómo replicarlo, análisis de errores por tema, idioma y dificultad) y demo en la placa.

## Hardware: Arduino UNO Q (4 GB)

- Debian en un Qualcomm QRB2210 (4× Cortex-A53) más un microcontrolador STM32 para la matriz LED.
- Unos 3,6 GB de RAM usable. **No hay `pip`**: el código de la placa usa solo la librería estándar de Python.
- Modelo de Reason: **Qwen2.5-Coder-1.5B-Instruct Q4_K_M**, `llama-server` en el puerto 8081, fijado en `config.env`. Embeddings: bge-small-en-v1.5, puerto 8082.
- **Límite: 60 s por problema.** Si se pasa, la respuesta es `D`. Temperatura 0.

## Datos: M3Kang

- Problemas del concurso Canguro (2007–2024), multilingües. Con el kit: 1.747 problemas en inglés, más los mismos en catalán.
- Campos tras `laptop/prepare_m3kang.py`: `id`, `language`, `level` (0 a 7), `year`, `text_only`, `text` (sin opciones), `options` (A–E leídas por OCR, o `{}`) y `label`.
- Las opciones solo están en la imagen. El OCR las recupera en el 62 % de los problemas. En los problemas con figura, el texto no describe la figura.
- Licencia solo para investigación: **no subir `data/*.jsonl` ni imágenes**.

## Estado de Reason

`predict.py` pide al modelo un programa Python corto sin enseñarle las opciones, lo ejecuta en un sandbox y responde la opción que coincide con la salida. Si no sale nada, responde `D`. Detalle y ideas descartadas: [../docs/reason.md](../docs/reason.md).

Cifras verificables (informe completo en [../docs/results.md](../docs/results.md)):

| Medida | Resultado |
|---|---|
| Baseline original, validación M3Kang (281 problemas) | 65/281 (23,13 %), igual que responder siempre `D` |
| Práctica de la organización, portátil: baseline | 23/100 |
| Práctica de la organización, portátil: Coder 1.5B (E10) | 46/100 (40/80 solo texto, 6/20 con figura) |
| Problemas propios (80 filas), portátil: baseline → Coder 1.5B (E11) | 19/80 → 54/80 |
| Placa, práctica (subconjunto) | 19/40 (47,5 %), 29,8 s de media y 48,0 s de máximo; **solo registro agregado**, sin CSV por pregunta ni RAM medida |

## Estado de Teach

La app web es `cortex/` (práctica adaptativa con compromiso previo de respuesta, explicaciones estáticas y flashcards con FSRS-6). No usa ningún modelo de lenguaje. Está comprobada en el portátil, no en la placa.

## Reglas para los agentes

Las reglas que no se rompen están en [CLAUDE.md](CLAUDE.md).
