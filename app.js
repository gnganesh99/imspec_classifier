// SPM Labeler UI: folder access, keyboard labeling, canvas / uPlot rendering.
// Python (worker.js + py/reader.py) parses files; all folder IO happens here.
"use strict";

const LOG_DIR = "classified";
const LOG_FILE = "classification_log.csv";
const LOG_COLUMNS = ["file", "type", "channel", "label", "score", "tags", "note", "timestamp"];
const DEFAULT_CONFIG = { classes: ["Good", "Bad"], score: null, notes: true, copy_files: true, copy_as: null };
const SUPPORTED = /\.(sxm|dat|3ds|jpe?g|png|bmp|gif|webp|tiff?)$/i;
const PREFETCH = 3;
const VIEW_CACHE_SIZE = 12;
const FLATTENS = ["none", "offset", "line", "plane"];
const DEFAULT_SETTINGS = {
  sxm: { flatten: "offset", cmap: "afmhot" }, "3ds": { flatten: "none", cmap: "viridis" },
  dat: {}, img: { flatten: "none", cmap: "gray" },
};

const $ = (id) => document.getElementById(id);
const state = {
  dir: null, config: DEFAULT_CONFIG, files: [], done: new Set(), pos: -1,
  current: null,    // {name, type, key, summary, view}
  gen: 0, note: "", workerReady: false, settings: loadSettings(),
  copyAs: loadPref("spm-labeler-copy-as", "original"),   // "original" | "image" (jpeg of the view)
};
const viewCache = new Map();   // `${key}|${settingsKey}` -> {summary, view}
let ioChain = Promise.resolve();
let plot = null;

// --------------------------------------------------------------------------- worker RPC
const worker = new Worker("worker.js");
const pending = new Map();
let nextId = 1;
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.status) return onWorkerStatus(m);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
};
function call(op, args, prio = 0, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, prio, gen: state.gen, ...args }, transfer);
  });
}
function onWorkerStatus(m) {
  if (m.status === "ready") {
    state.workerReady = true;
    setStatus("");
  } else if (m.status === "error") {
    setStatus("Python failed to load: " + m.error);
  } else {
    setStatus(m.status + (state.dir ? "" : " (first visit downloads ~25 MB, cached afterwards)"));
  }
}

// --------------------------------------------------------------------------- settings
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("spm-labeler-settings") || "{}"); } catch {}
  const out = {};
  for (const t of Object.keys(DEFAULT_SETTINGS)) {
    out[t] = { channel: null, direction: "forward", flatten: "none", cmap: "viridis", index: null,
               ...DEFAULT_SETTINGS[t], ...(saved[t] || {}) };
  }
  return out;
}
function saveSettings() {
  try { localStorage.setItem("spm-labeler-settings", JSON.stringify(state.settings)); } catch {}
}
function settingsKey(s) { return [s.channel, s.direction, s.flatten, s.index].join("|"); }

// --------------------------------------------------------------------------- folder
async function openFolder(handle) {
  try {
    if (!handle) handle = await window.showDirectoryPicker({ id: "spm-labeler", mode: "readwrite" });
    else if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") return;
  } catch (e) {
    if (e.name !== "AbortError") toast(e.message);
    return;
  }
  state.dir = handle;
  rememberHandle(handle);
  $("folder").textContent = handle.name;
  state.config = { ...DEFAULT_CONFIG, ...(await readJson("labeler.json")) };
  if (["original", "image"].includes(state.config.copy_as)) setCopyAs(state.config.copy_as);
  $("copyRow").classList.toggle("hidden", !state.config.copy_files);
  const files = [];
  for await (const [name, h] of handle.entries()) {
    if (h.kind === "file" && SUPPORTED.test(name)) files.push(name);
  }
  state.files = files.sort(naturalCompare);
  state.done = new Set((await readLog()).map((r) => r.file));
  viewCache.clear();
  buildLabelButtons();
  $("message").classList.add("hidden");
  $("side").classList.remove("hidden");
  if (!state.files.length) return showMessage("No supported files in this folder", "");
  goTo(nextUndone(0));
}

