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
| `→` / `←`, `1` / `0` | **Binary mode**: first / second class; no other number key does anything |
| `1`–`9`, `0` | **Multiclass mode**: the class with that key (see below) |
| `0`–`9` `.` `-`, `Enter` | **Score mode**: just start typing a number (negatives and decimals are fine), `Enter` saves, `Backspace` edits, `Esc` clears |
| `D` | defer, in every mode: logged as `Deferred`, copied to `classified/deferred/` (not in Score mode) |
| `Space` | skip (stays unlabeled) |
| `[` / `]` | previous / next file, labeled or not (also the ‹ › buttons beside the image); a labeled file shows its label, and pressing a label key **overwrites** it |
| `Home` / `End` | first / last file |
| `Shift`+`Space` | jump to the first unlabeled file |
| `Z` | undo the last entry made in the current mode (removes the CSV row and the copied file) |
| `↑` `↓` | channel (remembered per file type) |
| `B` | backward / forward scan |
| `F` / `C` | flatten / colormap (`Shift` = backwards) |
| `PageUp` / `PageDown` | previous / next slice of `.3ds` grids and tif stacks |
| `N` | note, attached to the next label |

Files are ordered **oldest first by modified time** (all types mixed; ties by name). The sidebar's **Files** list shows
every file with its label chip; search by name or label, filter (All / Unlabeled / each class / Deferred), and click a
row (or press Enter in the search box) to jump there. Jumping does not label anything in between.

**View** and **Tools** (buttons in the header) open panels to the left of the sidebar:

- *View*: **Colormap** (also `C`), **Contrast** slider (percent clipped at each end, default 1 %, 0 = full range; the colorbar follows), **Theme** (Auto / Light / Dark), **Transpose**, **Origin** (auto / upper / lower) and **Scale** (axis ticks / scale bar / none). Only the image
  is transformed; the axis ticks keep their meaning (x to the right, y upwards), so you can correct a mixed-up
  convention without changing the coordinates. Remembered per file type. A scale bar is also drawn on jpeg copies.
- *Tools*: **Flatten** (also `F`), **Line profile** (a drop down; open it, turn on *Draw line*, drag on an image; values in the channel's units vs distance; averaging
  width in px, default 5; *Export profile as CSV*; `Esc` clears the line), **Pixel readout** (position and value
  follow the cursor), and **Metadata** (key facts from the file header plus a searchable list of all fields).

Output, inside the chosen folder:

- `classified/classification_log.csv` with columns `file, type, channel, mode, label, class_id, score, tags, note, timestamp`:
  **one row per file and mode**, all modes in the same log. Binary and multiclass rows fill `label` (multiclass also
  `class_id`), score rows fill `score`. Each mode keeps its own progress: files already in the log for the current
  mode are skipped when the folder is opened again. Older logs without `mode` / `class_id` are upgraded automatically
  (their rows count as binary).
- `classified/<label>/`: copies of labeled files, depending on the sidebar's *Copy* option: **do not copy**
  (default; only the CSV is written), **original file**, or **image**: a jpeg of the current view (channel,
  flatten and colormap as shown; the plot for spectra, in the current light/dark theme), named `<file name>.jpg`.

### Modes and settings

Pick the mode in the header, top left (**Binary** by default, **Multiclass** or **Score**). The settings box under
**Tools → Labeling settings** shows only the options of the current mode, validated while you type; *Save to folder*
writes them to `labeler.json` in the data folder (loaded when you open the folder again, together with the last mode).

| Mode | Settings box | Written to the log |
| --- | --- | --- |
| **Binary** | `{ "classes": [ {"name": "Good", "id": 1}, {"name": "Bad", "id": 0} ] }`: exactly two classes, e.g. Good / Bad, Yes / No, High / Low; plain names work too (`["Yes", "No"]`) | `label` = name, `class_id` = id (default 1 for the first class, 0 for the second) |
| **Multiclass** | `{ "start": 1, "classes": ["one", "two", {"name": "three", "id": 30}] }`: up to 10 classes; `start` 1 gives the keys 1-9 then 0, `start` 0 gives 0-9 | `label` = name, `class_id` = id (default: the number of its key) |
| **Score** | `{ "min": -10, "max": 10 }`: optional limits (`null` = none) | `score` = the number you typed (nothing is written until `Enter`) |

Scores are never copied (the *Copy* option is hidden). `labeler.json` also keeps the other modes' settings, `notes` and
`copy_as`, untouched when you save one mode.

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
| `tools.js` | View / Tools panels: transpose / origin, axes + scale bar, pixel readout, line profile, metadata |
| `modes.js` | labeling modes (binary / multiclass / score), `labeler.json` validation and the settings editor |
| `worker.js` | loads Pyodide + wheels, runs `py/reader.py` off the UI thread |
| `py/reader.py` | file reading (SciFiReaders), flattening, contrast, display data; plain Python |
| `py/compat.py` | stubs heavy optional imports of sidpy/SciFiReaders so they import in Pyodide |
| `tools/build_wheels.py`, `tools/wheels.txt` | build/download the pure-Python wheels into `wheels/` |

