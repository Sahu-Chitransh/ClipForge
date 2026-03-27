const LOCALHOST_BACKEND_URL = "http://127.0.0.1:8000";
const STORAGE_KEYS = {
  backendMode: "kinetic_backend_mode",
  cloudBackendUrl: "kinetic_cloud_backend_url",
  activeTab: "kinetic_active_tab",
  queueView: "kinetic_queue_view",
  playlistBulkFormat: "kinetic_playlist_bulk_format",
  playlistBulkQuality: "kinetic_playlist_bulk_quality",
};

const state = {
  items: [],
  pollers: new Map(),
  toastTimer: null,
  backendMode: localStorage.getItem(STORAGE_KEYS.backendMode) || "local",
  activeTab: localStorage.getItem(STORAGE_KEYS.activeTab) || "single",
  queueView: localStorage.getItem(STORAGE_KEYS.queueView) || "card",
  playlistBulkFormat: localStorage.getItem(STORAGE_KEYS.playlistBulkFormat) || "video",
  playlistBulkQuality: localStorage.getItem(STORAGE_KEYS.playlistBulkQuality) || "720p (HD)",
  playlistMeta: null,
  backendStatus: "checking",
};

const VIDEO_QUALITY_OPTIONS = [
  { label: "4K (Ultra HD)", height: 2160 },
  { label: "1440p (QHD)", height: 1440 },
  { label: "1080p (Full HD)", height: 1080 },
  { label: "720p (HD)", height: 720 },
  { label: "480p (SD)", height: 480 },
];

const AUDIO_QUALITIES = ["320 kbps (High)", "256 kbps (Standard)", "128 kbps (Mobile)"];

const PLAYLIST_VIDEO_QUALITIES = ["4K (Ultra HD)", "1440p (QHD)", "1080p (Full HD)", "720p (HD)", "480p (SD)"];
const PLAYLIST_AUDIO_QUALITIES = ["320 kbps (High)", "256 kbps (Standard)", "128 kbps (Mobile)"];

const el = {
  backendModeSelect: document.getElementById("backendModeSelect"),
  apiBaseInput: document.getElementById("apiBaseInput"),
  apiBaseLabel: document.getElementById("apiBaseLabel"),
  backendHint: document.getElementById("backendHint"),
  backendStatusLight: document.getElementById("backendStatusLight"),
  backendStatusText: document.getElementById("backendStatusText"),
  tabSingleButton: document.getElementById("tabSingleButton"),
  tabPlaylistButton: document.getElementById("tabPlaylistButton"),
  singlePanel: document.getElementById("singlePanel"),
  playlistPanel: document.getElementById("playlistPanel"),
  playlistUrlInput: document.getElementById("playlistUrlInput"),
  loadPlaylistButton: document.getElementById("loadPlaylistButton"),
  playlistSummary: document.getElementById("playlistSummary"),
  playlistTitleText: document.getElementById("playlistTitleText"),
  selectAllPlaylistWrap: document.getElementById("selectAllPlaylistWrap"),
  selectAllPlaylistCheckbox: document.getElementById("selectAllPlaylistCheckbox"),
  primaryDownloadButton: document.getElementById("primaryDownloadButton"),
  primaryDownloadLabel: document.getElementById("downloadAllLabel"),
  primaryDownloadHint: document.getElementById("primaryDownloadHint"),
  secondaryDownloadButton: document.getElementById("secondaryDownloadButton"),
  secondaryDownloadLabel: document.getElementById("secondaryDownloadLabel"),
  queueList: document.getElementById("queueList"),
  queueCount: document.getElementById("queueCount"),
  emptyState: document.getElementById("emptyState"),
  summaryText: document.getElementById("summaryText"),
  backendText: document.getElementById("backendText"),
  activeQueueTitle: document.getElementById("activeQueueTitle"),
  toast: document.getElementById("toast"),
  template: document.getElementById("queueItemTemplate"),
  addQueueButton: document.getElementById("addQueueButton"),
  urlInput: document.getElementById("urlInput"),
  clearQueueButton: document.getElementById("clearQueueButton"),
  resetFormButton: document.getElementById("resetFormButton"),
  queueCardViewButton: document.getElementById("queueCardViewButton"),
  queueListViewButton: document.getElementById("queueListViewButton"),
  playlistBulkFormatSelect: document.getElementById("playlistBulkFormatSelect"),
  playlistBulkQualitySelect: document.getElementById("playlistBulkQualitySelect"),
  helpToggleButton: document.getElementById("helpToggleButton"),
  faqPanel: document.getElementById("faqPanel"),
  faqCloseButton: document.getElementById("faqCloseButton"),
};

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeUrl(value) {
  return value.trim().replace(/\/$/, "");
}

