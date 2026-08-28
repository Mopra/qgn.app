// Validation for the two palettes Studio persists: saved solid colors and
// saved custom gradients.
//
// These are the only settings a renderer can write in bulk, so they are the
// ones worth validating carefully: anything that reaches disk here comes back
// on every later launch. Both sanitizers return null for "not a list at all"
// so the caller can tell "nothing saved yet" (fall back to defaults) apart
// from "the user saved an empty palette".

const MAX_STUDIO_COLORS = 24;
const MAX_STUDIO_GRADIENTS = 24;

// Seeded until the user curates their own; any of these can be removed.
const DEFAULT_STUDIO_COLORS = ["#6366F1", "#0F172A", "#FFFFFF", "#10B981", "#F43F5E", "#F59E0B"];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
function isHex(c) {
  return typeof c === "string" && HEX_RE.test(c);
}

function normalizeAngle(value) {
  let angle = Number(value);
  if (!Number.isFinite(angle)) angle = 135;
  return ((Math.round(angle) % 360) + 360) % 360;
}

// Validate + de-duplicate "#rrggbb" strings (case-insensitive), capped.
function sanitizeStudioColors(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const clean = [];
  for (const c of list) {
    if (!isHex(c)) continue;
    const upper = c.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    clean.push(upper);
    if (clean.length >= MAX_STUDIO_COLORS) break;
  }
  return clean;
}

// Validate + de-duplicate { angle, c0, c1 } gradients, capped. Angle is
// normalized to 0-359 so two spellings of the same gradient dedupe.
function sanitizeStudioGradients(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const clean = [];
  for (const g of list) {
    if (!g || typeof g !== "object" || !isHex(g.c0) || !isHex(g.c1)) continue;
    const c0 = g.c0.toUpperCase();
    const c1 = g.c1.toUpperCase();
    const angle = normalizeAngle(g.angle);
    const key = `${angle}|${c0}|${c1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ angle, c0, c1 });
    if (clean.length >= MAX_STUDIO_GRADIENTS) break;
  }
  return clean;
}

module.exports = {
  sanitizeStudioColors,
  sanitizeStudioGradients,
  DEFAULT_STUDIO_COLORS,
  MAX_STUDIO_COLORS,
  MAX_STUDIO_GRADIENTS,
};
