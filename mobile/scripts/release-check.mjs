#!/usr/bin/env node
// WI-1496 t900 Task 6 (unsigned CI slice): `pnpm --filter @abs/mobile release:check`.
//
// This is deliberately version-metadata-only. Signed-artifact checks
// (`apksigner verify`, `adb install` upgrade smoke) are t950's job, gated on Scott providing a
// real release keystore -- see mobile/RELEASE.md. Written as a plain .mjs file (not an inline
// package.json `node -e "..."`) because an inline script with nested double-quoted regex
// literals gets mangled by Windows' cmd.exe argument re-quoting when pnpm shells out to it
// (confirmed while authoring this task: the same one-liner ran fine invoked directly but broke
// under `pnpm run`).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const buildGradlePath = join(scriptDir, '..', 'android', 'app', 'build.gradle')

const contents = readFileSync(buildGradlePath, 'utf8')
const versionCode = contents.match(/versionCode\s+(\d+)/)?.[1]
const versionName = contents.match(/versionName\s+"([^"]+)"/)?.[1]

if (!versionCode || !versionName) {
  console.error(`release:check FAILED: could not read versionCode/versionName from ${buildGradlePath}`)
  process.exit(1)
}

console.log(`ShelfDroid release version check: versionCode=${versionCode} versionName=${versionName}`)
