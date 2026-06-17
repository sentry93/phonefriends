"use strict";

const $ = (id) => document.getElementById(id);

const screens = {
  name: $("nameScreen"),
  create: $("createScreen"),
};

const profile = {
  get id() {
    let value = localStorage.getItem("phonefriends_user_id");
    if (!value) {
      const randomValue = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
      value = `u_${randomValue}`;
      localStorage.setItem("phonefriends_user_id", value);
    }
    return value;
  },
  get name() {
    return localStorage.getItem("phonefriends_name") || "";
  },
  set name(value) {
    localStorage.setItem("phonefriends_name", value);
  },
  get wantsPlayback() {
    return localStorage.getItem("phonefriends_wants_playback") === "1";
  },
  set wantsPlayback(value) {
    localStorage.setItem("phonefriends_wants_playback", value ? "1" : "0");
  },
};

const state = {
  stream: null,
  facingMode: "user",
  capturedDataUrl: "",
  capturedAt: "",
  feed: [],
  index: 0,
  playing: false,
  audio: null,
  refreshTimer: null,
  gesturePlaybackBound: false,
  mediaHandlersBound: false,
  artworkPreload: new Map(),
};

function showScreen(name) {
  Object.values(screens).forEach((screen) => screen.classList.remove("is-active"));
  screens[name].classList.add("is-active");

  if (name === "create") {
    updateDisplayName();
    updateDebugAccess();
    profile.wantsPlayback = true;
    startCamera();
    loadFeed({ keepTrack: true });
    startFeedRefresh();
    bindGesturePlayback();
  } else {
    stopCamera();
    stopFeedRefresh();
  }
}

function setStatus(id, message, error = false) {
  const element = $(id);
  element.textContent = message;
  element.classList.toggle("is-error", error);
}

function updateNameButton() {
  $("nameNext").disabled = !$("nameInput").value.trim();
}

function updateDisplayName() {
  $("displayNameLabel").textContent = profile.name || "you";
}

function captureTimestampString(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function startCamera() {
  if (state.capturedDataUrl || state.stream) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("createStatus", "Camera unavailable. Choose a photo instead.", true);
    return;
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: state.facingMode,
        width: { ideal: 1280 },
        height: { ideal: 1280 },
      },
      audio: false,
    });
    $("cameraPreview").srcObject = state.stream;
    $("cameraPreview").hidden = false;
    setStatus("createStatus", "");
  } catch (error) {
    setStatus("createStatus", "Camera unavailable. Choose a photo instead.", true);
  }
}

function stopCamera() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  $("cameraPreview").srcObject = null;
}

function drawCoverFromSource(source, mirrored = false) {
  const canvas = $("captureCanvas");
  const size = 1200;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
  const side = Math.min(sourceWidth, sourceHeight);
  const sx = (sourceWidth - side) / 2;
  const sy = (sourceHeight - side) / 2;

  context.clearRect(0, 0, size, size);
  context.save();
  if (mirrored) {
    context.translate(size, 0);
    context.scale(-1, 1);
  }
  context.drawImage(source, sx, sy, side, side, 0, 0, size, size);
  context.restore();

  const capturedAtDate = new Date();
  state.capturedAt = capturedAtDate.toISOString();
  const capturedAtLabel = captureTimestampString(capturedAtDate);
  context.save();
  context.shadowColor = "rgba(0, 0, 0, 0.52)";
  context.shadowBlur = 16;
  context.shadowOffsetY = 2;
  context.fillStyle = "rgba(255, 255, 255, 0.96)";
  context.font = "800 34px -apple-system, BlinkMacSystemFont, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "top";
  context.fillText(capturedAtLabel, size / 2, 26);
  context.restore();

  return canvas.toDataURL("image/jpeg", 0.88);
}