function getBackendUrlFromUI() {
  if (state.backendMode === "local") {
    return LOCALHOST_BACKEND_URL;
  }
  const fallback = localStorage.getItem(STORAGE_KEYS.cloudBackendUrl) || window.location.origin;
  return normalizeUrl(el.apiBaseInput.value || fallback);
}

function getApiBase() {
  return getBackendUrlFromUI();
}

function showToast(message, type = "success") {
  clearTimeout(state.toastTimer);
  el.toast.textContent = message;
  el.toast.className = `${type} rounded-lg border px-4 py-3 text-sm font-label`;
  state.toastTimer = window.setTimeout(() => {
    el.toast.className = "hidden";
    el.toast.textContent = "";
  }, 3200);
}

function makeItem(url, group = "single", meta = {}) {
  return {
    id: uid(),
    group,
    selected: group === "playlist",
    url: url.trim(),
    title: meta.title || "Fetching details...",
    channel: meta.channel || "",
    uploader: meta.uploader || "",
    durationText: meta.durationText || "",
    thumbnail: meta.thumbnail || "",
    description: meta.description || "",
    metadataStatus: meta.metadataStatus || "loading",
    metadataError: meta.metadataError || "",
    availableVideoHeights: meta.availableVideoHeights || [],
    maxVideoHeight: meta.maxVideoHeight || null,
    format: meta.format || "video",
    quality: meta.quality || "720p (HD)",
    trimSegment: false,
    startTime: "",
    endTime: "",
    status: "ready",
    progress: 0,
    error: "",
    jobId: null,
    downloadUrl: "",
    fileName: "",
  };
}

function getVisibleItems() {
  return state.items.filter((item) => item.group === state.activeTab);
}

function getPlaylistItems() {
  return state.items.filter((item) => item.group === "playlist");
}

function normalizeStatus(status) {
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "processing") return "Downloading...";
  if (status === "pending") return "Waiting...";
  return "Ready";
}

function setBackendMode(mode) {
  state.backendMode = mode === "cloud" ? "cloud" : "local";
  localStorage.setItem(STORAGE_KEYS.backendMode, state.backendMode);
  syncBackendControls();
  updateSummary();
}

function setActiveTab(tab) {
  state.activeTab = tab === "playlist" ? "playlist" : "single";
  localStorage.setItem(STORAGE_KEYS.activeTab, state.activeTab);
  syncTabControls();
  render();
}

function setQueueView(view) {
  state.queueView = view === "list" ? "list" : "card";
  localStorage.setItem(STORAGE_KEYS.queueView, state.queueView);
  syncQueueViewControls();
  render();
}

function toggleFaqPanel(forceOpen = null) {
  if (!el.faqPanel) return;
  const shouldOpen = forceOpen === null ? el.faqPanel.classList.contains("hidden") : forceOpen;
  el.faqPanel.classList.toggle("hidden", !shouldOpen);
}

function setPlaylistBulkFormat(format) {
  state.playlistBulkFormat = format === "audio" ? "audio" : "video";
  if (state.playlistBulkFormat === "audio" && !state.playlistBulkQuality.toLowerCase().includes("kbps")) {
    state.playlistBulkQuality = PLAYLIST_AUDIO_QUALITIES[0];
  }
  if (state.playlistBulkFormat === "video" && state.playlistBulkQuality.toLowerCase().includes("kbps")) {
    state.playlistBulkQuality = PLAYLIST_VIDEO_QUALITIES[3];
  }
  localStorage.setItem(STORAGE_KEYS.playlistBulkFormat, state.playlistBulkFormat);
  localStorage.setItem(STORAGE_KEYS.playlistBulkQuality, state.playlistBulkQuality);
  syncPlaylistModControls();
  applyPlaylistBulkMods();
}

