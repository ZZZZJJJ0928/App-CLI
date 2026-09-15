# Validation record

## 2026-09-16: 0.2 runtime contracts

Scope: generic task outcomes, runtime protocol 1.0, the explicitly registered runtime adapter, and self-owned calculator references. This is a local development validation record; no release was published.

| Check | Observed result |
| --- | --- |
| Host | macOS, ARM64, Python 3.14.6 |
| Complete source test suite | 60 tests passed with `-W error::ResourceWarning`; no skips |
| Compatibility | Existing native/CLI calculator envelopes and `Registry.execute()` completed-data behavior preserved |
| Task outcomes | All eight statuses checked; incomplete outcomes return errors, retain public task IDs, and never carry successful data |
| Completed output | Invalid business output remains a failure even when the backend reports completion; task metadata is retained |
| Runtime transport | Real self-owned calculator worker matched native results; synthetic real workers exercised running, uncertain, and failed task responses over successful subprocess transport |
| Failure contracts | Simulated timeout/start failure, nonzero exit, invalid protocol versions, wrong identities, duplicate/non-finite JSON, size limits, and inconsistent task/data responses rejected without retry |
| Execution restrictions | Invalid arguments and mutation declarations rejected before subprocess dispatch; discovery starts no processes |
| Packaging | Isolated build produced wheel and source archive; 15 packaged application files matched the corresponding source bytes, including the public runtime protocol schema copy |
| Independent installation | A fresh virtual environment installed the wheel; the complete 60-test suite passed again from the extracted source archive, without another project, device, account, or private artifact |
| Installed examples | Native, CLI, and runtime multiplication each returned 42 from outside the source tree; the runtime result included `task.status: completed` |
| Import isolation | Installed reference succeeded with a conflicting working-directory module and `PYTHONPATH` |
| Public tree and docs | 40 public source files passed the repository check; local links across 10 Markdown files resolved |

The two 60-test runs exercise the same suite in different installation contexts; they are not 120 distinct tests. The build used its declared isolated environment. A preliminary non-isolated build could not import setuptools from the development environment; the standard isolated build installed the declared backend and succeeded.

The examples are synchronous and stateless. Incomplete outcomes use synthetic public fixtures; they do not prove a durable external worker. No third-party target application, production task, mutation, remote service, live confirmation, idempotent replay, cancellation, reconciliation, or process-tree teardown was validated. Windows/Linux CI remains configured rather than claimed as executed by this local run.

## Historical: 0.1 foundation

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

### Historical exclusions

- The configured GitHub Actions matrix has not run in the cloud.
- No real Windows, Linux, Android, or iOS target application was accessed.
- The API/SDK, COM, scripting, D-Bus, browser, accessibility, mobile-driver, instrumentation, file, and vision options were researched from official documentation; external-application integrations were not executed.
- The optional Tk GUI was not opened; its shared calculation function was tested.
- No Frida attachment, third-party GUI conversion, runtime integration, mutation, order, or payment was performed by this project.

Cross-platform and application-specific support claims require separate host/target/version evidence. The calculators demonstrate a reusable business contract over native functions and a self-owned CLI subprocess. Recognized manifest kinds do not establish working external backends.
