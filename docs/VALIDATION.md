# Validation record

Date: 2026-09-08. Scope: the App-CLI 0.1 foundation, Manifest 1.0 access methods, and its native/subprocess calculator references.

| Check | Observed result |
| --- | --- |
| Host | macOS, ARM64, Python 3.14.6 |
| Editable installation | `python -m pip install -e ".[dev]"` succeeded in a project virtual environment |
| Unit and subprocess tests | 39 tests passed with `-W error::ResourceWarning`; no skips |
| Public source check | No issues in the candidate source tree; includes untracked files and staged-content checks |
| Named CLI arguments | `calculator add --a 2 --b 3` returned `value: 5` |
| JSON CLI arguments | `calculator multiply --input '{"a":6,"b":7}'` returned `value: 42` |
| CLI access backend | Real `calculator-cli` child processes matched native addition, subtraction, and multiplication results, including a boundary multiplication |
| Access-method declarations | All 13 kinds accepted under Manifest 1.0; unknown kinds and unsupported versions rejected without execution |
| Child protocol and failures | Simulated timeout, start failure, nonzero exit, malformed/duplicate/non-finite JSON, incorrect command identity, and invalid business output were rejected with sanitized errors |
| Import isolation | Installed CLI and its child succeeded outside the repository despite a conflicting module in the working directory and `PYTHONPATH` |
| Discovery | `apps`, `describe`, and `schema` returned validated metadata without invoking calculator operations |
| Packaging | Wheel and source distribution built; runtime schemas and calculator manifest were included |
| Isolated wheel installation | A fresh virtual environment imported App-CLI from its own installed site-packages and ran both native and CLI-backend multiplication from outside the source directory |
| Source archive | Public schema, optional GUI source, technical options, contribution documentation, and backend tests were included |
| Documentation | Relative file/heading links resolved; public source content passed repository hygiene checks |

The tests cover argument admission, duplicate/non-finite JSON rejection, manifest snapshots, local schema references, unsupported mutations before dispatch, output validation, sanitized native failures, CLI subprocess boundaries, and accidental-publication checks. The Windows Git lookup/environment behavior and timeout/error paths are covered by mocked tests, not real Windows execution or a measured process-tree cancellation experiment.

The public-tree tool checks common mistakes; passing it is not proof that arbitrary proprietary or sensitive data is absent. It does not publish, stage, or commit files.

## Explicitly not validated

- The configured GitHub Actions matrix has not run in the cloud.
- No real Windows, Linux, Android, or iOS target application was accessed.
- The API/SDK, COM, scripting, D-Bus, browser, accessibility, mobile-driver, instrumentation, file, and vision options were researched from official documentation; external-application integrations were not executed.
- The optional Tk GUI was not opened; its shared calculation function was tested.
- No Frida attachment, third-party GUI conversion, runtime integration, mutation, order, or payment was performed by this project.

Cross-platform and application-specific support claims require separate host/target/version evidence. The calculators demonstrate a reusable business contract over native functions and a self-owned CLI subprocess. Recognized manifest kinds do not establish working external backends.
