/**
 * SellerBrain API — Cloudflare Worker
 * =====================================================================
 * Backend mínimo que conecta Amazon SP-API + Ads API con el dashboard.
 * El frontend (dashboard.html) consume /v1/dashboard con el contrato
 * JSON definido en SB_DEMO — este Worker debe devolver exactamente eso.
 *
 * DOS PLANES SOPORTADOS:
 *   Plan 1 "Análisis"  → solo Ads API conectada (PPC diario automático)
 *                        + el usuario sube sus CSV mensuales en el dashboard.
 *                        Si faltan los secretos SP-API, esos pasos se saltan solos.
 *   Plan 2 "Completo"  → SP-API + Ads API: todo automático cada noche.
 *
 * ONBOARDING DE CLIENTES (Plan 1):
 *   El usuario pulsa "Conectar Amazon Ads" → GET /auth/ads/start?email=...
 *   → consiente en Amazon → /auth/ads/callback guarda su refresh token
 *   en Supabase (tabla cuentas_ads). Requiere registrar la Redirect URI
 *   https://TU-WORKER.workers.dev/auth/ads/callback en el Security Profile.
 *
 * DESPLIEGUE:
 *   npm i -g wrangler
 *   wrangler secret put LWA_CLIENT_ID          (de tu app SP-API privada — opcional en Plan 1)
 *   wrangler secret put LWA_CLIENT_SECRET      (opcional en Plan 1)
 *   wrangler secret put SPAPI_REFRESH_TOKEN    (opcional en Plan 1)
 *   wrangler secret put ADS_CLIENT_ID          (app de Amazon Ads API)
 *   wrangler secret put ADS_CLIENT_SECRET
 *   wrangler secret put ADS_REFRESH_TOKEN      (tu propia cuenta)
 *   wrangler secret put ADS_PROFILE_ID
 *   wrangler secret put SUPABASE_URL
 *   wrangler secret put SUPABASE_SERVICE_KEY
 *   wrangler deploy
 *
 * CRON (wrangler.toml):
 *   [triggers]
 *   crons = ["0 3 * * *"]   # ingesta diaria 03:00 UTC
 * =====================================================================
 */

const SPAPI_HOST = 'https://sellingpartnerapi-eu.amazon.com'; // EU
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const ADS_HOST = 'https://advertising-api-eu.amazon.com';
const MARKETPLACES = {
  ES: 'A1RKKUPIHCS9HS', FR: 'A13V1IB3VIYZZH', IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9', NL: 'A1805IZSGTT6HS', BE: 'AMEN7PMS3EDWL', UK: 'A1F83G8C2ARO7P'
};

