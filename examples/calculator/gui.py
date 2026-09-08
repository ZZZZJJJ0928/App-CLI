"""Optional owned GUI using the exact same functions as the CLI adapter.

Install the repository first. Tk support is supplied by the Python installation;
it is not required by app-cli. This example is never launched by the CLI/tests.
"""

from app_cli.adapters.calculator import calculate


def main():
    try:
        import tkinter as tk
        from tkinter import ttk
    except ImportError:
        raise SystemExit("This optional GUI requires a Python installation with Tk support.") from None

    window = tk.Tk()
    window.title("App-CLI — Shared Calculator")
    frame = ttk.Frame(window, padding=20)
    frame.grid()
    a, b, operation, result = (tk.StringVar(value=value) for value in ("2", "3", "add", ""))
    ttk.Label(frame, text="The GUI and CLI call the same application functions.").grid(row=0, columnspan=2)
    for row, (label, value) in enumerate((("A", a), ("B", b)), 1):
        ttk.Label(frame, text=label).grid(row=row, column=0)
        ttk.Entry(frame, textvariable=value).grid(row=row, column=1, pady=4)
    ttk.Combobox(frame, textvariable=operation, values=("add", "subtract", "multiply"),
                 state="readonly").grid(row=3, columnspan=2, pady=4)

    def evaluate():
        try:
            result.set(str(calculate(operation.get(), int(a.get()), int(b.get()))))
        except Exception:
            result.set("Use integers within the command's published input limits.")

    ttk.Button(frame, text="Calculate", command=evaluate).grid(row=4, columnspan=2, pady=8)
    ttk.Label(frame, textvariable=result).grid(row=5, columnspan=2)
    window.mainloop()


if __name__ == "__main__":
    main()
