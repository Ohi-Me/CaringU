"""CareCircle vision service: OpenCV 5 blister-strip registration and inspection over HTTP.

Called by the CareCircle MCP server (Node), never directly by the language model.
Images are processed in memory; only reference strips (canonical image + metadata)
are stored, under data/refs. Run: uvicorn carecircle_vision.app:app --port 8790
"""
from __future__ import annotations

import base64
import os
import re
import threading
import time
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from . import strip

REFS_DIR = Path(os.environ.get("VISION_REFS_DIR", Path(__file__).resolve().parent.parent / "data" / "refs"))
MAX_BYTES = 12 * 1024 * 1024
ANNOTATED_MAX = 1000

app = FastAPI(title="CareCircle vision", version="0.1.0")
_lock = threading.Lock()
_refs: list[strip.Reference] = []


def _load() -> None:
    global _refs
    REFS_DIR.mkdir(parents=True, exist_ok=True)
    _refs = strip.load_references(REFS_DIR)


_load()


async def _read_image(file: UploadFile) -> np.ndarray:
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Image too large (max 12 MB)")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Could not decode image (send a JPEG or PNG)")
    return img


def _jpeg_b64(img: np.ndarray | None) -> str | None:
    if img is None:
        return None
    img, _ = strip._resize_max(img, ANNOTATED_MAX)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 82])
    return base64.b64encode(buf.tobytes()).decode() if ok else None


def _ref_summary(r: strip.Reference) -> dict:
    return {"ref_id": r.ref_id, "name": r.name, "medication_id": r.medication_id, "total": r.total,
            "rows": len({c.row for c in r.cavities}), "pills_in_reference": r.reference_pills,
            "keypoints": len(r.keypoints), "created_at": r.created_at}


@app.get("/health")
def health():
    return {"ok": True, "opencv": cv2.__version__, "references": len(_refs)}


@app.get("/references")
def references():
    return [_ref_summary(r) for r in _refs]


@app.post("/register")
async def register(image: UploadFile = File(...), name: str = Form(...), total: int = Form(...),
                   medication_id: str | None = Form(None), rows: int | None = Form(None),
                   pills_in_reference: int | None = Form(None)):
    if not 1 <= total <= 60:
        raise HTTPException(400, "total must be 1-60 cavities")
    if rows is not None and (rows < 1 or total % rows):
        raise HTTPException(400, "rows must divide total")
    if pills_in_reference is not None and not 0 <= pills_in_reference <= total:
        raise HTTPException(400, "pills_in_reference must be between 0 and total")
    img = await _read_image(image)
    ref_id = re.sub(r"[^a-z0-9_-]+", "-", (medication_id or name).lower()).strip("-")[:40] or f"ref-{int(time.time())}"
    t0 = time.perf_counter()
    ref = strip.register(img, ref_id, name[:60], total, medication_id, rows, pills_in_reference)
    with _lock:
        strip.save_reference(ref, REFS_DIR)
        global _refs
        _refs = [r for r in _refs if r.ref_id != ref_id] + [ref]
    preview = ref.canon.copy()
    for c in ref.cavities:
        cv2.circle(preview, (int(c.x), int(c.y)), int(c.r), (255, 200, 0), 2, cv2.LINE_AA)
    return {**_ref_summary(ref), "register_ms": round((time.perf_counter() - t0) * 1000, 1),
            "keypoints_warning": len(ref.keypoints) < 150, "preview_jpeg_b64": _jpeg_b64(preview)}


@app.delete("/references/{ref_id}")
def delete_reference(ref_id: str):
    global _refs
    with _lock:
        d = REFS_DIR / ref_id
        if not (d / "meta.json").exists():
            raise HTTPException(404, "No such reference")
        for f in d.iterdir():
            f.unlink()
        d.rmdir()
        _refs = [r for r in _refs if r.ref_id != ref_id]
    return {"deleted": ref_id}


@app.post("/inspect")
async def inspect(image: UploadFile = File(...)):
    img = await _read_image(image)
    if not _refs:
        return {"recognised": False, "reason": "No medicine strips have been registered yet.", "candidates": [], "annotated_jpeg_b64": None}
    result = strip.inspect(img, _refs)
    result["annotated_jpeg_b64"] = _jpeg_b64(result.pop("annotated", None))
    result.pop("scale", None)
    result["opencv"] = cv2.__version__
    return result
