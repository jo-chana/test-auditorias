// POST /api/deshacer  { portafolio, slug }
// Deshace la última carga de un edificio: restaura el respaldo previo
// (o lo elimina si esa carga fue la primera del edificio). Recalcula promedios.
import { resolveIdentity } from "../_roles.js";

export async function onRequestPost({ request, env }) {
  const session = await resolveIdentity(request, env);
  if (!session || !(session.scope === "ALL" || session.puede_cargar)) return json({ ok:false, error:"No autorizado" }, 401);
  if (!env.AUDIT_KV) return json({ ok:false, error:"Falta el binding AUDIT_KV" }, 500);
  const KV = env.AUDIT_KV;

  let body;
  try { body = await request.json(); } catch(e){ return json({ ok:false, error:"JSON inválido" }, 400); }
  const { slug } = body || {};
  const portafolio = (body && body.portafolio === "greystar") ? "greystar" : "lar";
  if (!slug) return json({ ok:false, error:"Falta slug" }, 400);
  if (portafolio === "greystar" && !session.greystar) return json({ ok:false, error:"No autorizado para Greystar" }, 403);

  const pref = portafolio === "greystar" ? "greystar/" : "";
  const fileKey = pref + `${slug}.json`;
  const bakKey  = pref + `${slug}.bak.json`;
  const manifestKey = pref + "manifest.json";

  const bak = await KV.get(bakKey, { type:"json" });
  if (!bak) return json({ ok:false, error:"No hay una carga previa para deshacer de este edificio." }, 404);

  let manifest = await KV.get(manifestKey, { type:"json" }) || { buildings: [], order: [] };
  let accion;

  if (bak.__nuevo__) {
    await KV.delete(fileKey);
    const b = manifest.buildings.find(x => x.slug === slug || x.file === `${slug}.json`);
    manifest.buildings = manifest.buildings.filter(x => !(x.slug === slug || x.file === `${slug}.json`));
    if (b) manifest.order = manifest.order.filter(n => n !== b.name);
    accion = "eliminado";
  } else {
    await KV.put(fileKey, JSON.stringify(bak));
    const fecha = bak.resumen && bak.resumen.fecha ? bak.resumen.fecha : null;
    const idx = manifest.buildings.findIndex(x => x.slug === slug || x.file === `${slug}.json`);
    if (idx >= 0) manifest.buildings[idx].fecha = fecha;
    accion = "restaurado";
  }
  await KV.put(manifestKey, JSON.stringify(manifest));
  await KV.delete(bakKey);

  const all = {};
  for (const b of manifest.buildings) { const d = await KV.get(pref + b.file, { type:"json" }); if (d) all[b.name] = d; }
  const names = Object.keys(all);
  const apct = (d,n) => { const a = d.resumen.aristas.find(x => x.nombre === n); return a ? a.pct : null; };
  const r4 = x => Math.round(x*10000)/10000;
  for (const s of names) {
    const d = all[s];
    for (const a of d.resumen.aristas) {
      const vals = names.filter(o => o!==s).map(o => apct(all[o], a.nombre)).filter(v => v!=null);
      a.avg_otros = vals.length ? r4(vals.reduce((x,y)=>x+y,0)/vals.length) : null;
    }
    const tot = names.filter(o => o!==s).map(o => all[o].resumen.total.pct);
    d.resumen.total.avg_otros = tot.length ? r4(tot.reduce((x,y)=>x+y,0)/tot.length) : null;
  }
  for (const b of manifest.buildings) { if (all[b.name]) await KV.put(pref + b.file, JSON.stringify(all[b.name])); }

  return json({ ok:true, accion, slug, portafolio });
}
function json(o,s=200){ return new Response(JSON.stringify(o), { status:s, headers:{ "Content-Type":"application/json" } }); }
