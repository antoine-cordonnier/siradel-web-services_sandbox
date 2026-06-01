"""
Proxy HTTP minimaliste pour RF Link Planner.
- Sert les fichiers statiques sur /
- Relaie /proxy/* vers l'API Bloonet WS et Keycloak (contourne le CORS)

Lancement : python proxy.py
Puis ouvrir : http://localhost:8765/
"""
import http.server
import http.client
import urllib.parse
import ssl
import os
import sys

PORT = 8765
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))

# Cibles proxifiées
PROXY_ROUTES = {
    "/proxy/auth":  "https://keycloak.bloonetws.siradel.com/realms/volcanoweb/protocol/openid-connect/token",
    "/proxy/api/":  "https://api.bloonetws.siradel.com/",
    "/proxy/dl/":   "https://dl.bloonetws.siradel.com/",
}

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, fmt, *args):
        print(f"[proxy] {self.address_string()} {fmt % args}")

    def send_cors(self):
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def _proxy(self):
        path = self.path.split("?")[0]
        query = self.path[len(path):]

        # Find matching route
        target_base = None
        strip_prefix = None
        for prefix, target in PROXY_ROUTES.items():
            if self.path.startswith(prefix):
                target_base = target
                strip_prefix = prefix
                break

        if target_base is None:
            return False  # let SimpleHTTPRequestHandler serve static files

        # Build upstream URL
        if strip_prefix == "/proxy/auth":
            upstream_url = target_base
        else:
            remainder = self.path[len(strip_prefix):]
            upstream_url = target_base + remainder

        # Read request body — handle both Content-Length and chunked
        length = self.headers.get("Content-Length")
        if length:
            body = self.rfile.read(int(length))
        elif self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            chunks = []
            while True:
                size_line = self.rfile.readline().strip()
                if not size_line:
                    break
                chunk_size = int(size_line, 16)
                if chunk_size == 0:
                    break
                chunks.append(self.rfile.read(chunk_size))
                self.rfile.read(2)  # \r\n
            body = b"".join(chunks) if chunks else None
        else:
            body = None

        # Build upstream request headers (strip Host)
        fwd_headers = {}
        for k, v in self.headers.items():
            if k.lower() not in ("host", "connection", "transfer-encoding", "accept-encoding"):
                fwd_headers[k] = v

        parsed = urllib.parse.urlparse(upstream_url)
        host   = parsed.netloc
        path   = parsed.path + (('?' + parsed.query) if parsed.query else '')

        print(f"  -> {self.command} https://{host}{path}")
        print(f"     Content-Type: {fwd_headers.get('Content-Type', '(none)')}")
        if body:
            print(f"     body: {len(body)} bytes")

        ctx = ssl.create_default_context()
        conn = http.client.HTTPSConnection(host, context=ctx, timeout=60)
        try:
            conn.request(self.command, path, body=body, headers=fwd_headers)
            resp = conn.getresponse()
            data = resp.read()

            self.send_response(resp.status)
            self.send_cors()
            ct = resp.getheader("Content-Type", "application/json")
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as ex:
            msg = str(ex).encode()
            print(f"  !! proxy error: {ex}")
            self.send_response(502)
            self.send_cors()
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
        finally:
            conn.close()

        return True

    def do_GET(self):
        if not self._proxy():
            super().do_GET()

    def do_POST(self):
        if not self._proxy():
            self.send_error(405)


if __name__ == "__main__":
    os.chdir(STATIC_DIR)
    server = http.server.HTTPServer(("localhost", PORT), Handler)
    print(f"RF Link Planner proxy running on http://localhost:{PORT}/")
    print("Ouvrir : http://localhost:8765/RF%20Link%20Planner.html")
    print("Ctrl+C pour arrêter.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt.")