export default {
  // ============ HTTP ============
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.CORS_ORIGIN || 'https://www.sellersbrain.io',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Content-Type': 'application/json'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      // --- Salud (público, no expone datos) ---
      if (url.pathname === '/health') {
        return json({ ok: true, ts: new Date().toISOString() }, cors);
      }

      // ============ SEGURIDAD ============
      // Todos los endpoints /v1/* requieren la clave privada (secreto SB_API_KEY).
      // Se acepta como cabecera "Authorization: Bearer LACLAVE" o como ?key=LACLAVE.
      // Excepciones públicas: /auth/ads/* (OAuth de clientes) y /v1/login (el
      // login del portal lo llama el navegador, que NO puede tener SB_API_KEY).
      if (url.pathname.startsWith('/v1/') && url.pathname !== '/v1/login') {
        const auth = (request.headers.get('Authorization') || '').replace('Bearer ', '');
        const key = auth || url.searchParams.get('key') || '';
        let ok = env.SB_API_KEY && key === env.SB_API_KEY;
        // Endpoints de LECTURA que un miembro puede consultar con su token de
        // login (JWT). Los de admin (ingest, ads, terminos…) siguen exigiendo
        // la SB_API_KEY maestra — la clave maestra nunca sale al navegador.
        const MIEMBRO_OK = url.pathname === '/v1/dashboard' || url.pathname === '/v1/ppc' || url.pathname === '/v1/plan' || url.pathname === '/v1/keywords';
        if (!ok && MIEMBRO_OK) ok = !!(await verificarJWT(env, auth));
        if (!ok) return json({ error: 'no_autorizado' }, cors, 401);
      }

      // --- Login propio del portal (público): valida email+código en el
      //     servidor contra la tabla `miembros`. La clave es el CÓDIGO (único).
      //     Si el código aún no tiene email (código sin asignar / prueba
      //     gratis), se liga a este email en el primer uso. El navegador solo
      //     manda credenciales y recibe sí/no (+ token). Nunca decide él. ---
      if (url.pathname === '/v1/login' && request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch (_) { body = {}; }
        const email = (body.email || '').trim().toLowerCase();
        const codigo = (body.codigo || '').trim();
        if (!email || !codigo) return json({ ok: false, error: 'faltan_credenciales' }, cors, 400);
        // Buscar por código (case-insensitive; los códigos no llevan % ni _).
        const filas = await selectSupabase(env,
          'miembros?codigo=ilike.' + encodeURIComponent(codigo) + '&activo=eq.true&limit=1');
        const m = (filas || [])[0];
        if (!m || (m.expira && new Date(m.expira) <= new Date())) {
          return json({ ok: false }, cors, 401);
        }
        const emailGuardado = (m.email || '').trim().toLowerCase();
        if (emailGuardado && emailGuardado !== email) {
          return json({ ok: false }, cors, 401); // código ya ligado a otro email
        }
        if (!emailGuardado) {
          // Primer uso del código: lo ligamos a este email.
          await upsertSupabase(env, 'miembros', [{ codigo: m.codigo, email: email }]);
        }
        const token = await firmarJWT(env, { email, plan: m.plan || 'beta' });
        return json({ ok: true, token, plan: m.plan || 'beta', expira: m.expira || null }, cors);
      }

      // --- Contrato del dashboard (lo que consume el frontend) ---
      if (url.pathname === '/v1/dashboard') {
        // TODO: validar JWT del usuario cuando haya multiusuario.
        const payload = await construirDashboard(env);
        return json(payload, cors);
      }

      // --- PPC en vivo (Plan 1): últimos N días desde la tabla ppc_dia ---
      if (url.pathname === '/v1/ppc') {
        const dias = Math.min(+url.searchParams.get('days') || 30, 90);
        const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
        const filas = await selectSupabase(env, 'ppc_dia?fecha=gte.' + desde + '&order=fecha.asc&select=*'.replace('?select=*',''));
        return json({ dias, datos: filas }, cors);
      }

      // --- Campañas guardadas (para la vista PPC del dashboard) ---
      if (url.pathname === '/v1/ppc/campanas') {
        const dias = Math.min(+url.searchParams.get('days') || 30, 90);
        const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
        const filas = await selectSupabase(env, 'ppc_campanas?fecha=gte.' + desde + '&order=fecha.desc,gasto.desc');
        return json({ dias, datos: filas }, cors);
      }

      // --- Términos guardados (última ventana de 30 días por país) ---
      if (url.pathname === '/v1/ppc/terminos') {
        const pais = (url.searchParams.get('pais') || '').toUpperCase();
        const filtro = pais ? 'pais=eq.' + pais + '&' : '';
        const filas = await selectSupabase(env, 'ppc_terminos?' + filtro + 'order=gasto.desc&limit=500');
        return json({ datos: filas }, cors);
      }

      // --- Utilidad de configuración: listar perfiles de anunciante (para elegir ADS_PROFILE_ID) ---
      if (url.pathname === '/v1/ads/profiles') {
        if (!env.ADS_REFRESH_TOKEN) return json({ error: 'Falta el secreto ADS_REFRESH_TOKEN' }, cors, 400);
        const token = await lwaToken(env, 'ads');
        const r = await fetch(ADS_HOST + '/v2/profiles', {
          headers: {
            'Authorization': 'Bearer ' + token,
            'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID
          }
        });
        if (!r.ok) return json({ error: 'profiles: ' + r.status + ' ' + await r.text() }, cors, 500);
        const perfiles = await r.json();
        return json(perfiles.map(p => ({
          profileId: p.profileId, pais: p.countryCode, moneda: p.currencyCode,
          tipo: p.accountInfo && p.accountInfo.type, nombre: p.accountInfo && p.accountInfo.name
        })), cors);
      }

      // --- OAuth Ads para CLIENTES (Plan 1): inicio ---
      if (url.pathname === '/auth/ads/start') {
        const email = url.searchParams.get('email') || '';
        if (!email) return json({ error: 'falta email' }, cors, 400);
        const redirect = url.origin + '/auth/ads/callback';
        const authUrl = 'https://eu.account.amazon.com/ap/oa?' + new URLSearchParams({
          client_id: env.ADS_CLIENT_ID,
          scope: 'advertising::campaign_management',
          response_type: 'code',
          redirect_uri: redirect,
          state: btoa(email) // en producción: firmar este state
        });
        return Response.redirect(authUrl, 302);
      }

      // --- OAuth Ads para CLIENTES: callback → guarda refresh token ---
      if (url.pathname === '/auth/ads/callback') {
        const code = url.searchParams.get('code');
        const email = atob(url.searchParams.get('state') || '') || 'desconocido';
        if (!code) return json({ error: 'sin code' }, cors, 400);
        const r = await fetch(LWA_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code', code,
            redirect_uri: url.origin + '/auth/ads/callback',
            client_id: env.ADS_CLIENT_ID, client_secret: env.ADS_CLIENT_SECRET
          })
        });
        if (!r.ok) return json({ error: 'token exchange: ' + await r.text() }, cors, 500);
        const tok = await r.json();
        await upsertSupabase(env, 'cuentas_ads', [{
          email, refresh_token: tok.refresh_token, creado: new Date().toISOString()
        }]);
        return new Response('<html><head><meta charset="UTF-8"></head><body style="font-family:sans-serif;background:#0D0D0D;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h1 style="color:#FF7A00">&#10003; Amazon Ads conectado</h1><p>Ya puedes cerrar esta pesta&ntilde;a y volver a SellerBrain.</p></div></body></html>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // --- Ingesta manual (para probar sin esperar al cron) ---
      if (url.pathname === '/v1/ingest' && request.method === 'POST') {
        const res = await ingestaDiaria(env);
        return json(res, cors);
      }

      // --- Plan de acción redactado por IA (capa Claude sobre el motor de reglas) ---
      // Uso: POST /v1/plan  (con SB_API_KEY). Genera bajo demanda (no en cada carga).
      if (url.pathname === '/v1/plan' && request.method === 'POST') {
        const productos = await selectSupabase(env, 'v_productos_mes').catch(() => []);
        const acciones = await generarAcciones(env, productos);
        if (!acciones.length) return json({ plan: null, mensaje: 'No hay acciones esta semana.' }, cors);
        // Contexto ligero: títulos de producto para que la IA juzgue relevancia de términos.
        const contexto = { productos: (productos || []).slice(0, 50).map(p => ({ sku: p.sku, nombre: p.nom })) };
        try {
          const plan = await generarPlanClaude(env, acciones, contexto);
          if (!plan) return json({ plan: null, mensaje: 'IA no disponible (falta ANTHROPIC_API_KEY).', acciones }, cors);
          return json({ plan, modelo: MODELO_IA, generado: new Date().toISOString(), n_acciones: acciones.length }, cors);
        } catch (e) {
          return json({ error: e.message, acciones }, cors, 500);
        }
      }

      // --- Listing con IA a partir de keywords de Helium 10 ---
      // Uso: POST /v1/keywords {producto, idioma, keywords:[{kw,vol}]}
      if (url.pathname === '/v1/keywords' && request.method === 'POST') {
        let body; try { body = await request.json(); } catch (_) { body = {}; }
        if (!body.keywords || !body.keywords.length) return json({ error: 'faltan keywords' }, cors, 400);
        try {
          const listing = await analizarKeywordsClaude(env, body);
          if (!listing) return json({ error: 'IA no disponible (falta ANTHROPIC_API_KEY).' }, cors, 200);
          return json({ listing, modelo: MODELO_IA }, cors);
        } catch (e) {
          return json({ error: e.message }, cors, 500);
        }
      }

      // --- Recoger un informe de Ads ya generado (por su reportId) ---
      // Uso: /v1/ads/fetch?pais=ES&id=REPORT_ID
      if (url.pathname === '/v1/ads/fetch') {
        const pais = (url.searchParams.get('pais') || 'ES').toUpperCase();
        const id = url.searchParams.get('id');
        const profileId = ADS_PROFILES[pais];
        if (!id || !profileId) return json({ error: 'faltan pais o id' }, cors, 400);
        const token = await lwaToken(env, 'ads');
        const headers = {
          'Authorization': 'Bearer ' + token,
          'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
          'Amazon-Advertising-API-Scope': profileId
        };
        const st = await fetch(ADS_HOST + '/reporting/reports/' + id, { headers });
        const j = await st.json();
        if (j.status !== 'COMPLETED') return json({ estado: j.status, mensaje: 'aún no listo, reintenta en unos segundos' }, cors);
        const gz = await fetch(j.url);
        const ds = new DecompressionStream('gzip');
        const txt = await new Response(new Response(await gz.arrayBuffer()).body.pipeThrough(ds)).text();
        const ads = JSON.parse(txt);
        const fecha = url.searchParams.get('fecha');
        if (!fecha) return json({ error: 'falta ?fecha=YYYY-MM-DD (la fecha de los datos del informe, no la de hoy)' }, cors, 400);
        const tot = (ads || []).reduce((a, c) => ({
          gasto: a.gasto + (c.cost || 0), clics: a.clics + (c.clicks || 0),
          impresiones: a.impresiones + (c.impressions || 0),
          ventas: a.ventas + (c.sales14d || 0), pedidos: a.pedidos + (c.purchases14d || 0)
        }), { gasto: 0, clics: 0, impresiones: 0, ventas: 0, pedidos: 0 });
        await upsertSupabase(env, 'ppc_dia', [{
          fecha, pais, gasto: +tot.gasto.toFixed(2), clics: tot.clics,
          impresiones: tot.impresiones, ventas_ppc: +tot.ventas.toFixed(2), pedidos_ppc: tot.pedidos
        }]);
        return json({ pais, campañas: ads.length, total: tot, guardado: true }, cors);
      }

      // --- Términos de búsqueda de los últimos 30 días de UN país ---
      // Uso: /v1/ads/terminos?pais=ES&key=...  (guarda en ppc_terminos y devuelve top)
      if (url.pathname === '/v1/ads/terminos') {
        const pais = (url.searchParams.get('pais') || 'ES').toUpperCase();
        const profileId = ADS_PROFILES[pais];
        if (!profileId) return json({ error: 'país no configurado: ' + pais }, cors, 400);
        const hasta = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const desde = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
        const filas = await adsInformeTerminos(env, profileId, desde, hasta);
        await upsertSupabase(env, 'ppc_terminos', (filas || []).map(t => ({
          pais, desde, hasta,
          termino: t.searchTerm || '', keyword: t.keyword || '', tipo: t.matchType || '',
          campania: t.campaignName || '',
          gasto: +(t.cost || 0).toFixed(2), clics: t.clicks || 0, impresiones: t.impressions || 0,
          ventas_ppc: +(t.sales14d || 0).toFixed(2), pedidos_ppc: t.purchases14d || 0
        })));
        const top = (filas || []).sort((a, b) => (b.cost || 0) - (a.cost || 0)).slice(0, 20)
          .map(t => ({ termino: t.searchTerm, gasto: t.cost, clics: t.clicks, pedidos: t.purchases14d, ventas: t.sales14d }));
        return json({ pais, periodo: desde + ' → ' + hasta, terminos: filas.length, top_gasto: top, guardado: true }, cors);
      }

      // --- Recoger un informe de TÉRMINOS ya generado (por reportId) ---
      // Uso: /v1/ads/terminos-fetch?pais=ES&id=REPORT_ID
      if (url.pathname === '/v1/ads/terminos-fetch') {
        const pais = (url.searchParams.get('pais') || 'ES').toUpperCase();
        const id = url.searchParams.get('id');
        const profileId = ADS_PROFILES[pais];
        if (!id || !profileId) return json({ error: 'faltan pais o id' }, cors, 400);
        const token = await lwaToken(env, 'ads');
        const headers = {
          'Authorization': 'Bearer ' + token,
          'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
          'Amazon-Advertising-API-Scope': profileId
        };
        const st = await fetch(ADS_HOST + '/reporting/reports/' + id, { headers });
        const j = await st.json();
        if (j.status !== 'COMPLETED') return json({ estado: j.status, mensaje: 'aún no listo, reintenta en unos minutos' }, cors);
        const gz = await fetch(j.url);
        const ds = new DecompressionStream('gzip');
        const txt = await new Response(new Response(await gz.arrayBuffer()).body.pipeThrough(ds)).text();
        const filas = JSON.parse(txt);
        const hasta = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const desde = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
        await upsertSupabase(env, 'ppc_terminos', (filas || []).map(t => ({
          pais, desde, hasta,
          termino: t.searchTerm || '', keyword: t.keyword || '', tipo: t.matchType || '',
          campania: t.campaignName || '',
          gasto: +(t.cost || 0).toFixed(2), clics: t.clicks || 0, impresiones: t.impressions || 0,
          ventas_ppc: +(t.sales14d || 0).toFixed(2), pedidos_ppc: t.purchases14d || 0
        })));
        const top = (filas || []).sort((a, b) => (b.cost || 0) - (a.cost || 0)).slice(0, 20)
          .map(t => ({ termino: t.searchTerm, keyword: t.keyword, gasto: t.cost, clics: t.clicks, pedidos: t.purchases14d, ventas: t.sales14d }));
        return json({ pais, terminos: filas.length, top_gasto: top, guardado: true }, cors);
      }

      // --- Prueba rápida de PPC de UN país (para diagnóstico) ---
      // Uso: /v1/ingest-test?pais=ES  (GET, sin esperar al cron)
      if (url.pathname === '/v1/ingest-test') {
        const pais = (url.searchParams.get('pais') || 'ES').toUpperCase();
        const profileId = ADS_PROFILES[pais];
        if (!profileId) return json({ error: 'país no configurado: ' + pais }, cors, 400);
        const fecha = url.searchParams.get('fecha') ||
          new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        try {
          const ads = await adsInformeDiario(env, fecha, profileId);
          const tot = (ads || []).reduce((a, c) => ({
            gasto: a.gasto + (c.cost || 0), clics: a.clics + (c.clicks || 0),
            impresiones: a.impresiones + (c.impressions || 0),
            ventas: a.ventas + (c.sales14d || 0), pedidos: a.pedidos + (c.purchases14d || 0)
          }), { gasto: 0, clics: 0, impresiones: 0, ventas: 0, pedidos: 0 });
          await upsertSupabase(env, 'ppc_dia', [{
            fecha, pais, gasto: +tot.gasto.toFixed(2), clics: tot.clics,
            impresiones: tot.impresiones, ventas_ppc: +tot.ventas.toFixed(2), pedidos_ppc: tot.pedidos
          }]);
          return json({ pais, fecha, campañas: ads ? ads.length : 0, total: tot }, cors);
        } catch (e) {
          return json({ pais, fecha, error: e.message }, cors, 500);
        }
      }

      return json({ error: 'not_found' }, cors, 404);
    } catch (e) {
      return json({ error: e.message }, cors, 500);
    }
  },

  // ============ CRON: ingesta diaria ============
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ingestaDiaria(env, 'cron'));
  }
};

