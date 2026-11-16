import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  repo = resolve(app, "../.."),
  out = resolve(process.env.OFFICECLI_WORKSPACE_DIST || join(app, "dist"));
const admin = join(repo, "examples/hdoc/admin-app"),
  editor = join(repo, "examples/hdoc/editor");
function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
if (process.env.OFFICECLI_SKIP_UI_BUILD !== "1") {
  run("npm", ["run", "build"], admin);
  run("npm", ["run", "build"], editor);
}
const { build } = await import(
  join(editor, "node_modules/esbuild/lib/main.js")
);
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(editor, "sidecar.ts")],
  outfile: join(out, "sidecar.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  logLevel: "info",
  // crossws creates a require from import.meta.url. Preserve that URL when
  // bundling ESM dependencies into a relocatable, dependency-free CJS file.
  define: { "import.meta.url": "__officecliSidecarUrl" },
  banner: {
    js: "const __officecliSidecarUrl = require('node:url').pathToFileURL(__filename).href;",
  },
});
cpSync(join(admin, "embed"), join(out, "admin"), { recursive: true });
cpSync(join(editor, "dist"), join(out, "editor"), { recursive: true });
const binary =
  process.env.OFFICECLI_BIN || join(repo, "target/debug/officecli");
if (!existsSync(binary))
  throw new Error("请先 cargo build -p officecli --bin officecli");
cpSync(binary, join(out, "officecli"));
console.log(`Workspace 构建完成：${out}`);
