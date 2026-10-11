"""Blister-strip inspection with OpenCV 5.

Registration (once per medicine, from a top-down reference photo):
  1. find the strip outline (Canny + morphology + contours + minAreaRect) and
     warp it to a canonical, axis-aligned frame (getPerspectiveTransform);
  2. locate the blister cavities (HoughCircles on a CLAHE-normalised image,
     regularised onto a rows x cols grid);
  3. learn the pill's appearance (CIE Lab colour of the cavity centres) and the
     foil appearance (Lab of the area between cavities);
  4. store SIFT keypoints/descriptors of the canonical strip.

Inspection (any photo: tilted, rotated, other lighting/background):
  1. SIFT + FLANN matching with Lowe's ratio test against every registered strip,
     USAC-MAGSAC homography -> which medicine (or "unknown" when evidence is weak);
  2. warpPerspective the photo into the canonical frame of that strip;
  3. classify every cavity as pill present / empty from colour distance to the
     learned pill model vs the foil, plus a texture cue (torn foil is busy);
  4. return per-cavity results, the remaining count and an annotated image.
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

import cv2
import numpy as np

CANON_LONG = 1000           # canonical long side in pixels
MAX_INPUT = 1600            # photos are downscaled to this long side before matching
MIN_INLIERS = 18            # below this the strip is "unknown" (never guess a medicine)
MIN_INLIER_RATIO = 0.12   # repetitive cavities create many weak matches; keep this loose
MIN_NCC_MARGIN = 0.10       # print-correlation lead that settles a close geometric match


# ---------------------------------------------------------------- utilities
def _resize_max(img: np.ndarray, max_side: int) -> tuple[np.ndarray, float]:
    h, w = img.shape[:2]
    s = min(1.0, max_side / max(h, w))
    return (cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA) if s < 1 else img), s


def _clahe_gray(img: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(g)


def _order_quad(pts: np.ndarray) -> np.ndarray:
    """Order 4 points as top-left, top-right, bottom-right, bottom-left."""
    pts = pts.reshape(4, 2).astype(np.float32)
    s, d = pts.sum(1), np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], np.float32)


_sift = None
def _sift_detector():
    global _sift
    if _sift is None:
        _sift = cv2.SIFT_create(nfeatures=4000)
    return _sift


# ---------------------------------------------------------------- strip outline
def find_strip_quad(img: np.ndarray) -> np.ndarray | None:
    """Largest roughly-rectangular object: the strip. Returns 4 ordered corners or None."""
    g = cv2.GaussianBlur(_clahe_gray(img), (5, 5), 0)
    edges = cv2.Canny(g, 40, 120)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15)), iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    area_img = img.shape[0] * img.shape[1]
    best = max(contours, key=cv2.contourArea)
    if cv2.contourArea(best) < 0.08 * area_img:
        return None
    box = cv2.boxPoints(cv2.minAreaRect(best))
    return _order_quad(box)


def canonicalize(img: np.ndarray, quad: np.ndarray | None) -> tuple[np.ndarray, np.ndarray]:
    """Warp the strip to an axis-aligned canonical image with the long side horizontal.
    Returns (canonical image, 3x3 homography photo->canonical)."""
    if quad is None:
        h, w = img.shape[:2]
        quad = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    tl, tr, br, bl = quad
    wq = (np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2
    hq = (np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2
    if hq > wq:  # portrait strip: rotate so the long side is horizontal
        quad = np.array([bl, tl, tr, br], np.float32)
        wq, hq = hq, wq
    W = CANON_LONG
    H = max(120, int(round(CANON_LONG * hq / max(wq, 1))))
    M = cv2.getPerspectiveTransform(quad, np.float32([[0, 0], [W, 0], [W, H], [0, H]]))
    return cv2.warpPerspective(img, M, (W, H)), M


# ---------------------------------------------------------------- cavities
@dataclass
class Cavity:
    index: int
    row: int
    col: int
    x: float
    y: float
    r: float


def _grid_shape(total: int, aspect: float) -> tuple[int, int]:
    """rows x cols factorisation of `total` whose cols/rows best matches the strip aspect."""
    best = (1, total)
    for rows in range(1, total + 1):
        if total % rows:
            continue
        cols = total // rows
        if abs(np.log((cols / rows) / aspect)) < abs(np.log((best[1] / best[0]) / aspect)):
            best = (rows, cols)
    return best


def _cluster_1d(values: np.ndarray, k: int) -> np.ndarray:
    """k cluster centres of 1-D values (cv2.kmeans), sorted."""
    if len(values) < k:
        return np.array([])
    data = values.reshape(-1, 1).astype(np.float32)
    _, _, centres = cv2.kmeans(data, k, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.1), 5, cv2.KMEANS_PP_CENTERS)
    return np.sort(centres.ravel())


def _even(centres: np.ndarray) -> np.ndarray:
    """Robust evenly-spaced fit: least squares, then refit without the worst outlier."""
    n = len(centres)
    if n < 3:
        return centres
    idx = np.arange(n, dtype=np.float64)
    b, a = np.polyfit(idx, centres, 1)
    resid = np.abs(centres - (a + b * idx))
    keep = resid < max(resid.max(), 1e-6)  # drop the single worst point
    if keep.sum() >= 2:
        b, a = np.polyfit(idx[keep], centres[keep], 1)
    return a + b * idx


def detect_cavities(canon: np.ndarray, total: int, rows: int | None = None) -> list[Cavity]:
    """HoughCircles candidates regularised onto a rows x cols grid; falls back to an even grid."""
    H, W = canon.shape[:2]
    if rows is None:
        rows, cols = _grid_shape(total, W / H)
    else:
        cols = max(1, total // rows)
    pitch = min(W / cols, H / rows)
    g = cv2.medianBlur(_clahe_gray(canon), 5)
    circles = cv2.HoughCircles(g, cv2.HOUGH_GRADIENT, dp=1.2, minDist=pitch * 0.6, param1=110, param2=26,
                               minRadius=int(pitch * 0.18), maxRadius=int(pitch * 0.55))
    xs = ys = np.array([])
    radii = np.array([])
    if circles is not None:
        c = circles[0]
        # keep circles away from the very edge of the strip
        c = c[(c[:, 0] > pitch * 0.25) & (c[:, 0] < W - pitch * 0.25) & (c[:, 1] > pitch * 0.2) & (c[:, 1] < H - pitch * 0.2)]
        xs, ys, radii = c[:, 0], c[:, 1], c[:, 2]
    row_y = _cluster_1d(ys, rows) if len(ys) >= rows else np.array([])
    if len(row_y) == rows and len(ys):
        # Drop circles that don't sit on a row (e.g. between rows); they would skew the columns.
        on_row = np.min(np.abs(ys[:, None] - row_y[None, :]), axis=1) < 0.22 * H / rows
        xs, ys, radii = xs[on_row], ys[on_row], radii[on_row]
        row_y = _cluster_1d(ys, rows) if len(ys) >= rows else np.array([])
    col_x = _cluster_1d(xs, cols) if len(xs) >= cols else np.array([])
    # Fall back to an even grid inside typical margins when detection is too sparse.
    if len(col_x) != cols or (cols > 1 and np.min(np.diff(col_x)) < pitch * 0.5):
        mx = W / cols / 2
        col_x = np.linspace(mx, W - mx, cols)
    if len(row_y) != rows or (rows > 1 and np.min(np.diff(row_y)) < pitch * 0.5):
        my = H / rows / 2
        row_y = np.linspace(my, H - my, rows)
    # Blister cavities are evenly spaced: fit position = a + b*index by least squares, which
    # removes the pull of a stray circle on any single cluster.
    col_x, row_y = _even(col_x), _even(row_y)
    r = float(np.median(radii)) if len(radii) else pitch * 0.36
    r = float(np.clip(r, pitch * 0.2, pitch * 0.48))
    return [Cavity(i * cols + j, i, j, float(col_x[j]), float(row_y[i]), r) for i in range(rows) for j in range(cols)]


# ---------------------------------------------------------------- appearance features
def _lab(img: np.ndarray) -> np.ndarray:
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    lab[..., 0] *= 100 / 255  # L in 0..100, a/b offset by 128 (fine for distances)
    return lab


def _disk_mask(shape, x, y, r) -> np.ndarray:
    m = np.zeros(shape[:2], np.uint8)
    cv2.circle(m, (int(round(x)), int(round(y))), max(2, int(round(r))), 255, -1)
    return m


def foil_lab(canon: np.ndarray, cavities: list[Cavity]) -> np.ndarray:
    """Median Lab of the strip outside the cavities (the foil/backing)."""
    mask = np.full(canon.shape[:2], 255, np.uint8)
    for c in cavities:
        cv2.circle(mask, (int(c.x), int(c.y)), int(c.r * 1.25), 0, -1)
    lab = _lab(canon)[mask > 0]
    return np.median(lab, axis=0) if len(lab) else np.array([60, 128, 128], np.float32)


def local_foil(canon: np.ndarray, cavities: list[Cavity]) -> list[np.ndarray]:
    """Foil colour in a ring around each cavity (excluding all cavities), so uneven
    lighting across the strip doesn't bias the comparison. Falls back to the global foil."""
    lab = _lab(canon)
    holes = np.zeros(canon.shape[:2], np.uint8)
    for c in cavities:
        cv2.circle(holes, (int(c.x), int(c.y)), int(c.r * 1.2), 255, -1)
    glob = foil_lab(canon, cavities)
    out = []
    for c in cavities:
        ring = _disk_mask(canon.shape, c.x, c.y, c.r * 1.75) > 0
        ring &= holes == 0
        px = lab[ring]
        out.append(np.median(px, axis=0) if len(px) > 50 else glob)
    return out


