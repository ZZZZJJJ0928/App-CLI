"""Public task outcomes supplied by a trusted adapter or execution runtime."""

from dataclasses import dataclass
import re


TASK_STATUSES = frozenset({"completed", "pending", "running", "waiting_confirmation",
                           "uncertain", "failed", "cancelled", "blocked"})
_NEEDS_ID = frozenset({"pending", "running", "waiting_confirmation", "uncertain", "cancelled"})


@dataclass(frozen=True)
class TaskResult:
    """An adapter's outcome, not a task coordinator or an authorization grant.

    A completed task carries business data. Every other status carries no
    successful data; ongoing/uncertain tasks must include the backend's public
    task ID. The backend retains ownership of persistence and recovery.
    """

    status: str
    data: dict | None = None
    task_id: str | None = None

    def __post_init__(self):
        if type(self.status) is not str or self.status not in TASK_STATUSES:
            raise ValueError("Unsupported task status")
        if self.task_id is not None and (type(self.task_id) is not str
                or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", self.task_id) is None):
            raise ValueError("Invalid public task ID")
        if self.status in _NEEDS_ID and self.task_id is None:
            raise ValueError("This task status requires a public task ID")
        if (self.status == "completed" and type(self.data) is not dict
                or self.status != "completed" and self.data is not None):
            raise ValueError("Only completed tasks carry business data")

    def metadata(self):
        return {"status": self.status, **({"id": self.task_id} if self.task_id is not None else {})}