async function readJson(name) {
  try {
    const f = await (await state.dir.getFileHandle(name)).getFile();
    return JSON.parse(await f.text());
  } catch (e) {
    if (e.name !== "NotFoundError") toast(`${name} ignored: ${e.message}`);
    return {};
  }
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function fileType(name) {
  const ext = name.split(".").pop().toLowerCase();
  return ["sxm", "dat", "3ds"].includes(ext) ? ext : "img";
}

function nextUndone(from) {
  for (let i = from; i < state.files.length; i++) if (!state.done.has(state.files[i])) return i;
  return state.files.length;
}

// --------------------------------------------------------------------------- showing files
async function goTo(pos) {
  state.pos = pos;
  state.gen++;
  worker.postMessage({ op: "cancel", gen: state.gen });
  updateProgress();
  if (pos >= state.files.length) return showEnd();
  const name = state.files[pos];
  const type = fileType(name);
  state.current = { name, type, key: null, summary: null, view: null };
  $("fileName").textContent = name;
  $("fileInfo").textContent = `${pos + 1} of ${state.files.length} · ${type === "img" ? "image" : "." + type}`;
  try {
    const res = await fetchView(name, state.settings[type], 0);
    if (state.current.name !== name) return;
    Object.assign(state.current, res);
    draw();
  } catch (e) {
    if (state.current.name !== name || e.message === "cancelled") return;
    showMessage("Could not read this file", e.message);
  }
  prefetch(pos);
}

async function fetchView(name, settings, prio) {
  const file = await (await state.dir.getFileHandle(name)).getFile();
  const key = `${name}|${file.size}|${file.lastModified}`;
  const ck = key + "|" + settingsKey(settings);
  if (viewCache.has(ck)) return { key, ...viewCache.get(ck) };
  if (!state.workerReady) setStatus("Loading Python…");
  const bytes = await file.arrayBuffer();
  const res = await call("show", { key, name, bytes, settings }, prio, [bytes]);
  cacheView(ck, res);
  return { key, ...res };
}

function cacheView(ck, res) {
  viewCache.delete(ck);
  viewCache.set(ck, res);
  while (viewCache.size > VIEW_CACHE_SIZE) viewCache.delete(viewCache.keys().next().value);
}

function prefetch(pos) {
  let i = pos;
  for (let n = 0; n < PREFETCH; n++) {
    i = nextUndone(i + 1);
    if (i >= state.files.length) break;
    const name = state.files[i];
    fetchView(name, state.settings[fileType(name)], 1).catch(() => {});
  }
}

// re-render the current file after a settings change
let renderSeq = 0;
async function rerender() {
  const cur = state.current;
  if (!cur || !cur.key) return;
  const seq = ++renderSeq;
  const s = state.settings[cur.type];
  saveSettings();
  const ck = cur.key + "|" + settingsKey(s);
  let res = viewCache.get(ck);
  if (!res) {
    try {
      res = await call("render", { key: cur.key, settings: s }, 0);
      if (res.notLoaded) res = await fetchView(cur.name, s, 0);
      else cacheView(ck, res);
    } catch (e) {
      return toast(e.message);
    }
  }
  if (state.current !== cur || seq !== renderSeq) return;   // a newer file or setting won
  Object.assign(cur, res);
  draw();
  prefetch(state.pos);   // neighbours with the new settings
}

// --------------------------------------------------------------------------- drawing
function draw() {
  const { type, summary, view } = state.current;
  const s = state.settings[type];
  $("message").classList.add("hidden");

  const sel = $("channel");
  sel.replaceChildren(...summary.channels.map((c) => new Option(c, c)));
  sel.value = view.channel;
  $("fallback").classList.toggle("hidden", !view.fallback);

  const dirs = summary.directions[view.channel] || [];
  const isImage = view.kind === "image" || view.kind === "cube";
  $("dirRow").classList.toggle("hidden", dirs.length < 2 || view.kind === "spectrum");
  for (const b of $("direction").children) b.classList.toggle("on", b.dataset.dir === view.direction);
  $("flattenRow").classList.toggle("hidden", !isImage);
  $("flatten").value = s.flatten;
  $("cmapRow").classList.toggle("hidden", !isImage);
  $("cmap").value = s.cmap;
  $("sliceRow").classList.toggle("hidden", view.kind !== "cube");
  if (view.kind === "cube") {
    $("slice").max = view.n - 1;
    $("slice").value = view.index;
    $("sliceText").textContent = `${view.index + 1}/${view.n} · ${fmt(view.slice_value)} ${unitOf(view.slice_label)}`;
  }

  const showImg = view.kind !== "spectrum";
  $("canvasWrap").classList.toggle("hidden", !showImg);
  $("scale").classList.toggle("hidden", !showImg);
  $("cbar").classList.toggle("hidden", view.kind === "rgb");
  if (showImg) drawImage(view, s.cmap);
  const spec = view.kind === "spectrum" ? view : view.spectrum;
  $("plot").classList.toggle("hidden", !spec);
  if (spec) drawPlot(spec, view.kind === "cube" ? view.slice_value : null, showImg);
  else if (plot) { plot.destroy(); plot = null; }
}

function lut(name) {
  const hex = COLORMAPS[name] || COLORMAPS.gray;
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) out.set([0, 2, 4].map((o) => parseInt(hex.substr(i * 6 + o, 2), 16)), i * 3);
  return out;
}
const lutCache = {};

