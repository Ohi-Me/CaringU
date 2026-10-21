"""Make the Scam Lens sample photos used by the "Try a sample" buttons in the web demo.

They are generated, not real photos: a QR code made with OpenCV's encoder, printed on a
simple flyer, then "photographed" (tilt, lighting, blur, noise) with the same synth code
the strip tests use. Run from vision/: python scripts/make_lens_samples.py ../web/public/samples
"""
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from carecircle_vision.synth import photograph  # noqa: E402

SAMPLES = {
    "prize-flyer": ("upi://pay?pa=prize-desk@okaxis&pn=Prize%20Desk&am=5000&cu=INR&tn=Receive%20your%20prize",
                    ["CONGRATULATIONS!", "You won Rs 5,000 cashback", "Scan to RECEIVE now"], (60, 60, 200)),
    "kyc-message": ("https://sbi-kyc-update.xyz/verify?acct=blocked",
                    ["Dear customer, your account", "is BLOCKED. Update KYC", "today: scan the code"], (40, 40, 40)),
    "pharmacy-bill": ("upi://pay?pa=sharma.medicals@okicici&pn=Sharma%20Medicals&am=420&cu=INR&tn=Bill%202291",
                      ["Sharma Medicals", "Bill 2291   Rs 420", "Pay by UPI"], (90, 70, 30)),
}


def flyer(payload: str, lines: list[str], colour) -> np.ndarray:
    q = cv2.QRCodeEncoder.create().encode(payload)
    q = cv2.resize(q, None, fx=9, fy=9, interpolation=cv2.INTER_NEAREST)
    page = np.full((q.shape[0] + 330, max(q.shape[1] + 120, 700), 3), 250, np.uint8)
    y = 70
    for i, line in enumerate(lines[:2]):
        cv2.putText(page, line, (40, y), cv2.FONT_HERSHEY_DUPLEX, 1.25 if i == 0 else 0.95, colour, 2, cv2.LINE_AA)
        y += 60
    x0 = (page.shape[1] - q.shape[1]) // 2
    page[y:y + q.shape[0], x0:x0 + q.shape[1]] = cv2.cvtColor(q, cv2.COLOR_GRAY2BGR)
    cv2.putText(page, lines[2], (40, y + q.shape[0] + 55), cv2.FONT_HERSHEY_DUPLEX, 0.95, colour, 2, cv2.LINE_AA)
    return page


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for i, (name, (payload, lines, colour)) in enumerate(SAMPLES.items()):
        photo = photograph(flyer(payload, lines, colour), seed=100 + i, tilt=0.08, background="random")[0]
        cv2.imwrite(str(out / f"{name}.jpg"), photo, [cv2.IMWRITE_JPEG_QUALITY, 85])
        print(name, photo.shape)


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "../web/public/samples"))
