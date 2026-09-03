/**
 * Copy static assets (renderer HTML/CSS/JS + resources) into dist/ after `tsc`,
 * so the packaged app can ship a single dist/ tree.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Renderer (static web assets) -> dist/renderer
copyDir(path.join(root, "src", "renderer"), path.join(root, "dist", "renderer"));
// Resources (icons) -> dist/resources
if (fs.existsSync(path.join(root, "resources"))) {
  copyDir(path.join(root, "resources"), path.join(root, "dist", "resources"));
}

console.log("[copy-assets] renderer + resources copied to dist/");
