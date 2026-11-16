# Cortex: informe de accuracy, latencia y errores de Reason

Fecha: 15 de noviembre de 2026. Informe calculado a partir de los artefactos locales existentes; no se ha vuelto a ejecutar inferencia para elaborarlo.

## Resultado que podemos respaldar

En una ejecución completa sobre la práctica de la organización, la variante **E10 con Qwen2.5-Coder 1.5B Q4_K_M obtuvo 46/100 respuestas correctas (46,0 %)** en el portátil, frente a 23/100 del baseline sobre las mismas filas. La latencia media fue 6,092 s por respuesta y la máxima 16,96 s.

El resumen local de Arduino registra **47,5 % sobre 40 filas de práctica**, con 29,8 s de media y 48,0 s de máximo. Esta evidencia es un registro agregado: no se ha localizado su CSV por pregunta, y no permite identificar de forma independiente la versión exacta del solver ni desglosar sus errores.

**El 46,0 % corresponde a E10, no a la versión actual del código.** La ejecución de práctica E11 guardada en disco contiene únicamente 39 de las 100 filas. No hay aquí una evaluación completa de la versión actual sobre toda la práctica en Arduino.

## Alcance y método

Este informe evalúa la selección de respuestas A–E de **Reason**. No mide eficacia pedagógica, experiencia de usuario ni estimación del nivel del alumno de Teach.

- La práctica tiene 100 filas: 50 problemas, cada uno en inglés y catalán. Son 50 problemas distintos, no 100 observaciones independientes.
- Los sintéticos tienen 80 filas: 40 problemas propios, también en ambos idiomas. Se usaron para desarrollar y seleccionar variantes; no son un test independiente.
- La validación histórica de M3Kang tiene 281 filas en inglés. Sus resultados no deben compararse directamente con los de práctica o sintéticos.
- Accuracy = respuestas correctas / filas evaluadas. Los fallos del sistema no se excluyen del denominador.
- Los tiempos proceden de la columna `seconds`; no incluyen necesariamente arranque del servidor, carga de pesos o calentamiento previo. No se ha medido el tiempo total desde un arranque en frío.
- Se han comprobado las claves únicas `(id, language)`, la cobertura completa de cada conjunto seleccionado, las etiquetas y la coherencia de `correct` con `answer == label`.
- El p95 usa el rango más próximo: posición `ceil(0.95 × n)` de los tiempos ordenados. Los CSV de origen redondean a centésimas.
- Los experimentos se seleccionaron después de observar estos conjuntos. Los resultados son descriptivos y no demuestran rendimiento en el test oculto.

## Ejecuciones completas en portátil

| Variante y conjunto | Aciertos/filas | Accuracy | Media s | Mediana s | p95 s | Máximo s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline, práctica | 23/100 | 23.0 % | 0.888 | 0.860 | 1.20 | 1.30 |
| Coder 1.5B, E10, práctica | 46/100 | 46.0 % | 6.092 | 5.810 | 12.55 | 16.96 |
| Baseline, sintéticos | 19/80 | 23.8 % | 1.381 | 1.360 | 1.72 | 2.38 |
| Coder 1.5B, E11, sintéticos | 54/80 | 67.5 % | 4.120 | 3.765 | 6.70 | 8.32 |

Las cuatro ejecuciones registran `status=ok` en todas sus filas y cero respuestas por encima de 60 s. Ese estado no acredita que el programa generado haya funcionado: el sistema puede devolver una letra de respaldo y marcar la petición como completada.

En práctica, E10 corrige 34 respuestas que el baseline fallaba y pierde 11 que acertaba: **+23 puntos porcentuales** en las mismas 100 filas. Cambian tanto el modelo como la estrategia, por lo que no se puede atribuir toda la diferencia al modelo. Siempre responder D obtiene 20/100 en esta práctica.

El 67,5 % de E11 se refiere únicamente al conjunto sintético. No debe presentarse como accuracy de M3Kang ni como resultado en Arduino. El baseline histórico completo de M3Kang fue 65/281 (23,13 %) en portátil, documentado en `baseline-audit.md`; es otro conjunto y otra evaluación.

## Resultados disponibles en Arduino UNO Q

Fuente: última fila de `results/ablations-board.csv`, ejecución `coder-board-practica40` registrada a las 09:38:54 del 15/11/2026, según la marca temporal del archivo, sin zona horaria documentada.

| Conjunto | Filas | Accuracy registrada | Media s | Máximo s | Casos sobre el límite registrados |
| --- | ---: | ---: | ---: | ---: | ---: |
| Práctica, subconjunto | 40 | 47,5 % (equivale a 19/40) | 29,8 | 48,0 | 0 |

La atribución al modelo Coder procede del nombre del experimento y del README. Faltan el detalle por pregunta, la revisión del código y la configuración de esa ejecución. No se pueden obtener mediana, p95, desglose por idioma, tema o nivel, ni número de fallbacks internos.

