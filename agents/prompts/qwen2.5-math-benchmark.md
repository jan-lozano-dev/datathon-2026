Actúa como un ingeniero experto en Machine Learning y sistemas Edge Computing. Estoy participando en el Datathon FME de la UPC y necesito optimizar la evaluación del dataset `qualcomm/M3Kang`.

**Mi Hardware:**
- Placa: Arduino UNO Q (basada en Qualcomm QRB2210).
- SO: Debian Linux.
- RAM: 4 GB LPDDR4X (compartida).
- GPU: Qualcomm Adreno 702 (Soporta Vulkan).

**El Objetivo:**
Actualmente tengo un baseline del 46% de accuracy usando `Qwen2.5-Coder-1.5B`. Quiero reemplazarlo por `Qwen2.5-Math-1.5B-Instruct` en formato GGUF (cuantización Q4_K_M) para superar este baseline. 

**Tus Tareas:**
Escribe un script en Python y los comandos de bash necesarios para realizar el siguiente flujo completo:

1. **Instalación Optimizada:**
   - Dame el comando exacto para instalar `llama-cpp-python` compilándolo desde cero con soporte para Vulkan (`CMAKE_ARGS="-DGGML_VULKAN=on"`), ya que no tenemos CUDA, tenemos una GPU Adreno.
   - Instala las dependencias necesarias (`datasets`, `huggingface_hub`, `scikit-learn`, etc.).

2. **Descarga del Modelo:**
   - Escribe el código Python para descargar automáticamente el modelo `qwen2.5-math-1.5b-instruct-q4_k_m.gguf` desde HuggingFace (puedes usar el repo de `bartowski` u otro de GGUF confiable).

3. **Script de Evaluación (El core del reto):**
   - Carga el dataset `qualcomm/M3Kang` (usaremos la parte de texto para esta prueba).
   - Configura el modelo en `llama-cpp-python` enviando todas las capas a la GPU (`n_gpu_layers=-1`).
   - Itera sobre un subconjunto de prueba (ej. 100 ejemplos) para hacer un benchmark rápido.
   - **System Prompt Crucial:** Configura el prompt usando el formato ChatML de Qwen. El system prompt debe obligar al modelo a razonar paso a paso y dar la respuesta final **siempre** dentro de un bloque LaTeX `\boxed{}`.
   - Extrae la respuesta generada usando una expresión regular (Regex) que capture lo que hay dentro de `\boxed{}`.
   - Compara la respuesta extraída con el *ground truth* del dataset y calcula el *accuracy* final.

4. **Prevención de Errores (OOM):**
   - Asegúrate de limitar el `n_ctx` (contexto máximo) en `llama_cpp` a unos 1024 o 2048 tokens como máximo para no saturar los 4GB de RAM de la Arduino.

Por favor, entrégame el archivo `setup.sh` con los comandos de instalación y el archivo `evaluate_math.py` con la lógica limpia y modular.