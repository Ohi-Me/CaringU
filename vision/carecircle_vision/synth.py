"""Synthetic blister-strip images with exact ground truth.

Only for developing and unit-testing the pipeline before real photos exist.
Results on synthetic images are never reported as real-world accuracy.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class StripSpec:
    rows: int = 2
    cols: int = 5
    pill_bgr: tuple[int, int, int] = (235, 235, 240)    # white pill
    pill_shape: str = "round"                          # round | oval
    foil_bgr: tuple[int, int, int] = (190, 192, 196)   # silver
    label: str = "MEDICINE 5mg"
    seed: int = 0
    full: list[bool] = field(default_factory=list)     # row-major; empty list = all full


def draw_strip(spec: StripSpec, w: int = 1000, h: int = 420) -> tuple[np.ndarray, list[tuple[int, int, int]], list[bool]]:
    """Canonical, top-down strip. Returns image, cavity (x, y, r) list, full flags."""
    rng = np.random.default_rng(spec.seed)
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = spec.foil_bgr
    # brushed-foil texture + printed text so SIFT has features to lock onto
    noise = rng.normal(0, 6, (h, w)).astype(np.float32)
    noise = cv2.GaussianBlur(noise, (0, 0), sigmaX=8, sigmaY=0.6)
    img = np.clip(img.astype(np.float32) + noise[..., None], 0, 255).astype(np.uint8)
    for k in range(6):
        x = int(40 + k * 160 + rng.integers(0, 30))
        cv2.putText(img, spec.label, (x, h - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (90, 60, 40), 2, cv2.LINE_AA)
        cv2.putText(img, f"B.No{100 + k}", (x, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (60, 60, 140), 1, cv2.LINE_AA)
    cv2.rectangle(img, (4, 4), (w - 5, h - 5), (150, 150, 155), 3)

    n = spec.rows * spec.cols
    full = spec.full or [True] * n
    mx, my = 90, 85
    sx = (w - 2 * mx) / max(spec.cols - 1, 1)
    sy = (h - 2 * my) / max(spec.rows - 1, 1)
    r = int(min(sx, sy) * 0.36)
    cavities = []
    for i in range(spec.rows):
        for j in range(spec.cols):
            cx, cy = int(mx + j * sx), int(my + i * sy)
            cavities.append((cx, cy, r))
            idx = i * spec.cols + j
            # blister dome: clear plastic rim with a highlight
            cv2.circle(img, (cx, cy), r + 6, (160, 162, 168), 3, cv2.LINE_AA)
            if full[idx]:
                axes = (r - 4, r - 4) if spec.pill_shape == "round" else (r - 2, int(r * 0.55))
                cv2.ellipse(img, (cx, cy), axes, 0, 0, 360, spec.pill_bgr, -1, cv2.LINE_AA)
                cv2.ellipse(img, (cx, cy), axes, 0, 0, 360, tuple(int(c * 0.8) for c in spec.pill_bgr), 2, cv2.LINE_AA)
                cv2.line(img, (cx - r // 2, cy), (cx + r // 2, cy), tuple(int(c * 0.85) for c in spec.pill_bgr), 2)  # score line
            else:
                # popped: torn foil, dark hole and crumpled edges
                pts = np.array([[cx + rng.integers(-r, r), cy + rng.integers(-r, r)] for _ in range(9)], np.int32)
                cv2.fillPoly(img, [cv2.convexHull(pts)], (70, 72, 78))
                for _ in range(10):
                    a, b = rng.integers(-r, r, 2), rng.integers(-r, r, 2)
                    cv2.line(img, (cx + int(a[0]), cy + int(a[1])), (cx + int(b[0]), cy + int(b[1])), (220, 222, 228), 2)
            cv2.circle(img, (cx - r // 3, cy - r // 3), max(3, r // 8), (250, 250, 255), -1, cv2.LINE_AA)  # specular glint
    return img, cavities, full


def photograph(strip: np.ndarray, seed: int, out_size: tuple[int, int] = (1280, 960), tilt: float = 0.18,
               dark: float = 0.0, background: str = "random") -> tuple[np.ndarray, np.ndarray]:
    """Place the strip in a 'photo': random perspective, background, lighting gradient, blur, noise.
    Returns the photo and the 3x3 homography canonical->photo (ground truth)."""
    rng = np.random.default_rng(seed)
    W, H = out_size
    h, w = strip.shape[:2]
    if background == "random":
        bg = rng.integers(40, 200, 3)
        photo = np.full((H, W, 3), bg, np.uint8)
        tex = cv2.GaussianBlur(rng.normal(0, 18, (H, W)).astype(np.float32), (0, 0), 3)
        photo = np.clip(photo.astype(np.float32) + tex[..., None], 0, 255).astype(np.uint8)
    else:
        photo = np.full((H, W, 3), 225, np.uint8)
    scale = rng.uniform(0.6, 0.85) * W / w
    cw, ch = w * scale, h * scale
    cx, cy = W / 2 + rng.uniform(-60, 60), H / 2 + rng.uniform(-60, 60)
    ang = np.deg2rad(rng.uniform(-25, 25))
    corners = np.array([[-cw / 2, -ch / 2], [cw / 2, -ch / 2], [cw / 2, ch / 2], [-cw / 2, ch / 2]])
    rot = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
    dst = corners @ rot.T + [cx, cy]
    dst += rng.uniform(-tilt, tilt, dst.shape) * [cw * 0.25, ch * 0.25]
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    Hm = cv2.getPerspectiveTransform(src, dst.astype(np.float32))
    warped = cv2.warpPerspective(strip, Hm, (W, H))
    mask = cv2.warpPerspective(np.full((h, w), 255, np.uint8), Hm, (W, H))
    photo[mask > 0] = warped[mask > 0]
    # lighting gradient + exposure + blur + sensor noise
    gx = np.linspace(rng.uniform(0.7, 1.0), rng.uniform(1.0, 1.25), W, dtype=np.float32)
    light = np.tile(gx, (H, 1)) * (1.0 - dark)
    photo = np.clip(photo.astype(np.float32) * light[..., None] + rng.normal(0, 4, photo.shape), 0, 255).astype(np.uint8)
    photo = cv2.GaussianBlur(photo, (0, 0), rng.uniform(0.3, 1.0))
    return photo, Hm