Una versión anterior del README indicaba también 47,5 %, pero con **31,5 s de media, 53,1 s de máximo y cuatro timeouts**. No se ha encontrado el artefacto que respalde esos tiempos. Pueden ser ejecuciones distintas; no se deben combinar como si fueran una sola. El valor `over_limit=0` del resumen tampoco demuestra ausencia de timeouts internos.

No se ha encontrado una medición de memoria máxima que permita acreditar el consumo conjunto de servicios en los 4 GB de la placa.

## Errores por idioma: E10, práctica en portátil

| Idioma | Aciertos/filas | Errores | Accuracy |
| --- | ---: | ---: | ---: |
| Catalán | 21/50 | 29 | 42.0 % |
| Inglés | 25/50 | 25 | 50.0 % |

La diferencia observada es de ocho puntos a favor del inglés. Las dos lenguas contienen los mismos problemas; no se ha realizado un análisis causal de los fallos de traducción o comprensión.

## Errores por dificultad: E10, práctica en portátil

Se usa `level` (0–7) como indicador de nivel escolar. No es una dificultad medida de forma independiente.

| Nivel | Aciertos/filas | Errores | Accuracy |
| --- | ---: | ---: | ---: |
| 0 | 6/16 | 10 | 37.5 % |
| 1 | 9/16 | 7 | 56.3 % |
| 2 | 7/14 | 7 | 50.0 % |
| 3 | 2/12 | 10 | 16.7 % |
| 4 | 4/12 | 8 | 33.3 % |
| 5 | 6/10 | 4 | 60.0 % |
| 6 | 4/10 | 6 | 40.0 % |
| 7 | 8/10 | 2 | 80.0 % |

Los grupos contienen entre 10 y 16 filas e incluyen traducciones del mismo problema. El patrón no es monótono: el 80 % del nivel 7 no permite afirmar que el sistema resuelva mejor los problemas difíciles. El nivel 3 concentra 10 errores de 12 filas y merece revisión manual.

## Errores por presencia de figura: E10, práctica en portátil

| Tipo | Aciertos/filas | Errores | Accuracy |
| --- | ---: | ---: | ---: |
| Con figura | 6/20 | 14 | 30.0 % |
| Solo texto | 40/80 | 40 | 50.0 % |

La variante E10 obtuvo **40/80 (50,0 %) en solo texto**. No tiene una ruta de visión en esta evaluación: los aciertos en problemas con figura no acreditan interpretación visual. En E10 existía una petición de letra como respaldo; por tanto, no corresponde describir todas sus respuestas con figura como un fallback fijo D.

## Errores por tema: E10, práctica en portátil

M3Kang preparado no aporta un campo de tema en esta práctica. Se ha aplicado la clasificación inglesa por palabras clave de `benchmark/common.py`, con prioridad geometría → probabilidad → teoría de números → combinatoria → aritmética → álgebra → lógica. Es una etiqueta heurística de baja confianza, no una anotación validada por expertos. Solo se clasifican las 50 filas en inglés; las 50 en catalán quedan fuera de esta tabla para no aplicarles reglas inglesas.

| Tema heurístico | Aciertos/filas | Errores | Accuracy |
| --- | ---: | ---: | ---: |
| Álgebra | 1/2 | 1 | 50.0 % |
| Aritmética | 4/4 | 0 | 100.0 % |
| Combinatoria | 1/1 | 0 | 100.0 % |
| Geometría | 1/7 | 6 | 14.3 % |
| Lógica | 0/2 | 2 | 0.0 % |
| Teoría de números | 11/19 | 8 | 57.9 % |
| Probabilidad | 0/2 | 2 | 0.0 % |
| Sin clasificar | 7/13 | 6 | 53.8 % |

Las reglas pueden asignar un tema por una palabra incidental. Los grupos de una a cuatro filas no permiten sacar conclusiones sobre competencia matemática. Geometría registra 6/7 errores y teoría de números 8/19; son prioridades de inspección, no diagnósticos de la causa. Trece filas inglesas quedan sin clasificar. Una versión posterior debe sustituir estas etiquetas por revisión manual o una taxonomía validada en ambos idiomas.

## Qué muestran las trazas de E10

La traza completa identifica `qwen2.5-coder-1.5b-instruct-q4_k_m.gguf` en las 100 filas y confirma que el modelo no veía las opciones al generar el programa.

| Ruta registrada | Aciertos/filas | Errores | Accuracy |
| --- | ---: | ---: | ---: |
| Programa y correspondencia con una opción (`pot`) | 33/41 | 8 | 80,5 % |
| Petición de letra de respaldo (`letter`) | 13/59 | 46 | 22,0 % |