function drawImage(view, cmap) {
  const c = $("img");
  c.width = view.w;
  c.height = view.h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(view.w, view.h);
  if (view.kind === "rgb") {
    img.data.set(view.data);
  } else {
    const table = (lutCache[cmap] ||= lut(cmap));
    const px = img.data, idx = view.data;
    for (let i = 0, j = 0; i < idx.length; i++, j += 4) {
      const v = idx[i];
      if (v === 255) { px[j + 3] = 0; continue; }   // no data -> transparent
      const k = Math.round(v * 255 / 254) * 3;
      px[j] = table[k]; px[j + 1] = table[k + 1]; px[j + 2] = table[k + 2]; px[j + 3] = 255;
    }
    drawColorbar(cmap, view);
  }
  ctx.putImageData(img, 0, 0);

  // fit the stage, keeping the physical aspect ratio
  const stage = $("stage");
  const plotH = view.spectrum ? 220 : 0;
  const maxW = stage.clientWidth - 32 - (view.kind === "rgb" ? 0 : 90);
  const maxH = stage.clientHeight - 64 - plotH;
  const aspect = view.extent[0] / view.extent[1] || view.w / view.h;
  let w = Math.max(50, maxW), h = w / aspect;
  if (h > maxH) { h = Math.max(50, maxH); w = h * aspect; }
  c.style.width = Math.floor(w) + "px";
  c.style.height = Math.floor(h) + "px";
  $("cbarCanvas").style.height = Math.floor(h * 0.8) + "px";
  $("scale").textContent = view.extent_units === "px"
    ? `${view.w} × ${view.h} px shown`
    : `${fmt(view.extent[0])} × ${fmt(view.extent[1])} ${view.extent_units}` +
      (view.w ? ` · ${view.w} × ${view.h} px` : "");
}

function drawColorbar(cmap, view) {
  const c = $("cbarCanvas");
  const ctx = c.getContext("2d");
  const table = (lutCache[cmap] ||= lut(cmap));
  for (let i = 0; i < 256; i++) {
    ctx.fillStyle = `rgb(${table[i * 3]},${table[i * 3 + 1]},${table[i * 3 + 2]})`;
    ctx.fillRect(0, 255 - i, 1, 1);
  }
  const u = view.units ? " " + view.units : "";
  $("cbarMax").textContent = fmt(view.vmax) + u;
  $("cbarMin").textContent = fmt(view.vmin) + u;
}

function drawPlot(spec, marker, below) {
  const el = $("plot");
  if (plot) { plot.destroy(); plot = null; }
  const colors = ["#2f6fde", "#e0812f", "#1f8a4c", "#c43d3d"];
  const css = getComputedStyle(document.documentElement);
  const text = css.getPropertyValue("--muted").trim(), grid = css.getPropertyValue("--border").trim();
  const axis = (label) => ({ label, stroke: text, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } });
  const data = [spec.x, ...spec.series.map((s) => s.y.map((v) => (v === undefined ? null : v)))];
  const width = Math.min($("stage").clientWidth - 32, 1100);
  const height = below ? 200 : Math.max(240, Math.min($("stage").clientHeight - 60, 640));
  plot = new uPlot({
    width, height,
    scales: { x: { time: false } },
    axes: [axis(spec.x_label), axis(spec.y_label)],
    series: [{ label: spec.x_label }, ...spec.series.map((s, i) => ({
      label: s.label, stroke: colors[i % colors.length], width: 1.5, spanGaps: false,
    }))],
    cursor: { drag: { x: true, y: true } },
    hooks: marker === null ? {} : { draw: [(u) => {
      const x = u.valToPos(marker, "x", true);
      const ctx = u.ctx;
      ctx.save();
      ctx.strokeStyle = "#c43d3d";
      ctx.lineWidth = 1.5 * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(x, u.bbox.top); ctx.lineTo(x, u.bbox.top + u.bbox.height); ctx.stroke();
      ctx.restore();
    }] },
  }, data, el);
}

