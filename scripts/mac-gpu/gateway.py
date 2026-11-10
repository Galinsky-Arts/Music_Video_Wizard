#!/usr/bin/env python3
"""Authenticated loopback-only gateway for a user-owned ComfyUI GPU server."""
import argparse
import hmac
import http.client
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

class Gateway(BaseHTTPRequestHandler):
    server_version = "MusicVideoWizardGPU/1"
    def log_message(self, format, *args):
        # Never log headers, authorization values, or query strings.
        pass
    def respond(self, code, text):
        body = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        self.proxy()
    def do_POST(self):
        self.proxy()
    def proxy(self):
        provided = self.headers.get("Authorization", "")
        if not hmac.compare_digest(provided.encode(), ("Bearer " + self.server.token).encode()):
            self.respond(401, '{"error":"Unauthorized"}')
            return
        url = urlsplit(self.path)
        if url.scheme or url.netloc or url.fragment:
            self.respond(400, '{"error":"Invalid request path"}')
            return
        allowed = (self.command == "POST" and url.path in ("/prompt", "/upload/image") and not url.query) or (
            self.command == "GET" and not url.query and re.fullmatch(r"/history/[a-fA-F0-9-]{36}", url.path))
        if self.command == "GET" and url.path == "/view":
            query = parse_qs(url.query, keep_blank_values=True)
            allowed = set(query) == {"filename", "subfolder", "type"} and all(len(v) == 1 for v in query.values())
            if allowed:
                name, subfolder, kind = (query[k][0] for k in ("filename", "subfolder", "type"))
                allowed = bool(name) and not any(c in name for c in ("/", "\\")) and ".." not in name and not subfolder.startswith("/") and "\\" not in subfolder and ".." not in subfolder and ":" not in subfolder and kind in ("output", "temp")
        if not allowed:
            self.respond(403, '{"error":"GPU route is not exposed"}')
            return
        if self.headers.get("Transfer-Encoding"):
            self.respond(400, '{"error":"Content-Length is required"}')
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.respond(400, '{"error":"Invalid length"}')
            return
        maximum = 12 * 1024 * 1024 if url.path == "/upload/image" else 1024 * 1024
        if length < 0 or length > maximum or (self.command == "GET" and length):
            self.respond(413, '{"error":"Request too large"}')
            return
        self.connection.settimeout(30)
        upstream = http.client.HTTPConnection("127.0.0.1", self.server.comfy_port, timeout=60)
        try:
            body = self.rfile.read(length) if length else None
            if body is not None and len(body) != length:
                self.respond(400, '{"error":"Incomplete request"}')
                return
            headers = {"Content-Length": str(length)}
            if self.headers.get("Content-Type"):
                headers["Content-Type"] = self.headers["Content-Type"]
            upstream.request(self.command, self.path, body=body, headers=headers)
            response = upstream.getresponse()
            limit = 50 * 1024 * 1024 if url.path == "/view" else 2 * 1024 * 1024
            data = response.read(limit + 1)
            if len(data) > limit:
                self.respond(502, '{"error":"GPU output exceeds the transfer limit"}')
                return
            # Do not forward redirects or private ComfyUI headers.
            if 300 <= response.status < 400:
                self.respond(502, '{"error":"GPU redirects are disabled"}')
                return
            self.send_response(response.status)
            self.send_header("Content-Type", response.getheader("Content-Type", "application/octet-stream"))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        except (OSError, http.client.HTTPException):
            self.respond(502, '{"error":"Local GPU service unavailable"}')
        finally:
            upstream.close()

def make_server(token, port=8289, comfy_port=8288):
    if len(token) < 32 or "\n" in token:
        raise ValueError("A private token of at least 32 characters is required")
    server = ThreadingHTTPServer(("127.0.0.1", port), Gateway)
    server.token = token
    server.comfy_port = comfy_port
    server.daemon_threads = True
    return server

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--token-file", required=True)
    p.add_argument("--port", type=int, default=8289)
    p.add_argument("--comfy-port", type=int, default=8288)
    a = p.parse_args()
    server = make_server(Path(a.token_file).read_text().strip(), a.port, a.comfy_port)
    print("Authenticated GPU gateway listening on loopback.", flush=True)
    server.serve_forever()
