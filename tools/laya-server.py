# /// script
# requires-python = ">=3.11"
# dependencies = ["laya==0.4.12"]
# ///
"""Optional local decision service; run with uv run tools/laya-server.py."""

import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import laya
import torch

MODEL = "cklxx/laya-browser"
REVISION = "645cf366a2ae35f1086e8c20eff48f909bb49206"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    args = parser.parse_args()
    model = laya.load(MODEL, revision=REVISION, device=args.device)
    model.cfg["max_len"] = 1024
    model.cfg["head_max_len"] = 768
    model.model.encoder.config.reference_compile = False
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def respond(self, status, body):
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            self.respond(200 if self.path == "/health" else 404, {"model": MODEL, "revision": REVISION, "device": args.device})

        def do_POST(self):
            token = os.environ.get("LAYA_API_KEY")
            if token and self.headers.get("Authorization") != "Bearer " + token:
                return self.respond(401, {"error": "unauthorized"})
            size = int(self.headers.get("Content-Length", "0"))
            if self.path != "/v1/systemone" or not 0 < size <= 1_000_000:
                return self.respond(400, {"error": "invalid request"})
            try:
                body = json.loads(self.rfile.read(size))
                source = body["state"]
                fields = "; ".join(f"{e['label']}: checked={e['checked']}" if "checked" in e else f"{e['label']} = {e.get('value', '')!r}" for e in source.get("elements", []) if any(op in e.get("operations", []) for op in ("TYPE_TEXT", "SELECT", "CHECK", "UNCHECK")))
                state = {"fields": fields[:2000], "page": {**source.get("page", {}), "text": source.get("page", {}).get("text", "")[:1200]}, "recent_actions": source.get("recent_actions", [])[-10:]}
                questions = {}
                for key, question in body["questions"].items():
                    criteria = {}
                    for option, value in question["criteria"].items():
                        if isinstance(value, dict):
                            label = value.get("element", "").split("] ", 1)[-1]
                            value = label[:110] + f" ({value.get('role', '')})" + (f" = {value['current_value']!r}" if value.get("current_value") else "")
                            if "checked" in question["criteria"][option]:
                                value += " checked=" + str(question["criteria"][option]["checked"])
                        criteria[option] = value
                    questions[key] = {**question, "criteria": criteria}
                started = time.perf_counter()
                with lock:
                    result = model.predict(state, questions)
                result["model"] = MODEL + "@" + REVISION
                result["latency_ms"] = round((time.perf_counter() - started) * 1000, 2)
                self.respond(200, result)
            except Exception as error:
                print(type(error).__name__, flush=True)
                self.respond(422, {"error": "decision request failed"})

    print(json.dumps({"ready": True, "port": args.port, "model": MODEL, "revision": REVISION, "device": args.device}), flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
