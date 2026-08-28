/*
 * HOOKPRINT — verify/server.js
 *
 * Zero-dependency static server for the harness verification page.
 *
 * It exists because file:// is the wrong test surface: content scripts behave
 * differently there, opaque origins change the postMessage checks in bridge.js,
 * and worker.js refuses to fetch a non-http(s) source, so evidence.snippet
 * could never resolve. Everything must be served over a real origin.
 *
 *   node verify/server.js [port]
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = +process.argv[2] || 8777;
const ROOT = path.join(__dirname, "pages");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm"
};

/* A real, decodable media asset, synthesized rather than committed as a binary.
 * It has to genuinely decode: an undecodable file makes play() reject with
 * NotSupportedError, and then the autoplay path is never exercised at all —
 * which is exactly the false pass this rig exists to prevent. 16-bit PCM WAV,
 * 8 seconds of near-silence at 8 kHz, ~128 KB. */
function makeWav(seconds, rate) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 40) * 24), 44 + i * 2);
  return buf;
}
const WAV = makeWav(8, 8000);

let requestCount = 0;

const server = http.createServer((req, res) => {
  requestCount++;
  const u = new URL(req.url, "http://localhost:" + PORT);

  // The feed endpoint. Real network traffic, so net.request / net.response
  // carry a real duration and a real status rather than a synthetic one.
  if (u.pathname === "/api/feed") {
    const page = +u.searchParams.get("page") || 0;
    const items = [];
    for (let i = 0; i < 8; i++) {
      const n = page * 8 + i;
      items.push({ id: n, title: "Item " + n, body: "Body text for item " + n + ". ".repeat(3) });
    }
    res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" });
    res.end(JSON.stringify({ page, items }));
    return;
  }

  if (u.pathname === "/clip.wav") {
    res.writeHead(200, { "content-type": "audio/wav", "content-length": WAV.length, "cache-control": "no-store" });
    res.end(WAV);
    return;
  }

  let rel = u.pathname === "/" ? "/index.html" : u.pathname;
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ""));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("no"); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); res.end("404 " + rel); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write("verify server on http://localhost:" + PORT + "/\n");
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => { server.close(); process.exit(0); });
