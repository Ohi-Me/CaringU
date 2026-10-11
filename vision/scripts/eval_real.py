"""Evaluate the strip check on labelled photos.

Folder layout (see docs/PHOTO-GUIDE.md):
  ref_<medicine>_<left>of<total>.jpg     one reference per strip (top-down)
  <medicine>_<left>of<total>_<n>[_back].jpg   test photos

Reports, per photo and overall:
  * identification: correct / refused / WRONG medicine
  * pill count: exact, within 1, absolute error
  * latency
and compares with a BASELINE that skips reference matching (strip outline +
the same cavity grid and classifier), to show what SIFT + homography adds.

Usage:  python scripts/eval_real.py data/raw  [--out ../docs/vision-eval.md] [--label real]
"""
from __future__ import annotations

import argparse
import re
import statistics
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from carecircle_vision import strip  # noqa: E402

REF = re.compile(r"^ref_(?P<name>[a-z0-9-]+)_(?P<left>\d+)of(?P<total>\d+)\.(jpe?g|png)$", re.I)
TEST = re.compile(r"^(?P<name>[a-z0-9-]+)_(?P<left>\d+)of(?P<total>\d+)_(?P<n>\d+)(?P<back>_back)?\.(jpe?g|png)$", re.I)


def baseline_count(img: np.ndarray, ref: strip.Reference) -> int | None:
    """No reference matching: find the strip outline, warp, put the reference's cavity grid on it
    and use the same classifier. Fails when the outline is not found or the strip is upside down."""
    img, _ = strip._resize_max(img, strip.MAX_INPUT)
    quad = strip.find_strip_quad(img)
    if quad is None:
        return None
    canon, _ = strip.canonicalize(img, quad)
    canon = cv2.resize(canon, (ref.width, ref.height))
    foils = strip.local_foil(canon, ref.cavities)
    pills = None
    if ref.pill is not None:
        pills = [np.array(ref.pill) + (fn - np.array(fr)) * np.array([1.0, 0.5, 0.5]) for fn, fr in zip(foils, ref.foil)]
    feats = strip.cavity_features(canon, ref.cavities, foils, pills)
    return sum(strip.classify(f, pills is not None)[0] == "pill" for f in feats)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--out", default=None)
    ap.add_argument("--label", default="real")
    a = ap.parse_args()
    folder = Path(a.folder)
    files = sorted(p for p in folder.iterdir() if p.is_file())

    refs, ref_info = [], {}
    for p in files:
        m = REF.match(p.name)
        if not m:
            continue
        img = cv2.imread(str(p))
        if img is None:
            print(f"! unreadable {p.name}")
            continue
        total, left = int(m["total"]), int(m["left"])
        ref = strip.register(img, m["name"].lower(), m["name"], total, None, None, left)
        refs.append(ref)
        ref_info[ref.ref_id] = {"total": total, "keypoints": len(ref.keypoints), "pill_model": ref.pill is not None}
    if not refs:
        sys.exit("No reference photos (ref_<medicine>_<left>of<total>.jpg) found.")

    rows, lat = [], []
    for p in files:
        m = TEST.match(p.name)
        if not m:
            continue
        img = cv2.imread(str(p))
        if img is None:
            continue
        truth_name, truth_left = m["name"].lower(), int(m["left"])
        registered = truth_name in ref_info
        t0 = time.perf_counter()
        r = strip.inspect(img, refs)
        lat.append((time.perf_counter() - t0) * 1000)
        ident = "refused" if not r["recognised"] else ("correct" if r["ref_id"] == truth_name else "WRONG")
        pred = r.get("pills_remaining")
        ref = next((x for x in refs if x.ref_id == truth_name), None)
        base = baseline_count(img, ref) if ref else None
        rows.append({"file": p.name, "registered": registered, "back": bool(m["back"]), "ident": ident,
                     "truth": truth_left, "pred": pred if ident == "correct" else None, "baseline": base,
                     "inliers": (r.get("match") or {}).get("inliers"), "ms": round(lat[-1])})

    def rate(xs, cond):
        xs = list(xs)
        return f"{sum(map(cond, xs))}/{len(xs)}" if xs else "0/0"

    front = [r for r in rows if r["registered"] and not r["back"]]
    counted = [r for r in front if r["pred"] is not None]
    base_counted = [r for r in front if r["baseline"] is not None]
    unreg = [r for r in rows if not r["registered"]]
    lines = [
        f"# Strip check evaluation ({a.label})", "",
        f"OpenCV {cv2.__version__}. {len(refs)} reference strips, {len(rows)} test photos "
        f"({len(front)} front-side of registered strips, {sum(r['back'] for r in rows)} foil-side, {len(unreg)} of unregistered strips).", "",
        "## Identification (front side, registered strips)", "",
        f"- correct: {rate(front, lambda r: r['ident'] == 'correct')}",
        f"- refused (said it couldn't tell): {rate(front, lambda r: r['ident'] == 'refused')}",
        f"- **wrong medicine: {rate(front, lambda r: r['ident'] == 'WRONG')}**",
        f"- unregistered strips correctly refused: {rate(unreg, lambda r: r['ident'] == 'refused')}", "",
        "## Pill count (photos where the medicine was identified)", "",
        f"- exact: {rate(counted, lambda r: r['pred'] == r['truth'])}",
        f"- within ±1: {rate(counted, lambda r: abs(r['pred'] - r['truth']) <= 1)}",
        f"- mean absolute error: {statistics.mean(abs(r['pred'] - r['truth']) for r in counted):.2f}" if counted else "- mean absolute error: n/a", "",
        "## Baseline: no reference matching (outline + same grid/classifier)", "",
        f"- produced a count: {len(base_counted)}/{len(front)}",
        f"- exact: {rate(base_counted, lambda r: r['baseline'] == r['truth'])}",
        f"- within ±1: {rate(base_counted, lambda r: abs(r['baseline'] - r['truth']) <= 1)}", "",
        "## Latency (inspect, all photos)", "",
        f"- median {statistics.median(lat):.0f} ms, p95 {sorted(lat)[int(0.95 * (len(lat) - 1))]:.0f} ms (this machine)" if lat else "- n/a", "",
        "## Per photo", "", "| photo | identification | truth | strip check | baseline | inliers | ms |", "|---|---|---|---|---|---|---|",
    ] + [f"| {r['file']} | {r['ident']} | {r['truth']} | {r['pred'] if r['pred'] is not None else '—'} | "
         f"{r['baseline'] if r['baseline'] is not None else '—'} | {r['inliers'] or '—'} | {r['ms']} |" for r in rows] + [
        "", "## References", "", "| strip | cavities | SIFT keypoints | pill colour model |", "|---|---|---|---|",
    ] + [f"| {k} | {v['total']} | {v['keypoints']} | {'yes' if v['pill_model'] else 'no'} |" for k, v in ref_info.items()]
    report = "\n".join(lines) + "\n"
    print(report)
    if a.out:
        Path(a.out).write_text(report, encoding="utf-8")
        print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