/* =====================================================================
 * TOKENS
 * =================================================================== */
async function lwaToken(env, scope) {
  // scope 'spapi' | 'ads'
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: scope === 'ads' ? env.ADS_REFRESH_TOKEN : env.SPAPI_REFRESH_TOKEN,
    client_id: scope === 'ads' ? env.ADS_CLIENT_ID : env.LWA_CLIENT_ID,
    client_secret: scope === 'ads' ? env.ADS_CLIENT_SECRET : env.LWA_CLIENT_SECRET
  });
  const r = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error('LWA token ' + scope + ': ' + r.status + ' ' + await r.text());
  return (await r.json()).access_token;
}

/* =====================================================================
 * SP-API — Reports (2021-06-30)
 * Flujo: createReport → poll → getReportDocument → descargar (gzip)
 * =================================================================== */
async function spapiCall(env, path, opts = {}) {
  const token = await lwaToken(env, 'spapi');
  const r = await fetch(SPAPI_HOST + path, {
    ...opts,
    headers: {
      'x-amz-access-token': token,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!r.ok) throw new Error('SP-API ' + path + ': ' + r.status + ' ' + await r.text());
  return r.json();
}

async function pedirInforme(env, reportType, dataStartTime, dataEndTime, marketplaceIds) {
  const { reportId } = await spapiCall(env, '/reports/2021-06-30/reports', {
    method: 'POST',
    body: JSON.stringify({ reportType, dataStartTime, dataEndTime, marketplaceIds })
  });
  // Poll hasta DONE (máx ~4 min; los settlement suelen estar ya generados)
  for (let i = 0; i < 24; i++) {
    await sleep(10000);
    const rep = await spapiCall(env, '/reports/2021-06-30/reports/' + reportId);
    if (rep.processingStatus === 'DONE') return descargarDocumento(env, rep.reportDocumentId);
    if (['CANCELLED', 'FATAL'].includes(rep.processingStatus)) {
      throw new Error('Informe ' + reportType + ': ' + rep.processingStatus);
    }
  }
  throw new Error('Informe ' + reportType + ': timeout');
}

// Los settlement NO se piden: Amazon los genera solo. Se listan y descargan.
async function listarSettlements(env, desdeISO) {
  const q = new URLSearchParams({
    reportTypes: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
    processingStatuses: 'DONE',
    createdSince: desdeISO
  });
  const { reports } = await spapiCall(env, '/reports/2021-06-30/reports?' + q);
  return reports || [];
}

async function descargarDocumento(env, documentId) {
  const doc = await spapiCall(env, '/reports/2021-06-30/documents/' + documentId);
  const r = await fetch(doc.url);
  let buf = await r.arrayBuffer();
  if (doc.compressionAlgorithm === 'GZIP') {
    const ds = new DecompressionStream('gzip');
    buf = await new Response(new Response(buf).body.pipeThrough(ds)).arrayBuffer();
  }
  // Los flat files de Amazon EU vienen en latin-1/cp1252 con tabulador
  return new TextDecoder('iso-8859-1').decode(buf);
}

/* =====================================================================
 * ADS API — informes v3 (y Marketing Stream para horas, fase 2)
 * =================================================================== */
// Perfiles por país. Empieza por los que tienes campañas activas (ES/FR/IT/BE).
const ADS_PROFILES = {
  ES: '3874077641287409', FR: '2792047721008132',
  IT: '1402821377609437', BE: '1737778900266529'
};

async function adsInformeDiario(env, fecha /* YYYY-MM-DD */, profileId) {
  const token = await lwaToken(env, 'ads');
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
    'Amazon-Advertising-API-Scope': profileId,
    'Content-Type': 'application/vnd.createasyncreportrequest.v3+json'
  };
  const body = {
    name: 'sb-sp-daily-' + fecha,
    startDate: fecha, endDate: fecha,
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['campaign'],
      columns: ['date', 'campaignId', 'campaignName', 'cost', 'clicks', 'impressions', 'sales14d', 'purchases14d'],
      reportTypeId: 'spCampaigns',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON'
    }
  };
  const r = await fetch(ADS_HOST + '/reporting/reports', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Ads report: ' + r.status + ' ' + await r.text());
  const { reportId } = await r.json();
  // Poll (esperas cortas para no agotar el tiempo del Worker)
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const st = await fetch(ADS_HOST + '/reporting/reports/' + reportId, { headers });
    const j = await st.json();
    if (j.status === 'COMPLETED') {
      const gz = await fetch(j.url);
      const ds = new DecompressionStream('gzip');
      const txt = await new Response(new Response(await gz.arrayBuffer()).body.pipeThrough(ds)).text();
      return JSON.parse(txt);
    }
    if (j.status === 'FAILURE') throw new Error('Ads report FAILURE');
  }
  throw new Error('Ads report timeout');
}

