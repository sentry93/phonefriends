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
const LIVE_MP3_SEGMENT = fs.readFileSync(path.join(__dirname, "live-segment.mp3"));
const HLS_SEGMENT_SECONDS = 2.064;
const HLS_TARGET_DURATION = Math.ceil(HLS_SEGMENT_SECONDS);
const HLS_WINDOW_SEGMENTS = 5;
const feedClients = new Set();

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
  [".m3u8", "application/vnd.apple.mpegurl; charset=utf-8"],
  [".aac", "audio/aac"],
  [".mp3", "audio/mpeg"],
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
  const amplitude = 12;

  for (let i = 0; i < samples; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude);
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

function syncsafeInt(value) {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function id3TimestampTag(sequence) {
  const owner = Buffer.from("com.apple.streaming.transportStreamTimestamp\0", "ascii");
  const timestamp = BigInt(Math.max(0, Number(sequence) || 0)) * BigInt(Math.round(HLS_SEGMENT_SECONDS * 90000));
  const timestampData = Buffer.alloc(8);
  timestampData.writeBigUInt64BE(timestamp & 0x1ffffffffn);

  const frameBody = Buffer.concat([owner, timestampData]);
  const frameHeader = Buffer.concat([
    Buffer.from("PRIV", "ascii"),
    syncsafeInt(frameBody.length),
    Buffer.from([0, 0]),
  ]);
  const frame = Buffer.concat([frameHeader, frameBody]);
  const tagHeader = Buffer.concat([
    Buffer.from("ID3", "ascii"),
    Buffer.from([4, 0, 0]),
    syncsafeInt(frame.length),
  ]);

  return Buffer.concat([tagHeader, frame]);
}

function hlsSegmentMp3(sequence) {
  return Buffer.concat([id3TimestampTag(sequence), LIVE_MP3_SEGMENT]);
}

function liveHlsPlaylist() {
  const segmentMs = Math.round(HLS_SEGMENT_SECONDS * 1000);
  const newestSequence = Math.floor(Date.now() / segmentMs) - 1;
  const firstSequence = Math.max(0, newestSequence - HLS_WINDOW_SEGMENTS + 1);
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${HLS_TARGET_DURATION}`,
    `#EXT-X-MEDIA-SEQUENCE:${firstSequence}`,
  ];

  for (let sequence = firstSequence; sequence < firstSequence + HLS_WINDOW_SEGMENTS; sequence += 1) {
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(sequence * segmentMs).toISOString()}`);
    lines.push(`#EXTINF:${HLS_SEGMENT_SECONDS.toFixed(3)},`);
    lines.push(`/station-segment/${sequence}.mp3`);
  }

  return `${lines.join("\n")}\n`;
}

function sendLiveHlsPlaylist(req, res) {
  const playlist = liveHlsPlaylist();
  res.writeHead(200, {
    "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
    "Content-Length": Buffer.byteLength(playlist),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(playlist);
}

function sendStationStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  res.write(LIVE_MP3_SEGMENT);

  const streamTimer = setInterval(() => {
    if (!res.writableEnded) {
      res.write(LIVE_MP3_SEGMENT);
    }
  }, Math.round(HLS_SEGMENT_SECONDS * 1000));

  const cleanup = () => clearInterval(streamTimer);
  req.on("close", cleanup);
  res.on("close", cleanup);
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
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Phonefriends-Admin",
  });
  res.end(JSON.stringify(body));
}

function sendSse(res, event, body) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(body)}\n\n`);
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

function normalizeUserId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function cleanUserId(value) {
  return normalizeUserId(value) || crypto.randomUUID();
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

function broadcastFeed(payload) {
  for (const client of feedClients) {
    try {
      sendSse(client.res, "feed", payload);
    } catch {
      feedClients.delete(client);
    }
  }
}

function broadcastFeedUpdate(post) {
  const payload = {
    type: "post",
    station: "default",
    updatedAt: Date.now(),
    userId: post.userId,
    post: publicPost(post),
  };

  broadcastFeed(payload);
}

function broadcastFeedDelete(post) {
  broadcastFeed({
    type: "delete",
    station: "default",
    updatedAt: Date.now(),
    userId: post.userId,
  });
}

function deletePostFile(post) {
  if (!post?.file) return;
  const filePath = path.join(UPLOAD_DIR, path.basename(post.file));
  if (filePath.startsWith(UPLOAD_DIR) && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function handleFeedEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2500\n\n");

  const client = { res };
  feedClients.add(client);
  sendSse(res, "feed", {
    type: "hello",
    station: "default",
    updatedAt: Date.now(),
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
      feedClients.delete(client);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    feedClients.delete(client);
  });
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

  deletePostFile(previous);

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
  broadcastFeedUpdate(nextPost);
  sendJson(res, 200, { ok: true, post: publicPost(nextPost) });
}

function handleDeletePost(req, res, rawUserId) {
  const adminName = cleanText(req.headers["x-phonefriends-admin"], 28).toLowerCase();
  if (adminName !== "newar") {
    return sendJson(res, 403, { error: "Debug delete is only available to newar" });
  }

  const userId = normalizeUserId(rawUserId);
  if (!userId) {
    return sendJson(res, 400, { error: "User id is required" });
  }

  const posts = readPosts();
  const post = posts.find((item) => item.userId === userId);
  if (!post) {
    return sendJson(res, 404, { error: "Post not found" });
  }

  deletePostFile(post);
  writePosts(posts.filter((item) => item.userId !== userId));
  broadcastFeedDelete(post);
  return sendJson(res, 200, { ok: true, userId });
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
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Phonefriends-Admin",
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/events" && req.method === "GET") {
    return handleFeedEvents(req, res);
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/station.m3u8") {
    return sendLiveHlsPlaylist(req, res);
  }

  if ((req.method === "GET" || req.method === "HEAD") && /^\/station-segment\/\d+\.mp3$/.test(url.pathname)) {
    const sequence = Number(url.pathname.match(/^\/station-segment\/(\d+)\.mp3$/)?.[1] || 0);
    const stationAudio = hlsSegmentMp3(sequence);
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": stationAudio.length,
        "Cache-Control": "public, max-age=30",
        "X-Content-Type-Options": "nosniff",
      });
      res.end();
      return;
    }
    return sendBuffer(res, 200, stationAudio, "audio/mpeg", "public, max-age=30");
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/station-stream.mp3") {
    return sendStationStream(req, res);
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/station-live.wav") {
    const stationAudio = stationWav(url.searchParams.get("tracks"));
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": stationAudio.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end();
      return;
    }
    return sendBuffer(res, 200, stationAudio, "audio/wav", "no-store");
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

  if (req.method === "DELETE" && url.pathname.startsWith("/api/post/")) {
    let rawUserId;
    try {
      rawUserId = decodeURIComponent(url.pathname.slice("/api/post/".length));
    } catch {
      return sendJson(res, 400, { error: "User id is invalid" });
    }
    return handleDeletePost(req, res, rawUserId);
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