La mayoría de los errores observados pertenece a la ruta de respaldo: 46 de 54. El 80,5 % es precisión condicionada a haber elegido la ruta `pot`, no accuracy global. Los grupos se seleccionan por el propio comportamiento del sistema y no equivalen a una comparación experimental entre dos métodos sobre idénticos casos.

La comprobación de programas registra 95 `ok`, dos errores de sintaxis, dos de importación y uno de nombre. También aparecen cuatro errores de ejecución: dominio matemático, índice, memoria y nombre no definido. Estas categorías pueden solaparse y no deben sumarse como causas independientes de las 54 respuestas incorrectas. Un `MemoryError` dentro del programa generado tampoco acredita que la placa agotara su RAM: esta traza procede del portátil y la ejecución está limitada por el sandbox.

El solver emite B en 47/100 filas y D en 34/100; las etiquetas correctas están equilibradas, 20 por letra. Existe una distribución de salida sesgada, pero no se ha medido qué parte del error causa ese sesgo.

## Versiones parciales y cifras que no deben mezclarse

- `eval-20261115-031726-e11-demo-coder15.csv`: 20/39, ejecución incompleta de una práctica de 100 filas. No se publica como resultado final del conjunto.
- `eval-20261115-031618-e11-noletter-demo.csv`: 22/61, también incompleta. No se puede sumar a la anterior: son modelos distintos y sus muestras se solapan.
- Los 47/100 del README anterior y de `reason.md` se describen allí como un recálculo a partir de programas guardados. No son el resultado de una ejecución completa del pipeline actual acreditada por los CSV revisados.
- Las pruebas de cinco ejemplos sirven para comprobar funcionamiento. Su 100 % no es una estimación representativa de accuracy.
- Un experimento aparte con Qwen2.5-Math, que ya no forma parte del repositorio, no se incorpora a la comparación principal: no se ha acreditado aquí un protocolo común con estas ejecuciones.

## Qué falta para cerrar una cifra final de entrega

1. Ejecutar el conjunto completo de práctica en la UNO Q con la revisión y configuración elegidas, guardando CSV por pregunta, traza, modelo, cuantización, parámetros, commit y número de fallbacks/timeouts.
2. Registrar tiempos por respuesta, calentamiento y tiempo total desde arranque; medir memoria máxima de los servicios usados en la demostración.
3. Reconciliar las cifras del README con esa ejecución. Hasta entonces, usar 46,0 % como resultado completo de E10 en portátil y 47,5 % como registro agregado de una práctica parcial en placa.
4. Revisar manualmente los temas y ejemplos de error en ambos idiomas. Este informe aporta un desglose temático provisional y no atribuye causas cognitivas a partir de una sola letra.
5. Mantener el test oculto separado de la selección de variantes. Estas mediciones de desarrollo no sustituyen la evaluación oficial.

## Artefactos y trazabilidad

El [CSV público de métricas agregadas](evaluation/metrics.csv) contiene resultados globales y desgloses sin enunciados, opciones, imágenes ni respuestas por problema. Las fuentes privadas siguen en `results/` y `data/`, ignoradas por Git; los hashes permiten identificar exactamente los archivos usados.

| Fuente local | SHA256 |
| --- | --- |
| `results/eval-20261115-005939-e0-baseline-demo.csv` | `b8470f042539185756543e67e50bdd00927ad06d5bcc2141529243452ddc65ee` |
| `results/eval-20261115-024327-e10-demo-coder15.csv` | `24b8af07533fbcc74d5c0ebeeeed24c882161ed43e77b7bc6837ad60b34e8014` |
| `results/eval-20261115-013306-e0-baseline-synth.csv` | `05caab2e2dc268e21ab62c80d1969137f35aa422cffaaac083b6fd5f62c1e6e5` |
| `results/eval-20261115-030932-e11-synth-coder15.csv` | `9c1dc75ca9716bbbd9a1b66e3c45182177b442cdb7e45c54932f1f19835b9062` |
| `data/demo/train.jsonl` | `0825ef688b6f923efb9c45863b1dd23decbfbe72a622aef709165bb17cd09d36` |
| `data/dev_synth.jsonl` | `eadc85044789c9c16b2e5910daa94dc17d3017be964c71291d710261cfbebe47` |
| `results/ablations-board.csv` | `f27ea64a562900fc01d9ee6bf3098d98e56411031e12f9dd8fb4f039864ca718` |

Diagnóstico de rutas: `results/trace-e10-demo-coder15.jsonl`. Diagnóstico de ejecución incompleta: `results/trace-e11-demo-coder15.jsonl` y los CSV E11 indicados arriba. Para la auditoría histórica se ha consultado `baseline-audit.md`.

Las tablas se calculan con la biblioteca estándar de Python (`csv`, `json`, `statistics`, `hashlib`) y la clasificación local ya citada. No se han descargado datos ni modelos, ni se ha repetido o simulado inferencia para producir este informe.
