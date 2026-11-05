import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function verifyRuntimeResources(resources, platform, arch) {
  const catalog = JSON.parse(await readFile(path.join(resources, "runtime-catalog.json"), "utf8"));
  const bundled = path.join(resources, "runtime-bundled");
  const manifest = JSON.parse(await readFile(path.join(bundled, "bundle-manifest.json"), "utf8"));
  assert.equal(manifest.target, `${platform}-${arch}`, "Bundled tools must match the installer architecture");
  assert.equal(manifest.catalogVersion, catalog.catalogVersion);
  const components = catalog.platforms[manifest.target].components.filter(item => item.bundle);
  assert.equal(manifest.bundledComponents.length, components.length);
  for (const component of components) {
    const file = path.join(bundled, component.bundledFile);
    assert.equal((await stat(file)).size, component.size, `Missing or truncated ${component.id}`);
    const hash = createHash(component.checksum.algorithm);
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    assert.equal(hash.digest("hex"), component.checksum.value, `Invalid ${component.id}`);
  }
  for (const license of Object.values(catalog.licenses)) {
    const bytes = await readFile(path.join(resources, license.file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), license.sha256);
  }
  return { target: manifest.target, bundledComponents: components.map(item => item.id), verified: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resources = process.argv[2] || path.join("release", "win-unpacked", "resources");
  console.log(JSON.stringify(await verifyRuntimeResources(resources, process.platform, process.arch), null, 2));
}
