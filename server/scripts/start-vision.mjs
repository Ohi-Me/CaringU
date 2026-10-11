// Starts the Python OpenCV vision service from ../vision/.venv (see vision/README.md).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
const dir = resolve("../vision");
const py = join(dir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
if (!existsSync(py)) {
  console.error(`No venv at ${py}. Run: python -m venv ../vision/.venv && ../vision/.venv/Scripts/pip install -r ../vision/requirements.txt`);
  process.exit(1);
}
spawn(py, ["-m", "uvicorn", "carecircle_vision.app:app", "--host", "127.0.0.1", "--port", process.env.VISION_PORT ?? "8790"], { cwd: dir, stdio: "inherit" })
  .on("exit", (code) => process.exit(code ?? 0));
