"use strict";

const $ = (id) => document.getElementById(id);

const screens = {
  name: $("nameScreen"),
  create: $("createScreen"),
};

const STATION_LIVE_SRC = "/station-live.wav";

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
  audioEventsBound: false,
  refreshTimer: null,
  gesturePlaybackBound: false,
  cameraZoomGesturesBound: false,
  mediaHandlersBound: false,
  artworkPreload: new Map(),
  lastPlaybackAttempt: 0,
  cameraZoom: 1,
  cameraZoomBounds: { min: 1, max: 3, step: 0.01, hardware: false },
  cameraZoomUsesHardware: false,
  cameraZoomApplyTimer: null,
  lastCameraZoomApply: 0,
  pinchZoom: null,
};

function showScreen(name) {
  Object.values(screens).forEach((screen) => screen.classList.remove("is-active"));
  screens[name].classList.add("is-active");

  if (name === "create") {
    updateDisplayName();
    updateDebugAccess();
    profile.wantsPlayback = true;
    tryResumeStation({ silent: true });
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

function updateCurrentPostPreview() {
  const post = state.feed.find((item) => item.userId === profile.id);
  const preview = $("currentPostPreview");

  if (!post) {
    preview.hidden = true;
    $("currentPostThumb").removeAttribute("src");
    $("currentPostStatus").textContent = "";
    return;
  }

  $("currentPostThumb").src = artworkHref(post);
  $("currentPostStatus").textContent = post.caption || "your photo";
  preview.hidden = false;
}

function captureTimestampString(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getVideoTrack() {
  return state.stream?.getVideoTracks?.()[0] || null;
}

function readCameraZoomBounds() {
  const track = getVideoTrack();
  const capabilities = track?.getCapabilities?.();
  const zoom = capabilities?.zoom;

  if (zoom && Number.isFinite(zoom.max) && zoom.max > 1) {
    return {
      min: Number.isFinite(zoom.min) ? zoom.min : 1,
      max: zoom.max,
      step: Number.isFinite(zoom.step) && zoom.step > 0 ? zoom.step : 0.01,
      hardware: true,
    };
  }

  return { min: 1, max: 3, step: 0.01, hardware: false };
}

function updateCameraPreviewZoom() {
  const preview = $("cameraPreview");
  const visualZoom = state.cameraZoomUsesHardware ? 1 : state.cameraZoom;
  preview.style.setProperty("--preview-zoom", String(visualZoom));
}

function applyHardwareCameraZoom(immediate = false) {
  if (!state.cameraZoomBounds.hardware) return;

  const track = getVideoTrack();
  if (!track?.applyConstraints) return;

  const apply = () => {
    state.cameraZoomApplyTimer = null;
    state.lastCameraZoomApply = Date.now();
    track.applyConstraints({ advanced: [{ zoom: state.cameraZoom }] })
      .then(() => {
        state.cameraZoomUsesHardware = true;
        updateCameraPreviewZoom();
      })
      .catch(() => {
        state.cameraZoomUsesHardware = false;
        state.cameraZoomBounds = {
          ...state.cameraZoomBounds,
          min: 1,
          max: Math.max(3, state.cameraZoomBounds.max),
          hardware: false,
        };
        updateCameraPreviewZoom();
      });
  };

  if (state.cameraZoomApplyTimer) {
    window.clearTimeout(state.cameraZoomApplyTimer);
    state.cameraZoomApplyTimer = null;
  }

  const elapsed = Date.now() - state.lastCameraZoomApply;
  if (immediate || elapsed > 55) {
    apply();
  } else {
    state.cameraZoomApplyTimer = window.setTimeout(apply, 55 - elapsed);
  }
}

function setCameraZoom(value, { immediate = false } = {}) {
  const bounds = state.cameraZoomBounds;
  const stepped = bounds.min + Math.round((value - bounds.min) / bounds.step) * bounds.step;
  state.cameraZoom = clamp(stepped, bounds.min, bounds.max);
  updateCameraPreviewZoom();
  applyHardwareCameraZoom(immediate);
}

function syncCameraZoomCapabilities() {
  state.cameraZoomBounds = readCameraZoomBounds();
  state.cameraZoomUsesHardware = false;
  setCameraZoom(state.cameraZoom, { immediate: true });
}

function cameraCaptureZoom() {
  return state.cameraZoomUsesHardware ? 1 : state.cameraZoom;
}

function touchDistance(touches) {
  const [first, second] = touches;
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function bindCameraZoomGestures() {
  if (state.cameraZoomGesturesBound) return;
  state.cameraZoomGesturesBound = true;

  const cover = $("captureCover");

  cover.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 2 || state.capturedDataUrl) return;
    state.pinchZoom = {
      distance: touchDistance(event.touches),
      zoom: state.cameraZoom,
    };
    event.preventDefault();
  }, { passive: false });

  cover.addEventListener("touchmove", (event) => {
    if (!state.pinchZoom || event.touches.length !== 2 || state.capturedDataUrl) return;
    const distance = touchDistance(event.touches);
    if (!distance || !state.pinchZoom.distance) return;
    setCameraZoom(state.pinchZoom.zoom * (distance / state.pinchZoom.distance));
    event.preventDefault();
  }, { passive: false });

  const endPinch = (event) => {
    if (event.touches.length < 2) state.pinchZoom = null;
  };

  cover.addEventListener("touchend", endPinch, { passive: true });
  cover.addEventListener("touchcancel", endPinch, { passive: true });
}

async function startCamera() {
  if (state.capturedDataUrl || state.stream) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("createStatus", "Camera unavailable. Choose a photo instead.", true);
    return;
  }

  try {
    const preview = $("cameraPreview");
    preview.classList.toggle("is-mirrored", state.facingMode === "user");
    $("flipCameraButton").disabled = true;
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: state.facingMode,
        width: { ideal: 1280 },
        height: { ideal: 1280 },
      },
      audio: false,
    });
    preview.srcObject = state.stream;
    syncCameraZoomCapabilities();
    preview.hidden = false;
    $("flipCameraButton").disabled = false;
    setStatus("createStatus", "");
  } catch (error) {
    $("flipCameraButton").disabled = false;
    setStatus("createStatus", "Camera unavailable. Choose a photo instead.", true);
  }
}

