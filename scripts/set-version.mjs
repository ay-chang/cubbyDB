#!/usr/bin/env node
// Bumps the version in every place it's duplicated: package.json,
// src-tauri/tauri.conf.json, and src-tauri/Cargo.toml. Run this instead of
// editing any of the three by hand — a release is just this script, a
// commit, and a `git tag vX.Y.Z`.
//
// Usage: node scripts/set-version.mjs 0.2.0

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/set-version.mjs <semver, e.g. 0.2.0>");
  process.exit(1);
}

// Targeted string replacement rather than JSON.parse/stringify — a full
// round-trip through JSON.stringify reformats every nested object to a
// uniform indent, silently clobbering unrelated hand-formatting elsewhere in
// the file (e.g. single-line objects). Each of these files has exactly one
// top-level `"version"` field, and it appears before any other key named
// "version" could plausibly occur, so a non-global regex (replaces only the
// first match) hits the right one without parsing the whole document.
function replaceOnce(path, pattern, replacement) {
  const full = join(root, path);
  const text = readFileSync(full, "utf8");
  const updated = text.replace(pattern, replacement);
  if (updated === text) {
    console.error(`could not find a version field to update in ${path}`);
    process.exit(1);
  }
  writeFileSync(full, updated);
  console.log(`updated ${path}`);
}

replaceOnce(
  "package.json",
  /^(\s*"version":\s*)"[^"]*"/m,
  `$1"${version}"`,
);

replaceOnce(
  "src-tauri/tauri.conf.json",
  /^(\s*"version":\s*)"[^"]*"/m,
  `$1"${version}"`,
);

replaceOnce(
  "src-tauri/Cargo.toml",
  /^(\[package\][^[]*?\nversion\s*=\s*)"[^"]*"/m,
  `$1"${version}"`,
);

console.log(`\nVersion set to ${version} in all three files.`);
console.log("Next: commit, then `git tag v" + version + " && git push origin v" + version + "`");