async function adsInformeTerminos(env, profileId, desde, hasta) {
  const token = await lwaToken(env, 'ads');
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
    'Amazon-Advertising-API-Scope': profileId,
    'Content-Type': 'application/vnd.createasyncreportrequest.v3+json'
  };
  const body = {
    name: 'sb-terminos-' + desde + '-' + hasta,
    startDate: desde, endDate: hasta,
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['searchTerm'],
      columns: ['searchTerm', 'keyword', 'matchType', 'campaignName',
                'cost', 'clicks', 'impressions', 'sales14d', 'purchases14d'],
      reportTypeId: 'spSearchTerm',
      timeUnit: 'SUMMARY',
      format: 'GZIP_JSON'
    }
  };
  const r = await fetch(ADS_HOST + '/reporting/reports', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Ads términos: ' + r.status + ' ' + await r.text());
  const { reportId } = await r.json();
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const st = await fetch(ADS_HOST + '/reporting/reports/' + reportId, { headers });
    const j = await st.json();
    if (j.status === 'COMPLETED') {
      const gz = await fetch(j.url);
      const ds = new DecompressionStream('gzip');
      const txt = await new Response(new Response(await gz.arrayBuffer()).body.pipeThrough(ds)).text();
      return JSON.parse(txt);
    }
    if (j.status === 'FAILURE') throw new Error('Ads términos FAILURE');
  }
  // Devolvemos el id para recogerlo luego si Amazon va lento
  throw new Error('timeout · reportId=' + reportId);
}

