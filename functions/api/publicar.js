// POST /api/publicar  { portafolio, slug, edificio, data }
//   portafolio = "lar" (default) | "greystar"
// Guarda el edificio en el KV (en el portafolio correcto), actualiza su manifest
// y recalcula avg_otros entre los edificios de ESE portafolio.
import { resolveIdentity } from "../_roles.js";

export async function onRequestPost({ request, env }) {
  const session = await resolveIdentity(request, env);
  if (!session || !(session.scope === "ALL" || session.puede_cargar)) return json({ ok:false, error:"No autorizado" }, 401);
  if (!env.AUDIT_KV) return json({ ok:false, error:"Falta el binding AUDIT_KV" }, 500);
  const KV = env.AUDIT_KV;

  let body;
  try { body = await request.json(); } catch(e){ return json({ ok:false, error:"JSON inválido" }, 400); }
  const { slug, edificio, data } = body || {};
  const portafolio = (body && body.portafolio === "greystar") ? "greystar" : "lar";
  if (!slug || !edificio || !data) return json({ ok:false, error:"Faltan slug, edificio o data" }, 400);

  // Greystar: solo comité Greystar puede publicar ahí
  if (portafolio === "greystar" && !session.greystar) return json({ ok:false, error:"No autorizado para Greystar" }, 403);

  // Prefijo de claves KV según portafolio
  const pref = portafolio === "greystar" ? "greystar/" : "";
  const manifestKey = pref + "manifest.json";
  const fileKey = pref + `${slug}.json`;

  if (!data.resumen || !Array.isArray(data.resumen.aristas) || !data.resumen.total || typeof data.resumen.total.pct !== "number")
    return json({ ok:false, error:"El JSON a publicar no tiene resumen/aristas/total válidos" }, 400);

  let manifest = await KV.get(manifestKey, { type:"json" });
  if (!manifest) manifest = { buildings: [], order: [] };
  if (!Array.isArray(manifest.order)) manifest.order = manifest.buildings.map(b => b.name);
  const idx = manifest.buildings.findIndex(b => b.slug === slug || b.file === `${slug}.json`);

  // 1) respaldo: si el edificio ya existe, el respaldo es su data actual
  //    (KV o, si nunca se cargó al KV, el archivo estático de /data).
  //    Solo se marca __nuevo__ si de verdad no existía en ninguna parte.
  let prev = await KV.get(fileKey, { type: "json" });
  if (!prev) {
    const staticPath = portafolio === "greystar" ? `/data-greystar/${slug}.json` : `/data/${slug}.json`;
    const r = await env.ASSETS.fetch(new Request(new URL(staticPath, request.url)));
    if (r.ok) { try { prev = await r.json(); } catch (e) { prev = null; } }
  }
  if (!prev && idx >= 0) return json({ ok:false, error:`${manifest.buildings[idx].name} figura en el manifest pero no encontré su data actual; no publico para no perder el respaldo.` }, 409);
  await KV.put(pref + `${slug}.bak.json`, JSON.stringify(prev || { __nuevo__: true }));
  await KV.put(fileKey, JSON.stringify(data));

  // 2) actualizar el manifest de ese portafolio. Si el edificio ya existe se
  //    conserva su nombre: el order usa nombres, y cambiarlo dejaría el order
  //    apuntando a un edificio que ya no está (el dashboard se cae).
  const fecha = data.resumen.fecha || null;
  const nombre = idx >= 0 ? manifest.buildings[idx].name : edificio;
  const entry = { name: nombre, slug, file: `${slug}.json`, fecha, auditor: "Emilio Merino S." };
  if (idx >= 0) manifest.buildings[idx] = entry;
  else manifest.buildings.push(entry);
  if (!manifest.order.includes(nombre)) manifest.order.push(nombre);
  await KV.put(manifestKey, JSON.stringify(manifest));

  // avg_otros ya no se reescribe acá: lo calcula /api/data al leer. Releer y
  // reescribir todos los edificios justo después del put leía copias viejas
  // del KV (propagación de hasta ~60 s) y pisaba la carga recién publicada.
  return json({ ok:true, portafolio, guardado: fileKey, fecha });
}
function json(o,s=200){ return new Response(JSON.stringify(o), { status:s, headers:{ "Content-Type":"application/json" } }); }
