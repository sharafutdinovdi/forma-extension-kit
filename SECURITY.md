# Security policy

Security fixes target the latest released `0.1.x` version.

## Reporting

Suspected vulnerabilities can be submitted through [GitHub private vulnerability reporting](https://github.com/sharafutdinovdi/forma-extension-kit/security/advisories/new) when enabled for the repository.
If private reporting is unavailable, an issue may request a private contact without disclosing exploit details or sensitive data.
Reports should include the affected version, a minimal reproduction, expected impact and relevant runtime versions.
Credentials, authentication sessions, private project identifiers and proprietary geometry must be removed.

## Trust boundaries

Panel channel names and proposal ids are routing data, not authentication credentials.
Other same-origin code can send channel or storage messages; applications must validate payloads before using them.
The adapter validates message envelopes and ordering, not application data or permissions.
Fallback storage is transient but remains visible to scripts with access to the same storage origin.
Secrets must not be sent through panel channels.

The SDK controls host authentication and access.
Request deadlines bound adapter waits; they do not cancel underlying SDK requests.
Geometry and model properties remain external data and do not establish regulatory measurements.
