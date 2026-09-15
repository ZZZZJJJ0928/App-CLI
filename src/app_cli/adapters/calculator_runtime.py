"""Self-owned, synchronous reference for the generic runtime protocol."""

import sys

from .calculator import CalculatorAdapter
from .runtime import RuntimeAdapter


class CalculatorRuntimeAdapter(RuntimeAdapter):
    def __init__(self):
        manifest = CalculatorAdapter().manifest
        manifest.update(id="calculator-runtime", name="Calculator via runtime protocol")
        manifest["adapter"] = {"kind": "runtime", "name": "Self-owned calculator runtime"}
        super().__init__(manifest, [sys.executable, "-I", "-m", "app_cli.runtime_example"])
