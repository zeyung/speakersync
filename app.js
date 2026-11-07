import { Room } from "./room.js";
import { deviceKind, makeRoomCode, normalizeRoomCode } from "./sync.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const ICONS = { iPhone: "📱", "Android phone": "📱", iPad: "📲", "Android tablet": "📲", Mac: "💻", "Windows PC": "💻", "Linux PC": "💻", Chromebook: "💻", TV: "📺" };

let room = null;
const editing = new Set();   // sliders being dragged, so updates don't yank them
let wakeLock = null;

// ---------------- start screen ----------------

const kind = deviceKind(navigator.userAgent);
$("nameInput").value = localStorage.getItem("speakersync.name") || kind;
const params = new URLSearchParams(location.search);
const linkCode = normalizeRoomCode(params.get("room"));
if (linkCode.length === 4) {
  $("codeInput").value = linkCode;
  $("tapTitle").textContent = `Join room ${linkCode}`;
  $("tapOverlay").hidden = false;
}

$("hostButton").onclick = () => enter({ code: makeRoomCode(), isHost: true });
$("joinForm").onsubmit = (e) => {
  e.preventDefault();
  const code = normalizeRoomCode($("codeInput").value);
  if (code.length !== 4) return showStartError("Enter the 4-character room code shown on the host device.");
  enter({ code, isHost: false });
};
$("tapButton").onclick = () => { $("tapOverlay").hidden = true; enter({ code: linkCode, isHost: false }); };

function showStartError(text) {
  $("startError").textContent = text;
  $("startError").hidden = !text;
}

async function enter({ code, isHost }, attempt = 0) {
  showStartError("");
  const name = $("nameInput").value.trim() || kind;
  localStorage.setItem("speakersync.name", name);
  if (typeof Peer === "undefined") return showStartError("Couldn't load SpeakerSync's connection library. Check your internet connection and reload.");
  setBusy(true);
  const next = new Room({ code, isHost, name, kind });
  next.addEventListener("change", render);
  next.addEventListener("problem", (e) => showProblem(e.message));
  try {
    await next.open();
  } catch (err) {
    next.close();
    setBusy(false);
    if (isHost && /already in use/.test(err.message) && attempt < 3) return enter({ code: makeRoomCode(), isHost }, attempt + 1);
    return showStartError(err.message);
  }
  room = next;
  setBusy(false);
  history.replaceState(null, "", `${location.pathname}?room=${code}`);
  $("start").hidden = true;
  $("room").hidden = false;
  setupInvite();
  keepAwake();
  render();
  requestAnimationFrame(tick);
}

function setBusy(busy) {
  for (const id of ["hostButton", "joinButton", "tapButton"]) $(id).disabled = busy;
  $("hostButton").textContent = busy ? "Connecting…" : "Start a room";
}

$("leaveButton").onclick = () => {
  room?.close();
  room = null;
  history.replaceState(null, "", location.pathname);
  $("room").hidden = true;
  $("start").hidden = false;
  wakeLock?.release().catch(() => {});
};

// ---------------- room screen ----------------

function joinLink() {
  return `${location.origin}${location.pathname}?room=${room.code}`;
}

function setupInvite() {
  $("roomCode").textContent = room.code;
  $("inviteCode").textContent = room.code;
  $("inviteHost").textContent = location.host + location.pathname.replace(/index\.html$/, "");
  const qr = qrcode(0, "M");
  qr.addData(joinLink());
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  $("inviteCard").hidden = false;
}

$("hideInvite").onclick = () => { $("inviteCard").hidden = true; };
$("shareButton").onclick = async () => {
  const data = { title: "SpeakerSync", text: `Join my SpeakerSync room ${room.code}`, url: joinLink() };
  try {
    if (navigator.share) await navigator.share(data);
    else { await navigator.clipboard.writeText(data.url); $("shareButton").textContent = "Link copied"; }
  } catch {}
};

