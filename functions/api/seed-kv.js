// GET /api/seed-kv  -> siembra el KV con los datos del DASHBOARD REAL (producción).
// Copia manifest + logo + los 12 edificios corregidos desde el repo de producción.
// Solo comité (scope ALL). Idempotente: se puede correr de nuevo sin problema.
import { verifyToken, readSessionCookie, getSecret } from "../_session.js";

// Fuente: carpeta /data del repo de producción (datos ya corregidos).
const PROD = "https://raw.githubusercontent.com/jo-chana/Dashboard-Auditoria/main";

export async function onRequestGet({ request, env }) {
  const session = await verifyToken(readSessionCookie(request), getSecret(env));
  if (!session || session.scope !== "ALL") return json({ ok:false, error:"No autorizado" }, 401);
  if (!env.AUDIT_KV) return json({ ok:false, error:"Falta el binding AUDIT_KV" }, 500);

  // --- Modo restaurar UN edificio desde producción (?solo=slug) ---
  const solo = new URL(request.url).searchParams.get("solo");
  if (solo) {
    const r = await fetch(`${PROD}/data/${solo}.json`, { cf: { cacheTtl: 0 } });
    if (!r.ok) return json({ ok:false, error:`No encontré ${solo}.json en producción` }, 404);
    await env.AUDIT_KV.put(`${solo}.json`, await r.text());
    // corregir la fecha en el manifest del KV
    let manifest = await env.AUDIT_KV.get("manifest.json", { type:"json" });
    const prodMres = await fetch(`${PROD}/data/manifest.json`, { cf: { cacheTtl: 0 } });
    const prodM = prodMres.ok ? JSON.parse(await prodMres.text()) : null;
    if (manifest && prodM) {
      const pe = prodM.buildings.find(b => b.file === `${solo}.json`);
      const i = manifest.buildings.findIndex(b => b.file === `${solo}.json`);
      if (pe && i >= 0) { manifest.buildings[i].fecha = pe.fecha; await env.AUDIT_KV.put("manifest.json", JSON.stringify(manifest)); }
    }
    // recalcular avg_otros de todos
    if (manifest) {
      const all = {};
      for (const b of manifest.buildings) { const d = await env.AUDIT_KV.get(b.file, { type:"json" }); if (d) all[b.name] = d; }
      const names = Object.keys(all);
      const apct = (d,n) => { const a = d.resumen.aristas.find(x => x.nombre === n); return a ? a.pct : null; };
      const r4 = x => Math.round(x*10000)/10000;
      for (const s2 of names) {
        const d = all[s2];
        for (const a of d.resumen.aristas) {
          const vals = names.filter(o => o!==s2).map(o => apct(all[o], a.nombre)).filter(v => v!=null);
          a.avg_otros = vals.length ? r4(vals.reduce((x,y)=>x+y,0)/vals.length) : null;
        }
        const tot = names.filter(o => o!==s2).map(o => all[o].resumen.total.pct);
        d.resumen.total.avg_otros = tot.length ? r4(tot.reduce((x,y)=>x+y,0)/tot.length) : null;
      }
      for (const b of manifest.buildings) { if (all[b.name]) await env.AUDIT_KV.put(b.file, JSON.stringify(all[b.name])); }
    }
    return json({ ok:true, restaurado: `${solo}.json`, fuente:"producción" });
  }

  const copiados = [];
  const get = (p) => fetch(`${PROD}${p}`, { cf: { cacheTtl: 0 } });

  // manifest
  const mRes = await get("/data/manifest.json");
  if (!mRes.ok) return json({ ok:false, error:"No pude leer el manifest de producción" }, 502);
  const manifestText = await mRes.text();
  await env.AUDIT_KV.put("manifest.json", manifestText);
  copiados.push("manifest.json");

  // logo
  const lRes = await get("/data/lar_logo.txt");
  if (lRes.ok) { await env.AUDIT_KV.put("lar_logo.txt", await lRes.text()); copiados.push("lar_logo.txt"); }

  // cada edificio
  const manifest = JSON.parse(manifestText);
  for (const b of manifest.buildings) {
    const r = await get(`/data/${b.file}`);
    if (r.ok) { await env.AUDIT_KV.put(b.file, await r.text()); copiados.push(b.file); }
    else copiados.push(`(falló ${b.file})`);
  }

  // greystar (si existe en producción; si no, se ignora)
  const gsRes = await get("/data-greystar/manifest.json");
  if (gsRes.ok) {
    const gsText = await gsRes.text();
    await env.AUDIT_KV.put("greystar/manifest.json", gsText);
    copiados.push("greystar/manifest.json");
    try {
      const gs = JSON.parse(gsText);
      for (const b of (gs.buildings||[])) {
        const r = await get(`/data-greystar/${b.file}`);
        if (r.ok) { await env.AUDIT_KV.put("greystar/"+b.file, await r.text()); copiados.push("greystar/"+b.file); }
      }
    } catch(e){}
  }

  return json({ ok:true, fuente:"producción", copiados, total: copiados.length });
}
function json(o,s=200){ return new Response(JSON.stringify(o,null,2), { status:s, headers:{ "Content-Type":"application/json" } }); }
