import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

// Only reviewed, versioned public APK fixtures are accepted by this test runner.
const fixtures = JSON.parse(await readFile(new URL("./managed-apk-fixtures.json", import.meta.url), "utf8"));
const application = process.env.APK_TEST_APPLICATION || "maidong";
assert(Object.hasOwn(fixtures, application), `Unknown managed APK fixture: ${application}`);
const fixture = fixtures[application];
assert(new URL(fixture.url).protocol === "https:");
assert(/^[a-f0-9]{64}$/.test(fixture.sha256));
assert(process.argv[2], "Pass the destination APK file path");
const destination = path.resolve(process.argv[2]);
const partial = destination + ".part";
await mkdir(path.dirname(destination), { recursive: true });
try {
  execFileSync("curl", [
    "--fail", "--location", "--retry", "3", "--retry-all-errors",
    "--connect-timeout", "30", "--max-time", "300",
    fixture.url, "--output", partial,
  ], { stdio: "inherit" });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(partial)) hash.update(chunk);
  assert.equal(hash.digest("hex"), fixture.sha256, "Original APK checksum mismatch");
  await rename(partial, destination);
  console.log(`Verified ${fixture.name} ${fixture.versionName}: ${fixture.sha256}`);
} finally {
  await rm(partial, { force: true });
}
