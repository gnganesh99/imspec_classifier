"""Make sidpy / SciFiReaders importable in Pyodide.

sidpy and SciFiReaders import many heavy packages at import time (dask.distributed,
matplotlib, ipywidgets, scikit-learn, h5py, ...) that are unavailable in the browser
or not needed to read Nanonis/image files. ``install()`` registers empty stand-in
modules for them and switches dask to the synchronous scheduler.

Not needed (and not used) in a regular CPython environment.
"""
import importlib.abc
import importlib.machinery
import sys
import types

STUBBED = (
    "distributed", "ipywidgets", "IPython", "ipympl", "traitlets", "comm", "ase",
    "matplotlib", "mpl_toolkits", "sklearn", "dask_ml", "scipy", "joblib", "numba",
    "h5py", "pyUSID", "pyNSID", "mrcfile", "gwyfile", "pandas", "igor2", "hyperspy",
    "aicspylibczi",
)


class _Anything:
    """Placeholder returned for every attribute of a stubbed module."""

    def __init__(self, *args, **kwargs):
        pass

    def __call__(self, *args, **kwargs):
        return _Anything()

    def __getattr__(self, name):
        return _Anything()

    def __mro_entries__(self, bases):  # allows ``class X(stub.Base)``
        return (object,)

    def __iter__(self):
        return iter(())

    def __bool__(self):
        return False


class _StubModule(types.ModuleType):
    __path__ = []

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Anything()


class _StubFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, name, path, target=None):
        if name.split(".")[0] in STUBBED:
            return importlib.machinery.ModuleSpec(name, self, is_package=True)
        return None

    def create_module(self, spec):
        return _StubModule(spec.name)

    def exec_module(self, module):
        pass


def install():
    if not any(isinstance(f, _StubFinder) for f in sys.meta_path):
        sys.meta_path.insert(0, _StubFinder())
    import dask
    # "distributed" is stubbed, so dask must not look for a distributed client
    dask.config.set(scheduler="sync")
