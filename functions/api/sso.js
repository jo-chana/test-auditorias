// GET /api/sso?token=<jwt>
// Entrada desde el portal HUB: verifica el JWT (HS256) firmado con AUDITORIAS_SECRET
// y crea la sesión. El rol (scope, greystar, puede_cargar) viene en el token.
// Si algo falla, devuelve al portal; el motivo queda en los logs de Cloudflare
// (Pages → Functions → Logs), nunca en pantalla.
import { createToken } from "../_session.js";

const FALLBACK = "https://portal-hub-lar.djeldres.workers.dev/";

function base64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function fallar(motivo) {
  console.log("SSO rechazado: " + motivo);
  return new Response(null, { status: 302, headers: { "Location": FALLBACK, "Cache-Control": "no-store" } });
}

export async function onRequestGet({ request, env }) {
  if (!env.AUDITORIAS_SECRET || !env.SESSION_SECRET) {
    console.log("SSO: falta AUDITORIAS_SECRET o SESSION_SECRET en el entorno");
    return new Response("Servicio no disponible", { status: 503 });
  }
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return fallar("sin token");

  const partes = token.split(".");
  if (partes.length !== 3) return fallar("formato no JWT");
  const [encHeader, encBody, encFirma] = partes;

  const enc = new TextEncoder(), dec = new TextDecoder();
  let header, payload;
  try {
    header = JSON.parse(dec.decode(base64urlToBytes(encHeader)));
  } catch (e) { return fallar("header ilegible"); }
  if (header.alg !== "HS256") return fallar("alg no HS256");

  let firmaOk = false;
  try {
    const key = await crypto.subtle.importKey("raw", enc.encode(env.AUDITORIAS_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    firmaOk = await crypto.subtle.verify("HMAC", key, base64urlToBytes(encFirma), enc.encode(`${encHeader}.${encBody}`));
  } catch (e) { return fallar("error verificando firma"); }
  if (!firmaOk) return fallar("firma inválida");

  try {
    payload = JSON.parse(dec.decode(base64urlToBytes(encBody)));
  } catch (e) { return fallar("payload ilegible"); }

  const ahora = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < ahora) return fallar("token vencido o sin exp");
  if (typeof payload.iat === "number" && payload.iat > ahora + 60) return fallar("iat en el futuro");
  if (typeof payload.email !== "string" || !payload.email) return fallar("sin email");
  if (typeof payload.scope !== "string" || !payload.scope) return fallar("sin scope (" + payload.email + ")");

  const sessionToken = await createToken({
    user: payload.email.trim().toLowerCase(),
    scope: payload.scope,
    greystar: !!payload.greystar,
    puede_cargar: !!payload.puede_cargar,
  }, env.SESSION_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      "Location": "/",
      "Cache-Control": "no-store",
      "Set-Cookie": `lar_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${12 * 3600}`,
    },
  });
}
