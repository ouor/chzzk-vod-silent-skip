import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve everything relative to this file, so `node /path/to/build.mjs` works
// from any working directory.
const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "extension/src");
const OUT = join(ROOT, "extension/dist");
const MANIFEST = join(ROOT, "extension/manifest.json");

// Start from an empty dist: a renamed entry point must not leave a stale bundle
// behind that the manifest then references.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Content scripts and the page hook must be classic scripts (no ESM syntax),
// so they are bundled as IIFEs. The service worker and options page stay ESM.
await build({
  entryPoints: {
    content: join(SRC, "content.js"),
    "page-hook": join(SRC, "page-hook.js"),
  },
  bundle: true,
  format: "iife",
  target: "chrome116",
  outdir: OUT,
  logLevel: "info",
  minify: false,
  sourcemap: false,
});

await build({
  entryPoints: {
    background: join(SRC, "background.js"),
    options: join(SRC, "options.js"),
  },
  bundle: true,
  format: "esm",
  target: "chrome116",
  outdir: OUT,
  logLevel: "info",
  minify: false,
  sourcemap: false,
});

for (const f of ["model.json", "options.html"]) {
  copyFileSync(join(SRC, f), join(OUT, f));
}

// Validate that everything the manifest points at actually exists. A typo here
// only shows up as a broken extension in chrome://extensions.
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const referenced = new Set();
const add = (p) => {
  if (typeof p === "string") referenced.add(p);
};
add(manifest.background?.service_worker);
for (const cs of manifest.content_scripts ?? []) (cs.js ?? []).forEach(add);
for (const war of manifest.web_accessible_resources ?? []) (war.resources ?? []).forEach(add);
add(manifest.options_page);
add(manifest.action?.default_popup);

const missing = [...referenced].filter((p) => !existsSync(join(ROOT, "extension", p)));
if (missing.length) {
  console.error("\nmanifest.json references files that were not built:");
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}

console.log(`built extension/dist (${referenced.size} manifest reference(s) verified)`);
