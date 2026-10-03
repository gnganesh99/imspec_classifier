"""Reading and display preparation for the labeler (no browser-specific code).

Nanonis ``.sxm`` / ``.dat`` / ``.3ds`` files are read with the SciFiReaders fork;
plain images with Pillow (tif via SciFiReaders' ImageReader / tifffile). Every
file becomes a dict of *channels*, each holding one entry per scan direction.

``load(path)`` parses a file (cached), ``render(...)`` returns what the UI draws:
images as uint8 colormap indices (255 = no data), spectra as float lists.
"""
import math
import os
import re
import warnings
from collections import OrderedDict

import numpy as np

SPM_TYPES = {".sxm": "sxm", ".dat": "dat", ".3ds": "3ds"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tif", ".tiff"}
MAX_DISPLAY_PIXELS = 1024   # longer image side is strided down to at most this
CACHE_SIZE = 8              # parsed files kept in memory (current + prefetched)
NAN_INDEX = 255             # colormap index meaning "no data"

_cache = OrderedDict()


def file_type(name):
    """'sxm' | 'dat' | '3ds' | 'img' | None (unsupported)."""
    ext = os.path.splitext(name)[1].lower()
    if ext in SPM_TYPES:
        return SPM_TYPES[ext]
    return "img" if ext in IMAGE_EXTS else None


def list_files(folder):
    """Supported files directly inside ``folder``, naturally sorted."""
    names = [n for n in os.listdir(folder)
             if file_type(n) and os.path.isfile(os.path.join(folder, n))]
    return sorted(names, key=natural_key)


def natural_key(name):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


# ----------------------------------------------------------------------------- loading

def load(path, key=None):
    """Parse ``path`` (cached under ``key``) and return a summary of its channels."""
    key = key or path
    if key in _cache:
        _cache.move_to_end(key)
    else:
        ftype = file_type(path)
        entries = _read_image(path) if ftype == "img" else _read_spm(path, ftype)
        if not entries:
            raise ValueError("no channels found in " + os.path.basename(path))
        _cache[key] = {"type": ftype, "channels": entries}
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    item = _cache[key]
    return {"type": item["type"],
            "channels": list(item["channels"]),
            "directions": {name: list(dirs) for name, dirs in item["channels"].items()},
            "kinds": {name: next(iter(dirs.values()))["kind"]
                      for name, dirs in item["channels"].items()}}


def is_loaded(key):
    return key in _cache


def drop(key):
    _cache.pop(key, None)


def _read_spm(path, ftype):
    from SciFiReaders import NanonisDatReader, NanonisSXMReader, Nanonis3dsReader
    reader = {"sxm": NanonisSXMReader, "dat": NanonisDatReader, "3ds": Nanonis3dsReader}[ftype]
    datasets = reader(path).read()
    channels = OrderedDict()
    for key, ds in datasets.items():
        base, direction = split_direction(key)
        entry = _entry_from_dataset(ds)
        if entry is not None:
            channels.setdefault(base, OrderedDict())[direction] = entry
    return channels


def split_direction(key):
    """'Z forward' -> ('Z', 'forward'); 'Current [bwd]' -> ('Current', 'backward')."""
    m = re.match(r"^(.*\S)\s+(forward|backward)$", key)
    if m:
        return m.group(1), m.group(2)
    m = re.match(r"^(.*\S)\s*\[bwd\]$", key)
    if m:
        return m.group(1), "backward"
    return key, "forward"


def _axis(ds, i):
    dim = ds._axes[i]
    return {"name": str(dim.name), "units": str(dim.units),
            "values": np.asarray(dim.values, dtype=float),
            "type": str(getattr(dim.dimension_type, "name", dim.dimension_type)).upper()}


def _entry_from_dataset(ds):
    data = np.asarray(ds)
    axes = [_axis(ds, i) for i in range(data.ndim)]
    units, quantity = str(ds.units), str(ds.quantity)
    if data.ndim == 1:
        return {"kind": "spectrum", "y": data.astype(float), "x": axes[0],
                "units": units, "quantity": quantity}
    if data.ndim == 2:
        return {"kind": "image", "data": data, "y": axes[0], "x": axes[1],
                "units": units, "quantity": quantity, "origin": "lower"}
    if data.ndim == 3:
        spatial = [i for i, a in enumerate(axes) if a["type"] == "SPATIAL"]
        other = [i for i in range(3) if i not in spatial]
        if len(spatial) != 2:
            spatial, other = [0, 1], [2]
        cube = np.moveaxis(data, other[0], -1)
        return {"kind": "cube", "data": cube, "y": axes[spatial[0]], "x": axes[spatial[1]],
                "z": axes[other[0]], "units": units, "quantity": quantity, "origin": "lower"}
    return None


def _pixel_axis(n, name):
    return {"name": name, "units": "px", "values": np.arange(n, dtype=float), "type": "SPATIAL"}


def _read_image(path):
    ext = os.path.splitext(path)[1].lower()
    arr = None
    if ext in (".tif", ".tiff"):
        # scientific tifs (16/32-bit, stacks) via SciFiReaders/tifffile; Pillow as fallback
        try:
            from SciFiReaders import ImageReader
            arr = np.asarray(ImageReader(path).read())
        except Exception:
            arr = None
    if arr is None:
        from PIL import Image
        with Image.open(path) as im:
            if im.mode in ("P", "PA", "1", "CMYK", "YCbCr", "LAB", "HSV"):
                im = im.convert("RGBA" if "A" in im.mode or "transparency" in im.info else "RGB")
            elif im.mode == "LA":
                im = im.convert("L")
            arr = np.asarray(im)
    while arr.ndim > 3 or (arr.ndim == 3 and arr.shape[-1] not in (3, 4) and arr.shape[0] == 1):
        arr = arr[0]

    is_rgb = arr.ndim == 3 and arr.shape[-1] in (3, 4)
    h, w = arr.shape[1:] if arr.ndim == 3 and not is_rgb else arr.shape[:2]
    common = {"y": _pixel_axis(h, "y"), "x": _pixel_axis(w, "x"),
              "units": "", "quantity": "Intensity", "origin": "upper"}
    channels = OrderedDict()
    if is_rgb:
        rgb = arr[..., :3]
        channels["RGB"] = {"forward": dict(common, kind="rgb", data=rgb)}
        gray = rgb.astype(float) @ np.array([0.299, 0.587, 0.114])
        channels["Gray"] = {"forward": dict(common, kind="image", data=gray)}
        for i, c in enumerate("RGB"):
            channels[c] = {"forward": dict(common, kind="image", data=rgb[..., i])}
    elif arr.ndim == 3:   # stack: frames along axis 0
        z = {"name": "frame", "units": "", "values": np.arange(arr.shape[0], dtype=float),
             "type": "FRAME"}
        channels["Intensity"] = {"forward": dict(common, kind="cube",
                                                 data=np.moveaxis(arr, 0, -1), z=z)}
    else:
        channels["Intensity"] = {"forward": dict(common, kind="image", data=arr)}
    return channels


# ----------------------------------------------------------------------------- rendering

def render(key, channel=None, direction="forward", flatten="none", index=None):
    """Display data for one channel of a loaded file.

    Falls back to the first channel / an available direction when the requested
    one is missing (``fallback`` is True then).
    """
    channels = _cache[key]["channels"]
    fallback = channel is not None and channel not in channels
    if channel not in channels:
        channel = next(iter(channels))
    dirs = channels[channel]
    if direction not in dirs:
        direction = next(iter(dirs))
    entry = dirs[direction]
    out = {"channel": channel, "direction": direction, "fallback": fallback,
           "kind": entry["kind"], "title": entry["quantity"]}

    if entry["kind"] == "spectrum":
        out.update(_spectrum(dirs))
    elif entry["kind"] == "rgb":
        out.update(_rgb(entry))
    elif entry["kind"] == "image":
        out.update(_image(entry, entry["data"], flatten))
    else:  # cube
        cube = entry["data"]
        n = cube.shape[-1]
        index = n // 2 if index is None else int(min(max(index, 0), n - 1))
        z = entry["z"]
        out.update(_image(entry, cube[..., index], flatten))
        zf, zu = si_scale(np.abs(z["values"]).max(), z["units"])
        out.update(index=index, n=n, slice_label=_label(z["name"], zu),
                   slice_value=float(z["values"][index] * zf))
        if z["type"] == "SPECTRAL":
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                mean = np.nanmean(cube.reshape(-1, n), axis=0)
            yf, yu = si_scale(np.nanmax(np.abs(mean)), entry["units"])
            out["spectrum"] = {"x": (z["values"] * zf).tolist(), "x_label": out["slice_label"],
                               "y_label": _label("mean " + entry["quantity"], yu),
                               "series": [{"label": "mean", "y": _clean(mean * yf)}]}
    return out


def _label(name, units):
    return "%s (%s)" % (name, units) if units else name


def _clean(values):
    return [None if not math.isfinite(v) else v for v in np.asarray(values, float).tolist()]


def _spectrum(dirs):
    first = next(iter(dirs.values()))
    x = first["x"]
    xf, xu = si_scale(np.nanmax(np.abs(x["values"])), x["units"])
    ymax = max(float(np.nanmax(np.abs(e["y"]))) if np.isfinite(e["y"]).any() else 0
               for e in dirs.values())
    yf, yu = si_scale(ymax, first["units"])
    return {"x": (x["values"] * xf).tolist(), "x_label": _label(x["name"], xu),
            "y_label": _label(first["quantity"], yu),
            "series": [{"label": d, "y": _clean(e["y"] * yf)} for d, e in dirs.items()]}


def _stride(arr):
    step = math.ceil(max(arr.shape[:2]) / MAX_DISPLAY_PIXELS)
    return arr[::step, ::step] if step > 1 else arr


def _extent(entry):
    def size(ax):
        v = ax["values"]
        return float(abs(v[-1] - v[0]) * len(v) / (len(v) - 1)) if len(v) > 1 else 1.0
    w, h = size(entry["x"]), size(entry["y"])
    units = entry["x"]["units"]
    f, u = si_scale(max(w, h), units)
    return {"extent": [w * f, h * f], "extent_units": u}


def _rgb(entry):
    rgb = _stride(entry["data"])
    if rgb.dtype != np.uint8:   # e.g. 16-bit RGB tif
        rgb = rgb.astype(float)
        rgb = np.clip(rgb / max(np.nanmax(rgb), 1e-12) * 255, 0, 255).astype(np.uint8)
    h, w = rgb.shape[:2]
    rgba = np.empty((h, w, 4), np.uint8)
    rgba[..., :3] = rgb
    rgba[..., 3] = 255
    return dict(_extent(entry), w=w, h=h, data=rgba.tobytes())


def _image(entry, data, flatten):
    img = _stride(np.asarray(data, dtype=float))
    img = apply_flatten(img, flatten)
    if entry["origin"] == "lower":      # canvas row 0 is the top
        img = img[::-1]
    finite = np.isfinite(img)
    if finite.any():
        vmin, vmax = np.percentile(img[finite], [1, 99])
        if vmax <= vmin:
            vmin, vmax = float(img[finite].min()), float(img[finite].max())
    else:
        vmin, vmax = 0.0, 1.0
    span = (vmax - vmin) or 1.0
    with np.errstate(invalid="ignore"):
        idx = np.clip((img - vmin) / span * 254, 0, 254)
    idx = np.where(finite, idx, NAN_INDEX).astype(np.uint8)
    f, u = si_scale(max(abs(vmin), abs(vmax)), entry["units"])
    h, w = img.shape
    return dict(_extent(entry), w=w, h=h, data=idx.tobytes(),
                vmin=float(vmin * f), vmax=float(vmax * f), units=u)


def apply_flatten(img, mode):
    """'none' | 'offset' (line median) | 'line' (line-wise linear) | 'plane'."""
    if mode in (None, "none"):
        return img
    img = img.copy()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        if mode == "offset":
            img -= np.nan_to_num(np.nanmedian(img, axis=1, keepdims=True))
        elif mode == "line":
            x = np.arange(img.shape[1], dtype=float)
            for row in img:
                ok = np.isfinite(row)
                if ok.sum() > 1:
                    row -= np.polyval(np.polyfit(x[ok], row[ok], 1), x)
        elif mode == "plane":
            yy, xx = np.indices(img.shape, dtype=float)
            ok = np.isfinite(img)
            if ok.sum() > 2:
                A = np.c_[xx[ok], yy[ok], np.ones(ok.sum())]
                coef = np.linalg.lstsq(A, img[ok], rcond=None)[0]
                img -= coef[0] * xx + coef[1] * yy + coef[2]
    return img


_PREFIXES = [(1e-15, "f"), (1e-12, "p"), (1e-9, "n"), (1e-6, "µ"), (1e-3, "m"),
             (1, ""), (1e3, "k"), (1e6, "M"), (1e9, "G")]
_SI_UNITS = {"m", "A", "V", "Hz", "N", "s", "F", "W", "S", "T", "K", "Pa"}


def si_scale(max_abs, units):
    """(factor, prefixed units) so that ``max_abs * factor`` lies in [1, 1000)."""
    if units not in _SI_UNITS or not max_abs or not math.isfinite(max_abs):
        return 1.0, units
    for scale, prefix in reversed(_PREFIXES):
        if max_abs >= scale:
            return 1.0 / scale, prefix + units
    return 1.0 / _PREFIXES[0][0], _PREFIXES[0][1] + units
