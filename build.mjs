import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
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

// `--zip`: package what Chrome loads (manifest, dist/, icons/) into a release zip
// whose single top-level folder can be picked in "Load unpacked".
if (process.argv.includes("--zip")) {
  const name = `chzzk-skip-silence-${manifest.version}`;
  const files = ["manifest.json",
    ...readdirSync(join(ROOT, "extension/dist")).map((f) => `dist/${f}`),
    ...readdirSync(join(ROOT, "extension/icons")).map((f) => `icons/${f}`)];
  const out = join(ROOT, `${name}.zip`);
  writeFileSync(out, zip(files.map((f) => [`${name}/${f}`, readFileSync(join(ROOT, "extension", f))])));
  console.log(`packed ${files.length} files into ${name}.zip`);
}

/** Minimal deflate zip writer (no zip64; fine for a few MB). */
function zip(entries) {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [path, data] of entries) {
    const nameBuf = Buffer.from(path, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const head = Buffer.alloc(26);
    head.writeUInt16LE(20, 0);            // version needed
    head.writeUInt16LE(0x0800, 2);        // UTF-8 names
    head.writeUInt16LE(8, 4);             // deflate
    head.writeUInt16LE(time, 6);
    head.writeUInt16LE(date, 8);
    head.writeUInt32LE(crc32(data), 10);
    head.writeUInt32LE(packed.length, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt16LE(nameBuf.length, 22);
    const local = Buffer.concat([u32(0x04034b50), head, nameBuf, packed]);
    // central entry: made-by, the same 26 header bytes, then comment/disk/attrs (10 zero bytes) and the offset
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), head, Buffer.alloc(10), u32(offset), nameBuf]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(18);
  end.writeUInt16LE(entries.length, 4);
  end.writeUInt16LE(entries.length, 6);
  end.writeUInt32LE(cd.length, 8);
  end.writeUInt32LE(offset, 12);
  return Buffer.concat([...locals, cd, u32(0x06054b50), end]);
}
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }
