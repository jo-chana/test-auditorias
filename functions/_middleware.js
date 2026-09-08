
// Middleware global (modo dual Access + cookie).
import { verifyToken, readSessionCookie, getSecret } from "./_session.js";

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // Bloquear acceso directo a los datos crudos (siempre)
  if (path.startsWith("/data/") || path.startsWith("/data-greystar/")) {
    return new Response("No autorizado", { status: 403 });
  }

  // Si viene la cabecera de Cloudflare Access, la identidad ya está validada
  // en el borde -> dejar pasar. (Access corta las no autenticadas antes de llegar.)
  if (request.headers.get("Cf-Access-Authenticated-User-Email")) {
    return next();
  }

  // --- Sin Access (sandbox): login por cookie de siempre ---
  const publicPaths = ["/login.html", "/api/login", "/api/logout", "/favicon.ico"];
  if (publicPaths.includes(path)) return next();
  if (path === "/api/data") return next();

  const protectedPaths = ["/", "/index.html"];
  if (protectedPaths.includes(path)) {
    const session = await verifyToken(readSessionCookie(request), getSecret(env));
    if (!session) return Response.redirect(url.origin + "/login.html", 302);
  }
  return next();
}
