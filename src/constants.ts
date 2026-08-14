// Arguments for the ggshield command, per `scanScope` input value.
export const GGSHIELD_CHANGES_ARGS: string[] = ["secret", "scan", "ci"];

// Takes the directory to scan as a trailing argument.
export const GGSHIELD_REPOSITORY_ARGS: string[] = [
  "secret",
  "scan",
  "path",
  "--yes",
  "--recursive",
  "--use-gitignore",
];

// Timeout of the ggshield scan is milliseconds
export const GGSHIELD_SCAN_TIMEOUT_MS: number = 80000;
