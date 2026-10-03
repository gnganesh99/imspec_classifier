"""Collect the pure-Python wheels the browser app loads into ``wheels/``.

* the SciFiReaders fork, built from git (``SCIFIREADERS_REF``, default ``main``)
* the pure-Python packages pinned in ``tools/wheels.txt`` that are not part of
  the Pyodide distribution (sidpy, dask, ...)

Writes ``wheels/manifest.json`` (list of wheel file names) which ``worker.js``
reads. Run locally before ``python -m http.server``; the Pages workflow runs it
on every deploy.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "wheels"
FORK = "https://github.com/gnganesh99/SciFiReaders"
REF = os.environ.get("SCIFIREADERS_REF", "main")
PYODIDE_PY = "3.13"  # Python version of the Pyodide release used in worker.js


def pip(*args):
    subprocess.run([sys.executable, "-m", "pip", *args, "--disable-pip-version-check"], check=True)


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir()
    pip("wheel", "--no-deps", "-w", str(OUT), f"git+{FORK}@{REF}")
    pip("download", "--no-deps", "--only-binary", ":all:", "--python-version", PYODIDE_PY,
        "-d", str(OUT), "-r", str(ROOT / "tools" / "wheels.txt"))
    wheels = sorted(p.name for p in OUT.glob("*.whl"))
    bad = [w for w in wheels if not w.endswith("-none-any.whl")]
    if bad:
        sys.exit(f"not pure-Python, cannot load in Pyodide: {bad}")
    (OUT / "manifest.json").write_text(json.dumps(wheels, indent=1))
    print("\n".join(wheels))


if __name__ == "__main__":
    main()