function setPlaylistBulkQuality(quality) {
  state.playlistBulkQuality = quality;
  state.playlistBulkFormat = quality.toLowerCase().includes("kbps") ? "audio" : "video";
  localStorage.setItem(STORAGE_KEYS.playlistBulkFormat, state.playlistBulkFormat);
  localStorage.setItem(STORAGE_KEYS.playlistBulkQuality, quality);
  syncPlaylistModControls();
  applyPlaylistBulkMods();
}

function getPlaylistBulkQualityOptions(format) {
  return format === "audio" ? PLAYLIST_AUDIO_QUALITIES : PLAYLIST_VIDEO_QUALITIES;
}

function syncPlaylistBulkQualityOptions() {
  if (!el.playlistBulkQualitySelect) return;
  const options = getPlaylistBulkQualityOptions(state.playlistBulkFormat);
  const current = state.playlistBulkQuality;
  el.playlistBulkQualitySelect.innerHTML = "";
  for (const value of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === current;
    el.playlistBulkQualitySelect.appendChild(option);
  }
  if (!options.includes(current)) {
    state.playlistBulkQuality = options[0];
    localStorage.setItem(STORAGE_KEYS.playlistBulkQuality, state.playlistBulkQuality);
    el.playlistBulkQualitySelect.value = state.playlistBulkQuality;
  }
}

function syncBackendControls() {
  el.backendModeSelect.value = state.backendMode;
  const isLocal = state.backendMode === "local";
  el.apiBaseInput.readOnly = isLocal;
  el.apiBaseInput.value = isLocal
    ? LOCALHOST_BACKEND_URL
    : normalizeUrl(el.apiBaseInput.value || localStorage.getItem(STORAGE_KEYS.cloudBackendUrl) || "");
  el.apiBaseLabel.textContent = isLocal ? "Localhost Backend URL" : "Cloud Backend URL";
  el.apiBaseInput.placeholder = isLocal ? LOCALHOST_BACKEND_URL : "https://your-cloud-backend.example.com";
  el.backendHint.textContent = isLocal
    ? "Localhost mode points to `http://127.0.0.1:8000`."
    : "Cloud mode uses the URL you enter here. Save it for future visits.";
  el.backendText.textContent = getApiBase();
  if (!isLocal && el.apiBaseInput.value) {
    localStorage.setItem(STORAGE_KEYS.cloudBackendUrl, normalizeUrl(el.apiBaseInput.value));
  }
  updateBackendStatus("checking");
}

function syncTabControls() {
  el.tabSingleButton.classList.toggle("active-tab", state.activeTab === "single");
  el.tabPlaylistButton.classList.toggle("active-tab", state.activeTab === "playlist");
  el.singlePanel.classList.toggle("hidden", state.activeTab !== "single");
  el.playlistPanel.classList.toggle("hidden", state.activeTab !== "playlist");
  el.selectAllPlaylistWrap.classList.toggle("hidden", state.activeTab !== "playlist");
  el.secondaryDownloadButton.classList.remove("hidden");
  el.activeQueueTitle.textContent = state.activeTab === "single" ? "ACTIVE QUEUE" : "PLAYLIST VIDEOS";
}

function syncQueueViewControls() {
  el.queueCardViewButton.classList.toggle("active-view", state.queueView === "card");
  el.queueListViewButton.classList.toggle("active-view", state.queueView === "list");
  el.queueList.classList.toggle("queue-view-list", state.queueView === "list");
}

function syncPlaylistModControls() {
  if (!el.playlistBulkFormatSelect || !el.playlistBulkQualitySelect) return;
  el.playlistBulkFormatSelect.value = state.playlistBulkFormat;
  syncPlaylistBulkQualityOptions();
  el.playlistBulkQualitySelect.value = state.playlistBulkQuality;
}

function applyPlaylistBulkMods() {
  const playlistItems = getPlaylistItems();
  if (!playlistItems.length) {
    render();
    return;
  }

  playlistItems.forEach((item) => {
    item.format = state.playlistBulkFormat;
    item.quality = state.playlistBulkQuality;
    if (item.format === "video") {
      normalizeVideoQuality(item);
    }
  });
  render();
}

