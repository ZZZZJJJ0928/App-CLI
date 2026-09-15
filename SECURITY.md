# Security

## Trust boundary

App-CLI runs explicitly registered adapters inside its Python process. Registration trusts their code with that process's permissions; it is not a sandbox. Manifest validation, local-only schema references, and the prohibition on executing declared mutations reduce specific risks but cannot make malicious adapter code safe or prove a `read_only` declaration truthful.

The CLI does not automatically discover, import by caller-supplied path, or download third-party adapters. Review adapter code and its dependencies before adding it to a registry. Application authorization remains a separate requirement from installing App-CLI or gaining technical access to a process. No Android/iOS target adapter or Frida deployment is included in the initial release.

Adapters must expose only intended business operations, validate target versions and prerequisites where applicable, and avoid returning credentials or private diagnostic data. Public error messages are part of the output contract: deliberately raised errors must be sanitized. Do not treat a successful RPC as proof that an operation completed or retry an uncertain side effect blindly.

A `RuntimeAdapter` also trusts the registered executable and its environment. Executable arguments and timeout policy are supplied by reviewed code, never by business parameters. Runtime protocol validation checks task status, identity, and completed output; it does not confer authorization or provide a sandbox. Public task IDs must not contain credentials or encode sensitive user data. The current runtime adapter executes only declared read-only commands.

## Private reporting

If GitHub private vulnerability reporting is enabled for the repository, use **Security → Report a vulnerability**. If it is unavailable, ask a maintainer for a private reporting channel without including exploit details or sensitive data in a public issue. No security email address or response-time commitment is established here.

A useful report includes the affected App-CLI and adapter versions, platform, impact, minimal reproduction using synthetic data, and a sanitized trace. Keep live tokens, account details, login sessions, private screenshots, device identifiers, and keys out of the report unless a maintainer has arranged an appropriate private transfer method. Do not test against other people's accounts or systems without authorization.

This project does not provide mechanisms to conceal privileged access, defeat application verification, or replace platform authorization. Report a boundary failure rather than relying on such mechanisms as an adapter prerequisite.