def cavity_features(canon: np.ndarray, cavities: list[Cavity], foils: list[np.ndarray], pills: list[np.ndarray] | None) -> list[dict]:
    lab = _lab(canon)
    gray = _clahe_gray(canon)
    lap = np.abs(cv2.Laplacian(gray, cv2.CV_32F, ksize=3))
    out = []
    for i, c in enumerate(cavities):
        foil = foils[i]
        pill = pills[i] if pills is not None else None
        m = _disk_mask(canon.shape, c.x, c.y, c.r * 0.6) > 0
        px = lab[m]
        if len(px) == 0:
            out.append({"foil_diff": 0.0, "pill_sim": 0.0, "texture": 0.0})
            continue
        d_foil = np.linalg.norm(px - foil, axis=1)
        feat = {
            "foil_diff": float(np.mean(d_foil > 12)),                 # share of the centre unlike foil
            "texture": float(np.mean(lap[m]) / 255),                  # torn foil / crumpled plastic is busy
            "pill_sim": 0.0,
        }
        if pill is not None:
            d_pill = np.linalg.norm(px - pill, axis=1)
            feat["pill_sim"] = float(np.mean(d_pill < np.maximum(10.0, 0.6 * np.linalg.norm(pill - foil))))
        out.append(feat)
    return out