function updateSummary() {
  const visible = getVisibleItems();
  const completed = visible.filter((item) => item.status === "completed").length;
  const processing = visible.filter((item) => item.status === "processing").length;
  const selected = visible.filter((item) => item.selected).length;
  el.queueCount.textContent = `${visible.length} ITEM${visible.length === 1 ? "" : "S"}`;
  el.primaryDownloadLabel.textContent =
    state.activeTab === "playlist"
      ? `DOWNLOAD ALL (${visible.length} ITEMS)`
      : `DOWNLOAD ALL (${visible.length} ITEMS)`;
  el.primaryDownloadHint.textContent =
    state.activeTab === "playlist"
      ? "Start every playlist download"
      : "Start every queued download";
  el.secondaryDownloadLabel.textContent = `SAVE FILES TO PC (${completed} READY)`;
  el.summaryText.textContent = `${completed} completed, ${processing} active, ${Math.max(visible.length - completed - processing, 0)} queued`;
  el.backendText.textContent = getApiBase();
  el.emptyState.classList.toggle("hidden", visible.length > 0);

  if (state.playlistMeta) {
    el.playlistSummary.classList.remove("hidden");
    el.playlistSummary.textContent = `${state.playlistMeta.title} • ${visible.length} loaded • ${selected} selected`;
    el.playlistTitleText.textContent = state.playlistMeta.title;
  } else {
    el.playlistSummary.classList.add("hidden");
    el.playlistSummary.textContent = "";
    el.playlistTitleText.textContent = "No playlist loaded";
  }

  el.selectAllPlaylistCheckbox.checked = visible.length > 0 && visible.every((item) => item.selected);
}

function updateBackendStatus(stateName) {
  const isOnline = stateName === "online";
  const isOffline = stateName === "offline";
  el.backendStatusLight.className = `h-2.5 w-2.5 rounded-full ${
    isOnline
      ? "bg-[#34d399] shadow-[0_0_12px_rgba(52,211,153,0.6)]"
      : isOffline
        ? "bg-[#f87171] shadow-[0_0_12px_rgba(248,113,113,0.6)]"
        : "bg-[#fbbf24] shadow-[0_0_12px_rgba(251,191,36,0.45)]"
  }`;
  el.backendStatusText.textContent = isOnline ? "Backend online" : isOffline ? "Backend offline" : "Checking backend...";
}

function itemPayload(item) {
  const payload = {
    url: item.url,
    format: item.format,
    quality: item.quality,
    trimSegment: item.trimSegment,
  };
  if (item.format === "audio") {
    payload.audioBitrate = item.quality;
  }
  if (item.trimSegment) {
    if (item.startTime.trim()) payload.startTime = item.startTime.trim();
    if (item.endTime.trim()) payload.endTime = item.endTime.trim();
  }
  return payload;
}

function supportsHeight(item, height) {
  if (Array.isArray(item.availableVideoHeights) && item.availableVideoHeights.length) {
    return item.availableVideoHeights.includes(height);
  }
  if (item.maxVideoHeight) {
    return item.maxVideoHeight >= height;
  }
  return height <= 720;
}

function getVideoQualityOptions(item) {
  return VIDEO_QUALITY_OPTIONS.filter((option) => supportsHeight(item, option.height));
}

function getDefaultVideoQuality(item) {
  const options = getVideoQualityOptions(item);
  return options.length ? options[0].label : "720p (HD)";
}

function getItemsToSave() {
  const visible = getVisibleItems();
  if (state.activeTab === "playlist") {
    const selected = visible.filter((item) => item.selected && item.status === "completed");
    if (selected.length) return selected;
  }
  return visible.filter((item) => item.status === "completed");
}

function getQualityOptions(item) {
  if (item.format === "audio") {
    return AUDIO_QUALITIES;
  }
  if (item.metadataStatus === "loaded" || item.metadataStatus === "failed") {
    return getVideoQualityOptions(item).map((option) => option.label);
  }
  return ["720p (HD)", "480p (SD)"];
}

