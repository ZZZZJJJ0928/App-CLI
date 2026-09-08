"""Self-owned local application methods, shared by CLI and optional developer GUI."""

from importlib.resources import files
import json

from ..core import AppCLIError


INTEGER_LIMIT = 1_000_000


def validate_calculation(operation: str, a: int, b: int) -> None:
    if operation not in ("add", "subtract", "multiply"):
        raise AppCLIError("COMMAND_NOT_FOUND", "Calculator operation is not supported.", 2)
    if any(type(value) is not int or abs(value) > INTEGER_LIMIT for value in (a, b)):
        raise AppCLIError("INPUT_VALIDATION_FAILED", "Calculator operands must be integers between -1000000 and 1000000.", 2)


def calculate(operation: str, a: int, b: int) -> int:
    validate_calculation(operation, a, b)
    if operation == "add":
        return a + b
    if operation == "subtract":
        return a - b
    return a * b


class CalculatorAdapter:
    def __init__(self):
        self.manifest = json.loads(files("app_cli").joinpath("manifests/calculator.json").read_text(encoding="utf-8"))

    def invoke(self, command: str, arguments: dict) -> dict:
        if not isinstance(arguments, dict) or set(arguments) != {"a", "b"}:
            raise AppCLIError("INPUT_VALIDATION_FAILED", "Calculator requires exactly the operands a and b.", 2)
        return {"value": calculate(command, arguments["a"], arguments["b"])}