function stopCamera() {
  if (!state.stream) return;
  if (state.cameraZoomApplyTimer) {
    window.clearTimeout(state.cameraZoomApplyTimer);
    state.cameraZoomApplyTimer = null;
  }
  state.pinchZoom = null;
  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  state.cameraZoomUsesHardware = false;
  $("cameraPreview").srcObject = null;
}

function drawCoverFromSource(source, mirrored = false, zoom = 1) {
  const canvas = $("captureCanvas");
  const size = 1200;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
  const cropZoom = Math.max(1, Number(zoom) || 1);
  const side = Math.min(sourceWidth, sourceHeight) / cropZoom;
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
  $("flipCameraButton").disabled = true;
  $("flipCameraButton").hidden = true;
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
  setCaptured(drawCoverFromSource(video, state.facingMode === "user", cameraCaptureZoom()));
}

function resetCapture() {
  state.capturedDataUrl = "";
  state.capturedAt = "";
  $("capturedPreview").hidden = true;
  $("capturedPreview").removeAttribute("src");
  $("postButton").disabled = true;
  $("postButton").hidden = true;
  $("captureButton").hidden = false;
  $("flipCameraButton").disabled = false;
  $("flipCameraButton").hidden = false;
  $("retakeButton").disabled = true;
  $("retakeButton").hidden = true;
  $("cameraPreview").hidden = false;
  setStatus("createStatus", "");
  startCamera();
}

async function flipCamera() {
  if (state.capturedDataUrl || $("flipCameraButton").disabled) return;
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  stopCamera();
  await startCamera();
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
    syncAudioSource();
    updateCurrentPostPreview();
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
  renderFriendsButton(state.feed.length);
  updateMediaSession();
}

function friendCountText(count) {
  return `To ${count} ${count === 1 ? "Friend" : "Friends"}`;
}

function renderFriendsButton(count) {
  const button = $("friendsButton");
  const label = document.createElement("span");
  label.textContent = friendCountText(count);

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.classList.add("line-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m9 5 7 7-7 7");
  icon.append(path);

  button.replaceChildren(label, icon);
  button.setAttribute("aria-label", `Share station with ${count} ${count === 1 ? "friend" : "friends"}`);
}

function stationAudioSrc() {
  return STATION_LIVE_SRC;
}

function normalizedTrackIndex(index) {
  if (state.feed.length === 0) return 0;
  return (index + state.feed.length) % state.feed.length;
}

