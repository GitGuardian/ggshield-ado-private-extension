# Changelog

## [0.1.1] - 2026-05-06

### Fixed

- `scanMode: 'path'` no longer hangs on ggshield's >50-file confirmation
  prompt. The task now passes `--yes` automatically since CI agents have no
  stdin to answer the prompt.

## [0.1.0] - 2025-04-24

- Initial release.
