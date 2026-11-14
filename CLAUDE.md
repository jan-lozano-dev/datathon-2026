# CLAUDE.md — Equipo Datathon FME 2026 (reto Qualcomm, Arduino UNO Q)

Responde siempre en español, de forma breve.

## Objetivo
Copiloto de mates offline en la Arduino UNO Q con M3Kang. Nota: **50 % Reason (acierto objetivo en test oculto) + 50 % Teach (jurado)**. Ver QUALCOMM_CONTEXT.md.
Métrica principal: acierto de `predict.py` en el test oculto. Punto de partida: baseline 22,5 %, siempre D 25 %.
Entrega: domingo 12:00. Demo y pitch de 3 min el domingo a las 14:00.

## Quién toca qué (no editar archivos de otro sin avisar)
- Etna: `copilot/` (sobre todo `pipeline.py` → `solve()`), `predict.py`, experimentos con `eval.py`.
- Guillem: placa (servicios, `board/`), `laptop/` y generación de `data/*.jsonl` (OCR de opciones y campo `topic`).
- Nestor: carpeta `rawtree/` (subida de resultados y dashboard). Nada del copiloto.

## Reglas que nunca se rompen
- Código que corre en la placa: **solo librería estándar de Python** (no hay pip).
- `predict.py` devuelve exactamente una letra A–E por problema, con temperatura 0.
- Máximo 60 s por problema en la placa. La placa lee unos 11 tokens/s: vigila `prompt_n`. Más de ~400 tokens de prompt es peligroso.
- Sin red en ejecución.
- No subir nunca `data/train.jsonl`, `data/val.jsonl`, imágenes ni `.env` (M3Kang es solo para investigación; las claves son privadas).
- El portátil sirve para iterar rápido, pero los tiempos solo cuentan medidos en la placa.

## Bucle de trabajo
1. Un cambio cada vez.
2. `python3 eval.py --limit 200 --name <cambio>` (en el portátil: llama-server con el mismo modelo en el puerto 8081).
3. Apunta el resultado en `ablations.csv` y haz commit con el número en el mensaje.
4. Si mejora, Guillem lo prueba en la placa y pasa el CSV a Nestor.

## Plan de mejoras (por orden)
1. Logprobs de A–E + calibración del sesgo (prior estimado en train, validado en val).
2. Usar la versión en inglés del mismo `id` cuando exista.
3. Si el modelo duda mucho, responder la letra más frecuente según nivel y año.
4. Solvers con reglas en Python para aritmética y porcentajes.
5. Regresión logística sobre todas las señales (pesos entrenados en el portátil y copiados al código).

## Skills
Usa los skills de `.skills/`: `unoq-board`, `m3kang-copilot`, `unoq-hardware-ui`, `publish-project`.

## Contexto completo
@QUALCOMM_CONTEXT.md