/* =====================================================================
 * INGESTA DIARIA → Supabase
 * =================================================================== */
async function ingestaDiaria(env, origen) {
  const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const planCompleto = !!(env.LWA_CLIENT_ID && env.SPAPI_REFRESH_TOKEN); // Plan 2
  const resultado = { fecha: ayer, origen: origen || 'manual', plan: planCompleto ? 'completo' : 'analisis(ads-only)', pasos: [] };

  // 1. Pedidos del día (ventas + unidades por SKU) — solo Plan 2
  if (planCompleto) try {
    const tsv = await pedirInforme(env,
      'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      ayer + 'T00:00:00Z', ayer + 'T23:59:59Z',
      [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT]);
    const filas = parseTSV(tsv);
    await upsertSupabase(env, 'pedidos_dia', agregarPedidos(filas, ayer));
    resultado.pasos.push({ pedidos: filas.length });
  } catch (e) { resultado.pasos.push({ pedidos_error: e.message }); }

  // 2. Settlements nuevos (tarifas FBA REALES por unidad + devoluciones + ajustes) — solo Plan 2
  if (planCompleto) try {
    const hace15d = new Date(Date.now() - 15 * 86400000).toISOString();
    const reps = await listarSettlements(env, hace15d);
    for (const rep of reps) {
      const yaProcesado = await existeEnSupabase(env, 'settlements', 'report_id', rep.reportId);
      if (yaProcesado) continue;
      const tsv = await descargarDocumento(env, rep.reportDocumentId);
      const lineas = parseTSV(tsv);
      await upsertSupabase(env, 'settlement_lineas', mapearSettlement(lineas, rep.reportId));
      await upsertSupabase(env, 'settlements', [{ report_id: rep.reportId, procesado: new Date().toISOString() }]);
    }
    resultado.pasos.push({ settlements: reps.length });
  } catch (e) { resultado.pasos.push({ settlements_error: e.message }); }

  // 3. Devoluciones FBA — solo Plan 2
  if (planCompleto) try {
    const hace30d = new Date(Date.now() - 30 * 86400000).toISOString();
    const tsv = await pedirInforme(env, 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
      hace30d, ayer + 'T23:59:59Z', [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT]);
    await upsertSupabase(env, 'devoluciones', parseTSV(tsv).map(r => ({
      fecha: (r['return-date'] || '').slice(0, 10), sku: r['sku'], asin: r['asin'],
      cantidad: +r['quantity'] || 1, motivo: r['reason'] || '', estado: r['status'] || '',
      disposicion: r['detailed-disposition'] || ''
    })));
    resultado.pasos.push({ devoluciones: 'ok' });
  } catch (e) { resultado.pasos.push({ devoluciones_error: e.message }); }

  // 3b. Keywords reales de Amazon (Brand Analytics — requiere Brand Registry y rol aprobado)
  if (planCompleto) try {
    const iniSemana = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const tsv = await pedirInforme(env, 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT',
      iniSemana + 'T00:00:00Z', ayer + 'T23:59:59Z', [MARKETPLACES.ES]);
    // Este informe llega en JSON dentro del documento; si es TSV el parser genérico también sirve
    let filas;
    try { filas = JSON.parse(tsv).dataByDepartmentAndSearchTerm || []; }
    catch (_) { filas = parseTSV(tsv); }
    await upsertSupabase(env, 'busquedas_marca', filas.slice(0, 2000).map(r => ({
      semana: iniSemana,
      termino: r.searchTerm || r['search-term'] || '',
      ranking: +(r.searchFrequencyRank || r['search-frequency-rank'] || 0),
      asin1: r.clickedAsin || r['#1-clicked-asin'] || ''
    })));
    resultado.pasos.push({ brand_analytics: filas.length });
  } catch (e) { resultado.pasos.push({ brand_analytics_error: e.message }); }

  // 4. PPC del día (Ads API) — recorre los países con perfil configurado
  for (const [pais, profileId] of Object.entries(ADS_PROFILES)) {
    try {
      const ads = await adsInformeDiario(env, ayer, profileId);
      // Suma todas las campañas del día en un total por país
      const tot = (ads || []).reduce((a, c) => ({
        gasto: a.gasto + (c.cost || 0), clics: a.clics + (c.clicks || 0),
        impresiones: a.impresiones + (c.impressions || 0),
        ventas: a.ventas + (c.sales14d || 0), pedidos: a.pedidos + (c.purchases14d || 0)
      }), { gasto: 0, clics: 0, impresiones: 0, ventas: 0, pedidos: 0 });
      await upsertSupabase(env, 'ppc_dia', [{
        fecha: ayer, pais,
        gasto: +tot.gasto.toFixed(2), clics: tot.clics, impresiones: tot.impresiones,
        ventas_ppc: +tot.ventas.toFixed(2), pedidos_ppc: tot.pedidos
      }]);
      // Detalle por campaña (para saber cuál gasta y cuál convierte)
      await upsertSupabase(env, 'ppc_campanas', (ads || []).map(c => ({
        fecha: ayer, pais, campania_id: String(c.campaignId || ''), nombre: c.campaignName || '',
        gasto: +(c.cost || 0).toFixed(2), clics: c.clicks || 0, impresiones: c.impressions || 0,
        ventas_ppc: +(c.sales14d || 0).toFixed(2), pedidos_ppc: c.purchases14d || 0
      })));
      resultado.pasos.push({ ['ppc_' + pais]: 'ok · ' + (ads ? ads.length : 0) + ' campañas' });
    } catch (e) { resultado.pasos.push({ ['ppc_' + pais + '_error']: e.message }); }
  }

  // 5. Términos de búsqueda → ppc_terminos (para el motor de acciones).
  //    Semanal (solo lunes UTC): el informe es un resumen de 30 días, no hace
  //    falta a diario y así no saturamos la Ads API.
  if (new Date().getUTCDay() === 1) {
    const hastaT = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const desdeT = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    for (const [pais, profileId] of Object.entries(ADS_PROFILES)) {
      try {
        const filas = await adsInformeTerminos(env, profileId, desdeT, hastaT);
        await upsertSupabase(env, 'ppc_terminos', (filas || []).map(t => ({
          pais, desde: desdeT, hasta: hastaT,
          termino: t.searchTerm || '', keyword: t.keyword || '', tipo: t.matchType || '',
          campania: t.campaignName || '',
          gasto: +(t.cost || 0).toFixed(2), clics: t.clicks || 0, impresiones: t.impressions || 0,
          ventas_ppc: +(t.sales14d || 0).toFixed(2), pedidos_ppc: t.purchases14d || 0
        })));
        resultado.pasos.push({ ['terminos_' + pais]: filas ? filas.length : 0 });
      } catch (e) { resultado.pasos.push({ ['terminos_' + pais + '_error']: e.message }); }
    }
  }

  // Acta de la ejecución: queda registrada aunque haya fallos parciales
  try {
    await upsertSupabase(env, 'ingestas', [{
      ejecutada: new Date().toISOString(),
      origen: resultado.origen,
      plan: resultado.plan,
      resumen: JSON.stringify(resultado.pasos).slice(0, 2000)
    }]);
  } catch (e) { /* si falla el log, no rompe la ingesta */ }

  return resultado;
}