$("fileInput").onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length) await room.addFiles(files);
};
$("playButton").onclick = () => room.command(room.state.playback.playing ? "pause" : "play");
$("prevButton").onclick = () => room.command("previous");
$("nextButton").onclick = () => room.command("next");
$("seek").oninput = () => { editing.add("seek"); $("elapsed").textContent = fmtTime(+$("seek").value); };
$("seek").onchange = () => { editing.delete("seek"); room.command("seek", { position: +$("seek").value }); };
$("autoSyncButton").onclick = () => room.command("autoSync", { listener: room.me });
$("clickButton").onclick = () => room.command("clicks", { on: !room.state.clicks });

function showProblem(text) {
  const box = $("problems");
  box.innerHTML = `<div class="notice" role="status">${esc(text)}</div>`;
  clearTimeout(showProblem.timer);
  showProblem.timer = setTimeout(() => { box.innerHTML = ""; }, 8000);
}

function render() {
  if (!room) return;
  const s = room.state;
  const pb = s.playback;
  const track = s.tracks.find(t => t.id === pb.trackId);

  // Connection
  const status = $("connStatus");
  const connected = room.connected;
  const offline = Object.values(s.devices).filter(d => d.online).length;
  let text;
  if (!connected) text = room.isHost ? "Room offline" : "Disconnected";
  else if (room.isHost) text = `You're the host · ${offline} device${offline === 1 ? "" : "s"}`;
  else text = room.clock.bestRtt == null ? "Syncing clocks…" : `Clock in sync (±${Math.max(1, Math.round(room.clock.bestRtt / 2))} ms)`;
  status.className = `status ${connected ? "ok" : "bad"}`;
  status.lastElementChild.textContent = text;

  // Now playing
  $("trackTitle").textContent = track ? track.name : "No song yet";
  const mineReady = track && room.player.buffers.has(track.id);
  $("trackSub").textContent = !track ? (room.isHost ? "Add songs below to get started." : "Waiting for the host to add songs.")
    : !mineReady ? `Receiving this song… ${s.devices[room.me]?.progress?.[track.id] ?? 0}%`
    : pb.playing ? "Playing on every device" : "Paused";
  $("duration").textContent = fmtTime(track?.duration);
  $("seek").max = track?.duration || 1;
  $("seek").disabled = !track;
  $("playButton").disabled = !track;
  $("playButton").setAttribute("aria-label", pb.playing ? "Pause" : "Play");
  $("playIcon").innerHTML = pb.playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';

  // Songs
  $("addSongs").hidden = !room.isHost;
  $("addSongs").className = "button primary";
  $("trackList").innerHTML = s.tracks.map(t => `
    <li class="track ${t.id === pb.trackId ? "current" : ""}">
      <button class="select" data-track="${t.id}">${esc(t.name)}</button>
      <span class="len">${fmtTime(t.duration)}</span>
      ${room.isHost ? `<button class="remove" data-remove="${t.id}" aria-label="Remove ${esc(t.name)}">✕</button>` : ""}
    </li>`).join("");
  $("trackList").querySelectorAll("[data-track]").forEach(b => b.onclick = () => room.command("select", { trackId: b.dataset.track, play: true }));
  $("trackList").querySelectorAll("[data-remove]").forEach(b => b.onclick = () => room.command("remove", { trackId: b.dataset.remove }));
  $("songsHint").textContent = room.isHost
    ? (s.tracks.length ? "Songs are sent to every device in the room, including ones that join later." : "Pick audio files from this device (MP3, M4A, WAV…). Streaming apps like Spotify can't be shared.")
    : (s.tracks.length ? "" : "The host adds songs; they arrive here automatically.");

  renderDevices(s);

  // Sync
  const running = s.autoSync.status === "running";
  $("autoSyncButton").disabled = running || offline < 1;
  $("clickButton").disabled = running;
  $("clickButton").classList.toggle("on", !!s.clicks);
  $("clickButton").textContent = s.clicks ? "Stop sync test" : "Sync test";
  const sync = $("syncStatus");
  sync.className = `sync-status ${s.autoSync.status}`;
  sync.textContent = (running ? "⏳ " : "") + s.autoSync.text;
}

