"""Bounded one-shot transport for reviewed executables, with no retry path."""

import os
import queue
import signal
import subprocess
import threading
import time

from .core import AppCLIError


def exchange(argv, request, *, timeout, max_response):
    if os.name != "posix":
        raise AppCLIError("CAPABILITY_NOT_SUPPORTED", "Runtime 2.0 process cleanup is not qualified on this platform.")
    options = {"start_new_session": True, "bufsize": 0}
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, shell=False, **options)
    except (OSError, ValueError):
        raise AppCLIError("BACKEND_UNAVAILABLE", "The execution client could not start.") from None
    replies = queue.Queue(maxsize=1)
    input_errors = []
    deadline = time.monotonic() + timeout

    def send():
        try:
            remaining = memoryview(request)
            while remaining:
                written = process.stdin.write(remaining)
                if not written:
                    raise OSError("Closed execution input")
                remaining = remaining[written:]
            process.stdin.close()
        except (OSError, ValueError):
            input_errors.append(True)

    def receive():
        try:
            chunks = []
            size = 0
            while size <= max_response:
                chunk = process.stdout.read(min(65536, max_response + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
            replies.put(b"".join(chunks))
        except (OSError, ValueError):
            replies.put(None)

    writer = threading.Thread(target=send, daemon=True)
    reader = threading.Thread(target=receive, daemon=True)
    writer.start()
    reader.start()
    try:
        raw = replies.get(timeout=max(0.001, deadline - time.monotonic()))
        if raw is None or len(raw) > max_response:
            raise AppCLIError("BACKEND_PROTOCOL_INVALID", "The execution client exceeded its output contract.")
        process.wait(timeout=max(0.001, deadline - time.monotonic()))
        writer.join(timeout=max(0.001, deadline - time.monotonic()))
        if writer.is_alive():
            raise AppCLIError("BACKEND_TIMEOUT", "The execution client did not finish its exchange.")
        if process.returncode != 0 or input_errors:
            raise AppCLIError("BACKEND_EXECUTION_FAILED", "The execution client did not complete its exchange.")
        return raw
    except (queue.Empty, subprocess.TimeoutExpired):
        raise AppCLIError("BACKEND_TIMEOUT", "The execution client did not respond in time.") from None
    except OSError:
        raise AppCLIError("BACKEND_EXECUTION_FAILED", "The execution client exchange failed.") from None
    finally:
        # Descendants must not keep our pipes alive after the client returns.
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        reader.join(timeout=1)
        writer.join(timeout=1)
        process.stdout.close()
        process.stdin.close()
