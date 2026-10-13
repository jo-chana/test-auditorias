// GET /api/data  -> devuelve SOLO los datos permitidos según la sesión.
//
//   scope = "ALL"        -> todos los edificios + manifest completo
//   scope = "<Edificio>" -> solo ese edificio (con su avg_otros para el
//                           comparativo contra el promedio del portafolio).
//                           Si el edificio no tiene auditoría cargada,
//                           se devuelve un marcador { pending: true }.
//
// Importante: los JSON de los OTROS edificios nunca se envían al navegador
// cuando el scope es un edificio puntual. El filtrado ocurre en el servidor.

import { ALL_BUILDINGS_LIST } from "../_users.js";
import { resolveIdentity } from "../_roles.js";

export async function onRequestGet({ request, env, ASSETS }) {
  const session = await resolveIdentity(request, env);
  if (!session) {
    return json({ ok: false, error: "No autorizado" }, 401);
  }

  // helper para leer un archivo estático del propio sitio (carpeta /data)
  // Usamos env.ASSETS.fetch (binding de Pages) que lee el archivo directamente
  // SIN pasar por el _middleware (que bloquea /data/ para accesos externos).
  const origin = new URL(request.url).origin;
  const assetFetch = (env && env.ASSETS && env.ASSETS.fetch)
    ? (p) => env.ASSETS.fetch(new Request(`${origin}${p}`))
    : (p) => fetch(`${origin}${p}`);
  // Lectura KV-first: si el dato está en la pizarra (AUDIT_KV) se usa ése;
  // si no, cae automáticamente al archivo estático en /data (red de seguridad).
  const KV = env && env.AUDIT_KV ? env.AUDIT_KV : null;
  async function readData(file) {
    // clave KV: los del portafolio Greystar van con prefijo, el resto por nombre.
    const key = file.startsWith("../data-greystar/")
      ? "greystar/" + file.replace("../data-greystar/", "")
      : file;
    if (KV) {
      const v = await KV.get(key, { type: "json" });
      if (v !== null && v !== undefined) return v;
    }
    const path = file.startsWith("../data-greystar/")
      ? "/data-greystar/" + file.replace("../data-greystar/", "")
      : `/data/${file}`;
    const r = await assetFetch(path);
    if (!r.ok) return null;
    return r.json();
  }
  async function readText(file) {
    if (KV) {
      const v = await KV.get(file);
      if (v !== null && v !== undefined) return v;
    }
    const r = await assetFetch(`/data/${file}`);
    if (!r.ok) return null;
    return r.text();
  }

  const manifest = await readData("manifest.json");
  const larLogo = await readText("lar_logo.txt");
  if (!manifest) return json({ ok: false, error: "Sin manifest" }, 500);

  // Mapa nombre -> archivo, según manifest
  const fileByName = {};
  for (const b of manifest.buildings) fileByName[b.name] = b.file;

  // ---- Comité: ve todo ----
  if (session.scope === "ALL") {
    const entries = await Promise.all(
      manifest.buildings.map(async b => [b.name, await readData(b.file)])
    );
    const buildings = Object.fromEntries(entries.filter(([, v]) => v));
    // El order debe calzar con lo que realmente se entrega: si un nombre del
    // order no tiene data, el front se cae entero. Los que falten se loguean.
    const order = (manifest.order || []).filter(n => buildings[n]);
    for (const n of Object.keys(buildings)) if (!order.includes(n)) order.push(n);
    const faltantes = (manifest.order || []).filter(n => !buildings[n]);
    if (faltantes.length) console.log("data: en order sin data -> " + faltantes.join(", "));
    recalcAvgOtros(buildings);

    const resp = {
      ok: true,
      scope: "ALL",
      order,
      faltantes,
      buildings,
      larLogo,
      puede_cargar: !!session.puede_cargar,
    };

    // ---- Portafolio Greystar: SOLO para usuarios con el flag greystar ----
    // Se entrega en un objeto aparte. Los edificios LAR de arriba NO se tocan:
    // su promedio de portafolio se calcula como siempre, sin Greystar.
    if (session.greystar) {
      const gsManifest = await readData("../data-greystar/manifest.json");
      let gsBuildings = {};
      let gsOrder = [];
      if (gsManifest && Array.isArray(gsManifest.buildings)) {
        const gsEntries = await Promise.all(
          gsManifest.buildings.map(async b => [b.name, await readData("../data-greystar/" + b.file)])
        );
        gsBuildings = Object.fromEntries(gsEntries.filter(([, v]) => v));
        gsOrder = (gsManifest.order || gsManifest.buildings.map(b => b.name)).filter(n => gsBuildings[n]);
        for (const n of Object.keys(gsBuildings)) if (!gsOrder.includes(n)) gsOrder.push(n);
        recalcAvgOtros(gsBuildings);
      }

      // Promedio LAR Group (referencia): se calcula con los 12 edificios LAR
      // ya cargados. Es solo un benchmark para la vista Greystar; no altera
      // ningún número de los edificios LAR.
      const larList = Object.values(buildings);
      const COMPARABLE = ['Departamentos Vacantes','Pasillos Departamentos','Áreas Comunes Amenities','Áreas de Servicio','Personal'];
      function avg(arr){ const v=arr.filter(x=>x!=null); return v.length? v.reduce((a,c)=>a+c,0)/v.length : null; }
      const aristaNames = new Set();
      larList.forEach(b => b.resumen.aristas.forEach(a => aristaNames.add(a.nombre)));
      const larAristas = {};
      aristaNames.forEach(nom => {
        larAristas[nom] = avg(larList.map(b => {
          const a = b.resumen.aristas.find(x => x.nombre === nom);
          return a ? a.pct : null;
        }));
      });
      const larTotalCon = avg(larList.map(b => b.resumen.total.pct));
      const larTotalSin = avg(larList.map(b => avg(COMPARABLE.map(d => {
        const a = b.resumen.aristas.find(x => x.nombre === d);
        return a ? a.pct : null;
      }))));

      resp.greystar = {
        enabled: true,
        order: gsOrder,
        buildings: gsBuildings,
        larAvg: { aristas: larAristas, totalCon: larTotalCon, totalSin: larTotalSin, nLar: larList.length },
      };
    }

    return json(resp);
  }

  // ---- BM / BMA: ve solo su edificio ----
  const name = session.scope;

  // ¿El edificio existe en la lista oficial de 12?
  const known = ALL_BUILDINGS_LIST.includes(name);

  // ¿Tiene auditoría cargada?
  const file = fileByName[name];
  if (!file) {
    // Edificio válido pero sin data todavía -> aviso amable
    return json({
      ok: true,
      scope: name,
      pending: true,
      buildingName: name,
      known,
      larLogo,
    });
  }

  const data = await readData(file);
  if (!data) {
    return json({ ok: true, scope: name, pending: true, buildingName: name, known, larLogo });
  }

  // Calcular el promedio del PORTAFOLIO COMPLETO (los mismos números que ve el
  // comité), en ambos modos. Cargamos todos los edificios SOLO en el servidor;
  // al BM le mandamos únicamente su edificio + estos dos promedios. Los datos
  // de los otros edificios nunca salen del servidor.
  const COMPARABLE_DIMS = ['Departamentos Vacantes','Pasillos Departamentos','Áreas Comunes Amenities','Áreas de Servicio','Personal'];
  function totalCon(b) { return b.resumen.total.pct; }
  function totalSin(b) {
    const vals = COMPARABLE_DIMS.map(d => {
      const ar = b.resumen.aristas.find(a => a.nombre === d);
      return ar ? ar.pct : null;
    }).filter(v => v != null);
    return vals.length ? vals.reduce((a,c)=>a+c,0)/vals.length : null;
  }
  const allData = await Promise.all(manifest.buildings.map(b => readData(b.file)));
  const valid = allData.filter(Boolean);
  const porNombre = {};
  manifest.buildings.forEach((b, i) => { if (allData[i]) porNombre[b.name] = allData[i]; });
  porNombre[name] = data;
  recalcAvgOtros(porNombre);
  const portAvgCon = valid.reduce((s,b)=>s+totalCon(b),0)/valid.length;
  const sinVals = valid.map(totalSin).filter(v=>v!=null);
  const portAvgSin = sinVals.length ? sinVals.reduce((a,c)=>a+c,0)/sinVals.length : null;

  // Solo este edificio + los dos promedios del portafolio completo.
  return json({
    ok: true,
    scope: name,
    order: [name],
    buildings: { [name]: data },
    portAvgCon,
    portAvgSin,
    larLogo,
  });
}

// avg_otros = promedio de los OTROS edificios del mismo portafolio, por arista
// y total. Se calcula al leer (antes se guardaba en cada JSON al publicar, y esa
// reescritura de todos los edificios podía pisar una carga recién hecha).
function recalcAvgOtros(byName) {
  const names = Object.keys(byName);
  const r4 = x => Math.round(x * 10000) / 10000;
  const apct = (d, n) => { const a = d.resumen.aristas.find(x => x.nombre === n); return a ? a.pct : null; };
  for (const s of names) {
    const d = byName[s];
    if (!d || !d.resumen) continue;
    const otros = names.filter(o => o !== s && byName[o] && byName[o].resumen);
    for (const a of d.resumen.aristas) {
      const vals = otros.map(o => apct(byName[o], a.nombre)).filter(v => v != null);
      a.avg_otros = vals.length ? r4(vals.reduce((x, y) => x + y, 0) / vals.length) : null;
    }
    const tot = otros.map(o => byName[o].resumen.total.pct);
    d.resumen.total.avg_otros = tot.length ? r4(tot.reduce((x, y) => x + y, 0) / tot.length) : null;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
