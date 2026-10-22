"""Scam Lens evaluation: how often is the code read correctly, and does the view ladder help?

Generated set (always run): QR codes made with OpenCV's encoder from realistic payloads, placed
on a page and "photographed" with controlled difficulty: distance (downscale), extra blur, tilt,
darkness, glare and heavy JPEG compression. Each photo is decoded twice on the same image:
  baseline = one plain cv2.QRCodeDetector().detectAndDecodeMulti call on the photo
  ladder   = lens.scan(): equalised / upscaled / sharpened / binarised views x two detectors
A decode counts as correct only if the text matches exactly; a different text is a false read.

Real set (optional): photos in data/lens_real/ with labels.json {"file.jpg": "expected text" | null}
(null = no readable code expected). These are reported separately and never mixed with the
generated numbers.

Run from vision/: python scripts/eval_lens.py [N] > ../docs/lens-eval.md
"""
import json
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from carecircle_vision import lens  # noqa: E402
from carecircle_vision.synth import photograph  # noqa: E402

PAYLOADS = [
    "upi://pay?pa=prize-desk@okaxis&pn=Prize%20Desk&am=5000&cu=INR&tn=Receive%20your%20prize",
    "upi://pay?pa=sharma.medicals@okicici&pn=Sharma%20Medicals&am=420&cu=INR&tn=Bill%202291",
    "upi://pay?pa=kyc.helpdesk@ybl&pn=KYC%20Update&am=10&cu=INR",
    "upi://pay?pa=electricity.board@sbi&pn=MSEDCL&am=1830.50&cu=INR&tn=Consumer%20170012",
    "https://sbi-kyc-update.xyz/verify?acct=blocked",
    "https://paypa1-secure.com/verify",
    "https://paypal.me/helpdesk/250USD",
    "https://www.onlinesbi.sbi/",
    "http://bit.ly/3xYz9Q",
    "https://example.com/files/PMKisan.apk",
    "bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh?amount=0.01",
    "WIFI:T:WPA;S:Clinic-Guest;P:wait4doctor;;",
]
# Real photos are of the three demo samples (phone photos named prize_N, kyc_N, pharmacy_N or nocode_N), so the file name gives the label.
REAL_PREFIX = {"prize": PAYLOADS[0], "pharmacy": PAYLOADS[1], "kyc": PAYLOADS[4], "nocode": None}
DISTANCE = {"near": 1.0, "mid": 0.55, "far": 0.33, "very far": 0.22}  # whole photo downscaled
BLUR = {"none": 0.0, "some": 1.6, "heavy": 2.8, "extreme": 4.0}  # extra Gaussian sigma
TILT = {"flat": 0.04, "tilted": 0.28}
LIGHT = {"normal": "normal", "dark": "dark", "glare": "glare"}
JPEG = {"good": 90, "poor": 30}


