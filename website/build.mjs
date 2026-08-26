// Inline the whole site into one file.
//
// The site is plain HTML, CSS and JS by design — open index.html and it works.
// This exists for the two places a folder is inconvenient: pasting the page
// into a viewer that only accepts one file, and hosting somewhere that will
// not serve relative assets. Output goes to dist/index.html and depends on
// nothing at runtime except the Google Fonts stylesheet.
//
//   node website/build.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");

const logo = readFileSync(join(here, "assets/logo.png")).toString("base64");
const logoUri = `data:image/png;base64,${logo}`;

const html = read("index.html")
  .replace(
    '<link rel="stylesheet" href="./styles.css" />',
    `<style>\n${read("styles.css")}\n</style>`,
  )
  .replace(
    '<script src="./script.js"></script>',
    `<script>\n${read("script.js")}\n</script>`,
  )
  // A social card and a touch icon do nothing in a single file that is not
  // being served from a URL, and each one would carry another copy of the
  // image. Dropping them leaves two references: the favicon and the CSS
  // variable every mark on the page draws from.
  .replace(/\n\s*<link rel="apple-touch-icon"[^>]*>/, "")
  .replace(/\n\s*<meta property="og:image"[^>]*>/, "")
  .replaceAll("./assets/logo.png", logoUri);

mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "dist/index.html"), html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`website/dist/index.html — ${kb} KB, self-contained`);
