"""
PodcastCopilot — Backend Server
================================
Serves the frontend and proxies Claude API calls.

Usage:
    python server.py

Then open: http://localhost:8765
Requires:  ANTHROPIC_API_KEY environment variable
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

import anthropic

PORT = 8765
ROOT = Path(__file__).parent
client = anthropic.Anthropic()

ANALYZE_SYSTEM = """You are a real-time research assistant for a podcast host.
You receive a rolling transcript of the last ~2 minutes of conversation.

Your job is to detect ANY of the following — be generous, err on the side of detection:

ALWAYS detect:
- Any direct question: "how does X work?", "what is X?", "why does X happen?", "do you know X?"
- Expressed ignorance: "I don't know", "I have no idea", "I never understood", "I always wondered"
- Guest saying they don't know: "no idea", "not sure", "I haven't looked into it"
- Curiosity phrases: "I wonder", "interesting, I didn't know that", "tell me more about"
- Factual claims that could use a source: "apparently X does Y", "I heard that..."

Hungarian equivalents (detect ALL of these):
- "nem tudom", "fogalmam sincs", "nem értem", "sosem értettem"
- "mindig kíváncsi voltam", "érdekes", "hogy működik", "mi az hogy"
- "tudod-e hogy", "hallottad már hogy", "szerinted miért"
- Any sentence ending with "?" in the transcript

When in doubt — include it. It is better to show a button the host doesn't need than to miss one they do.

For each detected topic, return JSON. Match label language to the conversation (HU or EN).

Return ONLY valid JSON:
{
  "topics": [
    {
      "label": "Short topic label (2-5 words)",
      "question": "The specific question or knowledge gap detected",
      "answer": "A clear, concise answer in 3-5 sentences.",
      "sources": [
        {"title": "Source name", "url": "https://..."},
        {"title": "Source name", "url": "https://..."}
      ]
    }
  ]
}

If truly nothing resembling a question or uncertainty exists, return: {"topics": []}
Maximum 3 topics per response. Prioritise the most recent ones.
"""

SUMMARIZE_SYSTEM = """You are summarizing an older portion of a podcast transcript to preserve context.
Write a concise summary (3-6 sentences) capturing the key topics discussed, any conclusions reached, and the general flow of conversation.
Match the language of the transcript (Hungarian or English).
Return only the summary text, no extra formatting."""


class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} — {fmt % args}")

    # ── Routing ───────────────────────────────────────────────────────────────
    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/" or path == "/index.html":
            self._serve_file(ROOT / "index.html", "text/html")
        elif path.startswith("/src/"):
            file_path = (ROOT / path.lstrip("/")).resolve()
            if not str(file_path).startswith(str(ROOT.resolve())):
                self._send(403, {"error": "Forbidden"})
                return
            ext = file_path.suffix
            mime = {"css": "text/css", "js": "application/javascript"}.get(ext.lstrip("."), "text/plain")
            self._serve_file(file_path, mime)
        else:
            self._send(404, {"error": "Not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read_body()

        if path == "/api/analyze":
            self._handle_analyze(body)
        elif path == "/api/summarize":
            self._handle_summarize(body)
        else:
            self._send(404, {"error": "Not found"})

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    # ── Handlers ──────────────────────────────────────────────────────────────
    def _handle_analyze(self, body):
        transcript = body.get("transcript", "").strip()
        summary    = body.get("summary", "").strip()

        if not transcript:
            self._send(200, {"topics": []})
            return

        context = ""
        if summary:
            context = f"[Earlier context summary]\n{summary}\n\n"
        context += f"[Live transcript — last ~2 minutes]\n{transcript}"

        try:
            response = client.messages.create(
                model="claude-opus-4-6",
                max_tokens=1024,
                system=ANALYZE_SYSTEM,
                messages=[{"role": "user", "content": context}],
            )
            text = response.content[0].text.strip()
            # Strip markdown code fences if present
            if text.startswith("```"):
                text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
            data = json.loads(text)
            self._send(200, data)
        except json.JSONDecodeError as e:
            print(f"  [JSON parse error] {e}\n  Raw: {text[:200]}")
            self._send(200, {"topics": []})
        except Exception as e:
            print(f"  [Claude error] {e}")
            self._send(500, {"error": str(e)})

    def _handle_summarize(self, body):
        transcript = body.get("transcript", "").strip()
        if not transcript:
            self._send(200, {"summary": ""})
            return

        try:
            response = client.messages.create(
                model="claude-opus-4-6",
                max_tokens=512,
                system=SUMMARIZE_SYSTEM,
                messages=[{"role": "user", "content": transcript}],
            )
            summary = response.content[0].text.strip()
            self._send(200, {"summary": summary})
        except Exception as e:
            print(f"  [Summarize error] {e}")
            self._send(500, {"error": str(e)})

    # ── Helpers ───────────────────────────────────────────────────────────────
    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except Exception:
            return {}

    def _serve_file(self, path: Path, mime: str):
        if not path.exists():
            self._send(404, {"error": f"File not found: {path.name}"})
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def _send(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Error: ANTHROPIC_API_KEY is not set.")
        print('Run:  $env:ANTHROPIC_API_KEY = "sk-ant-..."  (PowerShell)')
        sys.exit(1)

    print(f"\nPodcastCopilot")
    print(f"  http://localhost:{PORT}")
    print(f"  Press Ctrl+C to stop\n")

    server = HTTPServer(("localhost", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
