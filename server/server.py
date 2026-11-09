"""Servidor local de inferencia para la extensión "Menos odio a la vista".

Carga el modelo v5 multitarea (RoBERTuito compartido + 3 cabezas: vulgaridad,
insulto, odio_grupal) y expone:

    GET  /health   -> estado, modelo, umbral por defecto
    POST /predict  -> {"texts": [...]}  =>  {"probs": [...], "threshold": 0.5, "signals": {...}}

`probs` es un puntaje combinado de las cabezas que bloquean (insulto y odio_grupal, regla de
LA PLAZA), reescalado para que el umbral de cada cabeza (DEV_EVAL) caiga en 0,5. `signals`
trae las probabilidades calibradas crudas de las tres cabezas.

Uso:
    python server/server.py                 # http://127.0.0.1:8765
    HF_MODEL_ID=ruta/o/id python server/server.py
    MODELO_DIR=ruta/a/modelo_v5 python server/server.py

`multitarea_es.py` y `robustez_es.py` son copias exactas de los módulos del repo
`Tecnicas-ML/proyecto-2` (rama Fine-Tuning2). El preprocesado
(pysentimiento.preprocess_tweet) y la calibración los aplica `Predictor`.
"""
from __future__ import annotations

import importlib.metadata
import importlib.util
import os
import re
import sys
import time
import types
from collections import OrderedDict
from pathlib import Path

# La consola de Windows (cp1252) no imprime algunos símbolos que usa multitarea_es
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent


def _shim_pysentimiento() -> None:
    """Permite `from pysentimiento.preprocessing import preprocess_tweet` sin importar todo
    pysentimiento (su __init__ exige `datasets`). Así Predictor usa el mismo preprocesado
    del entrenamiento y no el respaldo básico."""
    try:
        from pysentimiento.preprocessing import preprocess_tweet  # noqa: F401

        return
    except Exception:
        pass
    try:
        pkg_dir = Path(importlib.metadata.distribution("pysentimiento").locate_file("pysentimiento"))
        spec = importlib.util.spec_from_file_location("pysentimiento.preprocessing", pkg_dir / "preprocessing.py")
        mod = importlib.util.module_from_spec(spec)
        pkg = types.ModuleType("pysentimiento")
        pkg.__path__ = [str(pkg_dir)]
        pkg.preprocessing = mod
        sys.modules["pysentimiento"] = pkg
        sys.modules["pysentimiento.preprocessing"] = mod
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
    except Exception as exc:
        for k in ("pysentimiento", "pysentimiento.preprocessing"):
            sys.modules.pop(k, None)
        raise SystemExit(
            "No se encontró pysentimiento. Instala: pip install --no-deps pysentimiento emoji"
        ) from exc


_shim_pysentimiento()

import torch  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from huggingface_hub import snapshot_download  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from multitarea_es import HEADS, Predictor  # noqa: E402

MODEL_ID = os.environ.get("HF_MODEL_ID", "DavidVargas-Ctrl/menos-odio-v5-multitarea")
MAX_CHARS = 1000  # se recorta antes de tokenizar; el modelo solo ve 128 tokens
BATCH = int(os.environ.get("BATCH", "16"))
TTA = os.environ.get("TTA", "1") != "0"  # vista normalizada (más robusta a typos, ~2x costo)
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8765"))
HEAD = "odio_grupal"  # cabeza principal (para /health)
HEAD_IDX = HEADS.index(HEAD)
# Regla de moderación del proyecto (LA PLAZA): se bloquean insulto y odio grupal; la vulgaridad sola no.
BLOCK = [h for h in os.environ.get("BLOCK_HEADS", "insulto,odio_grupal").split(",") if h in HEADS]
DEFAULT_THR = 0.5  # umbral común del puntaje combinado (ver combined())


