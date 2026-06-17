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
};

const icons = {
  play: '<path d="M8 5v14l11-7L8 5z"/>',
  pause: '<path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z"/>',
};

function showScreen(name) {
  Object.values(screens).forEach((screen) => screen.classList.remove("is-active"));
  screens[name].classList.add("is-active");

  if (name === "create") {
    startCamera();
    loadFeed({ keepTrack: true });
    startFeedRefresh();
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

function timeString() {
  const now = new Date();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${suffix}`;
}

function updateClocks() {
  $("captureClock").textContent = timeString();
}

function updateNameButton() {
  $("nameNext").disabled = !$("nameInput").value.trim();
}

function hideCapturePlaceholder(hidden) {
  $("capturePlaceholder").hidden = hidden;
}

async function startCamera() {
  if (state.capturedDataUrl || state.stream) return;
  const placeholder = $("capturePlaceholderText");

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    placeholder.textContent = "Choose photo";
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
    hideCapturePlaceholder(true);
    setStatus("createStatus", "");
  } catch (error) {
    placeholder.textContent = "Choose photo";
    setStatus("createStatus", "Camera unavailable", true);
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

  context.fillStyle = "rgba(0, 0, 0, 0.28)";
  context.beginPath();
  if (context.roundRect) {
    context.roundRect(size / 2 - 104, 28, 208, 54, 27);
  } else {
    const x = size / 2 - 104;
    const y = 28;
    const width = 208;
    const height = 54;
    const radius = 27;
    context.moveTo(x + radius, y);
    context.arcTo(x + width, y, x + width, y + height, radius);
    context.arcTo(x + width, y + height, x, y + height, radius);
    context.arcTo(x, y + height, x, y, radius);
    context.arcTo(x, y, x + width, y, radius);
  }
  context.fill();
  context.fillStyle = "rgba(255, 255, 255, 0.95)";
  context.font = "800 32px -apple-system, BlinkMacSystemFont, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(timeString(), size / 2, 56);

  return canvas.toDataURL("image/jpeg", 0.88);
}

function setCaptured(dataUrl) {
  state.capturedDataUrl = dataUrl;
  $("capturedPreview").src = dataUrl;
  $("capturedPreview").hidden = false;
  $("cameraPreview").hidden = true;
  $("captureClock").hidden = true;
  hideCapturePlaceholder(true);
  $("postButton").disabled = false;
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
  $("captureClock").hidden = false;
  $("postButton").disabled = true;
  $("retakeButton").disabled = true;
  $("cameraPreview").hidden = false;
  hideCapturePlaceholder(false);
  $("capturePlaceholderText").textContent = "Camera";
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
      setPlayingUi(true);
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
      setPlayingUi(false);
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
      tryResumeStation();
    }
  } catch (error) {
    setStatus("stationStatus", "Station unavailable", true);
  }
}

function renderTrack() {
  const empty = state.feed.length === 0;
  $("stationPlaceholder").hidden = !empty;
  $("stationImage").hidden = empty;
  $("stationCount").textContent = `${state.feed.length} ${state.feed.length === 1 ? "track" : "tracks"}`;
  $("stationPosition").textContent = empty ? "--" : `${state.index + 1} / ${state.feed.length}`;
  $("previousButton").disabled = empty;
  $("nextButton").disabled = empty;
  $("playButton").disabled = empty;

  if (empty) {
    $("trackTitle").textContent = "No track";
    $("trackArtist").textContent = "Post a photo to start";
    $("playButton").setAttribute("aria-label", "Start station");
    $("playButton").title = "Start station";
    clearMediaSession();
    return;
  }

  const track = state.feed[state.index];
  $("stationImage").src = track.url;
  $("stationImage").alt = `${track.name}'s station photo`;
  $("trackTitle").textContent = track.caption || "Untitled";
  $("trackArtist").textContent = track.name;
  updateMediaSession();
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

function setPlayingUi(playing) {
  $("playIcon").innerHTML = playing ? icons.pause : icons.play;
  $("playButton").setAttribute("aria-label", playing ? "Pause station" : "Start station");
  $("playButton").title = playing ? "Pause station" : "Start station";
}

async function playStation() {
  profile.wantsPlayback = true;

  if (state.feed.length === 0) {
    setStatus("stationStatus", "Post a photo to start the station");
    return;
  }

  const started = await startAudioTransport();
  if (!started) {
    setStatus("stationStatus", "Tap play once before locking your phone", true);
    return;
  }

  state.playing = true;
  setPlayingUi(true);
  updateMediaSession();
  setStatus("stationStatus", "Playing");
}

function tryResumeStation() {
  playStation();
}

function pauseStation() {
  if (state.audio) state.audio.pause();
  state.playing = false;
  profile.wantsPlayback = false;
  setPlayingUi(false);
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
    if (profile.wantsPlayback) {
      tryResumeStation();
    }
  });

  $("captureButton").addEventListener("click", captureCameraFrame);
  $("retakeButton").addEventListener("click", resetCapture);
  $("postButton").addEventListener("click", postCapture);
  $("photoButton").addEventListener("click", () => $("photoInput").click());
  $("photoInput").addEventListener("change", (event) => loadPhotoFile(event.target.files[0]));
  $("playButton").addEventListener("click", () => (state.playing ? pauseStation() : playStation()));
  $("previousButton").addEventListener("click", () => goToTrack(state.index - 1));
  $("nextButton").addEventListener("click", () => goToTrack(state.index + 1));
  $("shareFromCreate").addEventListener("click", shareStation);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && screens.create.classList.contains("is-active")) {
      loadFeed({ keepTrack: true });
    }
  });
}

bindEvents();
updateClocks();
window.setInterval(updateClocks, 1000);

if (profile.name) {
  showScreen("create");
}
