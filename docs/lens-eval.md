# Scam Lens evaluation (OpenCV 5)

Generated 2026-10-21 by `vision/scripts/eval_lens.py 640` with OpenCV 5.0.0. Same images for both columns; a read counts only if the text matches exactly.

## Generated photos

640 photos of 12 different codes (UPI payments, look-alike bank links, PayPal links, crypto, Wi-Fi). Each photo gets a random distance, extra blur, tilt, lighting and JPEG quality. These are generated, not real camera photos, so they measure robustness to each kind of damage, not real-world accuracy.

| | Plain OpenCV call (baseline) | Scam Lens view ladder |
|---|---|---|
| Read correctly | 574/640 (89.7%) | 637/640 (99.5%) |
| Wrong text (false read) | 0 | 0 |
| Median time per photo | 42 ms | 44 ms |
| 95th percentile time | 148 ms | 153 ms |

### By condition (read correctly)

| Factor | Level | Photos | Baseline | Ladder |
|---|---|---|---|---|
| distance | near | 160 | 91.9% | 100.0% |
| distance | mid | 169 | 94.7% | 98.8% |
| distance | far | 166 | 95.8% | 100.0% |
| distance | very far | 145 | 74.5% | 99.3% |
| blur | none | 152 | 95.4% | 100.0% |
| blur | some | 164 | 93.9% | 100.0% |
| blur | heavy | 161 | 88.2% | 98.8% |
| blur | extreme | 163 | 81.6% | 99.4% |
| tilt | flat | 325 | 90.2% | 100.0% |
| tilt | tilted | 315 | 89.2% | 99.0% |
| light | normal | 214 | 93.9% | 98.6% |
| light | dark | 215 | 92.1% | 100.0% |
| light | glare | 211 | 82.9% | 100.0% |
| jpeg | good | 325 | 91.4% | 99.4% |
| jpeg | poor | 315 | 87.9% | 99.7% |

### Which view decoded it (ladder)

| View / detector | Photos |
|---|---|
| raw/standard | 574 |
| raw/aruco | 36 |
| equalised/standard | 15 |
| upscaled/standard | 10 |
| equalised/aruco | 2 |

### Where it still fails

Missed photos by distance and blur: mid + heavy blur: 2, very far + extreme blur: 1.
A miss is never a guess: the app says it can't read the code and asks for a closer, steadier photo.

## Real photos

Not measured yet: no labelled real photos in `vision/data/lens_real/`.