def _model_path() -> str:
    """MODELO_DIR o modelo_v5/ local si existen; si no, descarga desde el Hub."""
    for cand in (os.environ.get("MODELO_DIR"), REPO / "modelo_v5", ROOT / "modelo_v5"):
        if cand and Path(cand, "multitarea_config.json").exists():
            return str(cand)
    if Path(MODEL_ID, "multitarea_config.json").exists():
        return MODEL_ID
    return snapshot_download(MODEL_ID)


print(f"[server] cargando modelo: {MODEL_ID}")
t0 = time.time()
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
P = Predictor.cargar(_model_path(), device=device)
THRESHOLDS = {h: float(P.thr[j]) for j, h in enumerate(HEADS)}
print(f"[server] listo en {time.time() - t0:.1f}s · device={device} · umbrales={ {h: round(v, 3) for h, v in THRESHOLDS.items()} } · bloquean={BLOCK}")

# Caché LRU texto -> probabilidades por cabeza (los feeds repiten mucho al hacer scroll)
CACHE: "OrderedDict[str, list[float]]" = OrderedDict()
CACHE_MAX = 20_000
_ws = re.compile(r"\s+")


def _norm(t: str) -> str:
    return _ws.sub(" ", (t or "")).strip()[:MAX_CHARS]


def _num(x: float) -> float:
    return 0.0 if x != x else round(float(x), 4)  # NaN (cabeza sin entrenar) -> 0


def score(texts: list[str]) -> list[list[float]]:
    """Devuelve, por texto, las probabilidades de las 3 cabezas (orden HEADS)."""
    keys = [_norm(t) for t in texts]
    todo = [k for k in dict.fromkeys(keys) if k and k not in CACHE]
    for i in range(0, len(todo), BATCH):
        chunk = todo[i : i + BATCH]
        probs = P.probs(chunk, None, tta=TTA)
        for k, row in zip(chunk, probs):
            CACHE[k] = [_num(v) for v in row]
            if len(CACHE) > CACHE_MAX:
                CACHE.popitem(last=False)
    out = []
    for k in keys:
        if k in CACHE:
            CACHE.move_to_end(k)
            out.append(CACHE[k])
        else:
            out.append([0.0] * len(HEADS))  # texto vacío
    return out


def combined(row: list[float]) -> float:
    """Puntaje único para la extensión. Cada cabeza bloqueante se reescala con una función
    lineal por tramos que lleva SU umbral de DEV_EVAL a DEFAULT_THR (0,5); el puntaje es el
    máximo. Así `puntaje >= 0,5` equivale a "alguna cabeza bloqueante supera su umbral" y el
    slider de la extensión sigue siendo monótono. No es una probabilidad calibrada."""
    best = 0.0
    for h in BLOCK:
        j = HEADS.index(h)
        p, thr = row[j], THRESHOLDS[h]
        if p < thr:
            s = p / thr * DEFAULT_THR
        else:
            s = DEFAULT_THR + (p - thr) / max(1.0 - thr, 1e-6) * (1.0 - DEFAULT_THR)
        best = max(best, s)
    return round(best, 4)


app = FastAPI(title="Menos odio a la vista — inferencia local (v5)")
# Las peticiones vienen del service worker de la extensión (origen chrome-extension://)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension|moz-extension)://.*$|^http://(127\.0\.0\.1|localhost)(:\d+)?$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class PredictIn(BaseModel):
    texts: list[str] = Field(..., max_length=256)


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_ID,
        "version": "v5",
        "head": HEAD,
        "blocking": BLOCK,
        "threshold": DEFAULT_THR,
        "thresholds": THRESHOLDS,
        "device": str(device),
        "max_len": P.max_len,
    }


@app.post("/predict")
def predict(body: PredictIn):
    t = time.time()
    rows = score(body.texts)
    return {
        "probs": [combined(r) for r in rows],
        "threshold": DEFAULT_THR,
        "signals": {h: [r[j] for r in rows] for j, h in enumerate(HEADS)},
        "thresholds": THRESHOLDS,
        "ms": round((time.time() - t) * 1000, 1),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