function fmt(v) {
  if (v === null || v === undefined || !isFinite(v)) return "–";
  const a = Math.abs(v);
  return a !== 0 && (a < 0.01 || a >= 1e5) ? v.toExponential(2) : +v.toPrecision(4) + "";
}
function unitOf(label) { const m = /\(([^)]*)\)$/.exec(label || ""); return m ? m[1] : ""; }

function showMessage(title, detail) {
  for (const id of ["canvasWrap", "scale", "plot"]) $(id).classList.add("hidden");
  const m = $("message");
  m.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = detail;
  m.append(h, p);
  m.classList.remove("hidden");
}

function showEnd() {
  state.current = null;
  const left = state.files.filter((f) => !state.done.has(f)).length;
  $("fileName").textContent = "";
  $("fileInfo").textContent = "";
  showMessage(left ? "End of folder" : "All files labeled",
              left ? `${left} skipped file(s) still unlabeled.` : `Log: ${LOG_DIR}/${LOG_FILE}`);
  if (left) {
    const b = document.createElement("button");
    b.className = "primary";
    b.textContent = "Go to first unlabeled";
    b.onclick = () => goTo(nextUndone(0));
    $("message").append(b);
  }
}

function updateProgress() {
  const n = state.files.filter((f) => state.done.has(f)).length;
  $("progress").textContent = state.files.length ? `${n} / ${state.files.length} labeled` : "";
}

// --------------------------------------------------------------------------- labeling
function buildLabelButtons() {
  const wrap = $("labelButtons");
  wrap.replaceChildren();
  const classes = state.config.classes;
  classes.slice(0, 9).forEach((cls, i) => {
    const b = document.createElement("button");
    const keys = [String(i + 1)];
    if (i === 0 && classes.length >= 2) keys.unshift("→");
    if (i === 1) keys.unshift("←");
    b.innerHTML = `<span></span><span>${keys.map((k) => `<kbd>${k}</kbd>`).join("")}</span>`;
    b.firstChild.textContent = cls;
    if (classes.length >= 2 && i < 2) b.className = i === 0 ? "good" : "bad";
    b.onclick = () => label(cls);
    wrap.append(b);
  });
  const keys = [["↑ ↓", "channel"], ["D", "forward / backward"], ["F", "flatten"], ["C", "colormap"],
                [", .", "slice (3ds, stacks)"], ["Space", "skip"], ["Z", "undo last label"]];
  if (state.config.notes) keys.push(["N", "note for this file"]);
  $("keys").replaceChildren(...keys.flatMap(([k, d]) => {
    const a = document.createElement("span"); a.innerHTML = k.split(" ").map((x) => `<kbd>${x}</kbd>`).join(" ");
    const b = document.createElement("span"); b.textContent = d;
    return [a, b];
  }));
}

function label(cls) {
  const cur = state.current;
  if (!cur) return;
  const view = cur.view;
  let channel = "";
  if (view) {
    const dirs = cur.summary.directions[view.channel] || [];
    channel = view.kind === "spectrum" || dirs.length < 2 ? view.channel : `${view.channel} ${view.direction}`;
  }
  const row = {
    file: cur.name, type: cur.type, channel, label: cls, score: "", tags: "", note: state.note, timestamp: localTimestamp(),
  };
  state.note = "";
  $("noteChip").classList.add("hidden");
  state.done.add(cur.name);
  const copy = state.config.copy_files;
  // snapshot now: the canvas is redrawn for the next file before the IO runs
  const snapshot = copy && state.copyAs === "image" ? snapshotView() : null;
  queueIO(async () => {
    await appendLog(row);
    if (snapshot) await writeJpeg(snapshot, jpegName(cur.name), cls);
    else if (copy) await copyInto(cur.name, cls);
  }, `Could not save label for ${cur.name}`);
  toast(`${cur.name} → ${cls}`);
  goTo(nextUndone(state.pos + 1));
}

function skip() {
  if (state.pos < state.files.length) goTo(nextUndone(state.pos + 1));
}

