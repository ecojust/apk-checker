import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile, appendFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const platforms = [
  { key: "arm64", artifact: "APK-Checker-macOS-arm64", platform: "darwin", arch: "arm64", binaryArch: "arm64", suffix: "mac-arm64.dmg" },
  { key: "intel", artifact: "APK-Checker-macOS-x64", platform: "darwin", arch: "x64", binaryArch: "x86_64", suffix: "mac-x64.dmg" },
  { key: "windows", artifact: "APK-Checker-Windows-x64", platform: "win32", arch: "x64", suffix: "win-x64.exe" },
];
const macChecks = [
  "dmgIntegrityVerified", "mountedBundleSignatureVerified", "copiedBundleSignatureVerified",
  "managedFirstRunVerified", "rendererStarted", "preloadIpcVerified", "bundleUnchangedAfterLaunch",
];
const publisherFiles = new Set([
  "README.md", ".github/workflows/release.yml", "scripts/stage-release.mjs", "tests/stage-release.test.mjs",
]);

function command(file, args) {
  const result = spawnSync(file, args, { encoding: "utf8", maxBuffer: 16 * 1024 ** 2 });
  if (result.error || result.status !== 0) {
    throw new Error(file + " failed: " + (result.stderr || result.error?.message || "exit " + result.status).trim());
  }
  return result.stdout.trim();
}
function github(endpoint, missingAllowed = false) {
  const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8", maxBuffer: 16 * 1024 ** 2 });
  if (missingAllowed && result.status !== 0 && /\(HTTP 404\)/.test(result.stderr)) return null;
  if (result.error || result.status !== 0) throw new Error("GitHub API request failed: " + (result.stderr || result.error?.message).trim());
  return JSON.parse(result.stdout);
}
function repository() {
  const value = process.env.GITHUB_REPOSITORY || "";
  assert.match(value, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Invalid repository");
  return value;
}
function workDirectory() {
  assert(process.env.RELEASE_WORK_DIR && path.isAbsolute(process.env.RELEASE_WORK_DIR), "RELEASE_WORK_DIR must be absolute");
  return process.env.RELEASE_WORK_DIR;
}
async function regularFile(directory, name, limit) {
  assert.equal(path.basename(name), name, "Unexpected nested filename");
  const file = path.join(directory, name);
  const stat = await lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), "Expected regular file: " + name);
  assert(stat.size > 0 && stat.size <= limit, "Unexpected file size: " + name);
  const base = await realpath(directory);
  assert.equal(path.dirname(await realpath(file)), base, "File escapes artifact directory");
  return { file, size: stat.size };
}
async function jsonFile(directory, name) {
  const { file } = await regularFile(directory, name, 1024 * 1024);
  return JSON.parse(await readFile(file, "utf8"));
}
export async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export function validateVersion(version) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Invalid package version");
  return version;
}
export function validateRun(run, repo, runId) {
  assert.equal(String(run.id), String(runId), "Wrong build run");
  assert.equal(run.repository?.full_name, repo, "Wrong build repository");
  assert.equal(run.head_repository?.full_name, repo, "Fork build cannot be released");
  assert.equal(run.path, ".github/workflows/build.yml", "Unexpected build workflow");
  assert.equal(run.status, "completed", "Build has not completed");
  assert.equal(run.conclusion, "success", "Build did not succeed");
  assert.match(run.head_sha, /^[0-9a-f]{40}$/, "Invalid build source SHA");
}
export function validateChangedFiles(files) {
  for (const name of files) {
    assert(publisherFiles.has(name) || name.startsWith("docs/") || name.startsWith("history/"),
      "Production differs from the built source: " + name);
  }
}
export async function verifyPlatformDirectory(config, directory, version) {
  validateVersion(version);
  const originalName = "APK Checker-" + version + "-" + config.suffix;
  const normalizedName = "APK-Checker-" + version + "-" + config.suffix;
  const installer = await regularFile(directory, originalName, 2 * 1024 ** 3);
  const checksumFile = await regularFile(directory, "SHA256SUMS.txt", 1024 * 1024);
  const lines = (await readFile(checksumFile.file, "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 1, "Expected exactly one installer checksum");
  const checksum = /^([0-9a-f]{64})  (.+)$/.exec(lines[0]);
  assert(checksum && checksum[2] === originalName, "Checksum names the wrong installer");
  const digest = await sha256(installer.file);
  assert.equal(digest, checksum[1], "Installer SHA-256 mismatch");
  const portable = await jsonFile(directory, "portable-tools-verification.json");
  assert.equal(portable.status, "passed", "Portable tools verification failed");
  assert.equal(portable.platform, config.platform, "Wrong portable-tools platform");
  assert.equal(portable.arch, config.arch, "Wrong portable-tools architecture");
  assert.equal(portable.privateAdbAutostartAndCleanupVerified, true, "Private ADB lifecycle not verified");
  let mac;
  if (config.platform === "darwin") {
    assert.equal(portable.displayLogStreamingVerified, true, "Mac log streaming not verified");
    mac = await jsonFile(directory, "mac-verification.json");
    assert.equal(mac.status, "passed", "Mac package verification failed");
    assert.equal(mac.artifact, originalName, "Mac report names the wrong installer");
    assert.equal(mac.host?.platform, "darwin", "Mac report is not from macOS");
    assert.equal(mac.host?.arch, config.arch, "Wrong native Mac host architecture");
    assert.equal(mac.binaryArchitectures, config.binaryArch, "Wrong Mac binary architecture");
    assert.equal(mac.runtimeResources?.target, "darwin-" + config.arch, "Wrong bundled runtime architecture");
    assert.equal(mac.runtimeResources?.verified, true, "Runtime resources not verified");
    for (const key of macChecks) assert.equal(mac[key], true, "Missing native Mac verification: " + key);
  }
  return {
    file: installer.file, originalName, name: normalizedName, size: installer.size, sha256: digest,
    verification: {
      portableToolsPassed: true, privateAdbAutostartAndCleanupVerified: true,
      ...(mac ? { nativeMacChecksPassed: true, binaryArchitecture: mac.binaryArchitectures,
        signing: mac.signing, notarized: mac.notarized } : {}),
    },
  };
}
export async function stageInstallers(inputDirectory, outputDirectory, metadata) {
  const verified = [];
  for (const config of platforms) {
    const item = await verifyPlatformDirectory(config, path.join(inputDirectory, config.key), metadata.version);
    const artifact = metadata.artifacts.find((entry) => entry.name === config.artifact);
    assert(artifact, "Missing artifact provenance: " + config.artifact);
    verified.push({ ...item, artifactId: artifact.id, artifactName: artifact.name });
  }
  // Validate everything before creating the output directory or copying bytes.
  await mkdir(outputDirectory);
  for (const file of verified) await copyFile(file.file, path.join(outputDirectory, file.name));
  await writeFile(path.join(outputDirectory, "SHA256SUMS.txt"),
    verified.map((file) => file.sha256 + "  " + file.name).join("\n") + "\n", { flag: "wx" });
  const provenance = {
    version: metadata.version, tag: "v" + metadata.version, repository: metadata.repository,
    buildRunId: metadata.runId, buildRunUrl: metadata.runUrl, builtSource: metadata.sourceSha,
    tagTarget: metadata.targetSha,
    installers: verified.map(({ file, ...item }) => item),
  };
  await writeFile(path.join(outputDirectory, "release-provenance.json"),
    JSON.stringify(provenance, null, 2) + "\n", { flag: "wx" });
  return provenance;
}

async function validateBuild() {
  const repo = repository();
  const runId = process.env.BUILD_RUN_ID || "";
  assert.match(runId, /^[1-9]\d*$/, "BUILD_RUN_ID must contain only digits");
  const run = github("repos/" + repo + "/actions/runs/" + runId);
  validateRun(run, repo, runId);
  const targetSha = command("git", ["rev-parse", "HEAD"]);
  command("git", ["merge-base", "--is-ancestor", run.head_sha, targetSha]);
  const changed = command("git", ["diff", "--name-only", "-z", run.head_sha, targetSha]).split("\0").filter(Boolean);
  validateChangedFiles(changed);
  const version = validateVersion(JSON.parse(await readFile("package.json", "utf8")).version);
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const response = github("repos/" + repo + "/actions/runs/" + runId + "/artifacts?per_page=100&page=" + page);
    all.push(...response.artifacts);
    if (all.length >= response.total_count) break;
    assert(page < 20, "Too many artifacts");
  }
  const artifacts = platforms.map((config) => {
    const found = all.filter((item) => item.name === config.artifact);
    assert.equal(found.length, 1, "Expected one artifact: " + config.artifact);
    const item = found[0];
    assert.equal(item.expired, false, "Artifact has expired: " + item.name);
    assert.equal(item.workflow_run?.head_sha, run.head_sha, "Artifact source mismatch");
    assert.equal(String(item.workflow_run?.id), runId, "Artifact run mismatch");
    return { id: item.id, name: item.name, size: item.size_in_bytes, digest: item.digest };
  });
  const metadata = { repository: repo, version, runId, runUrl: run.html_url,
    sourceSha: run.head_sha, targetSha, artifacts };
  const directory = workDirectory();
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
  assert(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
  await appendFile(process.env.GITHUB_OUTPUT,
    "run_id=" + runId + "\n" + platforms.map((p) => p.key + "_id=" + artifacts.find((a) => a.name === p.artifact).id).join("\n") + "\n");
  console.log("Validated build " + runId + " from " + run.head_sha + " for " + targetSha);
}
export function releaseByTag(repo, tag, request = github) {
  // REST /releases/tags cannot resolve a draft whose tag has not been created.
  // Authenticated listing includes drafts; fetch the selected ID for current assets.
  for (let page = 1; page <= 20; page++) {
    const releases = request("repos/" + repo + "/releases?per_page=100&page=" + page);
    const matching = releases.filter((release) => release.tag_name === tag);
    assert(matching.length <= 1, "Multiple releases use the requested tag");
    if (matching.length) return request("repos/" + repo + "/releases/" + matching[0].id);
    if (releases.length < 100) return null;
  }
  throw new Error("Too many releases to resolve the requested tag safely");
}
function validateExistingTag(repo, tag, target) {
  let reference = github("repos/" + repo + "/git/ref/tags/" + tag, true);
  if (!reference) return;
  let object = reference.object;
  for (let depth = 0; object.type === "tag" && depth < 5; depth++) {
    object = github("repos/" + repo + "/git/tags/" + object.sha).object;
  }
  assert.equal(object.type, "commit", "Release tag does not resolve to a commit");
  assert.equal(object.sha, target, "Existing tag points to another commit");
}
async function prepareDraft() {
  const directory = workDirectory();
  const metadata = await jsonFile(directory, "metadata.json");
  const output = path.join(directory, "prepared");
  const provenance = await jsonFile(output, "release-provenance.json");
  const repo = repository();
  assert.equal(provenance.repository, repo, "Staged repository mismatch");
  assert.equal(provenance.tagTarget, command("git", ["rev-parse", "HEAD"]), "Staged target mismatch");
  const tag = "v" + validateVersion(metadata.version);
  assert.equal(provenance.tag, tag, "Staged version mismatch");
  const notes = path.join("docs", "releases", tag + ".md");
  await regularFile(path.dirname(notes), path.basename(notes), 1024 * 1024);
  const names = [...provenance.installers.map((item) => item.name), "SHA256SUMS.txt", "release-provenance.json"];
  assert.deepEqual((await readdir(output)).sort(), [...names].sort(), "Unexpected staged files");
  const files = [];
  for (const name of names) {
    const info = await regularFile(output, name, 2 * 1024 ** 3);
    files.push({ ...info, name, sha256: await sha256(info.file) });
  }
  for (const installer of provenance.installers) {
    assert.equal(files.find((file) => file.name === installer.name)?.sha256, installer.sha256, "Staged bytes changed");
  }
  validateExistingTag(repo, tag, provenance.tagTarget);
  let release = releaseByTag(repo, tag);
  if (release) {
    assert.equal(release.draft, true, "Refusing to modify a published release");
    assert.equal(release.target_commitish, provenance.tagTarget, "Existing draft targets another commit");
    assert(release.assets.every((asset) => names.includes(asset.name)), "Draft contains unrelated assets");
  } else {
    command("gh", ["release", "create", tag, "--repo", repo, "--draft", "--target", provenance.tagTarget,
      "--title", "APK Checker " + tag, "--notes-file", notes]);
    release = releaseByTag(repo, tag);
    assert(release, "Created draft release could not be found");
    assert.equal(release.draft, true, "Expected a draft release");
    assert.equal(release.target_commitish, provenance.tagTarget, "Draft target mismatch");
  }
  for (const file of files) {
    const existing = release.assets.find((asset) => asset.name === file.name);
    if (existing) {
      assert.equal(existing.size, file.size, "Existing asset size mismatch: " + file.name);
      assert.equal(existing.digest, "sha256:" + file.sha256, "Existing asset checksum mismatch: " + file.name);
    } else {
      command("gh", ["release", "upload", tag, file.file, "--repo", repo]);
    }
  }
  const final = github("repos/" + repo + "/releases/" + release.id);
  assert.equal(final.draft, true, "Release must remain draft");
  assert.equal(final.assets.length, files.length, "Unexpected draft asset count");
  for (const file of files) {
    const asset = final.assets.find((item) => item.name === file.name);
    assert(asset && asset.size === file.size && asset.digest === "sha256:" + file.sha256,
      "Uploaded asset verification failed: " + file.name);
  }
  console.log(JSON.stringify({ draft: true, tag, target: provenance.tagTarget, url: final.html_url,
    assets: final.assets.map(({ name, size, digest }) => ({ name, size, digest })) }, null, 2));
}
async function main() {
  const action = process.argv[2];
  if (action === "validate") return validateBuild();
  if (action === "stage") {
    const directory = workDirectory();
    const metadata = await jsonFile(directory, "metadata.json");
    const result = await stageInstallers(path.join(directory, "downloads"), path.join(directory, "prepared"), metadata);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (action === "draft") return prepareDraft();
  throw new Error("Expected validate, stage or draft");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