function formatMetaLine(item) {
  const parts = [];
  if (item.channel) parts.push(item.channel);
  if (item.uploader && item.uploader !== item.channel) parts.push(item.uploader);
  if (item.durationText) parts.push(item.durationText);
  if (item.description) parts.push(item.description);
  return parts.filter(Boolean).join(" • ");
}

function normalizeVideoQuality(item) {
  if (item.format !== "video") return;
  const options = getVideoQualityOptions(item);
  if (!options.length) {
    item.quality = "720p (HD)";
    return;
  }
  if (!options.some((option) => option.label === item.quality)) {
    item.quality = options[0].label;
  }
}

function renderItem(item) {
  const fragment = el.template.content.cloneNode(true);
  const root = fragment.querySelector(".queue-card");
  root.dataset.id = item.id;

  const title = fragment.querySelector(".item-title");
  const subtitle = fragment.querySelector(".item-subtitle");
  const meta = fragment.querySelector(".item-meta");
  const status = fragment.querySelector(".item-status");
  const progressText = fragment.querySelector(".item-progress-text");
  const progressBar = fragment.querySelector(".item-progress-bar");
  const error = fragment.querySelector(".item-error");
  const trimToggle = fragment.querySelector(".trim-toggle");
  const trimGrid = fragment.querySelector(".trim-grid");
  const startTime = fragment.querySelector(".start-time");
  const endTime = fragment.querySelector(".end-time");
  const qualityLabel = fragment.querySelector(".quality-label");
  const qualitySelect = fragment.querySelector(".quality-select");
  const actions = fragment.querySelector(".item-actions");
  const downloadLink = fragment.querySelector(".download-link");
  const filename = fragment.querySelector(".filename");
  const duration = fragment.querySelector(".item-duration");
  const thumbnail = fragment.querySelector(".item-thumbnail");
  const thumbnailFallback = fragment.querySelector(".item-thumbnail-fallback");
  const selectWrap = fragment.querySelector(".item-select-wrap");
  const selectCheckbox = fragment.querySelector(".item-select");

  title.textContent = item.title || item.url;
  subtitle.textContent = item.channel ? `YouTube • ${item.channel}` : "YouTube • fetching metadata...";
  meta.textContent = formatMetaLine(item);
  status.textContent = item.metadataStatus === "loading" ? "Fetching metadata..." : normalizeStatus(item.status);
  progressText.textContent = `${Math.round(item.progress)}%`;
  progressBar.style.width = `${Math.max(0, Math.min(100, item.progress))}%`;
  trimToggle.checked = item.trimSegment;
  trimGrid.classList.toggle("hidden", !item.trimSegment);
  startTime.value = item.startTime;
  endTime.value = item.endTime;
  duration.textContent = item.durationText || "Queued";

  if (item.thumbnail) {
    thumbnail.src = item.thumbnail;
    thumbnail.classList.remove("hidden");
    thumbnailFallback.classList.add("hidden");
  } else {
    thumbnail.removeAttribute("src");
    thumbnail.classList.add("hidden");
    thumbnailFallback.classList.remove("hidden");
  }

  const showSelect = state.activeTab === "playlist" && item.group === "playlist";
  selectWrap.classList.toggle("hidden", !showSelect);
  selectWrap.classList.toggle("flex", showSelect);
  selectCheckbox.checked = !!item.selected;

  qualityLabel.textContent = item.format === "audio" ? "Bitrate" : "Quality";
  qualitySelect.innerHTML = "";
  const options = getQualityOptions(item);
  if (item.metadataStatus === "loading" && item.format === "video") {
    const loadingOption = document.createElement("option");
    loadingOption.disabled = true;
    loadingOption.selected = true;
    loadingOption.textContent = "Inspecting available qualities...";
    qualitySelect.appendChild(loadingOption);
  }
  for (const value of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === item.quality;
    qualitySelect.appendChild(option);
  }

  if (item.format === "video" && options.length && !options.includes(item.quality)) {
    item.quality = options[0];
  }

  for (const button of fragment.querySelectorAll(".format-button")) {
    button.classList.toggle("active-format", button.dataset.format === item.format);
  }

  if (item.status === "completed" && item.downloadUrl) {
    actions.classList.remove("hidden");
    downloadLink.href = item.downloadUrl;
    filename.textContent = item.fileName || "File ready";
    root.classList.add("border-primary");
  } else {
    actions.classList.add("hidden");
    root.classList.toggle("border-primary", item.status === "processing");
  }

  if (item.metadataError) {
    status.textContent = "Metadata unavailable";
    meta.textContent = item.metadataError;
  }

  if (item.error) {
    error.classList.remove("hidden");
    error.textContent = item.error;
    root.classList.add("border-error");
  } else {
    error.classList.add("hidden");
  }

  return fragment;
}

