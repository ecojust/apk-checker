import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve("release");
const artifacts = (await readdir(directory))
  .filter((file) => /\.(dmg|exe)$/.test(file))
  .sort();
assert(artifacts.length > 0, "No installers found to checksum");
const lines = [];
for (const file of artifacts) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path.join(directory, file)))
    hash.update(chunk);
  lines.push(`${hash.digest("hex")}  ${file}`);
}
await writeFile(
  path.join(directory, "SHA256SUMS.txt"),
  `${lines.join("\n")}\n`,
);
console.log(lines.join("\n"));