/* =====================================================================
 * CONSTRUIR EL PAYLOAD DEL DASHBOARD (contrato SB_DEMO)
 * =================================================================== */
// Lectura tolerante: si la vista no existe o está vacía, devuelve el defecto
// en vez de tumbar todo el endpoint (evita el "no pude leer tus datos").
async function selSafe(env, vista, def) {
  try { return await selectSupabase(env, vista); }
  catch (_) { return def === undefined ? [] : def; }
}

async function construirDashboard(env) {
  // Lee agregados de Supabase y los transforma al contrato del frontend.
  // Cada vista es tolerante a fallos: si falta, sale vacía (dashboard "sin datos aún").
  const [periodos, pnl, productos, serie30, stock] = await Promise.all([
    selSafe(env, 'v_periodos'),
    selSafe(env, 'v_pnl_mes'),
    selSafe(env, 'v_productos_mes'),
    selSafe(env, 'v_serie_30d'),
    selSafe(env, 'v_stock_riesgo')
  ]);
  return {
    meta: { actualizado: new Date().toISOString(), monedas: 'EUR', marketplaces: ['ES','FR','IT'], skus: productos.length },
    periodos, pnl: pnl[0] || {},
    productos,
    // El motor de acciones corre sobre los mismos datos (fase siguiente):
    acciones: await generarAcciones(env, productos),
    alertas: [],
    stock: stock,
    serie30
  };
}

// Umbrales del motor (editables · aquí entrarán los de David — TAREA 5)
const REGLAS_PPC = {
  negClicsMin: 8,     // NEGATIVIZAR: 0 pedidos y al menos este nº de clics
  acosAlto: 0.60,     // BAJAR PUJA:  >=1 pedido y ACoS por encima de esto
  acosBajo: 0.20,     // ESCALAR:     ACoS por debajo de esto
  escPedidosMin: 2    // ESCALAR:     al menos este nº de pedidos
};

