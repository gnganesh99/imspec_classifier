// Runs Pyodide + py/reader.py off the main thread.
// Messages in:  {id, op: "show" | "render" | "cancel", prio, gen, ...args}
// Messages out: {id, ok, result | error} and {status: "..."} while starting up.
const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
const PYODIDE_PACKAGES = ["numpy", "pillow", "pyyaml", "packaging", "toolz", "cloudpickle"];
importScripts(PYODIDE_URL + "pyodide.js");

let py, reader;
const queue = [];   // pending jobs; prio 0 (current file) runs before prio 1 (prefetch)
let running = false;

const ready = (async () => {
  self.postMessage({ status: "Loading Python…" });
  py = await loadPyodide({ indexURL: PYODIDE_URL });
  self.postMessage({ status: "Loading packages…" });
  await py.loadPackage(PYODIDE_PACKAGES, { messageCallback: () => {} });
  const wheels = await (await fetch("wheels/manifest.json", { cache: "no-cache" })).json();
  await py.loadPackage(wheels.map((w) => new URL("wheels/" + w, self.location).href),
                       { messageCallback: () => {} });
  for (const f of ["compat.py", "reader.py"]) {
    const src = await (await fetch("py/" + f, { cache: "no-cache" })).text();
    py.FS.writeFile("/home/pyodide/" + f, src);
  }
  self.postMessage({ status: "Importing SciFiReaders…" });
  py.runPython(`
import sys
sys.path.insert(0, "/home/pyodide")
import compat
compat.install()
import reader, SciFiReaders
`);
  reader = py.pyimport("reader");
  self.postMessage({ status: "ready" });
})().catch((e) => self.postMessage({ status: "error", error: String(e) }));

self.onmessage = (ev) => {
  const job = ev.data;
  if (job.op === "cancel") {   // drop prefetches made for an older position
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].prio > 0 && queue[i].gen < job.gen) {
        self.postMessage({ id: queue[i].id, ok: false, error: "cancelled" });
        queue.splice(i, 1);
      }
    }
    return;
  }
  queue.push(job);
  pump();
};

async function pump() {
  if (running) return;
  running = true;
  await ready;
  while (queue.length) {
    queue.sort((a, b) => a.prio - b.prio);
    const job = queue.shift();
    try {
      const result = run(job);
      const transfer = result && result.view && result.view.data ? [result.view.data.buffer] : [];
      self.postMessage({ id: job.id, ok: true, result }, transfer);
    } catch (e) {
      self.postMessage({ id: job.id, ok: false, error: pyError(e) });
    }
    await new Promise((r) => setTimeout(r, 0));   // let newer messages arrive
  }
  running = false;
}

function run(job) {
  if (!reader) throw new Error("Python failed to start");
  if (job.op === "show") {
    // bytes are only written to the in-memory FS when the file is not parsed yet
    if (!reader.is_loaded(job.key)) {
      const path = "/tmp/" + job.name.replace(/[\/\\]/g, "_");
      py.FS.writeFile(path, new Uint8Array(job.bytes));
      try { reader.load(path, job.key); } finally { py.FS.unlink(path); }
    }
  } else if (!reader.is_loaded(job.key)) {
    return { notLoaded: true };
  }
  if (job.op === "meta") {
    return toJs(reader.metadata.callKwargs(job.key, { channel: job.channel, direction: job.direction }));
  }
  const summary = toJs(reader.load("", job.key));
  const s = job.settings || {};
  // JS null becomes pyodide's jsnull, not None, so unset values are left out
  const kwargs = { direction: s.direction || "forward", flatten: s.flatten || "none" };
  if (s.channel != null) kwargs.channel = s.channel;
  if (s.index != null) kwargs.index = s.index;
  const view = toJs(reader.render.callKwargs(job.key, kwargs));
  return { summary, view };
}

function toJs(proxy) {
  const out = proxy.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false });
  proxy.destroy();
  return out;
}

function pyError(e) {
  const msg = String(e && e.message || e);
  // keep the last line of a Python traceback ("ValueError: ...")
  const lines = msg.trim().split("\n");
  return lines[lines.length - 1] || msg;
}
