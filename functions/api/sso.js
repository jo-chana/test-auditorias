// GET /api/sso?token=<jwt>  — VERSIÓN DIAGNÓSTICO (temporal)
// En caso de fallo, muestra el motivo en texto (no expone el secreto).
import { createToken, getSecret } from "../_session.js";

const FALLBACK = "https://portal-hub-lar.djeldres.workers.dev/";

function base64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function diag(msg){ return new Response("SSO DIAG: "+msg, { status:200, headers:{ "Content-Type":"text/plain; charset=utf-8" } }); }

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return diag("no llegó ningún token en la URL (?token=...). La tarjeta del HUB quizá no apunta a /go/auditorias.");
  if (!env.AUDITORIAS_SECRET) return diag("falta la variable AUDITORIAS_SECRET en Cloudflare.");

  const partes = token.split(".");
  if (partes.length !== 3) return diag("el token no tiene formato JWT (esperaba 3 partes separadas por punto, llegaron "+partes.length+").");
  const [encHeader, encBody, encFirma] = partes;

  let header;
  try { header = JSON.parse(new TextDecoder().decode(base64urlToBytes(encHeader))); }
  catch(e){ return diag("no pude leer el header del token."); }
  if (header.alg !== "HS256") return diag("el algoritmo del token es '"+header.alg+"', no HS256.");

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(env.AUDITORIAS_SECRET), { name:"HMAC", hash:"SHA-256" }, false, ["verify"]);
  let firmaOk=false;
  try { firmaOk = await crypto.subtle.verify("HMAC", key, base64urlToBytes(encFirma), enc.encode(`${encHeader}.${encBody}`)); } catch(e){ return diag("error verificando la firma: "+e.message); }
  if (!firmaOk) return diag("FIRMA INVÁLIDA → el AUDITORIAS_SECRET de Cloudflare NO coincide con el que usa el portal para firmar. (revisa espacios/saltos de línea o pide el valor exacto).");

  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(encBody))); }
  catch(e){ return diag("no pude leer el payload del token."); }
  const ahora = Math.floor(Date.now()/1000);
  if (!payload.exp) return diag("el token no trae 'exp'.");
  if (payload.exp < ahora) return diag("TOKEN VENCIDO: expiró hace "+(ahora-payload.exp)+" s (dura 90 s). Revisa la hora del servidor o reintenta rápido.");
  if (!payload.email || !payload.scope) return diag("el token no trae email o scope. payload: "+JSON.stringify(payload));

  // Todo OK -> crear sesión y entrar
  const sessionToken = await createToken({ user:payload.email, scope:payload.scope, greystar:!!payload.greystar, puede_cargar:!!payload.puede_cargar }, getSecret(env));
  return new Response(null, { status:302, headers:{ "Location":"/", "Set-Cookie":`lar_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${12*3600}` } });
}
