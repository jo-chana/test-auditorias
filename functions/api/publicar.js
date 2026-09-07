// POST /api/publicar  { slug, edificio }  -> guarda un edificio en el KV y actualiza el manifest.
// Solo comité (ALL) o el auditor. El cuerpo trae el JSON completo del edificio ya validado.
import { verifyToken, readSessionCookie, getSecret } from "../_session.js";

export async function onRequestPost({ request, env }) {
  const session = await verifyToken(readSessionCookie(request), getSecret(env));
  if (!session || !(session.scope === "ALL" || session.auditor)) return json({ ok:false, error:"No autorizado" }, 401);
  if (!env.AUDIT_KV) return json({ ok:false, error:"Falta el binding AUDIT_KV" }, 500);

  let body;
  try { body = await request.json(); } catch(e){ return json({ ok:false, error:"JSON inválido" }, 400); }
  const { slug, edificio, data } = body || {};
  if (!slug || !edificio || !data) return json({ ok:false, error:"Faltan slug, edificio o data" }, 400);

  const file = `${slug}.json`;
  // guardar el edificio
  await env.AUDIT_KV.put(file, JSON.stringify(data));

  // actualizar el manifest (fecha del edificio); si no estaba, agregarlo
  let manifest = await env.AUDIT_KV.get("manifest.json", { type:"json" });
  if (!manifest) manifest = { buildings: [], order: [] };
  const fecha = data.resumen && data.resumen.fecha ? data.resumen.fecha : null;
  const idx = manifest.buildings.findIndex(b => b.slug === slug || b.file === file);
  const entry = { name: edificio, slug, file, fecha, auditor: "Emilio Merino S." };
  if (idx >= 0) manifest.buildings[idx] = entry;
  else { manifest.buildings.push(entry); if (!manifest.order.includes(edificio)) manifest.order.push(edificio); }
  await env.AUDIT_KV.put("manifest.json", JSON.stringify(manifest));

  return json({ ok:true, guardado: file, fecha });
}
function json(o,s=200){ return new Response(JSON.stringify(o), { status:s, headers:{ "Content-Type":"application/json" } }); }
