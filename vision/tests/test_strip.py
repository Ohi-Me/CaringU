"""Pipeline tests on SYNTHETIC strips (exact ground truth). They check the mechanics:
identification, rejection of unknown strips, geometry and per-cavity classification
under perspective, rotation, lighting gradients and blur. Real-photo accuracy is
measured separately (scripts/eval_real.py) and reported in docs/vision-eval.md."""
import numpy as np
import pytest

from carecircle_vision import strip
from carecircle_vision.synth import StripSpec, draw_strip, photograph

DESIGNS = {
    "amlo": StripSpec(rows=2, cols=5, seed=1, label="AMLO 5mg", pill_bgr=(235, 235, 240)),
    "metf": StripSpec(rows=2, cols=5, seed=7, label="METFORMIN 500", pill_bgr=(120, 170, 235), pill_shape="oval"),
    "ator": StripSpec(rows=1, cols=10, seed=3, label="ATORVA 10", pill_bgr=(200, 120, 60)),
    "levo": StripSpec(rows=2, cols=7, seed=5, label="THYROX 50mcg", pill_bgr=(150, 220, 160)),
}


def _variant(name: str, full: list[bool]) -> np.ndarray:
    s = DESIGNS[name]
    return draw_strip(StripSpec(rows=s.rows, cols=s.cols, seed=s.seed, label=s.label, pill_bgr=s.pill_bgr, pill_shape=s.pill_shape, full=full))[0]


@pytest.fixture(scope="module")
def refs():
    out = []
    for i, (name, s) in enumerate(DESIGNS.items()):
        photo, _ = photograph(draw_strip(s)[0], seed=1000 + i, tilt=0.0, background="plain")
        out.append(strip.register(photo, name, name, s.rows * s.cols, f"med_{name}", rows=s.rows, pills_in_reference=s.rows * s.cols))
    return out


@pytest.mark.parametrize("name", list(DESIGNS))
def test_registration_finds_the_grid(refs, name):
    ref = next(r for r in refs if r.ref_id == name)
    s = DESIGNS[name]
    assert len(ref.cavities) == s.rows * s.cols
    xs = sorted({round(c.x) for c in ref.cavities})
    gaps = np.diff(xs)
    assert gaps.std() < 0.05 * gaps.mean(), "columns should be evenly spaced"


@pytest.mark.parametrize("name", list(DESIGNS))
def test_identifies_and_counts_under_perspective_and_lighting(refs, name):
    s = DESIGNS[name]
    n = s.rows * s.cols
    correct = total = recognised = 0
    for k in range(6):
        rng = np.random.default_rng(k + 50)
        full = list(rng.random(n) > 0.45)
        photo, _ = photograph(_variant(name, full), seed=300 + k, tilt=0.15, dark=0.25 if k == 5 else 0.0)
        r = strip.inspect(photo, refs)
        if not r["recognised"]:
            continue  # refusing is allowed (and counted); naming the WRONG medicine is not
        assert r["ref_id"] == name, f"misidentified {name} as {r['ref_id']}"
        recognised += 1
        pred = [c["state"] == "pill" for c in r["cavities"]]
        correct += sum(p == t for p, t in zip(pred, full))
        total += n
    assert recognised >= 5, f"{name}: recognised only {recognised}/6"
    assert correct / total >= 0.95, f"{name}: {correct}/{total}"


def test_unknown_strip_is_refused_not_guessed(refs):
    stranger = draw_strip(StripSpec(rows=2, cols=4, seed=99, label="UNKNOWN DRUG", pill_bgr=(90, 90, 230)))[0]
    photo, _ = photograph(stranger, seed=7, tilt=0.1)
    r = strip.inspect(photo, refs)
    assert r["recognised"] is False
    assert "won't guess" in r["reason"]


def test_blank_photo_is_refused(refs):
    r = strip.inspect(np.full((900, 1200, 3), 128, np.uint8), refs)
    assert r["recognised"] is False


def test_reference_roundtrip(tmp_path, refs):
    strip.save_reference(refs[0], tmp_path)
    loaded = strip.load_references(tmp_path)
    assert len(loaded) == 1 and loaded[0].ref_id == refs[0].ref_id
    assert len(loaded[0].cavities) == len(refs[0].cavities)
    assert loaded[0].descriptors is not None
