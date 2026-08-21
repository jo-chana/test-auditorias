// Middleware global: corre antes de servir cualquier ruta.
// - Deja pasar libremente: /login.html, /api/login, /api/logout y assets del login.
// - Bloquea el acceso directo a /data/*  (los JSON solo se sirven vía /api/data).
// - Para el dashboard (/ , /index.html): exige sesión válida; si no, redirige a /login.html
import { verifyToken, readSessionCookie, getSecret } from "./_session.js";

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // Rutas públicas (login y sus endpoints)
  const publicPaths = ["/login.html", "/api/login", "/api/logout", "/favicon.ico"];
  if (publicPaths.includes(path)) {
    return next();
  }

  // /api/data se valida solo (tiene su propia comprobación de sesión)
  if (path === "/api/data") {
    return next();
  }

  // Bloquear acceso directo a los datos crudos
  if (path.startsWith("/data/") || path.startsWith("/data-greystar/")) {
    return new Response("No autorizado", { status: 403 });
  }

  // Proteger el dashboard
  const protectedPaths = ["/", "/index.html"];
  if (protectedPaths.includes(path)) {
    const token = readSessionCookie(request);
    const session = await verifyToken(token, getSecret(env));
    if (!session) {
      return Response.redirect(url.origin + "/login.html", 302);
    }
  }

  return next();
}
