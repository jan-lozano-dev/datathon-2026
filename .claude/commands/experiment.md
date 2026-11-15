---
description: Implementa UN cambio en el copiloto (Reason), mídelo con eval.py y haz commit con el número
argument-hint: <descripción del cambio>
---
Experimento: $ARGUMENTS

1. Lee el último resultado en `ablations.csv` (o en `results/`) para saber contra qué número comparas.
2. Explícame en 3 líneas qué vas a cambiar y en qué archivo de `copilot/`. Solo librería estándar.
3. Implementa SOLO ese cambio. No toques la interfaz de `predict.py` ni de `eval.py`.
4. Comprueba que el contrato sigue en pie: `python3 predict.py --input data/sample_problems.jsonl --output results/check.csv` (una letra A–E por fila, `status ok`).
5. Mide: `python3 eval.py --limit 200 --name <nombre-corto>`.
6. Enséñame una tabla con: acierto antes y después, acierto en `text_only` true/false, distribución de letras, segundos medios y `prompt_tokens` medios. Avisa si los prompt_tokens superan ~400 (en la placa serían más de 36 s).
7. Si mejora: commit con el mensaje `exp: <nombre> <acierto>% val`. Si no mejora: revierte el cambio con git y dime por qué crees que no funcionó.
