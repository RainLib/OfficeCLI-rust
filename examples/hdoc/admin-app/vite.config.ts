import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";

// `hdoc serve` embeds the built page with include_str!, so the console has to
// ship as one self-contained index.html: no hashed sidecar assets, no CDN.
// JSX comes from Vite's own esbuild pass (tsconfig jsx: react-jsx), which keeps
// the Babel tree out of the install entirely; dev-time fast refresh is off.
export default defineConfig({
  server: {
    proxy: {
      "/workspace": process.env.HCD_WORKSPACE_API || "http://127.0.0.1:7400",
      "/v1": process.env.HCD_ADMIN_API || "http://127.0.0.1:8766",
      "/health": process.env.HCD_ADMIN_API || "http://127.0.0.1:8766",
    },
  },
  plugins: [tailwindcss(), viteSingleFile()],
  define: {
    // The overview page shows which build of the console is embedded.
    __BUILD_AT__: JSON.stringify(
      new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    ),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // `embed/` and not `dist/`: the repository ignores every `dist/`, but this
    // file is a checked-in build product because `hdoc serve` embeds it.
    outDir: "embed",
    emptyOutDir: true,
    cssMinify: true,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