function render() {
  const visible = getVisibleItems();
  el.queueList.innerHTML = "";
  for (const item of visible) {
    el.queueList.appendChild(renderItem(item));
  }
  syncQueueViewControls();
  updateSummary();
}

function triggerBrowserDownload(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function updateItem(id, changes) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  Object.assign(item, changes);
  render();
}

async function fetchMetadataForUrls(urls) {
  const response = await fetch(`${getApiBase()}/api/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Metadata request failed.");
  }
  return data.items || [];
}

async function hydrateMetadataForItems(items) {
  if (!items.length) return;
  try {
    const metadataList = await fetchMetadataForUrls(items.map((item) => item.url));
    metadataList.forEach((metadata, index) => {
      const item = items[index];
      if (!item) return;
      item.title = metadata.title || item.url;
      item.channel = metadata.channel || "";
      item.uploader = metadata.uploader || "";
      item.durationText = metadata.duration_text || "";
      item.thumbnail = metadata.thumbnail || "";
      item.description = metadata.description ? metadata.description.slice(0, 140) : "";
      item.availableVideoHeights = metadata.available_video_heights || [];
      item.maxVideoHeight = metadata.max_video_height || null;
      item.metadataStatus = "loaded";
      item.metadataError = "";
      normalizeVideoQuality(item);
    });
    render();
  } catch (error) {
    items.forEach((item) => {
      item.title = item.url;
      item.metadataStatus = "failed";
      item.metadataError = error.message || "Metadata fetch failed.";
    });
    render();
    showToast(error.message || "Metadata fetch nahi ho paya.", "error");
  }
}

async function fetchPlaylist(url) {
  const response = await fetch(`${getApiBase()}/api/playlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Playlist load failed.");
  }
  return data.playlist;
}

function addUrlsToQueue() {
  const urls = el.urlInput.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!urls.length) {
    showToast("At least one URL paste karo.", "error");
    return;
  }

  const newItems = urls.map((url) => makeItem(url, "single"));
  state.items.push(...newItems);
  el.urlInput.value = "";
  render();
  showToast(`${urls.length} item queue mein add ho gaya.`);
  hydrateMetadataForItems(newItems);
}

async function loadPlaylist() {
  const url = el.playlistUrlInput.value.trim();
  if (!url) {
    showToast("Playlist URL paste karo.", "error");
    return;
  }

  try {
    el.loadPlaylistButton.disabled = true;
    el.loadPlaylistButton.textContent = "Loading...";
    const playlist = await fetchPlaylist(url);
    state.playlistMeta = playlist;
    state.items = state.items.filter((item) => item.group !== "playlist");

    const playlistItems = (playlist.entries || []).map((entry) =>
      makeItem(entry.url || url, "playlist", {
        title: entry.title,
        channel: entry.channel,
        uploader: entry.uploader,
        durationText: entry.duration_text,
        thumbnail: entry.thumbnail,
        description: entry.description ? String(entry.description).slice(0, 140) : "",
        metadataStatus: "loaded",
        availableVideoHeights: entry.available_video_heights || [],
        maxVideoHeight: entry.max_video_height || null,
        quality: "720p (HD)",
      })
    );

    state.items.push(...playlistItems);
    state.activeTab = "playlist";
    localStorage.setItem(STORAGE_KEYS.activeTab, state.activeTab);
    syncTabControls();
    syncPlaylistModControls();
    applyPlaylistBulkMods();
    render();
    showToast(`Playlist loaded: ${playlist.title}`);
  } catch (error) {
    showToast(error.message || "Playlist load nahi ho paya.", "error");
  } finally {
    el.loadPlaylistButton.disabled = false;
    el.loadPlaylistButton.textContent = "Load Playlist";
  }
}

