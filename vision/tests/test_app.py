"""HTTP contract of the vision service (synthetic images)."""
import cv2
from fastapi.testclient import TestClient

from carecircle_vision.synth import StripSpec, draw_strip, photograph


def _jpeg(img):
    return cv2.imencode(".jpg", img)[1].tobytes()


def test_register_then_inspect(tmp_path, monkeypatch):
    monkeypatch.setenv("VISION_REFS_DIR", str(tmp_path))
    import importlib, carecircle_vision.app as appmod
    importlib.reload(appmod)
    c = TestClient(appmod.app)
    assert c.get("/health").json()["opencv"].startswith("5.")
    assert c.post("/inspect", files={"image": ("x.jpg", _jpeg(draw_strip(StripSpec())[0]))}).json()["recognised"] is False

    spec = StripSpec(seed=1, label="AMLO 5mg")
    ref_photo, _ = photograph(draw_strip(spec)[0], seed=1, tilt=0, background="plain")
    r = c.post("/register", data={"name": "Amlodipine 5 mg", "total": "10", "medication_id": "med_amlo", "rows": "2", "pills_in_reference": "10"},
               files={"image": ("ref.jpg", _jpeg(ref_photo))})
    assert r.status_code == 200, r.text
    assert r.json()["ref_id"] == "med_amlo"

    full = [True] * 7 + [False] * 3
    photo, _ = photograph(draw_strip(StripSpec(seed=1, label="AMLO 5mg", full=full))[0], seed=42, tilt=0.12)
    res = c.post("/inspect", files={"image": ("p.jpg", _jpeg(photo))}).json()
    assert res["recognised"] and res["medication_id"] == "med_amlo"
    assert res["pills_remaining"] == 7
    assert res["annotated_jpeg_b64"]


def test_rejects_bad_input(tmp_path, monkeypatch):
    monkeypatch.setenv("VISION_REFS_DIR", str(tmp_path))
    import importlib, carecircle_vision.app as appmod
    importlib.reload(appmod)
    c = TestClient(appmod.app)
    assert c.post("/inspect", files={"image": ("x.jpg", b"not an image")}).status_code == 400
    bad = c.post("/register", data={"name": "x", "total": "7", "rows": "2"}, files={"image": ("r.jpg", _jpeg(draw_strip(StripSpec())[0]))})
    assert bad.status_code == 400
