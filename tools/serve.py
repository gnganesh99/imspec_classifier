"""Local web server for trying the app: like `python -m http.server`, but the browser never caches the files.

    python tools/serve.py [port]        (default 8000)

Run it from any folder; it serves the project root. Open http://localhost:<port>.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("", port), partial(NoCacheHandler, directory=str(ROOT)))
    print(f"Serving {ROOT} at http://localhost:{port}  (Ctrl+C to stop)")
    server.serve_forever()