function renderDevices(s) {
  const entries = Object.entries(s.devices).sort(([a], [b]) => (a === room.me ? -1 : b === room.me ? 1 : 0));
  $("deviceCount").textContent = `${entries.filter(([, d]) => d.online).length} connected`;
  const list = $("deviceList");
  const signature = entries.map(([id, d]) => id + d.online).join("|");
  if (list.dataset.signature !== signature) {
    list.dataset.signature = signature;
    list.innerHTML = entries.map(([id]) => `
      <li class="device" data-id="${id}">
        <div class="device-head">
          <div class="device-icon"></div>
          <div><div class="device-name"></div><div class="device-sub"></div></div>
        </div>
        <div class="slider"><span>Delay</span><input type="range" data-field="latency" min="0" max="600" step="1" aria-label="Delay"><output></output></div>
        <div class="slider"><span>Volume</span><input type="range" data-field="volume" min="0" max="1" step="0.01" aria-label="Volume"><output></output></div>
        <div class="seg" role="group" aria-label="Which side of the song">
          <button data-channel="left">L only</button><button data-channel="both">Both</button><button data-channel="right">R only</button>
        </div>
      </li>`).join("");
    list.querySelectorAll(".device").forEach(li => {
      const id = li.dataset.id;
      li.querySelectorAll("input[type=range]").forEach(input => {
        const key = id + input.dataset.field;
        input.oninput = () => { editing.add(key); li.querySelector(`[data-field=${input.dataset.field}] + output`).textContent = fmtSetting(input.dataset.field, +input.value); };
        input.onchange = () => { editing.delete(key); room.setDevice(id, input.dataset.field, +input.value); };
      });
      li.querySelectorAll("[data-channel]").forEach(b => b.onclick = () => room.setDevice(id, "channel", b.dataset.channel));
    });
  }
  for (const [id, d] of entries) {
    const li = list.querySelector(`.device[data-id="${CSS.escape(id)}"]`);
    li.classList.toggle("offline", !d.online);
    li.querySelector(".device-icon").textContent = ICONS[d.kind] || "🔊";
    li.querySelector(".device-name").innerHTML = `${esc(d.name)} ${id === room.me ? "<small>(this device)</small>" : ""}`;
    const track = s.playback.trackId;
    const pct = track ? (d.progress?.[track] ?? 0) : null;
    const parts = [d.kind];
    if (!d.online) parts.push("offline");
    else if (track) parts.push(pct >= 100 ? '<span class="ok">ready</span>' : `receiving song ${pct}%`);
    if (d.rtt != null && id !== room.me) parts.push(`Wi-Fi ${Math.round(d.rtt)} ms`);
    li.querySelector(".device-sub").innerHTML = parts.join(" · ");
    for (const field of ["latency", "volume"]) {
      const input = li.querySelector(`input[data-field=${field}]`);
      if (editing.has(id + field)) continue;
      input.value = d[field];
      input.nextElementSibling.textContent = fmtSetting(field, d[field]);
    }
    li.querySelectorAll("[data-channel]").forEach(b => b.classList.toggle("on", b.dataset.channel === d.channel));
  }
}

const fmtSetting = (field, v) => field === "latency" ? `${Math.round(v)} ms` : `${Math.round(v * 100)}%`;

function tick() {
  if (!room) return;
  const s = room.state, track = s.tracks.find(t => t.id === s.playback.trackId);
  if (!editing.has("seek")) {
    const pos = Math.min(room.position(), track?.duration ?? 0);
    $("seek").value = pos;
    $("elapsed").textContent = fmtTime(pos);
  }
  requestAnimationFrame(tick);
}

// Phones dim and lock, which pauses web audio. Ask the screen to stay on while in a room.
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && room) {
    keepAwake();
    room.player.ctx?.resume();
  }
});

// For testing from the browser console.
window.speakersync = { get room() { return room; } };