function setCaptured(dataUrl) {
  state.capturedDataUrl = dataUrl;
  $("capturedPreview").src = dataUrl;
  $("capturedPreview").hidden = false;
  $("cameraPreview").hidden = true;
  $("postButton").disabled = false;
  $("postButton").hidden = false;
  $("captureButton").hidden = true;
  $("retakeButton").disabled = false;
  $("retakeButton").hidden = false;
  stopCamera();
}

function captureCameraFrame() {
  if (!state.stream) {
    startCamera();
    return;
  }
  const video = $("cameraPreview");
  if (!video.videoWidth || !video.videoHeight) {
    setStatus("createStatus", "Camera is warming up");
    return;
  }
  setCaptured(drawCoverFromSource(video, state.facingMode === "user"));
}

function resetCapture() {
  state.capturedDataUrl = "";
  state.capturedAt = "";
  $("capturedPreview").hidden = true;
  $("capturedPreview").removeAttribute("src");
  $("postButton").disabled = true;
  $("postButton").hidden = true;
  $("captureButton").hidden = false;
  $("retakeButton").disabled = true;
  $("retakeButton").hidden = true;
  $("cameraPreview").hidden = false;
  setStatus("createStatus", "");
  startCamera();
}

function loadPhotoFile(file) {
  if (!file) return;
  const image = new Image();
  image.onload = () => {
    setCaptured(drawCoverFromSource(image, false));
    URL.revokeObjectURL(image.src);
  };
  image.onerror = () => setStatus("createStatus", "That photo could not be opened", true);
  image.src = URL.createObjectURL(file);
}

async function postCapture() {
  if (!state.capturedDataUrl) return;
  const wasPlaying = state.playing;
  profile.wantsPlayback = true;
  const audioStarted = await startAudioTransport();
  $("postButton").disabled = true;
  setStatus("createStatus", "Posting...");

  try {
    const response = await fetch("/api/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: profile.id,
        name: profile.name,
        caption: $("captionInput").value.trim(),
        capturedAt: state.capturedAt,
        imageBase64: state.capturedDataUrl,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Post failed");

    setStatus("createStatus", "Posted");
    $("captionInput").value = "";
    await loadFeed({ keepTrack: false, preferUserId: profile.id });
    if (audioStarted) {
      state.playing = true;
      updateMediaSession();
      setStatus("stationStatus", "Playing");
    } else {
      await playStation();
    }
    resetCapture();
    setStatus("createStatus", "Posted");
  } catch (error) {
    if (audioStarted && !wasPlaying && state.audio) {
      state.audio.pause();
      state.playing = false;
      profile.wantsPlayback = false;
    }
    setStatus("createStatus", error.message, true);
    $("postButton").disabled = false;
  }
}

async function loadFeed({ keepTrack = false, preferUserId = "" } = {}) {
  const currentUserId = keepTrack && state.feed[state.index] ? state.feed[state.index].userId : "";

  try {
    const response = await fetch("/api/feed", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Feed failed");

    state.feed = Array.isArray(payload.posts) ? payload.posts : [];
    const preferredIndex = preferUserId ? state.feed.findIndex((post) => post.userId === preferUserId) : -1;
    const keptIndex = currentUserId ? state.feed.findIndex((post) => post.userId === currentUserId) : -1;
    state.index = preferredIndex >= 0 ? preferredIndex : keptIndex >= 0 ? keptIndex : Math.min(state.index, Math.max(state.feed.length - 1, 0));
    preloadArtwork();
    renderDebugList();
    renderTrack();
    setStatus("stationStatus", "");
    if (profile.wantsPlayback && state.feed.length > 0 && !state.playing) {
      tryResumeStation({ silent: true });
    }
  } catch (error) {
    setStatus("stationStatus", "Station unavailable", true);
  }
}

function renderTrack() {
  const empty = state.feed.length === 0;
  $("friendsButton").textContent = friendCountText(state.feed.length);

  if (empty) {
    clearMediaSession();
    return;
  }

  updateMediaSession();
}

function friendCountText(count) {
  return `${count} ${count === 1 ? "friend" : "friends"}`;
}

function goToTrack(index) {
  if (state.feed.length === 0) return;
  state.index = (index + state.feed.length) % state.feed.length;
  renderTrack();
  keepTransportAlive();
}

function advanceTrack(delta) {
  goToTrack(state.index + delta);
}

function getAudio() {
  if (state.audio) return state.audio;
  const audio = new Audio("/silence.wav");
  audio.loop = true;
  audio.volume = 0.0001;
  audio.preload = "auto";
  state.audio = audio;
  return audio;
}

async function startAudioTransport() {
  try {
    await getAudio().play();
    return true;
  } catch {
    return false;
  }
}

function keepTransportAlive() {
  const audio = getAudio();
  try {
    audio.currentTime = 0;
  } catch {
    /* Some browsers disallow currentTime writes during metadata changes. */
  }
  if (state.playing) {
    audio.play().catch(() => {});
  }
}

async function playStation({ silent = false } = {}) {
  profile.wantsPlayback = true;

  if (state.feed.length === 0) {
    if (!silent) setStatus("stationStatus", "Post a photo to start the station");
    return;
  }

  const started = await startAudioTransport();
  if (!started) {
    if (!silent) setStatus("stationStatus", "Tap once before locking your phone", true);
    return;
  }

  state.playing = true;
  updateMediaSession();
  if (!silent) setStatus("stationStatus", "Playing");
}

function tryResumeStation(options) {
  playStation(options);
}

function pauseStation() {
  if (state.audio) state.audio.pause();
  state.playing = false;
  profile.wantsPlayback = false;
  updateMediaSession();
  setStatus("stationStatus", "Paused");
}

function clearMediaSession() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
  } catch {
    /* Media Session cleanup is best-effort across browsers. */
  }
}