async function generarAcciones(env, productos) {
  const acciones = [];

  // --- 1) Acciones a nivel de PRODUCTO (P&L), como hasta ahora ---
  for (const p of (productos || [])) {
    if (p.mg < 0 && p.ppc > 0) acciones.push({
      _v: p.ppc,
      ic: '⏸️', bg: 'rgba(245,166,35,.15)', c: 'var(--am)',
      t: 'Pausa PPC de «' + p.nom + '»',
      v: '+' + p.ppc.toFixed(2).replace('.', ',') + '€/mes',
      p: 'Margen ' + p.mg + '%: cada venta con clic pierde dinero'
    });
  }

  // --- 2) Acciones a nivel de TÉRMINO de búsqueda (ppc_terminos) ---
  // Se usa solo el último snapshot (max hasta) para no contar dos veces.
  try {
    const filas = await selectSupabase(env, 'ppc_terminos?order=hasta.desc,gasto.desc&limit=800');
    if (filas && filas.length) {
      const maxHasta = filas[0].hasta;
      for (const t of filas.filter(f => f.hasta === maxHasta)) {
        const gasto = +t.gasto || 0, clics = +t.clics || 0;
        const pedidos = +t.pedidos_ppc || 0, ventas = +t.ventas_ppc || 0;
        const acos = ventas > 0 ? gasto / ventas : null;
        const term = (t.termino || '').slice(0, 60);
        const donde = t.campania ? ' · ' + t.campania : '';

        // NEGATIVIZAR — desperdicio puro → € real ahorrado (= lo gastado sin vender)
        if (pedidos === 0 && clics >= REGLAS_PPC.negClicsMin && gasto > 0) {
          acciones.push({
            _v: gasto,
            ic: '🚫', bg: 'rgba(232,64,64,.15)', c: 'var(--rd)',
            t: 'Negativiza «' + term + '»' + donde,
            v: '+' + gasto.toFixed(2).replace('.', ',') + '€/mes',
            p: clics + ' clics y 0 ventas en 30 días: gasto tirado'
          });
        }
        // BAJAR PUJA — sangra (ACoS alto). Muestra ACoS real, sin € prometido.
        else if (pedidos >= 1 && acos !== null && acos >= REGLAS_PPC.acosAlto) {
          acciones.push({
            _v: gasto,
            ic: '📉', bg: 'rgba(245,166,35,.15)', c: 'var(--am)',
            t: 'Baja la puja de «' + term + '»' + donde,
            v: 'ACoS ' + Math.round(acos * 100) + '%',
            p: 'Gasta ' + gasto.toFixed(2).replace('.', ',') + '€ con ACoS alto (' + pedidos + ' pedidos)'
          });
        }
        // ESCALAR — oro (ACoS bajo y convierte). Muestra ACoS real.
        else if (pedidos >= REGLAS_PPC.escPedidosMin && acos !== null && acos <= REGLAS_PPC.acosBajo) {
          acciones.push({
            _v: ventas,
            ic: '🚀', bg: 'rgba(46,230,160,.15)', c: 'var(--or)',
            t: 'Escala «' + term + '»' + donde,
            v: 'ACoS ' + Math.round(acos * 100) + '%',
            p: pedidos + ' pedidos y ACoS bajo: sube puja o crea campaña exacta'
          });
        }
      }
    }
  } catch (e) { /* si aún no hay términos, el motor sigue con las de producto */ }

  // Ordenar por impacto (€/ventas reales) y limitar; quitar el campo interno _v
  acciones.sort((a, b) => (b._v || 0) - (a._v || 0));
  return acciones.slice(0, 10).map(a => { const { _v, ...rest } = a; return rest; });
}

/* =====================================================================
 * CAPA IA (Claude) — redacta y prioriza el plan SOBRE las reglas.
 * Las reglas ya calcularon los números; Claude solo explica, prioriza
 * y juzga la relevancia de cada término. NUNCA inventa cifras.
 * =================================================================== */
const MODELO_IA = 'claude-opus-4-8'; // editable; para abaratar: 'claude-haiku-4-5' o 'claude-sonnet-5'

async function generarPlanClaude(env, acciones, contexto) {
  if (!env.ANTHROPIC_API_KEY) return null;            // sin clave → no hay capa IA
  if (!acciones || !acciones.length) return null;
  const sys =
    'Eres el cerebro de SellerBrain, copiloto de PPC para vendedores de Amazon FBA. ' +
    'Recibes ACCIONES ya calculadas por reglas, con cifras REALES. Reglas estrictas: ' +
    'NO inventes ni modifiques ningún número, € ni ACoS: usa SOLO los que te doy. ' +
    'No prometas resultados ni rentabilidad futura. Tu trabajo es priorizar, explicar en ' +
    'lenguaje claro y directo, y juzgar la RELEVANCIA de cada término: si un término de ' +
    'búsqueda no encaja con el producto, confirma negativizar; si es relevante pero caro, ' +
    'recomienda bajar la puja en vez de negativizar. Responde en español, en Markdown, breve ' +
    'y accionable. Estructura: (1) un titular con el ahorro total en € (suma SOLO los € de las ' +
    'acciones de negativizar que te paso), (2) "Haz primero" (máximo 5, cada una con su porqué en ' +
    'una línea), (3) "Vigila" (máximo 3). Nada de relleno ni de introducciones.';
  const user = 'Acciones y contexto de esta semana (JSON):\n' +
    JSON.stringify({ acciones: acciones, contexto: contexto || {} }).slice(0, 12000);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODELO_IA,
      max_tokens: 1500,
      system: sys,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  const texto = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return texto || null;
}

