import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export function parseOptions(args) {
  const options = {
    platform: process.platform,
    arch: process.arch,
    output: path.join(repositoryRoot, "resources/runtime-bundled"),
    dryRun: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (["--platform", "--arch", "--output"].includes(argument)) {
      const value = args[++index];
      assert(value && !value.startsWith("--"), `Missing value for ${argument}`);
      options[argument.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  options.output = path.resolve(options.output);
  return options;
}

export function resolveBundleFiles(catalog, platform, arch) {
  assert.equal(catalog.schemaVersion, 1, "Unsupported runtime catalog");
  const target = `${platform}-${arch}`;
  const specification = catalog.platforms[target];
  assert(specification, `Unsupported runtime target: ${target}`);
  const components = specification.components.filter(
    (component) => component.bundle,
  );
  assert(components.length > 0, "No bundled core components are configured");
  for (const component of components) {
    assert(
      ["zip", "tar.gz"].includes(component.archive),
      "Unsupported archive type",
    );
    assert(
      ["sha1", "sha256"].includes(component.checksum.algorithm),
      "Unsupported checksum type",
    );
    assert(
      new RegExp(
        `^[a-f0-9]{${component.checksum.algorithm === "sha1" ? 40 : 64}}$`,
      ).test(component.checksum.value),
      "Invalid pinned checksum",
    );
    assert(
      Number.isSafeInteger(component.size) && component.size > 0,
      "Invalid archive byte count",
    );
    assert(
      /^archives\/[a-zA-Z0-9._-]+\.(?:zip|tar\.gz)$/.test(
        component.bundledFile,
      ),
      "Invalid bundled archive path",
    );
    const url = new URL(component.url);
    assert(
      url.protocol === "https:" &&
        ["dl.google.com", "github.com"].includes(url.hostname),
      "Runtime archives must use a pinned official HTTPS source",
    );
    for (const mirror of component.mirrors ?? []) {
      assert(
        component.url.startsWith("https://dl.google.com/android/repository/") &&
          mirror ===
            component.url.replace(
              "https://dl.google.com/android/repository/",
              "https://mirrors.cloud.tencent.com/AndroidSDK/",
            ),
        "Runtime mirrors must preserve the verified Android SDK archive path",
      );
    }
  }
  return { target, components };
}

async function digestFile(file, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function validateArchive(file, component) {
  const info = await stat(file).catch(() => null);
  return Boolean(
    info?.isFile() &&
    info.size === component.size &&
    (await digestFile(file, component.checksum.algorithm)) ===
      component.checksum.value,
  );
}

export async function downloadArchive(component, destination) {
  if (await validateArchive(destination, component)) {
    console.log(`Verified cached core: ${component.id}`);
    return;
  }
  const temporary = `${destination}.${randomUUID()}.partial`;
  const sources = [component.url, ...(component.mirrors ?? [])];
  const maximumAttempts = sources.length * 3;
  let finalError;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await fetch(sources[(attempt - 1) % sources.length], {
        signal: AbortSignal.timeout(180_000),
      });
      assert(
        response.ok && response.body,
        `Download failed with HTTP ${response.status}`,
      );
      const hash = createHash(component.checksum.algorithm);
      let size = 0;
      const verifier = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > component.size)
            callback(new Error("Archive exceeds pinned byte count"));
          else {
            hash.update(chunk);
            callback(null, chunk);
          }
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        verifier,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      assert.equal(
        size,
        component.size,
        `Wrong byte count for ${component.id}`,
      );
      assert.equal(
        hash.digest("hex"),
        component.checksum.value,
        `Checksum mismatch for ${component.id}`,
      );
      await rename(temporary, destination);
      console.log(`Bundled verified core: ${component.id} (${size} bytes)`);
      return;
    } catch (error) {
      finalError = error;
      await rm(temporary, { force: true });
      if (attempt < maximumAttempts && attempt % sources.length === 0)
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(
    `Cannot prepare ${component.id}: ${finalError?.message || finalError}`,
  );
}

export async function prepareRuntime(options) {
  const sourceDirectory = path.join(repositoryRoot, "resources");
  const catalogPath = path.join(sourceDirectory, "runtime-catalog.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const { target, components } = resolveBundleFiles(
    catalog,
    options.platform,
    options.arch,
  );
  const summary = {
    target,
    catalogVersion: catalog.catalogVersion,
    bundledBytes: components.reduce(
      (total, component) => total + component.size,
      0,
    ),
    bundledComponents: components.map(
      ({ id, bundledFile, size, checksum }) => ({
        id,
        bundledFile,
        size,
        checksum,
      }),
    ),
    firstUseDownloads: [
      ...catalog.platforms[target].components.filter(
        (component) => !component.bundle,
      ),
      ...Object.values(catalog.platforms[target].images),
    ].map(({ id, size }) => ({ id, size })),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (options.dryRun) return summary;

  await mkdir(path.join(options.output, "archives"), { recursive: true });
  // Only remove stale generated archive files, never arbitrary paths outside this directory.
  const wanted = new Set(
    components.map((component) => path.basename(component.bundledFile)),
  );
  for (const file of await readdir(path.join(options.output, "archives"))) {
    if (!wanted.has(file) && /\.(?:zip|tar\.gz|partial)$/.test(file))
      await rm(path.join(options.output, "archives", file), { force: true });
  }
  for (const component of components)
    await downloadArchive(
      component,
      path.join(options.output, component.bundledFile),
    );

  await copyFile(
    catalogPath,
    path.join(options.output, "runtime-catalog.json"),
  );
  for (const license of Object.values(catalog.licenses)) {
    assert(
      /^licenses\/[a-z0-9-]+\.txt$/.test(license.file),
      "Invalid license resource path",
    );
    const contents = await readFile(path.join(sourceDirectory, license.file));
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      license.sha256,
      "License text checksum mismatch",
    );
    await mkdir(path.dirname(path.join(options.output, license.file)), {
      recursive: true,
    });
    await writeFile(path.join(options.output, license.file), contents);
  }
  await writeFile(
    path.join(options.output, "bundle-manifest.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  prepareRuntime(parseOptions(process.argv.slice(2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
