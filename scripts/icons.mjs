#!/usr/bin/env node
/**
 * Writes every Photos icon from one definition of the star: the web favicon,
 * the phone's launcher, adaptive and splash SVGs, and the PNGs that Expo reads.
 *
 * The star used to be copied by hand into each SVG, with each PNG rasterised
 * by hand from its SVG. The copies drifted: a clip added to four files missed
 * the fifth. Edit the star here, run `pnpm icons`, and commit what it writes.
 *
 * `--check` writes nothing and fails when a committed file differs from what
 * this script would write. SVGs must match byte for byte. PNGs must match
 * within a small per-channel tolerance, since rasterisers on different
 * platforms anti-alias the same edge a shade differently.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const sharp = createRequire(resolve(root, "package.json"))("sharp");

// The star and its inner pentagon, in a 64-unit box.
const STAR =
  "M 17.50 22.20 L 18.61 1.00 L 36.42 12.56 L 56.93 7.07 L 51.44 27.58 L 63.00 45.39 L 41.80 46.50 L 28.43 63.00 L 20.82 43.18 L 1.00 35.57 Z";
const PENTAGON = "M 51.44 27.58 L 41.80 46.50 L 20.82 43.18 L 17.50 22.20 L 36.42 12.56 Z";
// The circumcentre of the star's tips, which the star turns about.
const PIVOT = "-33.59 -30.41";
const TURN = 14;
const GOLDEN = ["#ffd23f", "#ff8a3d", "#ff5069"];
const BACKDROP = ["#241a52", "#0a0818"];

const MOBILE = "photos-mobile/assets/icon";

// `scale` sizes the star: star units to output pixels. The farthest tip sits
// about 33 units from the pivot, so 9.21 puts it 304px from centre on the
// adaptive foreground, inside Android's 313px safe zone.
const ICONS = [
  { file: "photos/src/icon.svg", size: 64, scale: 0.94, label: "Photos" },
  { file: `${MOBILE}/icon.svg`, size: 1024, scale: 13.82, backdrop: true, shine: true, png: true },
  { file: `${MOBILE}/splash-icon.svg`, size: 1024, scale: 12.82, shine: true, png: true },
  { file: `${MOBILE}/adaptive-foreground.svg`, size: 1024, scale: 9.21, shine: true, png: true },
  { file: `${MOBILE}/adaptive-monochrome.svg`, size: 1024, scale: 9.21, monochrome: true, png: true },
  { file: `${MOBILE}/adaptive-background.svg`, size: 1024, backdrop: true, star: false, png: true },
];

function stops(colors, indent) {
  return colors
    .map((color, i) => `${indent}<stop offset="${i / (colors.length - 1)}" stop-color="${color}"/>`)
    .join("\n");
}

function place(icon) {
  const half = icon.size / 2;
  return `translate(${half} ${half}) rotate(${TURN}) scale(${icon.scale}) translate(${PIVOT})`;
}

// The pentagon's stroke is centred on the star's inner corners, so half of it
// falls outside the star. The clip keeps it flush with the star's edge.
const outline = `<path d="${PENTAGON}" fill="none" stroke="#000" stroke-width="1.4" stroke-linejoin="round" clip-path="url(#star)"/>`;

function svg(icon) {
  const { size } = icon;
  const open = icon.label
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${icon.label}">`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;
  const defs = [];
  const body = [];

  if (icon.backdrop) {
    defs.push(`    <radialGradient id="backdrop" cx="0.5" cy="0.45" r="0.75">\n${stops(BACKDROP, "      ")}\n    </radialGradient>`);
    body.push(`  <rect width="${size}" height="${size}" fill="url(#backdrop)"/>`);
  }

  if (icon.monochrome) {
    // Android tints the monochrome layer itself, so the star is a white mask
    // with the outline cut out of it.
    defs.push(`    <clipPath id="star"><path d="${STAR}"/></clipPath>`);
    defs.push(
      `    <mask id="mask" maskUnits="userSpaceOnUse" x="0" y="0" width="${size}" height="${size}">\n` +
        `      <g transform="${place(icon)}">\n` +
        `        <path d="${STAR}" fill="#fff"/>\n` +
        `        ${outline}\n` +
        `      </g>\n` +
        `    </mask>`,
    );
    body.push(`  <rect width="${size}" height="${size}" fill="#fff" mask="url(#mask)"/>`);
  } else if (icon.star !== false) {
    defs.push(`    <linearGradient id="fill" x1="0" y1="0" x2="1" y2="1">\n${stops(GOLDEN, "      ")}\n    </linearGradient>`);
    defs.push(`    <clipPath id="star"><path d="${STAR}"/></clipPath>`);
    const star = [];
    if (icon.shine) {
      defs.push(
        `    <linearGradient id="sheen" x1="0" y1="0" x2="0.6" y2="0.6">\n` +
          `      <stop offset="0" stop-color="#fff" stop-opacity="0.45"/>\n` +
          `      <stop offset="1" stop-color="#fff" stop-opacity="0"/>\n` +
          `    </linearGradient>`,
      );
      defs.push(`    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.5"/></filter>`);
      star.push(`    <path d="${STAR}" fill="url(#fill)" opacity="0.55" filter="url(#glow)"/>`);
    }
    star.push(`    <path d="${STAR}" fill="url(#fill)"/>`);
    if (icon.shine) star.push(`    <rect width="64" height="64" fill="url(#sheen)" clip-path="url(#star)"/>`);
    star.push(`    ${outline}`);
    body.push(`  <g transform="${place(icon)}">\n${star.join("\n")}\n  </g>`);
  }

  return [open, "  <defs>", ...defs, "  </defs>", ...body, "</svg>", ""].join("\n");
}

const pngPath = (icon) => icon.file.replace(/\.svg$/, ".png");
const render = (source) => sharp(Buffer.from(source)).png().toBuffer();

// The largest per-channel difference the check accepts between a committed
// PNG and a fresh render.
const PNG_TOLERANCE = 8;

async function pngDiffers(committedPath, source) {
  let committed;
  try {
    committed = await sharp(resolve(root, committedPath)).raw().toBuffer({ resolveWithObject: true });
  } catch {
    return "missing";
  }
  const fresh = await sharp(Buffer.from(source)).raw().toBuffer({ resolveWithObject: true });
  const a = committed.info;
  const b = fresh.info;
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    return `${a.width}x${a.height}x${a.channels}, expected ${b.width}x${b.height}x${b.channels}`;
  }
  let worst = 0;
  for (let i = 0; i < committed.data.length; i++) {
    worst = Math.max(worst, Math.abs(committed.data[i] - fresh.data[i]));
  }
  return worst > PNG_TOLERANCE ? `a channel differs by ${worst}` : null;
}

const check = process.argv.includes("--check");
const problems = [];

for (const icon of ICONS) {
  const source = svg(icon);
  if (check) {
    let committed = null;
    try {
      committed = readFileSync(resolve(root, icon.file), "utf8");
    } catch {}
    if (committed !== source) problems.push(`${icon.file}: differs from the generated SVG`);
    if (icon.png) {
      const reason = await pngDiffers(pngPath(icon), source);
      if (reason) problems.push(`${pngPath(icon)}: ${reason}`);
    }
  } else {
    writeFileSync(resolve(root, icon.file), source);
    if (icon.png) writeFileSync(resolve(root, pngPath(icon)), await render(source));
    console.log(`wrote ${icon.file}${icon.png ? " and its PNG" : ""}`);
  }
}

if (problems.length > 0) {
  console.error("Icons differ from scripts/icons.mjs:");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("\nEdit the star in scripts/icons.mjs, run `pnpm icons`, and commit what it writes.");
  process.exit(1);
}
if (check) console.log(`check-icons: ${ICONS.length} icons match scripts/icons.mjs.`);
