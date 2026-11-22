import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { verifyRelease } from "../workspace/src/release.mjs";

const { values } = parseArgs({ options: {
  release: { type: "string" },
  "electron-zip": { type: "string" },
  "electron-sha256": { type: "string" },
  output: { type: "string" },
} });
if (process.platform !== "darwin" || !values.release || !values["electron-zip"] ||
    !/^[0-9a-f]{64}$/.test(values["electron-sha256"] || "") || !values.output)
  throw Error("在 macOS 指定 --release、--electron-zip、--electron-sha256 和 --output。");
const output = resolve(values.output);
if (!output.endsWith(".zip") || existsSync(output)) throw Error("请指定新的 .zip 输出路径。");
const { root, manifest } = await verifyRelease(values.release);
const { version } = manifest;
if (!/^\d+\.\d+\.\d+$/.test(version) || manifest.engine.version !== version)
  throw Error("桌面版本必须与工作台及原生引擎的版本一致。");
const electronZip = resolve(values["electron-zip"]);
const digest = createHash("sha256");
for await (const bytes of createReadStream(electronZip)) digest.update(bytes);
if (digest.digest("hex") !== values["electron-sha256"]) throw Error("Electron 压缩包校验失败。");

const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
await mkdir(dirname(output), { recursive: true });
const stage = await mkdtemp(join(dirname(output), ".foldly-macos-"));
try {
  run("/usr/bin/ditto", ["-x", "-k", electronZip, stage]);
  const bundle = join(stage, "Foldly Desktop.app");
  await rename(join(stage, "Electron.app"), bundle);
  const info = join(bundle, "Contents", "Info.plist");
  const electronArchitectures = execFileSync("/usr/bin/lipo", ["-archs", join(bundle, "Contents", "MacOS", "Electron")], { encoding: "utf8" });
  if (!electronArchitectures.trim().split(/\s+/).includes(manifest.arch === "x64" ? "x86_64" : manifest.arch))
    throw Error("Electron 与工作台的架构不同。");
  for (const [key, value] of Object.entries({
    CFBundleName: "Foldly Desktop",
    CFBundleDisplayName: "折页",
    CFBundleIdentifier: "com.rainlib.foldly.desktop",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
  })) run("/usr/bin/plutil", ["-replace", key, "-string", value, info]);
  const resources = join(bundle, "Contents", "Resources");
  const app = join(resources, "app");
  await rm(join(resources, "default_app.asar"));
  await mkdir(app);
  await writeFile(join(app, "package.json"), JSON.stringify({
    name: "foldly-desktop", productName: "Foldly Desktop", version, main: "main.cjs",
  }) + "\n");
  await copyFile(join(import.meta.dirname, "main.cjs"), join(app, "main.cjs"));
  await Promise.all([
    cp(root, join(resources, "workspace"), { recursive: true }),
    copyFile(join(stage, "LICENSE"), join(resources, "LICENSE.Electron.txt")),
    copyFile(join(stage, "LICENSES.chromium.html"), join(resources, "LICENSES.chromium.html")),
  ]);
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  await verifyRelease(join(resources, "workspace"));
  const archive = join(stage, "desktop.zip");
  run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", bundle, archive]);
  await rename(archive, output);
  console.log(JSON.stringify({ version, arch: manifest.arch, release: manifest.id, archive: output }, null, 2));
} finally {
  await rm(stage, { recursive: true, force: true });
}