function clearQueue() {
  for (const poller of state.pollers.values()) {
    clearInterval(poller);
  }
  state.pollers.clear();
  state.items = state.items.filter((item) => item.group !== state.activeTab);
  if (state.activeTab === "playlist") {
    state.playlistMeta = null;
    el.playlistUrlInput.value = "";
  }
  render();
}

function resetForm() {
  el.urlInput.value = "";
  el.playlistUrlInput.value = "";
  state.items = [];
  state.playlistMeta = null;
  clearQueue();
  showToast("Form reset ho gaya.");
}

function setPlaylistSelection(selected) {
  for (const item of getPlaylistItems()) {
    item.selected = selected;
  }
  render();
}

async function pollJob(itemId, jobId) {
  const poller = window.setInterval(async () => {
    try {
      const response = await fetch(`${getApiBase()}/api/status/${jobId}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Status request failed.");
      }

      updateItem(itemId, {
        status: data.status,
        progress: data.progress ?? 0,
        error: data.error || "",
        downloadUrl: data.download_url ? `${getApiBase()}${data.download_url}` : "",
        fileName: data.file_name || "",
      });

      if (data.status === "completed" || data.status === "failed") {
        clearInterval(poller);
        state.pollers.delete(itemId);
        if (data.status === "completed") {
          showToast("Download complete.");
        }
      }
    } catch (error) {
      clearInterval(poller);
      state.pollers.delete(itemId);
      updateItem(itemId, { status: "failed", error: error.message || "Polling failed." });
    }
  }, 1500);

  state.pollers.set(itemId, poller);
}

async function submitItems(items) {
  const response = await fetch(`${getApiBase()}/api/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: items.map(itemPayload) }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Download request failed.");
  }
  return data.jobs || [];
}

async function downloadItems(items) {
  if (!items.length) {
    showToast("No videos selected.", "error");
    return;
  }

  try {
    const jobs = await submitItems(items);
    jobs.forEach((job, index) => {
      const item = items[index];
      updateItem(item.id, {
        jobId: job.job_id,
        status: job.status || "pending",
        progress: job.progress || 0,
        error: "",
      });
      pollJob(item.id, job.job_id);
    });
    showToast(`${items.length} download request bhej diya gaya.`);
  } catch (error) {
    showToast(error.message || "Download start nahi ho paya.", "error");
  }
}

function primaryDownload() {
  const visible = getVisibleItems();
  downloadItems(visible);
}

function saveFilesToPc() {
  const items = getItemsToSave();
  if (!items.length) {
    showToast("No completed files to save.", "error");
    return;
  }

  items.forEach((item, index) => {
    const url = item.downloadUrl || (item.jobId ? `${getApiBase()}/api/files/${item.jobId}` : "");
    if (!url) return;
    const filename = item.fileName || `download-${index + 1}`;
    triggerBrowserDownload(url, filename);
  });
  showToast(`${items.length} file${items.length === 1 ? "" : "s"} saving to PC.`);
}

function prepareBackendMode() {
  const savedCloudUrl = localStorage.getItem(STORAGE_KEYS.cloudBackendUrl);
  if (savedCloudUrl) {
    el.apiBaseInput.value = savedCloudUrl;
  }

  if (!localStorage.getItem(STORAGE_KEYS.backendMode)) {
    state.backendMode = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "local" : "cloud";
    localStorage.setItem(STORAGE_KEYS.backendMode, state.backendMode);
  }

  syncBackendControls();
}

async function refreshBackendStatus() {
  const base = getApiBase();
  if (!base) {
    state.backendStatus = "offline";
    updateBackendStatus("offline");
    return;
  }

  try {
    const response = await fetch(`${base}/health`, { cache: "no-store" });
    if (!response.ok) throw new Error("Backend unhealthy");
    state.backendStatus = "online";
    updateBackendStatus("online");
  } catch (_) {
    state.backendStatus = "offline";
    updateBackendStatus("offline");
  }
}

function init() {
  prepareBackendMode();
  syncTabControls();
  syncQueueViewControls();
  syncPlaylistModControls();
  render();
  refreshBackendStatus();
  window.setInterval(refreshBackendStatus, 15000);
}

el.tabSingleButton.addEventListener("click", () => setActiveTab("single"));
el.tabPlaylistButton.addEventListener("click", () => setActiveTab("playlist"));
el.addQueueButton.addEventListener("click", addUrlsToQueue);
el.loadPlaylistButton.addEventListener("click", loadPlaylist);
el.clearQueueButton.addEventListener("click", clearQueue);
el.resetFormButton.addEventListener("click", resetForm);
el.primaryDownloadButton.addEventListener("click", primaryDownload);
el.secondaryDownloadButton.addEventListener("click", saveFilesToPc);
el.backendModeSelect.addEventListener("change", (event) => setBackendMode(event.target.value));
el.selectAllPlaylistCheckbox.addEventListener("change", (event) => setPlaylistSelection(event.target.checked));
el.queueCardViewButton.addEventListener("click", () => setQueueView("card"));
el.queueListViewButton.addEventListener("click", () => setQueueView("list"));
el.playlistBulkFormatSelect.addEventListener("change", (event) => setPlaylistBulkFormat(event.target.value));
el.playlistBulkQualitySelect.addEventListener("change", (event) => setPlaylistBulkQuality(event.target.value));
el.helpToggleButton.addEventListener("click", () => toggleFaqPanel());
el.faqCloseButton.addEventListener("click", () => toggleFaqPanel(false));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    toggleFaqPanel(false);
  }
});