function undo() {
  queueIO(async () => {
    const rows = await readLog();
    const last = rows.pop();
    if (!last) return toast("Nothing to undo");
    await writeLog(rows);
    if (state.config.copy_files) {
      try {
        const logDir = await state.dir.getDirectoryHandle(LOG_DIR);
        const dst = await logDir.getDirectoryHandle(safeName(last.label));
        // the copy is either the original file or its jpeg image
        for (const n of [last.file, jpegName(last.file)]) await dst.removeEntry(n).catch(() => {});
      } catch {}
    }
    state.done = new Set(rows.map((r) => r.file));
    toast(`Undid ${last.file} → ${last.label}`);
    const i = state.files.indexOf(last.file);
    goTo(i >= 0 ? i : nextUndone(0));
  }, "Undo failed");
}

function queueIO(fn, errorText) {
  ioChain = ioChain.then(fn).catch((e) => toast(`${errorText}: ${e.message}`));
  return ioChain;
}

function localTimestamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function safeName(s) { return String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "_"; }

async function logHandle(create) {
  const logDir = await state.dir.getDirectoryHandle(LOG_DIR, { create });
  return logDir.getFileHandle(LOG_FILE, { create });
}

async function readLog() {
  try {
    const text = await (await (await logHandle(false)).getFile()).text();
    const [header, ...rows] = parseCsv(text);
    if (!header) return [];
    return rows.filter((r) => r.length > 1 || r[0])
      .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
  } catch (e) {
    if (e.name === "NotFoundError") return [];
    throw e;
  }
}

async function appendLog(row) {
  const fh = await logHandle(true);
  const file = await fh.getFile();
  const w = await fh.createWritable({ keepExistingData: true });
  await w.seek(file.size);
  let text = file.size ? "" : csvLine(LOG_COLUMNS);
  if (file.size && !(await file.slice(-1).text()).endsWith("\n")) text += "\n";
  await w.write(text + csvLine(LOG_COLUMNS.map((c) => row[c] ?? "")));
  await w.close();
}

async function writeLog(rows) {
  const fh = await logHandle(true);
  const w = await fh.createWritable();
  await w.write([LOG_COLUMNS, ...rows.map((r) => LOG_COLUMNS.map((c) => r[c] ?? ""))].map(csvLine).join(""));
  await w.close();
}

async function copyInto(name, cls) {
  const src = await (await state.dir.getFileHandle(name)).getFile();
  const logDir = await state.dir.getDirectoryHandle(LOG_DIR, { create: true });
  const dst = await logDir.getDirectoryHandle(safeName(cls), { create: true });
  const w = await (await dst.getFileHandle(name, { create: true })).createWritable();
  await w.write(src);
  await w.close();
}

function jpegName(name) { return name.replace(/\.[^.]+$/, "") + ".jpg"; }

// copy of what is on screen: the image canvas, or the spectrum plot
function snapshotView() {
  const v = state.current && state.current.view;
  if (!v) return null;
  const src = v.kind === "spectrum" ? plot && plot.ctx.canvas : $("img");
  if (!src || !src.width) return null;
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d");
  ctx.fillStyle = v.kind === "spectrum" ? getComputedStyle(document.body).backgroundColor : "#808080";
  ctx.fillRect(0, 0, c.width, c.height);   // jpeg has no transparency (no-data pixels, plot background)
  ctx.drawImage(src, 0, 0);
  return c;
}

async function writeJpeg(canvas, name, cls) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  const logDir = await state.dir.getDirectoryHandle(LOG_DIR, { create: true });
  const dst = await logDir.getDirectoryHandle(safeName(cls), { create: true });
  const w = await (await dst.getFileHandle(name, { create: true })).createWritable();
  await w.write(blob);
  await w.close();
}

function loadPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function setCopyAs(value) {
  state.copyAs = value;
  $("copyAs").value = value;
  try { localStorage.setItem("spm-labeler-copy-as", value); } catch {}
}

