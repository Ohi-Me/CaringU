"""Scam Lens decoding on generated photos: the ladder reads damaged codes and never invents text."""
import cv2
import numpy as np

from carecircle_vision import lens
from carecircle_vision.synth import photograph

PAYLOAD = "upi://pay?pa=prize-desk@okaxis&pn=Prize%20Desk&am=5000&cu=INR&tn=Receive%20your%20prize"


def _photo(seed: int, blur: float = 0.0, scale: float = 1.0) -> np.ndarray:
    q = cv2.resize(cv2.QRCodeEncoder.create().encode(PAYLOAD), None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
    page = cv2.cvtColor(cv2.copyMakeBorder(q, 70, 70, 70, 70, cv2.BORDER_CONSTANT, value=250), cv2.COLOR_GRAY2BGR)
    img = photograph(page, seed=seed, tilt=0.2, background="random")[0]
    if blur:
        img = cv2.GaussianBlur(img, (0, 0), blur)
    return cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale != 1 else img


def test_reads_a_tilted_code_and_outlines_it():
    r = lens.scan(_photo(1))
    assert [c["text"] for c in r["codes"]] == [PAYLOAD]
    assert len(r["codes"][0]["corners"]) == 4
    assert r["annotated"].shape[2] == 3


def test_ladder_reads_at_least_what_the_baseline_reads():
    imgs = [_photo(s, blur=2.8, scale=0.4) for s in range(10, 18)]
    base = sum(any(c["text"] == PAYLOAD for c in lens.scan(i, baseline=True)["codes"]) for i in imgs)
    ours = sum(any(c["text"] == PAYLOAD for c in lens.scan(i)["codes"]) for i in imgs)
    assert ours >= base


def test_no_code_means_no_text_and_a_quality_report():
    blank = np.full((600, 800, 3), 128, np.uint8)
    r = lens.scan(blank)
    assert r["codes"] == []
    assert "sharpness" in r["quality"] and "issues" in r["quality"]


def test_scan_endpoint(client=None):
    from fastapi.testclient import TestClient
    from carecircle_vision.app import app
    ok, buf = cv2.imencode(".jpg", _photo(3))
    res = TestClient(app).post("/scan", files={"image": ("q.jpg", buf.tobytes(), "image/jpeg")})
    assert res.status_code == 200
    body = res.json()
    assert body["codes"][0]["text"] == PAYLOAD
    assert body["annotated_jpeg_b64"]
