"""Only self-owned adapters are registered by the built-in factory."""

from ..core import Adapter
from .calculator import CalculatorAdapter
from .calculator_cli import CalculatorCLIAdapter
from .calculator_runtime import CalculatorRuntimeAdapter


def builtin_adapters() -> list[Adapter]:
    return [CalculatorAdapter(), CalculatorCLIAdapter(), CalculatorRuntimeAdapter()]