el.apiBaseInput.addEventListener("input", () => {
  if (state.backendMode === "cloud") {
    localStorage.setItem(STORAGE_KEYS.cloudBackendUrl, normalizeUrl(el.apiBaseInput.value));
  }
  syncBackendControls();
  updateSummary();
  refreshBackendStatus();
});

el.queueList.addEventListener("click", (event) => {
  const card = event.target.closest(".queue-card");
  if (!card) return;
  const itemId = card.dataset.id;
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) return;

  const removeButton = event.target.closest(".remove-item");
  if (removeButton) {
    const poller = state.pollers.get(itemId);
    if (poller) {
      clearInterval(poller);
      state.pollers.delete(itemId);
    }
    state.items = state.items.filter((entry) => entry.id !== itemId);
    render();
    return;
  }

  const selectWrap = event.target.closest(".item-select-wrap");
  if (selectWrap && state.activeTab === "playlist" && item.group === "playlist") {
    const checkbox = selectWrap.querySelector(".item-select");
    item.selected = checkbox ? checkbox.checked : !item.selected;
    render();
    return;
  }

  const formatButton = event.target.closest(".format-button");
  if (formatButton) {
    item.format = formatButton.dataset.format;
    item.quality = item.format === "audio" ? AUDIO_QUALITIES[0] : getDefaultVideoQuality(item);
    render();
    return;
  }

  const downloadNow = event.target.closest(".download-now");
  if (downloadNow) {
    downloadItems([item]);
  }
});

el.queueList.addEventListener("change", (event) => {
  const card = event.target.closest(".queue-card");
  if (!card) return;
  const item = state.items.find((entry) => entry.id === card.dataset.id);
  if (!item) return;

  if (event.target.classList.contains("quality-select")) {
    item.quality = event.target.value;
  }
  if (event.target.classList.contains("trim-toggle")) {
    item.trimSegment = event.target.checked;
    if (!item.trimSegment) {
      item.startTime = "";
      item.endTime = "";
    }
  }
  if (event.target.classList.contains("item-select")) {
    item.selected = event.target.checked;
  }
  render();
});

el.queueList.addEventListener("input", (event) => {
  const card = event.target.closest(".queue-card");
  if (!card) return;
  const item = state.items.find((entry) => entry.id === card.dataset.id);
  if (!item) return;

  if (event.target.classList.contains("start-time")) {
    item.startTime = event.target.value;
  }
  if (event.target.classList.contains("end-time")) {
    item.endTime = event.target.value;
  }
});

init();
