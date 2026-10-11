# Strip check evaluation

**Status: waiting for real photos.** No real-photo results yet.

So far the pipeline has only been tested on **synthetic** strips (rendered images with exact ground truth):
13 unit/HTTP tests and an end-to-end test pass, with zero wrong-medicine identifications on those images.
Synthetic results are not evidence of real-world accuracy.

To produce this report from real photos, follow [PHOTO-GUIDE.md](PHOTO-GUIDE.md), then run:

```bash
cd vision
.venv/Scripts/python scripts/eval_real.py data/raw --out ../docs/vision-eval.md
```
