// POST /api/publicar  { slug, edificio, data }
// Guarda el edificio en el KV, actualiza el manifest y recalcula avg_otros de los 12.
import { verifyToken, readSessionCookie, getSecret } from "../_session.js";

export async function onRequestPost({ request, env }) {
  const session = await verifyToken(readSessionCookie(request), getSecret(env));
  if (!session || !(session.scope === "ALL" || session.puede_cargar)) return json({ ok:false, error:"No autorizado" }, 401);
  if (!env.AUDIT_KV) return json({ ok:false, error:"Falta el binding AUDIT_KV" }, 500);
  const KV = env.AUDIT_KV;

  let body;
  try { body = await request.json(); } catch(e){ return json({ ok:false, error:"JSON inválido" }, 400); }
  const { slug, edificio, data } = body || {};
  if (!slug || !edificio || !data) return json({ ok:false, error:"Faltan slug, edificio o data" }, 400);

  const file = `${slug}.json`;
  // 1) guardar el edificio nuevo
  await KV.put(file, JSON.stringify(data));

  // 2) actualizar el manifest
  let manifest = await KV.get("manifest.json", { type:"json" });
  if (!manifest) manifest = { buildings: [], order: [] };
  const fecha = data.resumen && data.resumen.fecha ? data.resumen.fecha : null;
  const idx = manifest.buildings.findIndex(b => b.slug === slug || b.file === file);
  const entry = { name: edificio, slug, file, fecha, auditor: "Emilio Merino S." };
  if (idx >= 0) manifest.buildings[idx] = entry;
  else { manifest.buildings.push(entry); if (!manifest.order.includes(edificio)) manifest.order.push(edificio); }
  await KV.put("manifest.json", JSON.stringify(manifest));

  // 3) recalcular avg_otros de TODOS los edificios (leer todos, recomputar, reescribir)
  const all = {};
  for (const b of manifest.buildings) {
    const d = await KV.get(b.file, { type:"json" });
    if (d) all[b.name] = d;
  }
  const names = Object.keys(all);
  const apct = (d,n) => { const a = d.resumen.aristas.find(x => x.nombre === n); return a ? a.pct : null; };
  const round4 = x => Math.round(x*10000)/10000;
  for (const s of names) {
    const d = all[s];
    for (const a of d.resumen.aristas) {
      const vals = names.filter(o => o!==s).map(o => apct(all[o], a.nombre)).filter(v => v!=null);
      a.avg_otros = vals.length ? round4(vals.reduce((x,y)=>x+y,0)/vals.length) : null;
    }
    const tot = names.filter(o => o!==s).map(o => all[o].resumen.total.pct);
    d.resumen.total.avg_otros = tot.length ? round4(tot.reduce((x,y)=>x+y,0)/tot.length) : null;
  }
  // reescribir todos
  for (const b of manifest.buildings) {
    if (all[b.name]) await KV.put(b.file, JSON.stringify(all[b.name]));
  }

  return json({ ok:true, guardado: file, fecha, recalculados: names.length });
}
function json(o,s=200){ return new Response(JSON.stringify(o), { status:s, headers:{ "Content-Type":"application/json" } }); }
