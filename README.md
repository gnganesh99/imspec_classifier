# imspec_classifier
A classifier app and model for images and spectra.

## SPM Labeler (web app)

**https://gnganesh99.github.io/imspec_classifier/** — open in Chrome or Edge, click *Open folder*, press keys.
Nothing to install: Python ([Pyodide](https://pyodide.org)) runs in the browser and reads files with the
[SciFiReaders fork](https://github.com/gnganesh99/SciFiReaders). Files never leave your computer.

Supported: Nanonis `.sxm` (images), `.dat` (spectra), `.3ds` (grid spectroscopy, bias slice + mean spectrum),
and `jpg / png / tif / bmp / gif / webp` images.

| Key | Action |
| --- | --- |
| `→` / `←` | first / second class (default *Good* / *Bad*) |
| `D` | defer: logged as `Deferred`, copied to `classified/deferred/` |
| `1`–`9` | class 1–9 |
| `Space` | skip (stays unlabeled) |
| `Z` | undo the last label (removes the CSV row and the copied file) |
| `↑` `↓` | channel (remembered per file type) |
| `B` | backward / forward scan |
| `F` / `C` | flatten / colormap (`Shift` = backwards) |
| `,` `.` | slice of `.3ds` grids and tif stacks |
| `N` | note, attached to the next label |

Output, inside the chosen folder:

- `classified/classification_log.csv` with columns `file, type, channel, label, score, tags, note, timestamp`
  (one row per label). Files already in the log are skipped when the folder is opened again.
- `classified/<label>/`: copies of labeled files, depending on the sidebar's *Copy* option: **do not copy**
  (default; only the CSV is written), **original file**, or **image**: a jpeg of the current view (channel,
  flatten and colormap as shown; the plot for spectra, in the current light/dark theme), named `<file name>.jpg`.

Optional `labeler.json` in the folder:

```json
{ "classes": ["Good", "Bad", "Unsure"], "notes": true, "copy_as": "none" }   // none | original | image
```

### Run locally (e.g. offline lab PC)

```bash
python tools/build_wheels.py
python -m http.server 8000
```

Then open http://localhost:8000. Pyodide itself is still loaded from the jsDelivr CDN.

### Deploy

`.github/workflows/pages.yml` builds the wheels and deploys on every push to `main`.
Run the workflow manually to pick up new commits of the SciFiReaders fork.
One-time setup: *Settings → Pages → Source: GitHub Actions*.

### Layout

| File | Role |
| --- | --- |
| `index.html`, `app.js` | UI, keys, canvas / uPlot rendering, folder IO (File System Access API) |
| `worker.js` | loads Pyodide + wheels, runs `py/reader.py` off the UI thread |
| `py/reader.py` | file reading (SciFiReaders), flattening, contrast, display data; plain Python |
| `py/compat.py` | stubs heavy optional imports of sidpy/SciFiReaders so they import in Pyodide |
| `tools/build_wheels.py`, `tools/wheels.txt` | build/download the pure-Python wheels into `wheels/` |