// Genera un LISTING optimizado (título + bullets + backend + estrategia) a partir
// de las keywords reales de Helium 10. Usa SOLO esas keywords, no inventa producto.
async function analizarKeywordsClaude(env, datos) {
  if (!env.ANTHROPIC_API_KEY) return null;
  const kws = (datos.keywords || []).slice(0, 60);
  if (!kws.length) return null;
  const sys =
    'Eres experto en SEO y listings de Amazon FBA. Te doy un producto y una lista de keywords REALES ' +
    '(de Helium 10) con su volumen. Escribe un listing optimizado en el idioma pedido. Reglas estrictas: ' +
    'usa SOLO estas keywords (no inventes otras ni marcas), no inventes características del producto que ' +
    'no se deduzcan de la descripción, no prometas resultados. Devuelve Markdown, conciso, con: ' +
    '(1) **Título** (máx 200 caracteres, con las keywords de más volumen de forma natural y legible; NADA ' +
    'de rellenar con "|"), (2) **5 bullet points** (cada uno empieza con 2-4 palabras EN MAYÚSCULAS y luego ' +
    'una frase, integrando keywords relevantes de forma natural), (3) **Términos de búsqueda backend** (una ' +
    'sola línea, las keywords que no entraron arriba, separadas por espacios, sin comas ni repetir palabras), ' +
    '(4) **Estrategia PPC** (2-3 líneas: qué keywords a coincidencia exacta, cuáles a amplia/auto, cuáles ' +
    'vigilar o negativizar por poco relevantes).';
  const IDIOMAS = { es: 'español', en: 'inglés', fr: 'francés', de: 'alemán', it: 'italiano' };
  const user = 'Producto: ' + (datos.producto || '(sin descripción)') +
    '\nIdioma del listing: ' + (IDIOMAS[datos.idioma] || 'español') +
    '\nKeywords (frase · volumen):\n' +
    kws.map(k => (typeof k === 'string' ? k : (k.kw + ' · ' + (k.vol || 0)))).join('\n');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODELO_IA, max_tokens: 1800, system: sys, messages: [{ role: 'user', content: user }] })
  });
  if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  const texto = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return texto || null;
}

/* =====================================================================
 * SUPABASE REST
 * =================================================================== */
async function upsertSupabase(env, tabla, filas) {
  if (!filas || !filas.length) return;
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + tabla, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify(filas)
  });
  if (!r.ok) throw new Error('Supabase ' + tabla + ': ' + r.status + ' ' + await r.text());
}

async function selectSupabase(env, vista) {
  const sep = vista.indexOf('?') > -1 ? '&' : '?';
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + vista + sep + 'select=*', {
    headers: { apikey: env.SUPABASE_SERVICE_KEY }
  });
  if (!r.ok) throw new Error('Supabase ' + vista + ': ' + r.status);
  return r.json();
}

async function existeEnSupabase(env, tabla, campo, valor) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + tabla + '?' + campo + '=eq.' + encodeURIComponent(valor) + '&select=' + campo + '&limit=1', {
    headers: { apikey: env.SUPABASE_SERVICE_KEY }
  });
  return r.ok && (await r.json()).length > 0;
}

/* =====================================================================
 * PARSERS
 * =================================================================== */
function parseTSV(texto) {
  const lineas = texto.split('\n').filter(l => l.trim());
  if (!lineas.length) return [];
  const headers = lineas[0].split('\t').map(h => h.trim().toLowerCase());
  return lineas.slice(1).map(l => {
    const vals = l.split('\t');
    const o = {};
    headers.forEach((h, i) => o[h] = (vals[i] || '').trim());
    return o;
  });
}

function agregarPedidos(filas, fecha) {
  const porSku = {};
  for (const r of filas) {
    if ((r['item-status'] || '').toLowerCase() === 'cancelled') continue;
    const sku = r['sku'] || 'desconocido';
    if (!porSku[sku]) porSku[sku] = { fecha, sku, marketplace: (r['sales-channel'] || '').replace('Amazon.', '').toUpperCase(), unidades: 0, ventas: 0, pedidos: 0 };
    porSku[sku].unidades += +r['quantity'] || 0;
    porSku[sku].ventas += +((r['item-price'] || '0').replace(',', '.')) || 0; // EU: decimales con coma
    porSku[sku].pedidos += 1;
  }
  return Object.values(porSku);
}

function mapearSettlement(lineas, reportId) {
  return lineas
    .filter(l => l['transaction-type'])
    .map(l => ({
      report_id: reportId,
      fecha: (l['posted-date'] || '').slice(0, 10),
      tipo: l['transaction-type'],
      pedido: l['order-id'] || '',
      sku: l['sku'] || '',
      concepto: l['amount-type'] + '/' + l['amount-description'],
      importe: +(l['amount'] || '0').replace(',', '.'),
      cantidad: +l['quantity-purchased'] || 0
    }));
}

/* =====================================================================
 * JWT — token de sesión firmado (HMAC-SHA256) para el login del portal
 * Si no hay secreto SB_JWT_SECRET, devuelve null (el login sigue
 * funcionando con {ok:true}); cuando lo pongas, empieza a firmar tokens.
 * =================================================================== */
async function firmarJWT(env, payload) {
  if (!env.SB_JWT_SECRET) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: now, exp: now + 60 * 60 * 24 * 7 }; // 7 días
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const data = enc(header) + '.' + enc(body);
  const key = await crypto.subtle.importKey('raw',
    new TextEncoder().encode(env.SB_JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return data + '.' + b64url(new Uint8Array(sig));
}
function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// Verifica el JWT del login (firma HMAC + caducidad). Devuelve el payload o null.
async function verificarJWT(env, token) {
  if (!env.SB_JWT_SECRET || !token || token.split('.').length !== 3) return null;
  const [h, b, s] = token.split('.');
  const key = await crypto.subtle.importKey('raw',
    new TextEncoder().encode(env.SB_JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(h + '.' + b));
  if (b64url(new Uint8Array(sig)) !== s) return null;          // firma no coincide
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(b)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null; // caducado
    return payload;
  } catch (_) { return null; }
}

/* ===== utils ===== */
function json(obj, headers, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
