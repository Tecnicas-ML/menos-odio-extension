"""Servidor local de inferencia para la extensión "Menos odio a la vista".

Carga el modelo A3 (RoBERTuito fine-tuned, salida del notebook) y expone:

    GET  /health   -> estado, modelo, umbral por defecto
    POST /predict  -> {"texts": [...]}  =>  {"probs": [...], "threshold": 0.28}

Uso:
    python server/server.py                 # http://127.0.0.1:8765
    HF_MODEL_ID=ruta/a3_model python server/server.py

Mismo preprocesado que el notebook: pysentimiento.preprocess_tweet(lang="es"),
truncado a 128 tokens, probabilidad = softmax(logits)[1].
"""
from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import os
import re
import time
from collections import OrderedDict
from pathlib import Path

import torch
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from transformers import AutoModelForSequenceClassification, AutoTokenizer

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent

# --- Modelo: HF_MODEL_ID (ruta o id del Hub) > a3_model/ local > Hub ---
# Para usar los pesos que genera el notebook, copiá su carpeta a3_model/ a la raíz
# de este repo o apuntá HF_MODEL_ID a ella.
LOCAL_CANDIDATES = [REPO / "a3_model", ROOT / "a3_model"]
MODEL_ID = os.environ.get("HF_MODEL_ID") or next(
    (str(p) for p in LOCAL_CANDIDATES if (p / "config.json").exists()),
    "tatisvivass/menos-odio-a3-robertuito",
)
MAX_LEN = 128
MAX_CHARS = 1000  # se recorta antes de tokenizar; el modelo solo ve 128 tokens
BATCH = int(os.environ.get("BATCH", "16"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8765"))

DEFAULT_THR = 0.28
for meta in (REPO / "a3_metrics.json", ROOT / "a3_metrics.json"):
    if meta.exists():
        DEFAULT_THR = float(json.loads(meta.read_text())["test_metrics"]["thr"])
        break


def _load_preprocess():
    """preprocess_tweet sin importar todo pysentimiento (su __init__ pide `datasets`)."""
    try:
        from pysentimiento.preprocessing import preprocess_tweet  # type: ignore

        return preprocess_tweet
    except Exception:
        pass
    try:
        path = Path(importlib.metadata.distribution("pysentimiento").locate_file("pysentimiento"))
        spec = importlib.util.spec_from_file_location("_pys_pre", path / "preprocessing.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod.preprocess_tweet
    except Exception as exc:  # pragma: no cover
        raise SystemExit(
            "No se encontró pysentimiento. Instalá: pip install --no-deps pysentimiento emoji"
        ) from exc


preprocess_tweet = _load_preprocess()

print(f"[server] cargando modelo: {MODEL_ID}")
t0 = time.time()
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
tok = AutoTokenizer.from_pretrained(MODEL_ID)
model = AutoModelForSequenceClassification.from_pretrained(MODEL_ID).to(device).eval()
print(f"[server] listo en {time.time() - t0:.1f}s · device={device} · umbral={DEFAULT_THR:.3f}")

# Caché LRU texto -> probabilidad (los feeds repiten mucho al hacer scroll)
CACHE: "OrderedDict[str, float]" = OrderedDict()
CACHE_MAX = 20_000
_ws = re.compile(r"\s+")


def _norm(t: str) -> str:
    return _ws.sub(" ", (t or "")).strip()[:MAX_CHARS]


@torch.inference_mode()
def score(texts: list[str]) -> list[float]:
    keys = [_norm(t) for t in texts]
    todo = [k for k in dict.fromkeys(keys) if k and k not in CACHE]
    for i in range(0, len(todo), BATCH):
        chunk = todo[i : i + BATCH]
        enc = tok(
            [preprocess_tweet(t, lang="es") for t in chunk],
            return_tensors="pt",
            truncation=True,
            max_length=MAX_LEN,
            padding=True,
        ).to(device)
        probs = torch.softmax(model(**enc).logits, dim=-1)[:, 1].tolist()
        for k, p in zip(chunk, probs):
            CACHE[k] = float(p)
            if len(CACHE) > CACHE_MAX:
                CACHE.popitem(last=False)
    out = []
    for k in keys:
        if k in CACHE:
            CACHE.move_to_end(k)
            out.append(round(CACHE[k], 4))
        else:
            out.append(0.0)  # texto vacío
    return out


app = FastAPI(title="Menos odio a la vista — inferencia local")
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
    return {"ok": True, "model": MODEL_ID, "threshold": DEFAULT_THR, "device": str(device), "max_len": MAX_LEN}


@app.post("/predict")
def predict(body: PredictIn):
    t = time.time()
    probs = score(body.texts)
    return {"probs": probs, "threshold": DEFAULT_THR, "ms": round((time.time() - t) * 1000, 1)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
