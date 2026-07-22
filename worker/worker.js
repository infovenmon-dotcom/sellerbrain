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

const SB_VERSION = 'v7-detalle-fee-sku'; // súbelo al cambiar el Worker (para verificar despliegue)
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
      // --- Salud + VERSIÓN (público). Sirve para comprobar si el Worker está
      //     actualizado: abre la URL/health y mira 'version'. ---
      if (url.pathname === '/health' || url.pathname === '/' || url.pathname === '/version') {
        return json({ ok: true, version: SB_VERSION, ts: new Date().toISOString() }, cors);
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
        const MIEMBRO_OK = url.pathname.startsWith('/v1/ppc') || url.pathname === '/v1/dashboard' || url.pathname === '/v1/plan' || url.pathname === '/v1/keywords' || url.pathname === '/v1/costes' || url.pathname === '/v1/comparativa' || url.pathname === '/v1/productos' || url.pathname === '/v1/ventas-pais' || url.pathname === '/v1/producto-detalle';
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

      // --- Costes de producto (COGS) — el margen real depende de esto ---
      //     GET: lista {sku:coste}. POST {sku, coste}: guarda uno.
      if (url.pathname === '/v1/costes') {
        if (request.method === 'POST') {
          let b; try { b = await request.json(); } catch (_) { b = {}; }
          // Carga en BLOQUE: { lista: [{sku, coste}, ...] }
          if (Array.isArray(b.lista)) {
            const rows = b.lista
              .map(x => ({ sku: (x.sku || '').trim(), coste: +x.coste || 0, actualizado: new Date().toISOString() }))
              .filter(x => x.sku);
            if (rows.length) await upsertSupabase(env, 'costes_producto', rows);
            return json({ ok: true, guardados: rows.length }, cors);
          }
          // Uno solo: { sku, coste }
          const sku = (b.sku || '').trim();
          if (!sku) return json({ ok: false, error: 'falta_sku' }, cors, 400);
          await upsertSupabase(env, 'costes_producto', [{ sku, coste: +b.coste || 0, actualizado: new Date().toISOString() }]);
          return json({ ok: true, sku, coste: +b.coste || 0 }, cors);
        }
        const filas = await selSafe(env, 'costes_producto', []);
        const mapa = {}; for (const f of filas) mapa[f.sku] = +f.coste || 0;
        return json({ costes: mapa }, cors);
      }

      // --- Comparativas (mes vs mes, año vs año) ---
      if (url.pathname === '/v1/comparativa') {
        return json({ filas: await selSafe(env, 'v_comparativa', []) }, cors);
      }

      // --- Detalle de un producto: operaciones REALES de Amazon (trazabilidad).
      //     GET /v1/producto-detalle?sku=XXX  → líneas de settlement + tarifa/ud.
      if (url.pathname === '/v1/producto-detalle') {
        const sku = url.searchParams.get('sku');
        if (!sku) return json({ error: 'falta_sku' }, cors, 400);
        const q = 'settlement_lineas?sku=eq.' + encodeURIComponent(sku) + '&order=fecha.desc&limit=150&select=fecha,tipo,concepto,importe,cantidad,pedido';
        const lineas = await selSafe(env, q, []);
        const fee = await selSafe(env, 'v_fee_sku?sku=eq.' + encodeURIComponent(sku) + '&select=sku,uds_liq,fba,com', []);
        const porConcepto = {};
        for (const l of (lineas || [])) {
          if (!porConcepto[l.concepto]) porConcepto[l.concepto] = { concepto: l.concepto, n: 0, total: 0 };
          porConcepto[l.concepto].n++; porConcepto[l.concepto].total += +l.importe || 0;
        }
        const resumen = Object.values(porConcepto).map(x => ({ ...x, total: +x.total.toFixed(2) })).sort((a, b) => a.total - b.total);
        return json({ sku, fee: (fee || [])[0] || null, resumen, lineas }, cors);
      }

      // --- Tabla "Beneficio por producto" para CUALQUIER periodo (selector) ---
      //     GET /v1/productos?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
      if (url.pathname === '/v1/productos') {
        const desde = url.searchParams.get('desde');
        const hasta = url.searchParams.get('hasta');
        const pais = url.searchParams.get('pais') || null;   // ES/FR/IT o vacío = todos
        if (!desde || !hasta) return json({ error: 'faltan_fechas' }, cors, 400);
        return json({ desde, hasta, pais, productos: await productosPeriodo(env, desde, hasta, pais) }, cors);
      }

      // --- Ventas por país (total + desglose) para un rango ---
      //     GET /v1/ventas-pais?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
      if (url.pathname === '/v1/ventas-pais') {
        const desde = url.searchParams.get('desde');
        const hasta = url.searchParams.get('hasta');
        if (!desde || !hasta) return json({ error: 'faltan_fechas' }, cors, 400);
        const rows = await selSafe(env, 'ventas_sku_pais_dia?fecha=gte.' + desde + '&fecha=lte.' + hasta + '&select=pais,uds,ventas,pedidos', []);
        const byP = {}; const tot = { uds: 0, ventas: 0, pedidos: 0 };
        for (const r of (rows || [])) {
          const p = r.pais || '?';
          if (!byP[p]) byP[p] = { pais: p, uds: 0, ventas: 0, pedidos: 0 };
          byP[p].uds += +r.uds || 0; byP[p].ventas += +r.ventas || 0; byP[p].pedidos += +r.pedidos || 0;
          tot.uds += +r.uds || 0; tot.ventas += +r.ventas || 0; tot.pedidos += +r.pedidos || 0;
        }
        tot.ventas = +tot.ventas.toFixed(2);
        const paises = Object.values(byP).map(x => ({ ...x, ventas: +x.ventas.toFixed(2) })).sort((a, b) => b.ventas - a.ventas);
        return json({ desde, hasta, total: tot, paises }, cors);
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

      // --- Ingesta PPC (Ads API) en invocación separada (límite subrequests).
      //     ?pais=ES procesa UN país (para no pasar el límite en plan gratis).
      if (url.pathname === '/v1/ingest-ppc' && request.method === 'POST') {
        const forzar = url.searchParams.get('terminos') === '1';
        const pais = url.searchParams.get('pais') || null;
        const solo = url.searchParams.get('solo') || null;   // 'dia' | 'terminos'
        const res = await ingestaPPC(env, { terminos: forzar, pais, solo });
        return json(res, cors);
      }

      // --- BACKFILL histórico: procesa UN tipo + UN rango de fechas por llamada.
      //     El navegador lo orquesta mes a mes (así cada invocación del Worker
      //     hace un solo informe y no revienta límites de subrequests/tiempo).
      //     Uso: POST /v1/backfill?tipo=pedidos&desde=2025-01-01&hasta=2025-01-31&key=SB_API_KEY
      //     tipo: pedidos | devoluciones | settlements
      if (url.pathname === '/v1/backfill' && request.method === 'POST') {
        const tipo = url.searchParams.get('tipo') || 'pedidos';
        const desde = url.searchParams.get('desde');   // YYYY-MM-DD
        const hasta = url.searchParams.get('hasta');   // YYYY-MM-DD
        if (!desde || !hasta) return json({ ok: false, error: 'faltan_fechas' }, cors, 400);
        try {
          const r = await backfillRango(env, tipo, desde, hasta);
          return json({ ok: true, tipo, desde, hasta, ...r }, cors);
        } catch (e) {
          return json({ ok: false, tipo, desde, hasta, error: e.message }, cors, 200);
        }
      }

      // --- Estado del backfill: qué meses (YYYY-MM) ya tienen datos, para que
      //     el navegador NO se los vuelva a pedir a Amazon. Uso: GET /v1/backfill-estado
      if (url.pathname === '/v1/backfill-estado') {
        const mesesDe = async (tabla) => {
          try {
            const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + tabla + '?select=fecha', { headers: { apikey: env.SUPABASE_SERVICE_KEY } });
            if (!r.ok) return [];
            const s = new Set();
            for (const f of (await r.json())) if (f.fecha) s.add(String(f.fecha).slice(0, 7));
            return [...s];
          } catch (_) { return []; }
        };
        // 'pedidos' se mira sobre ventas_sku_pais_dia (tabla por país): así, al
        // re-lanzar el backfill, rellena el histórico por país donde falte.
        return json({ pedidos: await mesesDe('ventas_sku_pais_dia'), devoluciones: await mesesDe('devoluciones') }, cors);
      }

      // --- Imágenes de catálogo: trae la miniatura de Amazon por ASIN.
      //     De a pocos por llamada (subrequests); el navegador repite hasta
      //     que hayMas=false. Uso: POST /v1/catalogo-imagenes?key=SB_API_KEY
      if (url.pathname === '/v1/catalogo-imagenes' && request.method === 'POST') {
        try { return json({ ok: true, ...(await traerImagenesCatalogo(env)) }, cors); }
        catch (e) { return json({ ok: false, error: e.message }, cors, 200); }
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
const _tokenCache = {}; // {scope:{token,exp}} — evita pedir token en cada llamada (menos subrequests)
async function lwaToken(env, scope) {
  // scope 'spapi' | 'ads'
  const c = _tokenCache[scope];
  if (c && c.exp > Date.now() + 60000) return c.token;   // token aún válido (>1 min)
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
  const j = await r.json();
  _tokenCache[scope] = { token: j.access_token, exp: Date.now() + ((j.expires_in || 3600) * 1000) };
  return j.access_token;
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

// Inventario FBA en TIEMPO REAL (FBA Inventory API) — sin generar informe, así
// evita el FATAL del report GET_FBA_MYI_*. Trae stock + nombre + ASIN de todos
// los SKUs de un marketplace, paginado.
async function traerInventarioFBA(env, marketplaceId) {
  const inv = {}, cat = {};
  let nextToken = null, pag = 0;
  do {
    const qs = new URLSearchParams({ details: 'true', granularityType: 'Marketplace', granularityId: marketplaceId, marketplaceIds: marketplaceId });
    if (nextToken) qs.set('nextToken', nextToken);
    const j = await spapiCall(env, '/fba/inventory/v1/summaries?' + qs.toString());
    const items = (j && j.payload && j.payload.inventorySummaries) || [];
    for (const it of items) {
      const sku = it.sellerSku || '';
      if (!sku) continue;
      const d = it.inventoryDetails || {};
      inv[sku] = {
        sku,
        disponible: (+d.fulfillableQuantity || 0),
        entrante: (+d.inboundWorkingQuantity || 0) + (+d.inboundShippedQuantity || 0) + (+d.inboundReceivingQuantity || 0),
        reservado: (d.reservedQuantity && +d.reservedQuantity.totalReservedQuantity) || 0,
        snapshot: new Date().toISOString()
      };
      const nombre = (it.productName || '').trim();
      if (nombre) cat[sku] = { sku, asin: (it.asin || '').trim(), nombre: nombre.slice(0, 300) };
    }
    nextToken = (j && j.pagination && j.pagination.nextToken) || null;
    pag++;
  } while (nextToken && pag < 10);
  return { inv, cat };
}

async function pedirInforme(env, reportType, dataStartTime, dataEndTime, marketplaceIds) {
  // Los informes "snapshot" (p.ej. inventario) NO aceptan rango de fechas:
  // se piden con dataStartTime/dataEndTime a null y solo se manda el tipo.
  const body = { reportType, marketplaceIds };
  if (dataStartTime) body.dataStartTime = dataStartTime;
  if (dataEndTime) body.dataEndTime = dataEndTime;
  const { reportId } = await spapiCall(env, '/reports/2021-06-30/reports', {
    method: 'POST',
    body: JSON.stringify(body)
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
  // Los flat files de la SP-API vienen en UTF-8 (nombres con acentos, ñ, etc.).
  return new TextDecoder('utf-8').decode(buf);
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
  for (let i = 0; i < 55; i++) {
    await sleep(4000);
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
  for (let i = 0; i < 55; i++) {
    await sleep(4000);
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

  // 1. Pedidos — AYER + HOY (parcial) por día real, para que el día en curso no
  //    salga siempre vacío en el dashboard. agregarPedidosPorDia agrupa por la
  //    fecha real de cada línea, así ayer y hoy quedan en filas separadas.
  if (planCompleto) try {
    const tsv = await pedirInforme(env,
      'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      ayer + 'T00:00:00Z', new Date().toISOString(),
      [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT]);
    const filas = parseTSV(tsv);
    await upsertSupabase(env, 'pedidos_dia', agregarPedidosPorDia(filas));
    await upsertSupabase(env, 'ventas_sku_pais_dia', agregarVentasSkuPais(filas)); // total y por país
    await upsertSupabase(env, 'productos_catalogo', catalogoDePedidos(filas)); // nombres
    resultado.pasos.push({ pedidos: filas.length });
  } catch (e) { resultado.pasos.push({ pedidos_error: e.message }); }

  // 2. Settlements nuevos (tarifas FBA REALES por unidad + devoluciones + ajustes) — solo Plan 2
  //    Tope por ejecución: cada settlement gasta varias subpeticiones; procesar
  //    muchos de golpe agota el límite del plan gratis y tumba devoluciones/
  //    inventario. Se procesan de a pocos; el resto entra en la siguiente
  //    ejecución (existeEnSupabase salta los ya hechos).
  if (planCompleto) try {
    const hace15d = new Date(Date.now() - 15 * 86400000).toISOString();
    const reps = await listarSettlements(env, hace15d);
    const topeSettle = 4;
    let procS = 0;
    for (const rep of reps) {
      if (procS >= topeSettle) break;
      const yaProcesado = await existeEnSupabase(env, 'settlements', 'report_id', rep.reportId);
      if (yaProcesado) continue;
      const tsv = await descargarDocumento(env, rep.reportDocumentId);
      const lineas = parseTSV(tsv);
      // La CABECERA primero (settlement_lineas tiene FK a settlements).
      await upsertSupabase(env, 'settlements', [{ report_id: rep.reportId, procesado: new Date().toISOString() }]);
      await upsertSupabase(env, 'settlement_lineas', mapearSettlement(lineas, rep.reportId));
      procS++;
    }
    resultado.pasos.push({ settlements: procS + (procS >= topeSettle ? ' (quedan más para la próxima)' : '') });
  } catch (e) { resultado.pasos.push({ settlements_error: e.message }); }

  // 3. Devoluciones FBA — solo Plan 2
  if (planCompleto) try {
    const hace30d = new Date(Date.now() - 30 * 86400000).toISOString();
    const tsv = await pedirInforme(env, 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
      hace30d, ayer + 'T23:59:59Z', [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT]);
    const devMap = {};
    for (const r of parseTSV(tsv)) {
      if (!r['sku'] && !r['return-date']) continue;
      const d = {
        fecha: aISO(r['return-date']), sku: r['sku'] || '', asin: r['asin'] || '',
        cantidad: +r['quantity'] || 1, motivo: r['reason'] || '', estado: r['status'] || '',
        disposicion: r['detailed-disposition'] || ''
      };
      const k = [d.fecha, d.sku, d.asin, d.motivo, d.estado, d.disposicion].join('|');
      if (devMap[k]) devMap[k].cantidad += d.cantidad; else devMap[k] = d; // agrupa duplicados
    }
    const nDev = await guardarDevoluciones(env, Object.values(devMap));
    resultado.pasos.push({ devoluciones: nDev });
  } catch (e) { resultado.pasos.push({ devoluciones_error: e.message }); }

  // 3c. Inventario FBA (tiempo real, FBA Inventory API — sin informe → sin FATAL).
  //     Trae stock + nombre + ASIN de TODOS los SKUs (hayan vendido o no).
  if (planCompleto) try {
    const { inv, cat } = await traerInventarioFBA(env, MARKETPLACES.ES);
    if (Object.keys(inv).length) await upsertSupabase(env, 'inventario', Object.values(inv));
    if (Object.keys(cat).length) await upsertSupabase(env, 'productos_catalogo', Object.values(cat));
    resultado.pasos.push({ inventario: Object.keys(inv).length });
  } catch (e) { resultado.pasos.push({ inventario_error: e.message }); }

  // 3b. Keywords reales de Amazon (Brand Analytics — requiere Brand Registry y rol aprobado)
  //     Solo lunes: gasta subrequests y suele fallar sin Brand Registry; no hace falta a diario.
  if (planCompleto && new Date().getUTCDay() === 1) try {
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

  // PPC (Ads API) va en SU PROPIA invocación (/v1/ingest-ppc) para no pasar
  // el límite de 50 subpeticiones del plan gratis de Cloudflare al juntarlo
  // con SP-API. El botón admin lo llama después, en una segunda petición.

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
 * INGESTA PPC (Ads API) — invocación separada para respetar el límite de
 * 50 subpeticiones del plan gratis. Trae ppc_dia + ppc_campanas (+ términos).
 * Uso: POST /v1/ingest-ppc  (opcional ?terminos=1 para forzar los términos).
 * =================================================================== */
async function ingestaPPC(env, opts) {
  const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const forzarTerminos = !!(opts && opts.terminos);
  const soloPais = opts && opts.pais;   // si viene, procesa SOLO ese país
  // 'solo' separa los DOS informes de Ads en invocaciones distintas (cada uno
  // es 1 informe → no se pasa del límite de subpeticiones del plan gratis):
  //   solo='dia'      → solo PPC del día
  //   solo='terminos' → solo términos de búsqueda
  //   (sin 'solo')    → ambos (cron / plan de pago)
  const solo = opts && opts.solo;
  const perfiles = soloPais ? (ADS_PROFILES[soloPais] ? { [soloPais]: ADS_PROFILES[soloPais] } : {}) : ADS_PROFILES;
  const resultado = { fecha: ayer, pasos: [] };

  // 1. PPC del día por país
  if (solo !== 'terminos') for (const [pais, profileId] of Object.entries(perfiles)) {
    try {
      const ads = await adsInformeDiario(env, ayer, profileId);
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
      await upsertSupabase(env, 'ppc_campanas', (ads || []).map(c => ({
        fecha: ayer, pais, campania_id: String(c.campaignId || ''), nombre: c.campaignName || '',
        gasto: +(c.cost || 0).toFixed(2), clics: c.clicks || 0, impresiones: c.impressions || 0,
        ventas_ppc: +(c.sales14d || 0).toFixed(2), pedidos_ppc: c.purchases14d || 0
      })));
      resultado.pasos.push({ ['ppc_' + pais]: 'ok · ' + (ads ? ads.length : 0) + ' campañas' });
    } catch (e) { resultado.pasos.push({ ['ppc_' + pais + '_error']: e.message }); }
  }

  // 2. Términos de búsqueda (resumen 30 días) — solo lunes UTC o si se fuerza.
  if (solo !== 'dia' && (forzarTerminos || solo === 'terminos' || new Date().getUTCDay() === 1)) {
    const hastaT = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const desdeT = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    for (const [pais, profileId] of Object.entries(perfiles)) {
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

// Tabla "Beneficio por producto" para un rango cualquiera (mismo criterio que
// v_productos_mes: reparte tarifas con el ratio de cuenta del periodo; estima
// 15%+15% si no hay settlements; resta el coste si está puesto).
async function productosPeriodo(env, desde, hasta, pais) {
  // Lee de la tabla granular por país (permite filtrar por país). Si aún no
  // está poblada (histórico sin re-backfill), cae a pedidos_dia (sin país).
  const filtroPais = pais ? '&pais=eq.' + encodeURIComponent(pais) : '';
  let ped = await selSafe(env, 'ventas_sku_pais_dia?fecha=gte.' + desde + '&fecha=lte.' + hasta + filtroPais + '&select=sku,fecha,uds,ventas', []);
  if (!ped || !ped.length) {
    ped = await selSafe(env, 'pedidos_dia?fecha=gte.' + desde + '&fecha=lte.' + hasta + '&select=sku,fecha,uds,ventas', []);
  }
  const bySku = {};
  let tv = 0;
  for (const r of (ped || [])) {
    const s = r.sku || '';
    if (!s || /^amzn\.gr\./i.test(s)) continue;   // ignora reacondicionados de Amazon
    if (!bySku[s]) bySku[s] = { sku: s, uds: 0, ventas: 0, dias: {} };
    bySku[s].uds += +r.uds || 0;
    bySku[s].ventas += +r.ventas || 0;
    bySku[s].dias[String(r.fecha).slice(0, 10)] = (bySku[s].dias[String(r.fecha).slice(0, 10)] || 0) + (+r.uds || 0);
    tv += +r.ventas || 0;
  }
  // TARIFA REAL POR UNIDAD (de v_fee_sku, todo el histórico) → se aplica a las
  // unidades vendidas. Resuelve el desfase de liquidación de Amazon: aunque este
  // mes no estén liquidadas todas las unidades, el €/ud es el real y CUADRA.
  const feeUnit = {};   // {sku: {perUnit, fbaU, comU}}
  try {
    for (const r of (await selectSupabase(env, 'v_fee_sku?select=sku,uds_liq,fba,com'))) {
      const u = +r.uds_liq || 0;
      if (u > 0) feeUnit[r.sku] = { fbaU: (+r.fba || 0) / u, comU: (+r.com || 0) / u, perUnit: ((+r.fba || 0) + (+r.com || 0)) / u };
    }
  } catch (_) { /* sin v_fee_sku → se estima con % abajo */ }
  const costes = {}; try { for (const c of (await selectSupabase(env, 'costes_producto?select=sku,coste'))) costes[c.sku] = +c.coste || 0; } catch (_) {}
  const cat = {}; try { for (const c of (await selectSupabase(env, 'productos_catalogo?select=sku,nombre,imagen'))) cat[c.sku] = c; } catch (_) {}
  const fin = new Date(hasta + 'T00:00:00Z');
  const dias10 = [];
  for (let i = 9; i >= 0; i--) dias10.push(new Date(fin.getTime() - i * 86400000).toISOString().slice(0, 10));
  return Object.values(bySku).map(p => {
    const coste = costes[p.sku];
    const nocoste = coste === undefined;
    const costeTot = +(p.uds * (coste || 0)).toFixed(2);
    const fu = feeUnit[p.sku];
    const real = !!fu;                                    // ¿tenemos tarifa/ud real?
    const precioMed = p.uds > 0 ? p.ventas / p.uds : 0;
    const fba = +((real ? fu.fbaU * p.uds : p.ventas * 0.15)).toFixed(2);
    const com = +((real ? fu.comU * p.uds : p.ventas * 0.15)).toFixed(2);
    const dev = 0;
    const amazon = +(com + fba + dev).toFixed(2);        // lo que se queda Amazon
    const ben = +(p.ventas - costeTot - amazon).toFixed(2);
    const mg = p.ventas > 0 ? +(ben / p.ventas * 100).toFixed(1) : 0;
    const c = cat[p.sku] || {};
    return {
      nom: (c.nombre || p.sku), sku: p.sku, emoji: '📦', imagen: c.imagen || null,
      uds: p.uds, ventas: +p.ventas.toFixed(2),
      coste: costeTot, comision: com, fba, devol: dev, amazon,
      real, ppc: 0, ben, mg,
      trend: dias10.map(d => p.dias[d] || 0),
      estado: nocoste ? 'am' : (mg < 0 ? 'rd' : mg < 15 ? 'am' : 'gn'),
      txt: nocoste ? 'Sin coste ➜ clic' : (mg < 0 ? 'Pierde' : mg < 15 ? 'Margen bajo' : 'OK')
    };
  }).sort((a, b) => b.ventas - a.ventas).slice(0, 50);
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

  // --- 1) Acciones a nivel de PRODUCTO (P&L) ---
  for (const p of (productos || [])) {
    // Producto que PIERDE dinero (margen negativo) — la de PPC ya no exige ppc>0
    // porque el PPC no se atribuye por SKU; basta con que el margen sea negativo.
    if (p.mg < 0 && p.ventas > 30) acciones.push({
      _v: Math.abs(p.ben) || p.ventas,
      ic: '🔴', bg: 'rgba(232,64,64,.15)', c: 'var(--rd)',
      t: 'Revisa «' + p.nom + '»: margen ' + p.mg + '%',
      v: p.ben < 0 ? p.ben.toFixed(2).replace('.', ',') + '€' : 'margen ' + p.mg + '%',
      p: 'Pierde dinero por venta: sube precio, baja coste o revisa tarifas/PPC.'
    });
    // Producto SIN coste cargado → margen no es real (recordatorio de acción)
    else if (p.txt === 'Sin coste ➜ clic' && p.ventas > 100) acciones.push({
      _v: p.ventas * 0.001,
      ic: '✏️', bg: 'rgba(74,158,222,.15)', c: 'var(--bl)',
      t: 'Añade el coste de «' + p.nom + '»',
      v: 'margen exacto',
      p: 'Sin coste, su margen es estimado. Clic en el producto para ponerlo.'
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
// Amazon EU manda fechas como DD.MM.YYYY (a veces ISO). Postgres necesita YYYY-MM-DD.
function aISO(s) {
  s = (s || '').trim();
  let m = s.match(/^(\d{2})[.\/-](\d{2})[.\/-](\d{4})/);   // DD.MM.YYYY
  if (m) return m[3] + '-' + m[2] + '-' + m[1];
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                 // ya ISO
  if (m) return m[0];
  return (s.slice(0, 10) || null);
}

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

// Extrae el catálogo (nombre + ASIN por SKU) del informe de pedidos. El
// nombre viene gratis en el flat file; la imagen se pide aparte por ASIN.
// No incluye 'imagen' en el payload → el upsert NO pisa la imagen ya guardada.
function catalogoDePedidos(filas) {
  const cat = {};
  for (const r of filas) {
    const sku = r['sku'] || '';
    const nombre = (r['product-name'] || '').trim();
    if (!sku || cat[sku]) continue;
    cat[sku] = { sku, asin: (r['asin'] || '').trim(), nombre: nombre.slice(0, 300) };
  }
  return Object.values(cat);
}

// Guarda devoluciones tolerando el constraint real de la tabla: si choca
// (error 21000 = dos filas del lote comparten la clave única), reagrupa por
// una clave más gruesa y reintenta. Así funciona sea cual sea el constraint.
async function guardarDevoluciones(env, rows) {
  if (!rows || !rows.length) return 0;
  const reagrupar = (arr, campos) => {
    const m = {};
    for (const d of arr) {
      const k = campos.map(c => d[c]).join('|');
      if (m[k]) m[k].cantidad += d.cantidad;
      else m[k] = { fecha: d.fecha, sku: d.sku, asin: d.asin, motivo: d.motivo, estado: d.estado, disposicion: d.disposicion, cantidad: d.cantidad };
    }
    return Object.values(m);
  };
  const intentos = [
    rows,
    () => reagrupar(rows, ['fecha', 'sku', 'motivo']),
    () => reagrupar(rows, ['fecha', 'sku'])
  ];
  let ultimo;
  for (let i = 0; i < intentos.length; i++) {
    const lote = typeof intentos[i] === 'function' ? intentos[i]() : intentos[i];
    try { await upsertSupabase(env, 'devoluciones', lote); return lote.length; }
    catch (e) { ultimo = e; if (!/21000/.test(e.message)) throw e; } // solo reintenta si es colisión
  }
  throw ultimo;
}

// Como agregarPedidos, pero para un RANGO de varios días: agrupa por (día, sku)
// usando la fecha real de compra de cada línea, no una fecha fija.
function agregarPedidosPorDia(filas) {
  const porClave = {};
  for (const r of filas) {
    if ((r['item-status'] || '').toLowerCase() === 'cancelled') continue;
    const fecha = aISO(r['purchase-date']);
    if (!fecha) continue;
    const sku = r['sku'] || 'desconocido';
    const k = fecha + '|' + sku;
    if (!porClave[k]) porClave[k] = { fecha, sku, marketplace: (r['sales-channel'] || '').replace('Amazon.', '').toUpperCase(), unidades: 0, ventas: 0, pedidos: 0 };
    porClave[k].unidades += +r['quantity'] || 0;
    porClave[k].ventas += +((r['item-price'] || '0').replace(',', '.')) || 0;
    porClave[k].pedidos += 1;
  }
  return Object.values(porClave);
}

// Normaliza el canal de venta de Amazon a un código de país ISO limpio.
// Amazon usa dominios: Amazon.es, Amazon.com.be (Bélgica), Amazon.co.uk (UK)…
function paisDeCanal(sc) {
  sc = (sc || '').toLowerCase().trim();
  if (!sc || sc.indexOf('non-amazon') > -1) return 'OTROS';
  const s = sc.replace('amazon.', '');
  const MAP = {
    'es': 'ES', 'fr': 'FR', 'it': 'IT', 'de': 'DE', 'nl': 'NL', 'se': 'SE',
    'pl': 'PL', 'com.be': 'BE', 'co.uk': 'GB', 'ie': 'IE', 'com.tr': 'TR',
    'com': 'US', 'ca': 'CA', 'com.mx': 'MX', 'com.br': 'BR', 'com.au': 'AU',
    'in': 'IN', 'co.jp': 'JP', 'sg': 'SG', 'ae': 'AE', 'sa': 'SA', 'eg': 'EG'
  };
  return MAP[s] || s.toUpperCase();
}

// Ventas granulares por (día · sku · país) — fuente fiable para totales y país.
function agregarVentasSkuPais(filas) {
  const m = {};
  for (const r of filas) {
    if ((r['item-status'] || '').toLowerCase() === 'cancelled') continue;
    const fecha = aISO(r['purchase-date']);
    if (!fecha) continue;
    const sku = r['sku'] || 'desconocido';
    const pais = paisDeCanal(r['sales-channel']);
    const k = fecha + '|' + sku + '|' + pais;
    if (!m[k]) m[k] = { fecha, sku, pais, uds: 0, ventas: 0, pedidos: 0 };
    m[k].uds += +r['quantity'] || 0;
    m[k].ventas += +((r['item-price'] || '0').replace(',', '.')) || 0;
    m[k].pedidos += 1;
  }
  return Object.values(m);
}

// Trae miniaturas del catálogo de Amazon por ASIN, de a pocos por llamada.
async function traerImagenesCatalogo(env) {
  const pend = await selectSupabase(env, 'productos_catalogo?imagen=is.null&asin=not.is.null&limit=8');
  let ok = 0;
  for (const p of (pend || [])) {
    if (!p.asin) continue;
    try {
      const item = await getCatalogoItem(env, p.asin, MARKETPLACES.ES);
      const imgs = (item && item.images && item.images[0] && item.images[0].images) || [];
      const main = imgs.find(x => x.variant === 'MAIN') || imgs[0];
      const imagen = main ? main.link : null;
      const nombre = (item && item.summaries && item.summaries[0] && item.summaries[0].itemName) || p.nombre || null;
      if (imagen) { await upsertSupabase(env, 'productos_catalogo', [{ sku: p.sku, imagen, nombre }]); ok++; }
    } catch (_) { /* si un ASIN falla, seguimos con el resto */ }
  }
  return { procesados: ok, pendientes: (pend || []).length, hayMas: (pend || []).length >= 8 };
}

async function getCatalogoItem(env, asin, marketplaceId) {
  return spapiCall(env, '/catalog/2022-04-01/items/' + encodeURIComponent(asin) +
    '?marketplaceIds=' + marketplaceId + '&includedData=images,summaries');
}

// Rellena el histórico de UN tipo en UN rango. Lo llama el navegador mes a mes.
async function backfillRango(env, tipo, desde, hasta) {
  const planCompleto = !!(env.LWA_CLIENT_ID && env.SPAPI_REFRESH_TOKEN);
  if (!planCompleto) throw new Error('SP-API no configurada (faltan secretos LWA/SPAPI)');
  const MKT = [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT];

  if (tipo === 'pedidos') {
    const tsv = await pedirInforme(env, 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      desde + 'T00:00:00Z', hasta + 'T23:59:59Z', MKT);
    const filas = parseTSV(tsv);
    const rows = agregarPedidosPorDia(filas);
    await upsertSupabase(env, 'pedidos_dia', rows);
    await upsertSupabase(env, 'ventas_sku_pais_dia', agregarVentasSkuPais(filas)); // total y por país
    await upsertSupabase(env, 'productos_catalogo', catalogoDePedidos(filas)); // nombres
    return { filas: filas.length, guardados: rows.length };
  }

  if (tipo === 'devoluciones') {
    const tsv = await pedirInforme(env, 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
      desde + 'T00:00:00Z', hasta + 'T23:59:59Z', MKT);
    const devMap = {};
    for (const r of parseTSV(tsv)) {
      if (!r['sku'] && !r['return-date']) continue;
      const d = {
        fecha: aISO(r['return-date']), sku: r['sku'] || '', asin: r['asin'] || '',
        cantidad: +r['quantity'] || 1, motivo: r['reason'] || '', estado: r['status'] || '',
        disposicion: r['detailed-disposition'] || ''
      };
      const k = [d.fecha, d.sku, d.asin, d.motivo, d.estado, d.disposicion].join('|');
      if (devMap[k]) devMap[k].cantidad += d.cantidad; else devMap[k] = d;
    }
    const guardados = await guardarDevoluciones(env, Object.values(devMap));
    return { filas: Object.keys(devMap).length, guardados };
  }

  if (tipo === 'settlements') {
    // Los settlement NO se piden por rango: Amazon los genera solo y solo se
    // pueden LISTAR, y con RETENCIÓN de 90 DÍAS (createdSince más antiguo → 400).
    // Se topa a 89 días; el navegador repite hasta que 'hayMas' sea false.
    const min90 = new Date(Date.now() - 89 * 86400000).toISOString();
    let createdSince = desde + 'T00:00:00Z';
    if (new Date(createdSince) < new Date(min90)) createdSince = min90;
    const reps = await listarSettlements(env, createdSince);
    const tope = 5;
    let nuevos = 0, lineasT = 0;
    for (const rep of reps) {
      if (nuevos >= tope) break;
      if (await existeEnSupabase(env, 'settlements', 'report_id', rep.reportId)) continue;
      const tsv = await descargarDocumento(env, rep.reportDocumentId);
      const lineas = mapearSettlement(parseTSV(tsv), rep.reportId);
      // La CABECERA primero (settlement_lineas tiene FK a settlements).
      await upsertSupabase(env, 'settlements', [{ report_id: rep.reportId, procesado: new Date().toISOString() }]);
      await upsertSupabase(env, 'settlement_lineas', lineas);
      nuevos++; lineasT += lineas.length;
    }
    return { informes: reps.length, nuevos, lineas: lineasT, hayMas: nuevos >= tope };
  }

  throw new Error('tipo desconocido: ' + tipo);
}

function mapearSettlement(lineas, reportId) {
  return lineas
    .filter(l => l['transaction-type'])
    .map(l => ({
      report_id: reportId,
      fecha: aISO(l['posted-date']),
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