function syncAudioSource() {
  if (!state.audio) return;
  if (state.audio.src.endsWith(stationAudioSrc())) return;
  const wasPlaying = state.playing && !state.audio.paused;
  state.audio.src = stationAudioSrc();
  state.audio.load();
  if (wasPlaying) {
    state.audio.play().catch(() => {});
  }
}

function bindAudioEvents(audio) {
  if (state.audioEventsBound) return;
  state.audioEventsBound = true;
  audio.addEventListener("playing", () => {
    state.playing = true;
    updateMediaSession();
  });
  audio.addEventListener("pause", () => {
    state.playing = false;
    updateMediaSession();
  });
}

function goToTrack(index) {
  if (state.feed.length === 0) return;
  state.index = normalizedTrackIndex(index);
  renderTrack();
  keepTransportAlive();
}

function advanceTrack(delta) {
  goToTrack(state.index + delta);
}

function getAudio() {
  if (state.audio) return state.audio;
  const audio = new Audio(stationAudioSrc());
  audio.volume = 1;
  audio.muted = false;
  audio.preload = "auto";
  state.audio = audio;
  bindAudioEvents(audio);
  return audio;
}

async function startAudioTransport() {
  try {
    const audio = getAudio();
    syncAudioSource();
    updateMediaSession();
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

function shouldThrottlePlaybackAttempt() {
  const now = Date.now();
  if (now - state.lastPlaybackAttempt < 500) return true;
  state.lastPlaybackAttempt = now;
  return false;
}

function claimStationPlayback({ silent = true, force = false } = {}) {
  profile.wantsPlayback = true;
  if (!force && state.playing) {
    updateMediaSession();
    return;
  }
  if (!force && shouldThrottlePlaybackAttempt()) return;
  playStation({ silent });
}

function keepTransportAlive() {
  const audio = getAudio();
  syncAudioSource();
  if (state.playing) {
    audio.play().catch(() => {});
  }
}

async function playStation({ silent = false } = {}) {
  profile.wantsPlayback = true;

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
  if (!("mediaSession" in navigator)) return;
  bindMediaSessionHandlers();
  const track = state.feed[state.index] || {
    name: "Phonefriends",
    caption: "Live station",
    url: "/share-card.svg",
    updatedAt: "",
  };
  const artworkUrl = artworkHref(track);
  const artworkType = artworkMimeType(track.url);

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.caption || "Live station",
    artist: track.name || "Phonefriends",
    album: state.feed.length > 0 ? "Phonefriends live" : "Phonefriends",
    artwork: [
      { src: artworkUrl, sizes: "512x512", type: artworkType },
      { src: artworkUrl, sizes: "256x256", type: artworkType },
      { src: artworkUrl, sizes: "192x192", type: artworkType },
      { src: artworkUrl, sizes: "96x96", type: artworkType },
    ],
  });
  navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
}

function bindMediaSessionHandlers() {
  if (!("mediaSession" in navigator) || state.mediaHandlersBound) return;
  state.mediaHandlersBound = true;

  const actions = {
    play: () => playStation({ silent: true }),
    pause: pauseStation,
    stop: pauseStation,
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
  if (lower.endsWith(".svg")) return "image/svg+xml";
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
    if (profile.name || screens.create.classList.contains("is-active")) {
      claimStationPlayback({ silent: true, force: true });
    }
  };

  document.addEventListener("pointerdown", handler, { capture: true, passive: true });
  document.addEventListener("touchstart", handler, { capture: true, passive: true });
  document.addEventListener("click", handler, { capture: true, passive: true });
  document.addEventListener("keydown", handler, { capture: true });
  window.addEventListener("focus", () => claimStationPlayback({ silent: true }));
  window.addEventListener("pageshow", () => claimStationPlayback({ silent: true }));
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
    claimStationPlayback({ silent: true, force: true });
    showScreen("create");
    updateDisplayName();
    updateDebugAccess();
    if (profile.wantsPlayback) {
      tryResumeStation({ silent: true });
    }
  });

  $("captureButton").addEventListener("click", captureCameraFrame);
  $("flipCameraButton").addEventListener("click", flipCamera);
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
    if (screens.create.classList.contains("is-active")) {
      loadFeed({ keepTrack: true });
      claimStationPlayback({ silent: true, force: true });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDebugPanel();
  });

  bindCameraZoomGestures();
}

bindEvents();
bindGesturePlayback();
renderTrack();

if (profile.name) {
  showScreen("create");
}
