// Single source of truth for the CLI version string.
// Must match package.json "version" — test/version.test.ts fails the build if it
// drifts, so this stays a hand-edit rather than a build step or a runtime read.
export const VERSION = "0.2.0";
