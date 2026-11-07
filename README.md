# Extensión "Menos odio a la vista"

Extensión para navegadores Chromium (Chrome, Opera, Edge, Brave) que detecta comentarios con odio en español y los **difumina u oculta**, mostrando la probabilidad que asigna el modelo.

Usa el **modelo A3** del proyecto *Menos odio a la vista* (Técnicas de Aprendizaje de Máquina, Pontificia Universidad Javeriana): [`tatisvivass/menos-odio-a3-robertuito`](https://huggingface.co/tatisvivass/menos-odio-a3-robertuito), RoBERTuito ajustado sobre `piuba-bigdata/contextualized_hate_speech`. El entrenamiento y la evaluación están en el repositorio del proyecto (cuaderno `proyecto_toxicidad_es.ipynb`).

```
Página (YouTube, Instagram…)        Service worker              Servidor local (Python)
content.js ── lote de textos ──▶ background.js ── POST /predict ──▶ server.py
   ▲  difumina/oculta + badge         caché                    preprocess_tweet + A3
   └────────── probabilidades ◀───────────────────────────────── softmax[:,1]
```

El modelo corre en **tu máquina** (`server.py`) con el mismo preprocesado del cuaderno (`pysentimiento.preprocess_tweet`, 128 tokens). Los comentarios no salen del equipo. Como respaldo se puede usar el Space de Hugging Face, que es más lento, procesa los textos de a uno y depende de la cuota ZeroGPU.

## 1. Arrancar el servidor del modelo

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r server/requirements.txt
pip install --no-deps pysentimiento
python server/server.py
```

La primera vez descarga los pesos del Hub (~500 MB). Si copias la carpeta `a3_model/` que genera el cuaderno a la raíz de este repo (o defines `HF_MODEL_ID=ruta`), usa esos pesos locales. Queda escuchando en `http://127.0.0.1:8765`.

Prueba rápida: abre `http://127.0.0.1:8765/health`.

## 2. Instalar la extensión (modo desarrollador)

**Chrome / Edge / Brave:** `chrome://extensions` → activar *Modo desarrollador* → *Cargar descomprimida* → elegir la carpeta **`extension/`** (no la raíz del repo).

**Opera:** `opera://extensions` → *Modo desarrollador* → *Cargar desempaquetada* → `extension/`. Opera usa Chromium y acepta extensiones Manifest V3 de Chrome.

> Para probar en páginas abiertas como archivo (`file://`), por ejemplo el blog LA PLAZA del proyecto, activa *Permitir acceso a URLs de archivos* en los detalles de la extensión.

## 3. Uso

- Los comentarios con probabilidad ≥ umbral se **difuminan** (o se ocultan) y llevan un badge rojo con el puntaje y un botón **Mostrar**.
- El ícono de la extensión indica cuántos comentarios ocultó en la pestaña.
- En el popup se puede: activar o desactivar la extensión, ajustar el umbral (0,28 por defecto, elegido en DEV), elegir entre difuminar y ocultar, mostrar el puntaje en *todos* los comentarios (útil para la demo), pausar la extensión en un sitio y cambiar el backend.

## 4. Cómo probarla sin publicar nada

**Página de prueba local.** Abre [`demo/prueba.html`](demo/prueba.html), ya sea con doble clic (con *Permitir acceso a URLs de archivos* activado) o con `python -m http.server` y `http://127.0.0.1:8000/demo/prueba.html`. Trae casos limpios, ofensivos y difíciles (contra-discurso, crítica dura, cita) y una caja para agregar tus propios comentarios. Todo queda solo en esa página.

**Sitios reales, editando solo tu copia local.** En YouTube, Instagram, Facebook o el sitio que sea:

1. Clic derecho sobre el texto de un comentario → **Inspeccionar**.
2. En el panel *Elements*, doble clic sobre el texto del nodo y reemplázalo por un comentario de prueba. Enter.
3. La extensión detecta el cambio y lo vuelve a puntuar en ~1 s.

Así se verifican los selectores del sitio real sin escribir nada en la plataforma. Al recargar la página, todo vuelve a la normalidad.

**Activando "Mostrar puntaje en todos los comentarios"** en el popup también puedes ver cómo puntúa el modelo los comentarios reales que ya existen, sin escribir nada.

## Sitios soportados

| Sitio | Qué analiza | Estado |
|---|---|---|
| YouTube | comentarios y chat en vivo | selectores `ytd-comment-view-model #content-text` |
| Instagram | comentarios y pies de foto (`span[dir=auto]` en listas) | heurístico (clases ofuscadas) |
| Facebook | comentarios y texto de publicaciones | heurístico |
| Telegram Web (K y A) | mensajes | `.translatable-message`, `.text-content` |
| X / Twitter | `tweetText` | |
| Reddit | `shreddit-comment` | |
| Disqus (muchos periódicos) | `.post-message` (iframe) | |
| Genérico | `.comment-body`, `.comment-content`, `[itemprop=comment]`… y el blog LA PLAZA | modo genérico |

Las redes sociales cambian el DOM con frecuencia. Si un sitio deja de funcionar, normalmente basta con actualizar el selector en [`extension/sites.js`](extension/sites.js).

## Limitaciones (para el informe)

- El modelo se entrenó con respuestas a noticias en **español rioplatense** (corpus `piuba-bigdata`). Puede fallar con otro dominio o país, con ironía, contra-discurso, typos y textos en otros idiomas, que igual reciben un puntaje.
- Solo ve el texto del comentario, no el contexto (noticia, hilo).
- Trunca a 128 tokens.
- Con el umbral 0,28 se espera P ≈ 0,69 y R ≈ 0,62 en test, es decir, habrá falsos positivos y comentarios con odio que pasen. Por eso existe el botón *Mostrar*: no sustituye a la moderación humana.
- El servidor local en CPU tarda unas decenas de ms por comentario. Hay caché en el servidor y en la extensión.

## Archivos

```
extension/                 ← la carpeta que se carga en el navegador
  manifest.json            MV3, permisos: storage + localhost + *.hf.space
  background.js            llamadas al backend, caché, contador en el ícono
  sites.js                 adaptadores DOM por sitio + modo genérico
  content.js               escaneo, MutationObserver, lotes, difuminar/ocultar y badge
  content.css              estilos inyectados
  popup.*                  configuración y estado
  icons/
server/
  server.py                FastAPI + modelo A3 (preprocesado idéntico al cuaderno)
  requirements.txt
demo/
  prueba.html              página local de prueba (no publica nada)
```
