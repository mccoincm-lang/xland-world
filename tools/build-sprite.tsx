// Builds src/sprite.svg: one <symbol> per hand-drawn emblem and ornament, rendered from the
// approved React sources in the xland-territory-atlas repo. The page uses them with <use href="#…">.
// Run: tools/build-sprite.sh (bundles this file with esbuild and runs it with node).
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import { TerritoryEmblem, EMBLEM_IDS } from "../../xland-territory-atlas/src/components/emblems/TerritoryEmblem";
import {
  WaxSeal,
  CompassRose,
  FrameCorners,
  OrnamentDivider,
  Guilloche,
  IconWorld,
  IconWallet,
  IconJournal,
  IconChronicle,
  IconPassport,
} from "../../xland-territory-atlas/src/components/ornaments/Ornaments";

const out: string[] = [];

/** Take the first <svg …>…</svg> in markup and turn it into a <symbol>, giving its internal ids a unique prefix. */
function symbol(id: string, markup: string, extra = "") {
  const m = markup.match(/<svg([^>]*)>([\s\S]*?)<\/svg>/);
  if (!m) throw new Error("no svg for " + id);
  const attrs = m[1];
  let body = m[2];
  const viewBox = (attrs.match(/viewBox="([^"]+)"/) || [])[1];
  const par = (attrs.match(/preserveAspectRatio="([^"]+)"/) || [])[1];
  // Rename useId-based ids (e.g. "r0-brass") to stable, symbol-specific ones.
  const ids = new Set([...body.matchAll(/id="([^"]+?)-(?:brass|rim|field|glow|clip|wax|b)"/g)].map((x) => x[1]));
  for (const uid of ids) body = body.split(`"${uid}-`).join(`"${id}-`).split(`#${uid}-`).join(`#${id}-`);
  // Keep presentational attributes that live on the root <svg> (icons draw with stroke=currentColor).
  const keep = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"]
    .map((k) => (attrs.match(new RegExp(`\\s${k}="([^"]+)"`)) || [])[0] || "")
    .join("");
  const wrap = keep ? `<g${keep}>${body}</g>` : body;
  out.push(`<symbol id="${id}" viewBox="${viewBox}"${par ? ` preserveAspectRatio="${par}"` : ""}${extra}>${wrap}</symbol>`);
}

for (const id of EMBLEM_IDS) symbol(`xe-${id}`, renderToStaticMarkup(<TerritoryEmblem id={id} size={140} />));
for (const s of ["open", "restricted", "locked", "mythic"] as const) symbol(`xs-${s}`, renderToStaticMarkup(<WaxSeal status={s} label={false} />));
symbol("xo-compass", renderToStaticMarkup(<CompassRose />));
symbol("xo-corner", renderToStaticMarkup(<FrameCorners />));
symbol("xo-divider", renderToStaticMarkup(<OrnamentDivider />));
symbol("xo-guilloche", renderToStaticMarkup(<Guilloche />));
const icons = { world: IconWorld, wallet: IconWallet, journal: IconJournal, chronicle: IconChronicle, passport: IconPassport };
for (const [k, I] of Object.entries(icons)) symbol(`xi-${k}`, renderToStaticMarkup(<I />));

const sprite =
  `<svg id="xl-sprite" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">` +
  out.join("") +
  `</svg>`;
writeFileSync(process.argv[2], sprite);
console.log("sprite symbols:", out.length, "bytes:", sprite.length);