def classify(feat: dict, has_pill_model: bool) -> tuple[str, float]:
    """Pill present vs empty. Returns (state, score in 0..1). Thresholds are calibrated in docs/vision-eval.md."""
    if has_pill_model:
        score = 0.65 * feat["pill_sim"] + 0.35 * feat["foil_diff"] - 0.8 * max(0.0, feat["texture"] - 0.12)
    else:
        score = feat["foil_diff"] - 0.8 * max(0.0, feat["texture"] - 0.12)
    score = float(np.clip(score, 0, 1))
    return ("pill" if score >= 0.45 else "empty"), score


# ---------------------------------------------------------------- reference store
@dataclass
class Reference:
    ref_id: str
    name: str
    medication_id: str | None
    total: int
    width: int
    height: int
    cavities: list[Cavity]
    foil: list[list[float]]          # local foil Lab per cavity
    pill: list[float] | None
    reference_pills: int
    created_at: float = field(default_factory=time.time)
    # runtime only
    keypoints: list = field(default_factory=list, repr=False)
    descriptors: np.ndarray | None = field(default=None, repr=False)
    canon: np.ndarray | None = field(default=None, repr=False)
    mask: np.ndarray | None = field(default=None, repr=False)

RUNTIME_FIELDS = ("keypoints", "descriptors", "canon", "mask")


def register(img: np.ndarray, ref_id: str, name: str, total: int, medication_id: str | None = None,
             rows: int | None = None, pills_in_reference: int | None = None) -> Reference:
    """Build a reference from a top-down photo of the strip."""
    img, _ = _resize_max(img, MAX_INPUT)
    canon, _ = canonicalize(img, find_strip_quad(img))
    cavities = detect_cavities(canon, total, rows)
    foils = local_foil(canon, cavities)
    # Learn the pill colour from the cavities that look most unlike foil. If the user told us
    # how many pills the reference strip holds, use exactly that many; otherwise the clear ones.
    feats = cavity_features(canon, cavities, foils, None)
    order = np.argsort([-f["foil_diff"] for f in feats])
    k = pills_in_reference if pills_in_reference is not None else int(sum(f["foil_diff"] > 0.5 for f in feats))
    lab = _lab(canon)
    pill = None
    if k > 0:
        px = np.concatenate([lab[_disk_mask(canon.shape, cavities[i].x, cavities[i].y, cavities[i].r * 0.5) > 0] for i in order[:k]])
        pill = np.median(px, axis=0)
    ref = Reference(ref_id, name, medication_id, total, canon.shape[1], canon.shape[0], cavities,
                    [f.tolist() for f in foils], None if pill is None else pill.tolist(), k)
    _attach_runtime(ref, canon)
    return ref


