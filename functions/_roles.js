// Resolución de identidad + rol, en MODO DUAL:
//  1) Producción (detrás de Cloudflare Access): lee el correo verificado de la
//     cabecera 'Cf-Access-Authenticated-User-Email' y busca su rol en ROLES_JSON.
//  2) Sandbox / transición (sin Access): cae al login por cookie de siempre.
import { verifyToken, readSessionCookie, getSecret } from "./_session.js";

// ROLES_JSON: variable de entorno { "correo": { scope, greystar, puede_cargar } }
export function getRoles(env) {
  if (env && env.ROLES_JSON) {
    try { return JSON.parse(env.ROLES_JSON); } catch (e) {}
  }
  return {};
}

export async function resolveIdentity(request, env) {
  // --- Modo Access: Cloudflare ya autenticó, viene el correo en la cabecera ---
  const email = (request.headers.get("Cf-Access-Authenticated-User-Email") || "").trim().toLowerCase();
  if (email) {
    const r = getRoles(env)[email];
    if (!r) return null; // logueado en Access pero sin rol de auditorías asignado
    return {
      user: email,
      scope: r.scope,
      greystar: !!r.greystar,
      puede_cargar: !!r.puede_cargar,
      via: "access",
    };
  }
  // --- Modo cookie (sandbox): sesión propia ---
  const s = await verifyToken(readSessionCookie(request), getSecret(env));
  if (!s) return null;
  return {
    user: s.user,
    scope: s.scope,
    greystar: !!s.greystar,
    puede_cargar: !!s.puede_cargar,
    via: "cookie",
  };
}
