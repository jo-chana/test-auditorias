// GET /api/sso?token=<jwt>
// Punto de entrada desde el HUB. Verifica el JWT firmado por el portal
// (HS256, vida corta) contra AUDITORIAS_SECRET, y con eso crea la sesión
// propia del dashboard (cookie lar_session). Si el token es inválido/vencido,
// devuelve al HUB.
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

async function verificarToken(token, secreto) {
  if (!token || typeof token !== "string") return null;
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  const [encHeader, encBody, encFirma] = partes;

  let header;
  try { header = JSON.parse(new TextDecoder().decode(base64urlToBytes(encHeader))); }
  catch (e) { return null; }
  // Rechazar si el algoritmo no es exactamente HS256 (no confiar en el header sin validar)
  if (header.alg !== "HS256") return null;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  let firmaOk;
  try {
    firmaOk = await crypto.subtle.verify(
      "HMAC", key, base64urlToBytes(encFirma), enc.encode(`${encHeader}.${encBody}`)
    );
  } catch (e) { return null; }
  if (!firmaOk) return null;

  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(encBody))); }
  catch (e) { return null; }
  const ahora = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < ahora) return null;

  return payload; // { email, scope, greystar, puede_cargar, exp }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return Response.redirect(FALLBACK, 302);
  if (!env.AUDITORIAS_SECRET) return Response.redirect(FALLBACK, 302);

  const payload = await verificarToken(token, env.AUDITORIAS_SECRET);
  if (!payload || !payload.email || !payload.scope) return Response.redirect(FALLBACK, 302);

  // Crear la sesión propia del dashboard (12h) con los datos ya verificados.
  const sessionToken = await createToken({
    user: payload.email,
    scope: payload.scope,
    greystar: !!payload.greystar,
    puede_cargar: !!payload.puede_cargar,
  }, getSecret(env));

  return new Response(null, {
    status: 302,
    headers: {
      "Location": "/",
      "Set-Cookie": `lar_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${12 * 3600}`,
    },
  });
}