function updateMediaSession() {
  if (!("mediaSession" in navigator) || state.feed.length === 0) return;
  bindMediaSessionHandlers();
  const track = state.feed[state.index];
  const artworkUrl = artworkHref(track);
  const artworkType = artworkMimeType(track.url);

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.caption || "Untitled",
    artist: track.name,
    album: "Phonefriends",
    artwork: [
      { src: artworkUrl, sizes: "512x512", type: artworkType },
      { src: artworkUrl, sizes: "256x256", type: artworkType },
      { src: artworkUrl, sizes: "192x192", type: artworkType },
      { src: artworkUrl, sizes: "96x96", type: artworkType },
    ],
  });
  navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
  try {
    navigator.mediaSession.setPositionState({
      duration: Math.max(state.feed.length * 30, 30),
      playbackRate: 1,
      position: Math.min(state.index * 30, Math.max(state.feed.length * 30 - 1, 0)),
    });
  } catch {
    /* Position state is optional and not supported by every Media Session implementation. */
  }
}

function bindMediaSessionHandlers() {
  if (!("mediaSession" in navigator) || state.mediaHandlersBound) return;
  state.mediaHandlersBound = true;

  const actions = {
    play: () => playStation({ silent: true }),
    pause: pauseStation,
    nexttrack: () => advanceTrack(1),
    previoustrack: () => advanceTrack(-1),
    seekforward: () => advanceTrack(1),
    seekbackward: () => advanceTrack(-1),
    seekto: () => advanceTrack(1),
  };

  Object.entries(actions).forEach(([action, handler]) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      /* Some browsers expose Media Session but not every action. */
    }
  });
}

function artworkHref(track) {
  const url = new URL(track.url, location.origin);
  if (track.updatedAt) url.searchParams.set("v", String(track.updatedAt));
  return url.href;
}

