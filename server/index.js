"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const POSTS_FILE = path.join(DATA_DIR, "posts.json");
const MAX_BODY_BYTES = 14 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const STATION_TRACK_SECONDS = 10;
const MAX_STATION_TRACKS = 100;
const SILENCE_CACHE = new Map();
const LIVE_SAMPLE_RATE = 8000;
const LIVE_CHUNK_SECONDS = 1;

function ensureStorage() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(POSTS_FILE)) {
    fs.writeFileSync(POSTS_FILE, "[]\n");
  }
}

ensureStorage();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".wav", "audio/wav"],
]);

function createWavHeader(dataBytes, sampleRate = LIVE_SAMPLE_RATE) {
  const safeDataBytes = Math.max(0, Math.min(Number(dataBytes) || 0, 0xffffffff));
  const riffSize = safeDataBytes >= 0xffffffff - 36 ? 0xffffffff : 36 + safeDataBytes;
  const buffer = Buffer.alloc(44);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(riffSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(safeDataBytes, 40);

  return buffer;
}

function createQuietPcm(seconds = 1, sampleRate = LIVE_SAMPLE_RATE) {
  const safeSeconds = Math.max(1, Math.floor(seconds));
  const samples = sampleRate * safeSeconds;
  const buffer = Buffer.alloc(samples * 2);

  for (let i = 0; i < samples; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 3);
    buffer.writeInt16LE(sample, i * 2);
  }

  return buffer;
}

function createQuietWav(seconds = 1) {
  const pcm = createQuietPcm(seconds);
  return Buffer.concat([createWavHeader(pcm.length), pcm]);
}

function stationTrackCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(MAX_STATION_TRACKS, Math.floor(parsed)));
}

function stationWav(trackCount) {
  const count = stationTrackCount(trackCount);
  if (!SILENCE_CACHE.has(count)) {
    SILENCE_CACHE.set(count, createQuietWav(count * STATION_TRACK_SECONDS));
  }
  return SILENCE_CACHE.get(count);
}