function csvLine(values) {
  return values.map((v) => {
    v = String(v);
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(",") + "\n";
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// --------------------------------------------------------------------------- controls
function changeSetting(patch) {
  if (!state.current) return;
  Object.assign(state.settings[state.current.type], patch);
  rerender();
}

function cycleChannel(step) {
  const cur = state.current;
  if (!cur || !cur.summary) return;
  const chans = cur.summary.channels;
  const i = chans.indexOf(cur.view.channel);
  changeSetting({ channel: chans[(i + step + chans.length) % chans.length] });
}

function cycle(list, value, step = 1) { return list[(list.indexOf(value) + step + list.length) % list.length]; }

function onKey(e) {
  const tag = e.target.tagName;
  if (e.target.id === "note") {
    if (e.key === "Enter") { keepNote(); e.preventDefault(); }
    if (e.key === "Escape") { $("noteBox").classList.add("hidden"); e.target.blur(); }
    return;
  }
  if (tag === "INPUT" && e.target.type === "text") return;
  if (!state.dir || e.ctrlKey && e.key !== "z" || e.metaKey || e.altKey) return;
  const classes = state.config.classes;
  const view = state.current && state.current.view;
  const s = state.current && state.settings[state.current.type];
  let handled = true;
  if (e.key === "ArrowRight" && classes.length >= 2) label(classes[0]);
  else if (e.key === "ArrowLeft" && classes.length >= 2) label(classes[1]);
  else if (/^[1-9]$/.test(e.key) && classes[+e.key - 1]) label(classes[+e.key - 1]);
  else if (e.key === "ArrowUp") cycleChannel(-1);
  else if (e.key === "ArrowDown") cycleChannel(1);
  else if (e.key === " ") skip();
  else if (e.key.toLowerCase() === "z") undo();
  else if (!s) handled = false;
  else if (e.key.toLowerCase() === "d" && view) changeSetting({ direction: view.direction === "forward" ? "backward" : "forward" });
  else if (e.key.toLowerCase() === "f") changeSetting({ flatten: cycle(FLATTENS, s.flatten, e.shiftKey ? -1 : 1) });
  else if (e.key.toLowerCase() === "c") changeSetting({ cmap: cycle(Object.keys(COLORMAPS), s.cmap, e.shiftKey ? -1 : 1) });
  else if ((e.key === "," || e.key === ".") && view && view.kind === "cube")
    changeSetting({ index: Math.min(view.n - 1, Math.max(0, (s.index ?? view.index) + (e.key === "." ? 1 : -1))) });
  else if (e.key.toLowerCase() === "n" && state.config.notes) openNote();
  else handled = false;
  if (handled) {
    e.preventDefault();
    if (tag === "SELECT" || tag === "BUTTON") e.target.blur();
  }
}

function openNote() {
  $("noteBox").classList.remove("hidden");
  $("note").value = state.note;
  $("note").focus();
}

function keepNote() {
  state.note = $("note").value.trim();
  $("noteBox").classList.add("hidden");
  $("note").blur();
  $("noteChip").textContent = "Note: " + state.note;
  $("noteChip").classList.toggle("hidden", !state.note);
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

function setStatus(text) { $("status").textContent = text; }

// remember the last folder (IndexedDB is the only place a directory handle can be stored)
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("spm-labeler", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("handles");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function rememberHandle(h) {
  try { (await idb()).transaction("handles", "readwrite").objectStore("handles").put(h, "last"); } catch {}
}
async function lastHandle() {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const r = db.transaction("handles").objectStore("handles").get("last");
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    });
  } catch { return null; }
}

// --------------------------------------------------------------------------- startup
(async function init() {
  $("cmap").replaceChildren(...Object.keys(COLORMAPS).map((c) => new Option(c, c)));
  if (!window.showDirectoryPicker) {
    $("browserWarn").classList.remove("hidden");
    $("openBtn").disabled = true;
    return;
  }
  $("openBtn").onclick = () => openFolder();
  const last = await lastHandle();
  if (last) {
    $("reopenBtn").textContent = "Reopen " + last.name;
    $("reopenBtn").classList.remove("hidden");
    $("reopenBtn").onclick = () => openFolder(last);
  }
  document.addEventListener("keydown", onKey);
  $("channel").onchange = (e) => { changeSetting({ channel: e.target.value }); e.target.blur(); };
  $("flatten").onchange = (e) => { changeSetting({ flatten: e.target.value }); e.target.blur(); };
  $("cmap").onchange = (e) => { changeSetting({ cmap: e.target.value }); e.target.blur(); };
  $("copyAs").value = state.copyAs;
  $("copyAs").onchange = (e) => { setCopyAs(e.target.value); e.target.blur(); };
  $("slice").oninput = (e) => changeSetting({ index: +e.target.value });
  $("slice").onchange = (e) => e.target.blur();
  for (const b of $("direction").children) b.onclick = () => { changeSetting({ direction: b.dataset.dir }); b.blur(); };
  $("skipBtn").onclick = (e) => { skip(); e.target.blur(); };
  $("undoBtn").onclick = (e) => { undo(); e.target.blur(); };
  window.addEventListener("resize", () => state.current && state.current.view && draw());
})();
