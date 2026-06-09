# Changelog

## [0.2.1] - 2026-06-09

### Fixed

- The task now strips `--show-secrets` from `additionalArguments` (emitting a
  warning) so detected secret values are never printed in plaintext to the
  pipeline logs. `ggshield` masks secrets in its output by default; the old
  docs example that enabled `--show-secrets` could leak real credentials into
  broadly-visible CI logs. Removed that flag from the README and task help.

## [0.2.0] - 2026-06-04

### Added

- The task now runs a pinned, prebuilt standalone ggshield binary downloaded
  from GitHub Releases (per OS/arch) instead of relying on Python being present
  on the agent. The binary is cached on the agent after first download, and its
  provenance is verified via its GitHub artifact attestation (Sigstore) before
  use. When no prebuilt binary exists for the platform (e.g. Linux arm64,
  Alpine/musl) or the download/verification fails, the task falls back to a
  pip/`python -m ggshield` install. Pinned to ggshield `1.51.0`.

## [0.1.1] - 2026-05-06

### Fixed

- `scanMode: 'path'` no longer hangs on ggshield's >50-file confirmation
  prompt. The task now passes `--yes` automatically since CI agents have no
  stdin to answer the prompt.

## [0.1.0] - 2025-04-24

- Initial release.