function streamLiveStation(req, res) {
  const header = createWavHeader(0xffffffff);
  const chunk = createQuietPcm(LIVE_CHUNK_SECONDS);
  let closed = false;

  res.writeHead(200, {
    "Content-Type": "audio/wav",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  res.write(header);
  res.write(chunk);

  const timer = setInterval(() => {
    if (closed || res.destroyed) return;
    res.write(chunk);
  }, LIVE_CHUNK_SECONDS * 1000);

  const close = () => {
    closed = true;
    clearInterval(timer);
  };

  req.on("close", close);
  res.on("close", close);
}

function readPosts() {
  ensureStorage();
  try {
    const parsed = JSON.parse(fs.readFileSync(POSTS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Could not read posts file:", error);
    return [];
  }
}

function writePosts(posts) {
  ensureStorage();
  const tmp = `${POSTS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(posts, null, 2)}\n`);
  fs.renameSync(tmp, POSTS_FILE);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function sendBuffer(res, status, buffer, contentType, cacheControl = "public, max-age=86400") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": buffer.length,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(buffer);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanUserId(value) {
  const cleaned = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return cleaned || crypto.randomUUID();
}

function cleanTimestamp(value) {
  const rawValue = cleanText(value, 48);
  const parsed = Date.parse(rawValue);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

function timestampFromPost(post) {
  const captured = Date.parse(post.capturedAt || "");
  if (!Number.isNaN(captured)) return new Date(captured).toISOString();
  const fallback = Number(post.updatedAt || post.createdAt);
  return new Date(Number.isFinite(fallback) ? fallback : Date.now()).toISOString();
}

function parseImage(imageBase64) {
  const rawValue = String(imageBase64 || "");
  const match = rawValue.match(/^data:image\/(png|jpe?g|webp);base64,([\s\S]+)$/i);
  const type = match ? match[1].toLowerCase() : "jpeg";
  const raw = match ? match[2] : rawValue.replace(/^data:image\/\w+;base64,/i, "");

  if (!/^[a-zA-Z0-9+/=\s]+$/.test(raw)) {
    const error = new Error("Image data is not valid base64");
    error.statusCode = 400;
    throw error;
  }

  const buffer = Buffer.from(raw.replace(/\s/g, ""), "base64");
  if (buffer.length === 0) {
    const error = new Error("Image is empty");
    error.statusCode = 400;
    throw error;
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    const error = new Error("Image is too large");
    error.statusCode = 413;
    throw error;
  }

  const ext = type === "png" ? "png" : type === "webp" ? "webp" : "jpg";
  return { buffer, ext };
}

function publicPost(post) {
  return {
    userId: post.userId,
    name: post.name,
    caption: post.caption,
    url: `/uploads/${post.file}`,
    capturedAt: timestampFromPost(post),
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

async function handlePost(req, res) {
  const bodyText = await readRequestBody(req);
  let body;
  try {
    body = JSON.parse(bodyText || "{}");
  } catch {
    return sendJson(res, 400, { error: "Request body must be JSON" });
  }

  const userId = cleanUserId(body.userId);
  const name = cleanText(body.name, 28);
  const caption = cleanText(body.caption, 80);
  const capturedAt = cleanTimestamp(body.capturedAt);
  if (!name || !body.imageBase64) {
    return sendJson(res, 400, { error: "Name and image are required" });
  }

  const { buffer, ext } = parseImage(body.imageBase64);
  const posts = readPosts();
  const previous = posts.find((post) => post.userId === userId);

  if (previous && previous.file) {
    const oldPath = path.join(UPLOAD_DIR, previous.file);
    if (oldPath.startsWith(UPLOAD_DIR) && fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
    }
  }

  const now = Date.now();
  const file = `${userId}_${now}_${crypto.randomBytes(5).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buffer);

  const nextPost = {
    userId,
    name,
    caption,
    file,
    capturedAt: capturedAt || new Date(now).toISOString(),
    createdAt: previous ? previous.createdAt : now,
    updatedAt: now,
  };
  const nextPosts = posts.filter((post) => post.userId !== userId).concat(nextPost);
  writePosts(nextPosts);
  sendJson(res, 200, { ok: true, post: publicPost(nextPost) });
}

function handleFeed(_req, res) {
  const posts = readPosts()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(publicPost);

  sendJson(res, 200, {
    station: "default",
    updatedAt: Date.now(),
    posts,
  });
}

function safePath(baseDir, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const resolved = path.join(baseDir, normalized);
  const relative = path.relative(baseDir, resolved);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? resolved : null;
}

function serveStatic(req, res, baseDir, requestPath, cacheControl) {
  const filePath = safePath(baseDir, requestPath);
  if (!filePath) return sendText(res, 403, "Forbidden");

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) return sendText(res, 404, "Not found");

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes.get(ext) || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Cache-Control": cacheControl,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

function serveApp(req, res) {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  fs.stat(indexPath, (statError, stat) => {
    if (statError || !stat.isFile()) return sendText(res, 500, "App entry file is missing");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(indexPath).pipe(res);
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/station-live.wav") {
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      res.end();
      return;
    }
    return streamLiveStation(req, res);
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/silence.wav") {
    const stationAudio = stationWav(url.searchParams.get("tracks"));
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": stationAudio.length,
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      });
      res.end();
      return;
    }
    return sendBuffer(res, 200, stationAudio, "audio/wav");
  }

  if (url.pathname === "/api/feed" && req.method === "GET") {
    return handleFeed(req, res);
  }

  if (url.pathname === "/api/post" && req.method === "POST") {
    return handlePost(req, res);
  }

  if (url.pathname.startsWith("/api/")) {
    return sendJson(res, 404, { error: "API route not found" });
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/uploads/")) {
    return serveStatic(req, res, UPLOAD_DIR, url.pathname.replace(/^\/uploads\/?/, ""), "public, max-age=3600");
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const staticFile = safePath(PUBLIC_DIR, filePath);
    if (staticFile && fs.existsSync(staticFile) && fs.statSync(staticFile).isFile()) {
      return serveStatic(req, res, PUBLIC_DIR, filePath, "public, max-age=600");
    }
    return serveApp(req, res);
  }

  sendText(res, 405, "Method not allowed");
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    sendJson(res, status, { error: error.message || "Server error" });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Phonefriends Station running on http://localhost:${PORT}`);
});
