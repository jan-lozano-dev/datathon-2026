# Reason: estado del prototipo (15/11/2026)

El modelo fijado para Reason es Qwen2.5-Coder-1.5B-Instruct Q4_K_M, configurado en `config.env`. En la placa solo existe un registro agregado: 19/40 (47,5 %) en la práctica, con 29,8 s de media y 48,0 s de máximo, sin CSV por pregunta ni medición de RAM (ver [results.md](results.md)).

## Pendiente

Por orden de importancia:

1. **Medir y registrar RAM en la placa** con ambos servicios cargados; la prueba de 40 problemas solo dejó un registro agregado (29,8 s de media y 48,0 s de máximo).
2. Ejecutar allí `python3 -m unittest tests.test_reason` y volver a comprobar el peor tiempo, que debe quedar por debajo de 60 s.
3. Medir la versión final de principio a fin en la práctica. El 31 y el 47 de la tabla son del portátil y se recalcularon a partir de programas guardados.
4. Control de regresión en M3Kang: `python3 eval.py --limit 200 --name reason-final`. La versión anterior daba 24,5 %.

## Qué hace `predict.py`

1. Pide al modelo un programa Python corto de fuerza bruta. No le enseña las opciones.
2. Ejecuta el programa aislado: solo unos pocos módulos estándar, con tope de CPU, memoria y tiempo.
3. Responde la opción cuyo valor coincide con lo que imprime el programa. Si imprime un número que cae entre las opciones sin coincidir con ninguna, la más cercana.
4. Si no sale nada, responde `D` al instante.

Tope de 55 s por problema (`REASON_BUDGET_SECONDS`; era 50, subido el 15/11 porque con el Coder 1.5B la placa corta muchos programas: simulado, 41 → 43 sobre 100 a 3,0/1,5 tok/s). La interfaz de `predict.py` y `eval.py` no cambia.

## Resultados en el portátil

Set de práctica de la organización (50 problemas en inglés y catalán, 100 filas):

| Versión | Solo texto (80) | Con figura (20) | Total |
|---|---|---|---|
| Código anterior | 16 | 7 | 23 |
| Qwen3.5 0.8B (modelo anterior) | 22 | 9 | 31 |
| Qwen2.5-Coder 1.5B (Q4_K_M) | 37 | 10 | 47 |

El 31 y el 47 son recálculos a partir de programas guardados. La ejecución completa verificada es E10: 46/100 (40/80 solo texto, 6/20 con figura); detalle en [results.md](results.md).

- **Las figuras no se resuelven**: ahí la respuesta es siempre `D`, y en la práctica `D` es correcta en 5 de las 10 figuras. Es suerte. Con respuestas repartidas serían 4 de 20, así que la cifra que cuenta es la de solo texto: 20 % → 27,5 % → 46 %.
- **Catalán**: Qwen3.5 0.8B resuelve 13/50 en catalán y 18/50 en inglés. El Coder 1.5B, 22/50 y 25/50.
- En 40 problemas propios del mismo estilo (`experiments/synthetic_dev.py`, 80 filas): 19 → 44 → 54.
- Cuando el programa coincide con una opción acierta el 54 % con Qwen3.5 0.8B y el 80 % con el Coder 1.5B.

El test son 20 problemas: cada uno vale 5 puntos y el resultado tendrá unos ±10 puntos de ruido.

## Comprobación en la placa

Desde el portátil, en la carpeta del repo:

```bash
git archive main | ssh arduino@<ip> 'mkdir -p ~/reason-pot && tar -x -C ~/reason-pot'
scp data/demo/train.jsonl arduino@<ip>:~/reason-pot/data/demo.jsonl
```

En la placa:

```bash
cd ~/reason-pot
python3 -m unittest tests.test_reason
python3 eval.py --input data/demo.jsonl --limit 30 --name board-reason
```

Registro existente: 19/40 correctas, media 29,8 s y peor caso 48,0 s (solo agregado, sin CSV por pregunta). Faltan la RAM y el detalle de los timeouts.

## Modelo elegido y límites de la medición

El Coder 1.5B es el modelo fijado en `config.env`: dio 16 puntos más que Qwen3.5 0.8B en la práctica del portátil. En la placa logró 19/40; el uso de RAM no está registrado. Para medirlo en otra placa sin cambiar el servicio principal (descarga 1,1 GB y usa temporalmente el puerto 8091):

```bash
./experiments/board_try_model.sh
```

La última línea da tokens por segundo de lectura y de escritura. Resultado simulado en la práctica según esa velocidad:

| Lee / escribe (tok/s) | Total sobre 100 |
|---|---|
| 2,5 / 1,2 | 30 |
| 3,0 / 1,5 | 41 |
| 3,5 / 1,8 | 44 |
| 4,0 / 2,0 o más | 47 |

Merece la pena a partir de 3 y 1,5. Como alternativa, si se quiere mantener Qwen3.5 0.8B para otros usos y usar el Coder solo en Reason:

```bash
tmux new-session -d -s reason "~/llama.cpp/build/bin/llama-server -m ~/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf --host 127.0.0.1 --port 8091 --threads 4 --ctx-size 4096 --parallel 1 --cache-ram 0 --ctx-checkpoints 2 --jinja --reasoning off --reasoning-budget 0 --alias reason"
```

y en `config.env` poner `REASON_LLM_PORT=8091`. Después, repetir el `eval.py --limit 30` y mirar `free -m` con los dos modelos cargados.

## Ejecución en la placa

- **Calentar antes de la demo**: `python3 predict.py --input data/sample_problems.jsonl --output /tmp/x.csv`. El arranque lee una vez el prefijo compartido; el tiempo de calentamiento del Coder debe medirse en la placa.
- **Que nada más use ese servidor durante la ejecución oficial.** Otra petición con otro prompt borra la caché y los problemas siguientes agotan el tiempo.

## Probado y descartado

| Idea | Resultado |
|---|---|
| Pedir una letra al modelo cuando el programa falla | Acierta 173 de 784 (22 %): azar, y cuesta unos 10 s |
| Calibrar el sesgo de letra | Sin mejora fuera de muestra |
| Segundo intento de programa | Acierta 1 de 6 y 1 de 3 donde falló el primero |
| Traducir el catalán al inglés con el Qwen 0.8B | De 14 enunciados deja 5 en catalán y en 3 responde en vez de traducir |
| Enseñar las opciones al pedir el programa | Peor en los dos modelos (29 → 35 y 43 → 47 aciertos sin ellas) |
| Afinar sobre M3Kang train | Demasiado difícil: el programa coincide en el 6 % |
| Qwen3.5 2B, Coder 0.5B, Qwen3.5 0.8B en Q4 | 51, 34 y 34 sobre 80 en problemas propios; el 2B pesa 1,4 GB |

## Repetir una medición

```bash
python3 experiments/synthetic_dev.py
REASON_TRACE=results/trace-x.jsonl python3 eval.py --input data/demo/train.jsonl --limit 0 --name x
python3 experiments/pot_report.py results/trace-x.jsonl
python3 experiments/replay.py results/trace-x.jsonl --repair --no-letter --near --board --read-tps 4 --write-tps 2
```

`pot_report.py` da el acierto por idioma, nivel y método, que sirve para el análisis de errores. Código en `copilot/pot.py`, `copilot/sandbox.py`, `copilot/options.py` y `copilot/pipeline.py`.
