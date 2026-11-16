# Instrucciones para agentes

Responde siempre en español, de forma breve.

Copiloto de mates offline en la Arduino UNO Q con M3Kang. Contexto del reto, hardware, datos y cifras: @context.md

## Reglas que nunca se rompen

- Código que corre en la placa: **solo librería estándar de Python** (no hay pip).
- `predict.py` devuelve exactamente una letra A–E por problema, con temperatura 0. No cambies la interfaz de `predict.py` ni de `eval.py`.
- Máximo 60 s por problema en la placa; el presupuesto de Reason es 55 s (`REASON_BUDGET_SECONDS`).
- Sin red en ejecución.
- No subas nunca `data/train.jsonl`, `data/val.jsonl`, imágenes, `.env` ni claves. M3Kang es solo para investigación.
- Los tiempos medidos en el portátil no valen: solo cuentan los medidos en la placa.
- Sin medición, sin cifra: no escribas un resultado en la documentación si no sale de un CSV de `results/`.

## Bucle de trabajo

1. Un cambio cada vez.
2. Contrato: `python3 predict.py --input data/sample_problems.jsonl --output results/check.csv`.
3. Mide: `python3 eval.py --limit 200 --name <cambio>`. Escribe una fila en `results/ablations.csv`.
4. Si mejora, commit con el número en el mensaje. Si no, revierte y apunta por qué.
5. Comprueba tiempos y RAM en la placa antes de dar una versión por buena.

## Dónde está cada cosa

| Qué | Dónde |
|---|---|
| Pipeline de Reason | `predict.py`, `copilot/` (`pot.py`, `sandbox.py`, `options.py`, `pipeline.py`) |
| Evaluación | `eval.py`, `benchmark/`, `experiments/` |
| Placa | `board/`, `config.env` |
| App Teach | `cortex/` |
| Informes | `docs/` (índice en `docs/README.md`) |

## Skills, subagentes y comandos

Viven en esta carpeta; para activarlos en Claude Code, ver [README.md](README.md).

- Skills (`skills/`): `unoq-board`, `m3kang-copilot`, `unoq-hardware-ui`, `publish-project`.
- Subagentes (`subagents/`): `board-checker` (comprueba tiempos y RAM en la placa), `error-analyst` (analiza los CSV de `eval.py`).
- Comandos (`commands/`): `experiment` (un cambio, medido, con commit).