def make_photo(payload: str, rng: np.random.Generator, seed: int, cond: dict) -> np.ndarray:
    q = cv2.QRCodeEncoder.create().encode(payload)
    q = cv2.resize(q, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
    page = cv2.copyMakeBorder(q, 70, 70, 70, 70, cv2.BORDER_CONSTANT, value=250)
    page = cv2.cvtColor(page, cv2.COLOR_GRAY2BGR)
    photo = photograph(page, seed=seed, tilt=TILT[cond["tilt"]], dark=0.55 if cond["light"] == "dark" else 0.0,
                       background="random")[0]
    if cond["light"] == "glare":
        h, w = photo.shape[:2]
        glare = np.zeros((h, w), np.float32)
        cv2.ellipse(glare, (int(rng.uniform(.35, .65) * w), int(rng.uniform(.35, .65) * h)), (w // 7, h // 9),
                    float(rng.uniform(0, 180)), 0, 360, 1.0, -1)
        glare = cv2.GaussianBlur(glare, (0, 0), 25)
        photo = np.clip(photo.astype(np.float32) + glare[..., None] * 170, 0, 255).astype(np.uint8)
    if BLUR[cond["blur"]]:
        photo = cv2.GaussianBlur(photo, (0, 0), BLUR[cond["blur"]])
    f = DISTANCE[cond["distance"]]
    if f < 1:
        photo = cv2.resize(photo, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", photo, [cv2.IMWRITE_JPEG_QUALITY, JPEG[cond["jpeg"]]])
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def judge(result: dict, expected: str | None) -> str:
    texts = [c["text"] for c in result["codes"]]
    if expected is None:
        return "correct" if not texts else "false_read"
    if expected in texts:
        return "correct"
    return "false_read" if texts else "missed"


def pct(n: int, d: int) -> str:
    return f"{100 * n / d:.1f}%" if d else "-"


def main(n: int) -> None:
    rng = np.random.default_rng(2026)
    factors = {"distance": DISTANCE, "blur": BLUR, "tilt": TILT, "light": LIGHT, "jpeg": JPEG}
    rows = []
    for i in range(n):
        cond = {k: list(v)[rng.integers(len(v))] for k, v in factors.items()}
        payload = PAYLOADS[i % len(PAYLOADS)]
        img = make_photo(payload, rng, 5000 + i, cond)
        b = lens.scan(img, baseline=True)
        l = lens.scan(img)
        rows.append({**cond, "payload": payload, "baseline": judge(b, payload), "ladder": judge(l, payload),
                     "b_ms": b["ms"], "l_ms": l["ms"], "method": l["method"]})

    out = []
    p = out.append
    p("# Scam Lens evaluation (OpenCV 5)\n")
    p(f"Generated {time.strftime('%Y-%m-%d')} by `vision/scripts/eval_lens.py {n}` with OpenCV {cv2.__version__}. "
      "Same images for both columns; a read counts only if the text matches exactly.\n")
    p("## Generated photos\n")
    p(f"{n} photos of {len(PAYLOADS)} different codes (UPI payments, look-alike bank links, PayPal links, crypto, Wi-Fi). "
      "Each photo gets a random distance, extra blur, tilt, lighting and JPEG quality. These are generated, "
      "not real camera photos, so they measure robustness to each kind of damage, not real-world accuracy.\n")
    tot = len(rows)
    bc = sum(r["baseline"] == "correct" for r in rows)
    lc = sum(r["ladder"] == "correct" for r in rows)
    bf = sum(r["baseline"] == "false_read" for r in rows)
    lf = sum(r["ladder"] == "false_read" for r in rows)
    p("| | Plain OpenCV call (baseline) | Scam Lens view ladder |")
    p("|---|---|---|")
    p(f"| Read correctly | {bc}/{tot} ({pct(bc, tot)}) | {lc}/{tot} ({pct(lc, tot)}) |")
    p(f"| Wrong text (false read) | {bf} | {lf} |")
    p(f"| Median time per photo | {statistics.median(r['b_ms'] for r in rows):.0f} ms | {statistics.median(r['l_ms'] for r in rows):.0f} ms |")
    p(f"| 95th percentile time | {sorted(r['b_ms'] for r in rows)[int(.95 * tot) - 1]:.0f} ms | {sorted(r['l_ms'] for r in rows)[int(.95 * tot) - 1]:.0f} ms |\n")
    p("### By condition (read correctly)\n")
    p("| Factor | Level | Photos | Baseline | Ladder |")
    p("|---|---|---|---|---|")
    for k, levels in factors.items():
        for lv in levels:
            sub = [r for r in rows if r[k] == lv]
            p(f"| {k} | {lv} | {len(sub)} | {pct(sum(r['baseline'] == 'correct' for r in sub), len(sub))} | "
              f"{pct(sum(r['ladder'] == 'correct' for r in sub), len(sub))} |")
    used = defaultdict(int)
    for r in rows:
        if r["ladder"] == "correct":
            used[r["method"]] += 1
    p("\n### Which view decoded it (ladder)\n")
    p("| View / detector | Photos |")
    p("|---|---|")
    for m, c in sorted(used.items(), key=lambda x: -x[1]):
        p(f"| {m} | {c} |")
    hard = [r for r in rows if r["ladder"] != "correct"]
    p("\n### Where it still fails\n")
    if hard:
        worst = defaultdict(int)
        for r in hard:
            worst[(r["distance"], r["blur"])] += 1
        p("Missed photos by distance and blur: " + ", ".join(f"{d} + {b} blur: {c}" for (d, b), c in sorted(worst.items(), key=lambda x: -x[1])) + ".")
        p("A miss is never a guess: the app says it can't read the code and asks for a closer, steadier photo.\n")
    else:
        p("No misses in this run.\n")

    real_dir = Path(__file__).resolve().parent.parent / "data" / "lens_real"
    labels = real_dir / "labels.json"
    p("## Real photos\n")
    lab = json.loads(labels.read_text(encoding="utf-8")) if labels.exists() else {
        f.name: REAL_PREFIX[f.name.split("_")[0]] for f in sorted(real_dir.glob("*.jp*g")) if f.name.split("_")[0] in REAL_PREFIX
    } if real_dir.exists() else {}
    if lab:
        res = []
        for name, expected in lab.items():
            img = cv2.imread(str(real_dir / name))
            if img is None:
                continue
            res.append((judge(lens.scan(img, baseline=True), expected), judge(lens.scan(img), expected)))
        k = len(res)
        p(f"{k} real phone photos in `vision/data/lens_real/` (labels in labels.json).\n")
        p("| | Baseline | Ladder |")
        p("|---|---|---|")
        p(f"| Correct | {pct(sum(a == 'correct' for a, _ in res), k)} | {pct(sum(b == 'correct' for _, b in res), k)} |")
        p(f"| False read | {sum(a == 'false_read' for a, _ in res)} | {sum(b == 'false_read' for _, b in res)} |")
    else:
        p("Not measured yet: no labelled real photos in `vision/data/lens_real/`.")
    print("\n".join(out))


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 480)