def print_mask(ref: "Reference") -> np.ndarray:
    """255 on the printed foil, 0 on (and just around) the cavities. Cavities look alike on
    every strip and change as pills are taken, so the print-correlation check ignores them."""
    m = np.full((ref.height, ref.width), 255, np.uint8)
    for c in ref.cavities:
        cv2.circle(m, (int(c.x), int(c.y)), int(c.r * 1.25), 0, -1)
    return m


def _attach_runtime(ref: Reference, canon: np.ndarray) -> None:
    ref.canon = canon
    ref.mask = print_mask(ref)
    kp, des = _sift_detector().detectAndCompute(_clahe_gray(canon), None)
    ref.keypoints, ref.descriptors = kp, des


def save_reference(ref: Reference, folder: Path) -> None:
    d = folder / ref.ref_id
    d.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(d / "canonical.png"), ref.canon)
    meta = {f.name: getattr(ref, f.name) for f in fields(ref) if f.name not in RUNTIME_FIELDS}
    meta["cavities"] = [asdict(c) for c in ref.cavities]
    (d / "meta.json").write_text(json.dumps(meta, indent=2))


def load_references(folder: Path) -> list[Reference]:
    refs = []
    for d in sorted(p for p in folder.glob("*") if (p / "meta.json").exists()):
        meta = json.loads((d / "meta.json").read_text())
        meta["cavities"] = [Cavity(**c) for c in meta["cavities"]]
        ref = Reference(**meta)
        _attach_runtime(ref, cv2.imread(str(d / "canonical.png")))
        refs.append(ref)
    return refs


