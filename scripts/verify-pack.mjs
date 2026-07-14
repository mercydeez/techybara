#!/usr/bin/env node
// Verify the npm tarball ships exactly the intended release files — nothing more,
// nothing less. Guards against a build regression, a stray secret/scratch file,
// or the wrong asset leaking into a published package.
//
// No third-party dependencies: `npm pack --json` builds the tarball, then we
// physically inspect the .tgz (gunzip + a minimal ustar reader) rather than
// trusting package.json metadata. We validate required/forbidden *content*, not
// byte size, shasum, or an exact file count (those legitimately drift).
import { execSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { readFileSync, rmSync } from "node:fs";

// --- content rules ------------------------------------------------------------
// The package.json "files" allowlist should yield only these. Anything packed
// that is not one of these is a forbidden leak.
const isAllowed = (p) =>
  p === "package.json" ||
  p === "README.md" ||
  p === "LICENSE" ||
  p === "assets/techybara.png" ||
  p.startsWith("dist/");

const REQUIRED = ["package.json", "README.md", "LICENSE", "assets/techybara.png"];
// Stable dist entry points that must always be present; a missing one means a
// broken/partial build. (Not an exhaustive list — new modules don't break this.)
const REQUIRED_DIST = ["dist/cli.js", "dist/init.js", "dist/report/run.js", "dist/core/snapshot.js"];
const MIN_DIST_JS = 10; // a nearly-empty dist/ must fail loudly, not ship silently

// --- helpers ------------------------------------------------------------------

/** Run `npm pack --json`, returning the created tarball's filename. */
function packTarball() {
  const raw = execSync("npm pack --json", { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  // Defensive: isolate the JSON array in case a notice leaks onto stdout.
  const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
  const meta = JSON.parse(json);
  const filename = meta?.[0]?.filename;
  if (!filename) throw new Error("could not determine tarball filename from `npm pack --json`");
  return filename;
}

/** List regular-file paths inside a gzipped tar buffer (ustar, no deps). */
function listTarFiles(gzBuf) {
  const buf = gunzipSync(gzBuf);
  const files = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    if (name && (type === "0" || type === "\0" || type === "")) files.push(name);
    off += 512 + Math.ceil(size / 512) * 512; // header + padded data
  }
  return files;
}

// --- main ---------------------------------------------------------------------

let tarball;
const errors = [];
try {
  tarball = packTarball();
  const rel = listTarFiles(readFileSync(tarball)).map((p) => p.replace(/^package\//, ""));

  for (const req of REQUIRED) if (!rel.includes(req)) errors.push(`missing required file: ${req}`);
  for (const req of REQUIRED_DIST) if (!rel.includes(req)) errors.push(`missing required dist file: ${req}`);

  const distJs = rel.filter((p) => p.startsWith("dist/") && p.endsWith(".js"));
  if (distJs.length < MIN_DIST_JS) {
    errors.push(`only ${distJs.length} dist/*.js files (expected >= ${MIN_DIST_JS}) — build looks incomplete`);
  }

  for (const p of rel) {
    if (!isAllowed(p)) errors.push(`forbidden file present in tarball: ${p}`);
    if (p.endsWith(".map")) errors.push(`source map must not be published: ${p}`);
    if (p.startsWith("dist/") && !p.endsWith(".js")) errors.push(`unexpected non-JS file under dist/: ${p}`);
  }

  if (errors.length === 0) {
    console.log(`verify-pack: OK — ${rel.length} files, all required present, no forbidden paths.`);
    for (const p of rel.sort()) console.log(`  ${p}`);
  }
} catch (err) {
  errors.push(`verification threw: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (tarball) {
    try {
      rmSync(tarball, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

if (errors.length > 0) {
  console.error("verify-pack: FAILED");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
