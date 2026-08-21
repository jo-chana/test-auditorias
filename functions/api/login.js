// POST /api/login   { user, pass }  -> set cookie + { ok, scope }
import { getUsers } from "../_users.js";
import { createToken, getSecret } from "../_session.js";

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "Solicitud inválida" }, 400);
  }
  const { user, pass } = body || {};
  if (!user || !pass) {
    return json({ ok: false, error: "Faltan credenciales" }, 400);
  }

  const users = getUsers(env);
  // Comparación simple. (Mejora futura: hashear las claves.)
  const found = users.find(u => u.user === user && u.pass === pass);

  if (!found) {
    // Mensaje genérico a propósito: no revelamos si el usuario existe.
    return json({ ok: false, error: "Usuario o contraseña incorrectos" }, 401);
  }

  const token = await createToken(
    { user: found.user, scope: found.scope, greystar: !!found.greystar },
    getSecret(env)
  );

  const cookie = [
    `lar_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${60 * 60 * 12}`,
  ].join("; ");

  return new Response(JSON.stringify({ ok: true, scope: found.scope }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
