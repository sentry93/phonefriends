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
  feed: [],
  index: 0,
  playing: false,
  audio: null,
  refreshTimer: null,
  gesturePlaybackBound: false,
};

function showScreen(name) {
  Object.values(screens).forEach((screen) => screen.classList.remove("is-active"));
  screens[name].classList.add("is-active");

  if (name === "create") {
    updateDisplayName();
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
  $("capturedPreview").hidden = true;
  $("capturedPreview").removeAttribute("src");
  $("postButton").disabled = true;
  $("postButton").hidden = true;
  $("captureButton").hidden = false;
  $("retakeButton").disabled = true;
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
  const track = state.feed[state.index];
  const artworkUrl = new URL(track.url, location.origin).href;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.caption || "Untitled",
    artist: track.name,
    album: "Phonefriends",
    artwork: [
      { src: artworkUrl, sizes: "512x512", type: "image/jpeg" },
      { src: artworkUrl, sizes: "256x256", type: "image/jpeg" },
      { src: artworkUrl, sizes: "192x192", type: "image/jpeg" },
      { src: artworkUrl, sizes: "96x96", type: "image/jpeg" },
    ],
  });
  navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";

  const actions = {
    play: playStation,
    pause: pauseStation,
    nexttrack: () => goToTrack(state.index + 1),
    previoustrack: () => goToTrack(state.index - 1),
  };

  Object.entries(actions).forEach(([action, handler]) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      /* Some browsers expose Media Session but not every action. */
    }
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

function openShareModal() {
  $("shareLinkText").textContent = location.origin;
  $("shareModal").hidden = false;
}

function closeShareModal() {
  $("shareModal").hidden = true;
}

async function copyShareLink() {
  try {
    await navigator.clipboard.writeText(location.origin);
    setStatus("stationStatus", "Link copied");
  } catch {
    setStatus("stationStatus", "Copy unavailable", true);
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
    if (profile.wantsPlayback) {
      tryResumeStation({ silent: true });
    }
  });

  $("captureButton").addEventListener("click", captureCameraFrame);
  $("retakeButton").addEventListener("click", resetCapture);
  $("postButton").addEventListener("click", postCapture);
  $("photoButton").addEventListener("click", () => $("photoInput").click());
  $("photoInput").addEventListener("change", (event) => loadPhotoFile(event.target.files[0]));
  $("friendsButton").addEventListener("click", openShareModal);
  $("closeShareModal").addEventListener("click", closeShareModal);
  $("nativeShareButton").addEventListener("click", shareStation);
  $("copyShareButton").addEventListener("click", copyShareLink);
  $("shareModal").addEventListener("click", (event) => {
    if (event.target === $("shareModal")) closeShareModal();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && screens.create.classList.contains("is-active")) {
      loadFeed({ keepTrack: true });
      playStation({ silent: true });
    }
  });
}

bindEvents();

if (profile.name) {
  showScreen("create");
}
