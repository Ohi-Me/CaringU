"""Scam Lens: find and decode QR codes in a phone photo with OpenCV 5.

This module only reports what the codes say, where they are and how good the photo is.
Whether a code is a scam is decided by fixed rules in the Node server (server/src/lens.ts),
so the same rules apply whatever camera or model produced the text.

Phone photos of codes are often small, tilted, blurred or shot off a glossy screen, so a
single decoder call misses many of them. scan() tries a short ladder of views (raw, contrast
equalised, upscaled, sharpened, binarised) with two OpenCV detectors and stops at the first
view that decodes. scan(baseline=True) is the single plain call, kept for the evaluation.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import cv2
import numpy as np

MAX_SIDE = 1600
BLURRY_BELOW = 60.0      # variance of the Laplacian on the grey image
DARK_BELOW = 50.0        # mean grey level
GLARE_ABOVE = 225.0


@dataclass
class View:
    name: str
    image: np.ndarray
    scale: float          # view pixels per input pixel


def _resize_max(img: np.ndarray, side: int) -> tuple[np.ndarray, float]:
    h, w = img.shape[:2]
    s = min(1.0, side / max(h, w))
    return (cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA), s) if s < 1 else (img, 1.0)


def quality(gray: np.ndarray) -> dict:
    sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    bright = float(gray.mean())
    issues = [n for n, bad in (("blurry", sharp < BLURRY_BELOW), ("dark", bright < DARK_BELOW), ("glare", bright > GLARE_ABOVE)) if bad]
    return {"sharpness": round(sharp, 1), "brightness": round(bright, 1), "issues": issues}


def _views(img: np.ndarray):
    """Cheapest first; later views only run if earlier ones decoded nothing."""
    yield View("raw", img, 1.0)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    yield View("equalised", cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(gray), 1.0)
    if max(gray.shape) < 1200:
        yield View("upscaled", cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC), 2.0)
    soft = cv2.GaussianBlur(gray, (0, 0), 3)
    yield View("sharpened", cv2.addWeighted(gray, 1.8, soft, -0.8, 0), 1.0)
    yield View("binarised", cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 5), 1.0)


def _detectors():
    return [("standard", cv2.QRCodeDetector()), ("aruco", cv2.QRCodeDetectorAruco())]


def _decode(det, view: View) -> list[tuple[str, np.ndarray]]:
    try:
        ok, texts, pts, _ = det.detectAndDecodeMulti(view.image)
    except cv2.error:
        return []
    if not ok or pts is None:
        return []
    return [(t, np.asarray(p, np.float32).reshape(-1, 2) / view.scale) for t, p in zip(texts, pts) if t]


def scan(img: np.ndarray, baseline: bool = False) -> dict:
    t0 = time.perf_counter()
    img, s = _resize_max(img, MAX_SIDE)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    q = quality(gray)
    attempts = 0
    codes: list[tuple[str, np.ndarray]] = []
    method = None
    dets = _detectors()[:1] if baseline else _detectors()
    for view in _views(img):
        for name, det in dets:
            attempts += 1
            codes = _decode(det, view)
            if codes:
                method = f"{view.name}/{name}"
                break
        if codes or baseline:
            break
    # A code-like pattern that would not decode is worth a second photo, not a guess.
    unreadable = False
    if not codes:
        try:
            unreadable = bool(cv2.QRCodeDetector().detect(gray)[0])
        except cv2.error:
            unreadable = False
    seen: set[str] = set()
    out = []
    annotated = img.copy()
    for text, p in codes:
        if text in seen:
            continue
        seen.add(text)
        out.append({"text": text, "corners": [[round(float(x) / s, 1), round(float(y) / s, 1)] for x, y in p]})
        cv2.polylines(annotated, [p.astype(np.int32)], True, (40, 90, 220), 4, cv2.LINE_AA)
        x, y = p.min(axis=0)
        cv2.putText(annotated, f"code {len(out)}", (int(x), max(20, int(y) - 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (40, 90, 220), 2, cv2.LINE_AA)
    return {"codes": out, "method": method, "attempts": attempts, "found_unreadable": unreadable, "quality": q,
            "ms": round((time.perf_counter() - t0) * 1000, 1), "annotated": annotated, "opencv": cv2.__version__}