function artworkMimeType(url) {
  const lower = String(url).toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function preloadArtwork() {
  state.feed.forEach((track) => {
    const src = artworkHref(track);
    if (state.artworkPreload.has(src)) return;
    const image = new Image();
    image.src = src;
    state.artworkPreload.set(src, image);
  });
}

function isDebugUser() {
  return profile.name.trim().toLowerCase() === "newar";
}

function updateDebugAccess() {
  const allowed = isDebugUser();
  $("debugButton").hidden = !allowed;
  if (!allowed) closeDebugPanel();
}

function openDebugPanel() {
  if (!isDebugUser()) return;
  renderDebugList({ force: true });
  $("debugPanel").hidden = false;
}

function closeDebugPanel() {
  $("debugPanel").hidden = true;
}

function debugTimestamp(post) {
  const value = post.capturedAt || post.updatedAt || post.createdAt;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value || "no timestamp");
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderDebugList({ force = false } = {}) {
  const panel = $("debugPanel");
  if (!force && panel.hidden) return;

  const list = $("debugList");
  list.replaceChildren();

  if (!isDebugUser()) {
    closeDebugPanel();
    return;
  }

  if (state.feed.length === 0) {
    const empty = document.createElement("p");
    empty.className = "debug-empty";
    empty.textContent = "no live albums yet";
    list.append(empty);
    return;
  }

  state.feed.forEach((post) => {
    const item = document.createElement("article");
    item.className = "debug-item";

    const image = document.createElement("img");
    image.className = "debug-thumb";
    image.alt = "";
    image.src = artworkHref(post);

    const meta = document.createElement("div");
    meta.className = "debug-meta";

    const name = document.createElement("div");
    name.className = "debug-name";
    name.textContent = post.name || "unknown";

    const time = document.createElement("div");
    time.className = "debug-time";
    time.textContent = debugTimestamp(post);

    meta.append(name, time);
    item.append(image, meta);
    list.append(item);
  });
}

function startFeedRefresh() {
  stopFeedRefresh();
  state.refreshTimer = window.setInterval(() => {
    if (!document.hidden && screens.create.classList.contains("is-active")) {
      loadFeed({ keepTrack: true });
    }
  }, 6500);
}

function stopFeedRefresh() {
  if (!state.refreshTimer) return;
  window.clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

async function shareStation() {
  const shareData = {
    title: "Phonefriends",
    text: "Join my station",
    url: location.origin,
  };

  try {
    if (navigator.share) {
      await navigator.share(shareData);
      return;
    }
    await navigator.clipboard.writeText(shareData.url);
    setStatus("stationStatus", "Link copied");
  } catch {
    setStatus("stationStatus", "Share unavailable", true);
  }
}

function bindGesturePlayback() {
  if (state.gesturePlaybackBound) return;
  state.gesturePlaybackBound = true;

  const handler = () => {
    if (profile.wantsPlayback && state.feed.length > 0 && !state.playing) {
      playStation({ silent: true });
    }
  };

  document.addEventListener("pointerdown", handler, { passive: true });
  document.addEventListener("touchstart", handler, { passive: true });
  document.addEventListener("keydown", handler);
}

function bindEvents() {
  $("nameInput").value = profile.name;
  updateNameButton();
  $("nameInput").addEventListener("input", updateNameButton);

  $("nameForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("nameInput").value.trim();
    if (!name) return;
    profile.name = name;
    showScreen("create");
    updateDisplayName();
    updateDebugAccess();
    if (profile.wantsPlayback) {
      tryResumeStation({ silent: true });
    }
  });

  $("captureButton").addEventListener("click", captureCameraFrame);
  $("retakeButton").addEventListener("click", resetCapture);
  $("postButton").addEventListener("click", postCapture);
  $("photoButton").addEventListener("click", () => $("photoInput").click());
  $("photoInput").addEventListener("change", (event) => loadPhotoFile(event.target.files[0]));
  $("friendsButton").addEventListener("click", shareStation);
  $("debugButton").addEventListener("click", openDebugPanel);
  $("closeDebugButton").addEventListener("click", closeDebugPanel);
  $("debugPanel").addEventListener("click", (event) => {
    if (event.target === $("debugPanel")) closeDebugPanel();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && screens.create.classList.contains("is-active")) {
      loadFeed({ keepTrack: true });
      playStation({ silent: true });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDebugPanel();
  });
}

bindEvents();

if (profile.name) {
  showScreen("create");
}