# ---------------------------------------------------------------- inspection
def _match(ref: Reference, kp, des) -> tuple[np.ndarray | None, int, int]:
    """Homography canonical(ref) -> photo, inlier count, good-match count."""
    if des is None or ref.descriptors is None or len(des) < 8 or len(ref.descriptors) < 8:
        return None, 0, 0
    flann = cv2.FlannBasedMatcher({"algorithm": 1, "trees": 5}, {"checks": 64})
    pairs = flann.knnMatch(ref.descriptors, des, k=2)
    good = [m for m, n in (p for p in pairs if len(p) == 2) if m.distance < 0.75 * n.distance]
    if len(good) < 8:
        return None, 0, len(good)
    src = np.float32([ref.keypoints[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([kp[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    H, mask = cv2.findHomography(src, dst, cv2.USAC_MAGSAC, 4.0)
    if H is None:
        return None, 0, len(good)
    return H, int(mask.sum()), len(good)


def _print_ncc(gray_photo: np.ndarray, H: np.ndarray, ref: "Reference") -> float:
    """Normalised cross-correlation of the printed foil between the warped photo and the reference."""
    warped = cv2.warpPerspective(gray_photo, np.linalg.inv(H), (ref.width, ref.height))
    valid = cv2.warpPerspective(np.full(gray_photo.shape, 255, np.uint8), np.linalg.inv(H), (ref.width, ref.height))
    m = (ref.mask > 0) & (valid > 0)
    if m.sum() < 0.2 * m.size:
        return 0.0
    a = cv2.GaussianBlur(warped, (5, 5), 0)[m].astype(np.float32)
    b = cv2.GaussianBlur(_clahe_gray(ref.canon), (5, 5), 0)[m].astype(np.float32)
    a -= a.mean(); b -= b.mean()
    den = float(np.sqrt((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / den) if den > 0 else 0.0


def _plausible(H: np.ndarray, ref: Reference, shape) -> bool:
    """Reject degenerate homographies: projected strip must be a convex, reasonably sized quad."""
    corners = np.float32([[0, 0], [ref.width, 0], [ref.width, ref.height], [0, ref.height]]).reshape(-1, 1, 2)
    q = cv2.perspectiveTransform(corners, H).reshape(4, 2)
    if not cv2.isContourConvex(q.astype(np.float32)):
        return False
    area = cv2.contourArea(q.astype(np.float32))
    return 0.01 * shape[0] * shape[1] < area < 4.0 * shape[0] * shape[1]


def inspect(img: np.ndarray, refs: list[Reference]) -> dict:
    t0 = time.perf_counter()
    img, scale = _resize_max(img, MAX_INPUT)
    kp, des = _sift_detector().detectAndCompute(_clahe_gray(img), None)
    t_feat = time.perf_counter()
    candidates = []
    for ref in refs:
        H, inl, good = _match(ref, kp, des)
        candidates.append({"ref": ref, "H": H, "inliers": inl, "good": good})
    # Photometric verification: warp the photo onto each plausible candidate and compare the
    # printed foil (normalised cross-correlation). Geometry alone can be fooled by shared
    # structure (rims, borders); the print of a different medicine will not correlate.
    gray = _clahe_gray(img)
    for c in candidates:
        c["valid"] = c["H"] is not None and c["inliers"] >= MIN_INLIERS and _plausible(c["H"], c["ref"], img.shape)
        c["verify"] = _print_ncc(gray, c["H"], c["ref"]) if c["valid"] else 0.0
    # Only geometrically valid candidates compete; among them the most inliers wins, unless the
    # runner-up is close, in which case the printed-foil correlation must clearly settle it.
    valid = sorted((c for c in candidates if c["valid"]), key=lambda c: -c["inliers"])
    if len(valid) > 1 and valid[0]["inliers"] < 1.5 * valid[1]["inliers"] and valid[1]["verify"] > valid[0]["verify"]:
        valid[0], valid[1] = valid[1], valid[0]
    t_match = time.perf_counter()
    summary = [{"name": c["ref"].name, "inliers": c["inliers"], "good_matches": c["good"], "valid_geometry": c["valid"],
                "print_ncc": round(c["verify"], 3)} for c in sorted(candidates, key=lambda c: -c["inliers"])]
    best = valid[0] if valid else None
    runner_v = valid[1]["verify"] if len(valid) > 1 else 0.0
    runner = valid[1]["inliers"] if len(valid) > 1 else 0
    timing = lambda: {"features_ms": round((t_feat - t0) * 1000, 1), "matching_ms": round((t_match - t_feat) * 1000, 1),
                      "total_ms": round((time.perf_counter() - t0) * 1000, 1)}
    if (best is None or best["inliers"] < MIN_INLIER_RATIO * max(best["good"], 1)
            or (runner and best["inliers"] < 1.5 * runner and best["verify"] - runner_v < MIN_NCC_MARGIN)):
        return {"recognised": False, "reason": "No registered strip matches clearly enough. I won't guess which medicine this is.",
                "candidates": summary, "timing": timing(), "annotated": None}
    ref: Reference = best["ref"]
    Hinv = np.linalg.inv(best["H"])
    canon = cv2.warpPerspective(img, Hinv, (ref.width, ref.height))
    foils_now = local_foil(canon, ref.cavities)
    pills = None
    if ref.pill is not None:
        # Shift the learned pill colour by the local lighting change seen on the foil around each cavity.
        pills = [np.array(ref.pill) + (fn - np.array(fr)) * np.array([1.0, 0.5, 0.5]) for fn, fr in zip(foils_now, ref.foil)]
    feats = cavity_features(canon, ref.cavities, foils_now, pills)
    cav_out, annotated = [], img.copy()
    for c, f in zip(ref.cavities, feats):
        state, score = classify(f, pills is not None)
        cav_out.append({"index": c.index, "row": c.row, "col": c.col, "state": state, "score": round(score, 3),
                        "features": {k: round(v, 3) for k, v in f.items()}})
        centre = cv2.perspectiveTransform(np.float32([[[c.x, c.y]]]), best["H"])[0, 0]
        edge = cv2.perspectiveTransform(np.float32([[[c.x + c.r, c.y]]]), best["H"])[0, 0]
        rr = max(4, int(np.linalg.norm(edge - centre)))
        colour = (60, 200, 60) if state == "pill" else (40, 40, 230)
        cv2.circle(annotated, (int(centre[0]), int(centre[1])), rr, colour, 3, cv2.LINE_AA)
    outline = cv2.perspectiveTransform(np.float32([[0, 0], [ref.width, 0], [ref.width, ref.height], [0, ref.height]]).reshape(-1, 1, 2), best["H"])
    cv2.polylines(annotated, [outline.astype(np.int32)], True, (255, 200, 0), 2, cv2.LINE_AA)
    remaining = sum(c["state"] == "pill" for c in cav_out)
    return {
        "recognised": True, "ref_id": ref.ref_id, "name": ref.name, "medication_id": ref.medication_id,
        "match": {"inliers": best["inliers"], "good_matches": best["good"], "print_ncc": round(best["verify"], 3),
                  "runner_up_ncc": round(runner_v, 3), "runner_up_inliers": runner},
        "total_cavities": ref.total, "pills_remaining": remaining, "empty": ref.total - remaining,
        "cavities": cav_out, "candidates": summary, "timing": timing(), "annotated": annotated,
        "scale": scale,
    }
