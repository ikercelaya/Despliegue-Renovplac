// Zonas de servicio de Renoveplac (instrucciones del 22-10-2026).
// - Reformas y obra: Lliria y todo el Camp de Turia.
// - Electricidad: ademas, Paterna (incluida La Canada) y Burjassot.
// - No trabajamos en: Riba-roja de Turia, Serra, Gatova, Naquera, Bugarra ni Pedralba.

const EXCLUDED_TOWNS = [
  ["Riba-roja de Túria", /\briba[\s-]*r+oja\b|\bribarroja\b/],
  // "Serra" tambien es apellido: solo cuenta como pueblo con contexto de lugar o como respuesta suelta.
  ["Serra", /\b(?:en|de|a|por|zona|pueblo|municipio)\s+serra\b|^\s*serra\s*[.!?]*\s*$/],
  ["Gátova", /\bgatova\b/],
  ["Náquera", /\bnaquera\b/],
  ["Bugarra", /\bbugarra\b/],
  ["Pedralba", /\bpedralba\b/],
];

const EXCLUDED_POSTAL_CODES = new Map([
  ["46190", "Riba-roja de Túria"],
  ["46118", "Serra"],
  ["46119", "Náquera"],
  ["46165", "Bugarra"],
  ["46164", "Pedralba"],
]);

const OUT_OF_AREA_REPLY = "Por ahora no damos servicio en esa zona. ¡Gracias por pensar en nosotros!";

// Pueblos donde solo damos servicio de electricidad (no reformas ni obra).
const ELECTRIC_ONLY_TOWNS = [
  ["Paterna", /\bpaterna\b|\bla canada\b/],
  ["Burjassot", /\bburjass?ot\b/],
];

function normalizeZoneText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function findExcludedTown(text) {
  const normalized = normalizeZoneText(text);
  if (!normalized.trim()) return null;
  for (const [label, pattern] of EXCLUDED_TOWNS) {
    if (pattern.test(normalized)) return label;
  }
  const postalCodes = normalized.match(/\b46\d{3}\b/g) || [];
  for (const cp of postalCodes) {
    if (EXCLUDED_POSTAL_CODES.has(cp)) return EXCLUDED_POSTAL_CODES.get(cp);
  }
  return null;
}

function findElectricOnlyTown(text) {
  const normalized = normalizeZoneText(text);
  if (!normalized.trim()) return null;
  const match = ELECTRIC_ONLY_TOWNS.find(([, pattern]) => pattern.test(normalized));
  return match ? match[0] : null;
}

module.exports = { OUT_OF_AREA_REPLY, findElectricOnlyTown, findExcludedTown };
