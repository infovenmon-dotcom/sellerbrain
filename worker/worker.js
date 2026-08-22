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
 * ALERTAS POR EMAIL (opcional) — resumen diario de stock bajo / ACoS alto /
 * sobrecostes. Se envía a las 07:00 UTC solo si hay algo que contar. MULTI-TENANT:
 * cada vendedor recibe SUS alertas en SU email de registro (el identificador de
 * vendedor en SellerBrain ES su email). Stock se filtra por vendedor; ACoS y
 * sobrecostes (aún de la cuenta propia) solo se envían al owner.
 *   ALERTAS_EMAIL=1                 (interruptor global: sin esto, no se envía nada)
 *   ALERTAS_TO=tucorreo@dominio     (a dónde van las alertas de TU cuenta, VENMON)
 *   OWNER_SELLER=venmon             (opcional; identificador de la cuenta propia)
 *   ALERTAS_STOCK_DIAS=14           (opcional; avisa si cobertura <= N días)
 *   ALERTAS_ACOS=40                 (opcional; avisa si ACoS 7d > N%)
 *   ALERTAS_SOBRECOSTE=20           (opcional; avisa si recuperable >= N €/mes)
 *   ALERTAS_PERDIDA_MIN=30          (opcional; avisa de productos en pérdidas con ventas >= N €/30d)
 *   Los clientes de pago reciben las suyas automáticamente (tabla miembros).
 *   Prueba:  GET /v1/alertas-test?to=tucorreo[&seller=email_del_cliente]
 *
 * EJECUCIÓN vía Ads API (opcional, OFF por defecto) — pausar/reactivar campañas
 * REALES desde el panel. Doble seguridad: clave admin + interruptor.
 *   ADS_WRITE=1   (sin esto, /v1/ads/campana-estado devuelve 403). El frontend
 *   siempre pide confirmación antes de enviar el cambio a Amazon.
 *
 * CRON (wrangler.toml) — HORARIO, no diario:
 *   [triggers]
 *   crons = ["0 * * * *"]   # cada hora: foto PPC + refresco de ventas; 03:00 ingesta completa
 *   (Si pegas el worker a mano, cambia el Cron Trigger en el panel de Cloudflare a "0 * * * *".)
 * =====================================================================
 */

const SB_VERSION = 'v133-cors-multiorigen'; // súbelo al cambiar el Worker (para verificar despliegue)
const SPAPI_HOST = 'https://sellingpartnerapi-eu.amazon.com'; // EU
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const ADS_HOST = 'https://advertising-api-eu.amazon.com';
const MARKETPLACES = {
  ES: 'A1RKKUPIHCS9HS', FR: 'A13V1IB3VIYZZH', IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9', NL: 'A1805IZSGTT6HS', BE: 'AMEN7PMS3EDWL', UK: 'A1F83G8C2ARO7P'
};

// Centro logístico (fulfillment-center-id) -> país de SALIDA. El prefijo (3 letras,
// normalmente código IATA de la ciudad) identifica el país. Editable/ampliable: si
// aparece un FC no mapeado, la ingesta lo marca '?' y lo lista en el diagnóstico.
const FC_PAIS = {
  // España
  MAD:'ES', BCN:'ES', SVQ:'ES', VLC:'ES', RMU:'ES', OVD:'ES', ZAZ:'ES', GRX:'ES',
  ALC:'ES', SCQ:'ES', SDR:'ES', SVU:'ES', XSB:'ES', LEI:'ES', AGP:'ES', SZW:'ES',
  // Italia
  MXP:'IT', BGY:'IT', BLQ:'IT', FCO:'IT', TRN:'IT', PSR:'IT', CIA:'IT', VCE:'IT',
  NAP:'IT', TSF:'IT', SUF:'IT', PMF:'IT', FRL:'IT', CAG:'IT', REG:'IT', BRI:'IT',
  PSA:'IT', VRN:'IT', TRS:'IT', MER:'IT',
  // Francia
  ORY:'FR', CDG:'FR', BVA:'FR', MRS:'FR', LYS:'FR', ETZ:'FR', LIL:'FR', LEH:'FR',
  NTE:'FR', MLH:'FR', RNS:'FR', MPL:'FR', TLS:'FR', BOD:'FR', LIO:'FR',
  // Alemania
  LEJ:'DE', DTM:'DE', FRA:'DE', CGN:'DE', HAM:'DE', MUC:'DE', STR:'DE', DUS:'DE',
  HAJ:'DE', NUE:'DE', KSF:'DE', GHF:'DE', SCN:'DE', ERF:'DE', PAD:'DE', BER:'DE',
  // Polonia / NL / BE / CZ / SE / UK
  WRO:'PL', POZ:'PL', KTW:'PL', SZZ:'PL', LCJ:'PL', GDN:'PL', WAW:'PL', KRK:'PL',
  EIN:'NL', AMS:'NL', RTM:'NL', BRU:'BE', LGG:'BE', CRL:'BE', ANR:'BE',
  PRG:'CZ', BRQ:'CZ', OSR:'CZ', ARN:'SE', GOT:'SE',
  LTN:'GB', MAN:'GB', EMA:'GB', BHX:'GB', LBA:'GB', GLA:'GB', EDI:'GB', BRS:'GB'
};
function paisDeFC(fc) {
  const p = String(fc || '').toUpperCase().slice(0, 3);
  return FC_PAIS[p] || '?';
}
// Ingesta del Informe de Envíos Gestionados por Amazon → país de SALIDA (del FC) y
// país de DESTINO (ship-country) por pedido/SKU. NO necesita rol fiscal. Es la base
// para atribuir el sobrecoste logístico al país correcto (cruzando con el settlement).
// Ingesta de UNA ventana (para no encadenar varios informes en la misma petición
// y agotar el tiempo del worker). El informe limita a ~30 días -> dias se capa a 29.
// off = días de desfase hacia atrás (0 = ventana más reciente; 29 = la anterior…).
async function ingestaEnvios(env, ctx, diasArg, offArg) {
  const seller = (ctx && ctx.seller) || 'venmon';
  const dias = Math.min(+diasArg || 29, 29);
  const off = Math.max(+offArg || 0, 0);
  const diag = { filas: 0, desconocidos: [], por_salida: {}, off, dias };
  const hoy = new Date();
  const hasta = new Date(hoy.getTime() - off * 86400000).toISOString();
  const desde = new Date(hoy.getTime() - (off + dias) * 86400000).toISOString();
  const MK = [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT, MARKETPLACES.DE, MARKETPLACES.NL, MARKETPLACES.BE];
  let tsv = '';
  try {
    tsv = await pedirInforme(env, 'GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL', desde, hasta, MK, undefined, ctx);
  } catch (e) { diag.error = e.message; return diag; }
  const byKey = {}, desc = {};
  for (const r of parseTSV(tsv)) {
    const oid = r['amazon-order-id'] || '';
    const sku = r['sku'] || '';
    if (!oid || !sku) continue;
    const fc = (r['fulfillment-center-id'] || '').toUpperCase();
    const psal = paisDeFC(fc);
    if (psal === '?' && fc) desc[fc] = (desc[fc] || 0) + 1;
    const k = oid + '|' + sku;
    if (!byKey[k]) byKey[k] = {
      order_id: oid, sku, fc, pais_salida: psal,
      pais_destino: (r['ship-country'] || '').toUpperCase(), uds: 0,
      fecha: (r['shipment-date'] || r['purchase-date'] || '').slice(0, 10) || null
    };
    byKey[k].uds += (+(r['quantity-shipped'] || 0) || 0);
  }
  const rows = Object.values(byKey);
  for (let i = 0; i < rows.length; i += 500) {
    await upsertSupabase(env, 'envios_fc', conSeller(rows.slice(i, i + 500), seller));
  }
  diag.filas = rows.length;
  diag.desconocidos = Object.keys(desc).map(k => k + ' (' + desc[k] + ')');
  rows.forEach(r => { diag.por_salida[r.pais_salida] = (diag.por_salida[r.pais_salida] || 0) + 1; });
  return diag;
}

export default {
  // ============ HTTP ============
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // CORS con lista de orígenes permitidos: refleja el Origin de la petición si está
    // en la lista (así valen sellersbrain.io, www y la URL de Netlify a la vez). Se
    // pueden añadir más por la variable CORS_ORIGIN (separados por comas).
    const origen = request.headers.get('Origin') || '';
    const permitidos = ['https://sellersbrain.io', 'https://www.sellersbrain.io', 'https://sellerbrain.netlify.app'];
    if (env.CORS_ORIGIN) for (const o of env.CORS_ORIGIN.split(',')) { const t = o.trim(); if (t && !permitidos.includes(t)) permitidos.push(t); }
    const allowOrigin = permitidos.includes(origen) ? origen : permitidos[0];
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Content-Type': 'application/json'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      // --- Salud + VERSIÓN (público). Sirve para comprobar si el Worker está
      //     actualizado: abre la URL/health y mira 'version'. ---
      if (url.pathname === '/health' || url.pathname === '/' || url.pathname === '/version') {
        return json({ ok: true, version: SB_VERSION, ts: new Date().toISOString() }, cors);
      }

      // --- ACCIÓN desde el correo (botón "pausar" / "bajar puja"). El token va
      //     firmado (HMAC) y caduca; hacer clic aplica el cambio en Amazon. No pide
      //     login: el token ES la capacidad. Sigue exigiendo ADS_WRITE=1. ---
      if (url.pathname.startsWith('/a/')) {
        const o = await verificarToken(env, url.pathname.slice(3));
        if (!o) return paginaAccion('Enlace no válido o caducado', 'Este enlace ha caducado o no es correcto. Entra en SellerBrain para hacer el cambio a mano.', false);
        if (String(env.ADS_WRITE || '') !== '1') return paginaAccion('Ejecución desactivada', 'La escritura en Amazon está desactivada (ADS_WRITE). No se ha cambiado nada.', false);
        if (o.a === 'pausa') {
          let r = {}; try { r = await adsCampanaEstado(env, o.pais, o.cid, 'PAUSED'); } catch (_) {}
          return paginaAccion(r.aplicado ? '✓ Campaña pausada' : 'No se pudo pausar',
            r.aplicado ? '«' + (o.nom || o.cid) + '» (' + o.pais + ') está PAUSADA en Amazon. Puedes reactivarla cuando quieras desde SellerBrain.' : 'Amazon no confirmó el cambio. Revísalo en SellerBrain.', !!r.aplicado);
        }
        if (o.a === 'puja') {
          const token = await lwaToken(env, 'ads');
          const profileId = ADS_PROFILES[o.pais];
          let aplicado = false;
          if (profileId) {
            try {
              const rr = await fetch(ADS_HOST + '/sp/keywords', { method: 'PUT', headers: { 'Authorization': 'Bearer ' + token, 'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID, 'Amazon-Advertising-API-Scope': profileId, 'Content-Type': 'application/vnd.spKeyword.v3+json', 'Accept': 'application/vnd.spKeyword.v3+json' }, body: JSON.stringify({ keywords: [{ keywordId: String(o.kw), bid: +o.puja }] }) });
              const dd = await rr.json().catch(() => null);
              aplicado = !!(dd && dd.keywords && dd.keywords.success && dd.keywords.success.length);
            } catch (_) {}
          }
          return paginaAccion(aplicado ? '✓ Puja bajada' : 'No se pudo cambiar', aplicado ? 'La puja de «' + (o.nom || o.kw) + '» es ahora ' + (+o.puja).toFixed(2) + '€ en Amazon.' : 'Amazon no confirmó. Revísalo en SellerBrain.', aplicado);
        }
        return paginaAccion('Acción desconocida', 'No se reconoce la acción del enlace.', false);
      }

      // ============ SEGURIDAD ============
      // Cliente que está viendo (para FILTRAR los datos por su seller). Se resuelve
      // abajo, en cuanto la autorización pasa. Por defecto 'venmon' (dueño).
      let sellerActual = 'venmon';
      // Todos los endpoints /v1/* requieren la clave privada (secreto SB_API_KEY).
      // Se acepta como cabecera "Authorization: Bearer LACLAVE" o como ?key=LACLAVE.
      // Excepciones públicas: /auth/ads/* (OAuth de clientes) y /v1/login (el
      // login del portal lo llama el navegador, que NO puede tener SB_API_KEY).
      // POST /v1/feedback es público (lo envía el navegador del cliente desde el formulario).
      // POST /v1/lista-espera es público (alta en la lista de espera desde la landing).
      const feedbackPublico = url.pathname === '/v1/feedback' && request.method === 'POST';
      const listaEsperaPublica = url.pathname === '/v1/lista-espera' && request.method === 'POST';
      if (url.pathname.startsWith('/v1/') && url.pathname !== '/v1/login' && !feedbackPublico && !listaEsperaPublica) {
        const auth = (request.headers.get('Authorization') || '').replace('Bearer ', '');
        const key = auth || url.searchParams.get('key') || '';
        let ok = env.SB_API_KEY && key === env.SB_API_KEY;
        // Endpoints de LECTURA que un miembro puede consultar con su token de
        // login (JWT). Los de admin (ingest, ads, terminos…) siguen exigiendo
        // la SB_API_KEY maestra — la clave maestra nunca sale al navegador.
        const MIEMBRO_OK = url.pathname.startsWith('/v1/ppc') || url.pathname === '/v1/dashboard' || url.pathname === '/v1/plan' || url.pathname === '/v1/keywords' || url.pathname === '/v1/nichos' || url.pathname === '/v1/costes' || url.pathname === '/v1/comparativa' || url.pathname === '/v1/productos' || url.pathname === '/v1/ventas-pais' || url.pathname === '/v1/producto-detalle' || url.pathname === '/v1/satisfaccion' || url.pathname === '/v1/serie' || url.pathname === '/v1/mensual' || url.pathname === '/v1/pnl' || url.pathname === '/v1/pnl/desglose' || url.pathname === '/v1/cobertura' || url.pathname === '/v1/devoluciones' || url.pathname === '/v1/reembolsos-cliente' || url.pathname === '/v1/fugas' || url.pathname === '/v1/stock' || url.pathname === '/v1/stock-pais' || url.pathname === '/v1/ingest-ventas' || url.pathname === '/v1/reembolsos' || url.pathname === '/v1/alertas-prefs' || url.pathname === '/v1/buybox' || url.pathname === '/v1/ads/placement' || url.pathname === '/v1/ads/asin-gasto' || url.pathname === '/v1/listing-actual' || url.pathname === '/v1/ads/keywords' || url.pathname === '/v1/ads/keywords-perf' || url.pathname === '/v1/ads/keywords-perf-probe' || url.pathname === '/v1/sqp' || url.pathname === '/v1/fichas' || url.pathname === '/v1/resenas' || url.pathname === '/v1/listings';
        if (!ok) {
          // ¿JWT de login válido? Si el email es de un ADMIN (dueño), acceso TOTAL
          // (incluye ejecución de Ads, ingestas…) sin pegar la clave maestra. Si es
          // un miembro normal, solo los endpoints de lectura (MIEMBRO_OK).
          // Aceptamos el JWT venga por la CABECERA (auth) o por ?key= (algunos
          // botones admin antiguos lo mandan así) → así el login vale para todo y
          // no salta el «sesión caducada» que llevaba al formulario de la clave.
          const payload = (await verificarJWT(env, auth)) || (key && key !== auth ? await verificarJWT(env, key) : null);
          if (payload) {
            const admins = String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
            if (admins.length && admins.includes(String(payload.email || '').toLowerCase())) ok = true;   // dueño = admin
            else if (MIEMBRO_OK) ok = true;                                                                 // miembro = solo lectura
          }
        }
        if (!ok) return json({ error: 'no_autorizado' }, cors, 401);
        // Autorizado → resolvemos QUIÉN es para filtrar sus datos (aislamiento multicuenta).
        sellerActual = await sellerDeLogin(env, auth, key);
      }

      // --- LISTA DE ESPERA · alta pública desde la landing (pre-lanzamiento).
      //     POST {email, origen?}. Guarda en la tabla `lista_espera` (email = PK,
      //     así no se duplica). No expone datos: solo confirma ok. ---
      if (url.pathname === '/v1/lista-espera' && request.method === 'POST') {
        let b; try { b = await request.json(); } catch (_) { b = {}; }
        const email = String(b.email || '').trim().toLowerCase();
        const origen = String(b.origen || 'landing').slice(0, 40);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: 'email_invalido' }, cors, 400);
        try { await upsertSupabase(env, 'lista_espera', [{ email, origen }]); }
        catch (e) { return json({ ok: false, error: 'no_guardado' }, cors, 500); }
        return json({ ok: true }, cors);
      }
      // --- LISTA DE ESPERA · lectura (solo admin: exige SB_API_KEY, ya filtrada arriba). ---
      if (url.pathname === '/v1/lista-espera' && request.method === 'GET') {
        const filas = await selSafe(env, 'lista_espera?select=email,origen,creado&order=creado.desc&limit=5000', []);
        return json({ total: (filas || []).length, lista: filas || [] }, cors);
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
        const admins = String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
        const esAdmin = admins.length > 0 && admins.includes(email);
        return json({ ok: true, token, plan: m.plan || 'beta', expira: m.expira || null, admin: esAdmin }, cors);
      }

      // --- WEBHOOK de Stripe: al pagar, crea el miembro solo (y le manda el acceso
      //     por email si hay proveedor configurado). Público: la firma de Stripe es
      //     la autenticación. Requiere el secreto STRIPE_WEBHOOK_SECRET. ---
      if (url.pathname === '/stripe/webhook' && request.method === 'POST') {
        const raw = await request.text();
        const firmaOk = await verificarStripe(env.STRIPE_WEBHOOK_SECRET, request.headers.get('stripe-signature'), raw);
        if (!firmaOk) return new Response('firma invalida', { status: 400 });
        let evt; try { evt = JSON.parse(raw); } catch (_) { return new Response('json', { status: 400 }); }
        // Idempotencia: si ya procesamos este evento, no repetir.
        try { if (evt.id && await existeEnSupabase(env, 'stripe_eventos', 'id', evt.id)) return json({ ok: true, dup: true }, cors); } catch (_) {}
        let creado = null;
        // Solo el checkout.session.completed decide alta/renovación (trae `mode`).
        // El fundador (25€ único) y el mensual (~20€) se PARECEN en importe: la única
        // señal fiable es el TIPO de pago → 'payment' = fundador, 'subscription' = renovación.
        if (evt.type === 'checkout.session.completed') {
          let o = (evt.data && evt.data.object) || {};
          // Si el payload es "reducido" (thin: no trae email/mode), pedimos la sesión completa.
          if ((!o.mode || !(o.customer_details || o.customer_email || o.receipt_email)) && env.STRIPE_SECRET_KEY && o.id) {
            try {
              const rr = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(o.id),
                { headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY } });
              const full = await rr.json(); if (full && full.id) o = full;
            } catch (_) {}
          }
          const email = ((o.customer_details && o.customer_details.email) || o.customer_email || o.receipt_email || '').trim().toLowerCase();
          const nombre = (o.customer_details && o.customer_details.name) || '';
          const modo = o.mode || '';                       // 'payment' (fundador) | 'subscription' (renovación)
          const importe = +o.amount_total || +o.amount || 0; // en céntimos
          const esRenovacion = modo === 'subscription';    // suscripción = renovación
          // FILTRO: esta cuenta de Stripe se usa para más cosas además de SellerBrain.
          // Solo damos de alta/renovamos si el pago es de un PRODUCTO de SellerBrain.
          const esSB = await esCheckoutSellerBrain(env, o.id);
          if (email && esSB) {
            // ¿ya tiene código este email? (evita duplicar si paga dos veces)
            let ya = [];
            try { ya = await selectSupabase(env, 'miembros?email=eq.' + encodeURIComponent(email) + '&select=codigo&fin&limit=1'); } catch (_) {}
            const codigo = (ya && ya[0] && ya[0].codigo) || nuevoCodigo();
            if (esRenovacion) {
              // Renovación: se paran los correos, se amplía el acceso. Mensual o anual por importe.
              // Corte en 50€: separa mensual (~20€) de anual (~199-200€) sea cual sea el precio.
              const anual = importe >= 5000;
              const base = (ya && ya[0] && ya[0].fin) ? new Date(ya[0].fin + 'T00:00:00Z') : new Date();
              const nuevoFin = new Date(base.getTime() + (anual ? 365 : 30) * 86400000).toISOString().slice(0, 10);
              await upsertSupabase(env, 'miembros', [{ codigo, email, nombre, activo: true,
                plan: anual ? 'anual' : 'mensual', estado: 'renovado', fin: nuevoFin, seller: email,
                stripe_customer: o.customer || null,           // para reconocerle si cancela
                aviso1: null, aviso2: null, aviso3: null, baja: null, borrado: null }]);
              creado = { email, codigo, plan: anual ? 'anual' : 'mensual', renovacion: true };
            } else {
              // Alta FUNDADOR: 2 meses (60 días) por 25 €. Fija inicio/fin y manda el acceso.
              const hoy = new Date();
              const inicio = hoy.toISOString().slice(0, 10);
              const fin = new Date(hoy.getTime() + 60 * 86400000).toISOString().slice(0, 10);
              await upsertSupabase(env, 'miembros', [{ codigo, email, nombre, activo: true,
                plan: 'fundador', estado: 'activo', inicio, fin, seller: email,
                aviso1: null, aviso2: null, aviso3: null, borrado: null }]);
              creado = { email, codigo, plan: 'fundador', inicio, fin };
              try { await enviarAccesoEmail(env, email, codigo); } catch (_) {}
            }
          }
        }
        // CANCELACIÓN de suscripción. Los eventos de suscripción NO traen email:
        // localizamos al miembro por su stripe_customer (guardado al renovar).
        if (evt.type === 'customer.subscription.updated' || evt.type === 'customer.subscription.deleted') {
          let s = (evt.data && evt.data.object) || {};
          // Payload reducido → pedimos la suscripción completa (necesitamos items, cliente, fin de periodo).
          if ((!s.items || s.cancel_at_period_end === undefined || !s.customer) && env.STRIPE_SECRET_KEY && s.id) {
            try {
              const rr = await fetch('https://api.stripe.com/v1/subscriptions/' + encodeURIComponent(s.id),
                { headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY } });
              const full = await rr.json(); if (full && full.id) s = full;
            } catch (_) {}
          }
          const custId = s.customer || '';
          const cancelYa = evt.type === 'customer.subscription.deleted';                        // ya terminó
          const cancelProgramada = evt.type === 'customer.subscription.updated' && s.cancel_at_period_end === true;
          if (custId && (cancelYa || cancelProgramada) && suscripcionEsSellerBrain(env, s)) {
            let mm = [];
            try { mm = await selectSupabase(env, 'miembros?stripe_customer=eq.' + encodeURIComponent(custId) + '&select=codigo,email,seller,estado&limit=1'); } catch (_) {}
            const mem = mm && mm[0];
            // Evita reenviar el correo si ya estaba cancelado (updates repetidos con cancel_at_period_end=true).
            if (mem && !(cancelProgramada && mem.estado === 'cancelado')) {
              const periodoFin = s.current_period_end ? new Date(s.current_period_end * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
              const finAcceso = cancelYa ? new Date().toISOString().slice(0, 10) : periodoFin;   // sigue hasta fin del periodo pagado
              await upsertSupabase(env, 'miembros', [{ codigo: mem.codigo, estado: 'cancelado', fin: finAcceso }]);
              try { await enviarCancelacion(env, mem, finAcceso); } catch (_) {}
              creado = { email: mem.email, cancelado: true, fin: finAcceso };
            }
          } else if (evt.type === 'customer.subscription.updated' && custId && s.cancel_at_period_end !== true && suscripcionEsSellerBrain(env, s)) {
            // CAMBIO DE PLAN (mensual↔anual) o REACTIVACIÓN: actualizamos plan, periodo y estado.
            let mm = [];
            try { mm = await selectSupabase(env, 'miembros?stripe_customer=eq.' + encodeURIComponent(custId) + '&select=codigo,email&limit=1'); } catch (_) {}
            const mem = mm && mm[0];
            if (mem) {
              const anual = suscripcionEsAnual(s);
              const finN = s.current_period_end ? new Date(s.current_period_end * 1000).toISOString().slice(0, 10) : null;
              const upd = { codigo: mem.codigo, plan: anual ? 'anual' : 'mensual', estado: 'renovado', activo: true,
                aviso1: null, aviso2: null, aviso3: null, baja: null, borrado: null };
              if (finN) upd.fin = finN;
              await upsertSupabase(env, 'miembros', [upd]);
              creado = { email: mem.email, cambio_plan: anual ? 'anual' : 'mensual' };
            }
          }
        }
        try { await upsertSupabase(env, 'stripe_eventos', [{ id: evt.id, email: creado && creado.email, codigo: creado && creado.codigo, creado: new Date().toISOString() }]); } catch (_) {}
        return json({ ok: true, creado }, cors);
      }

      // --- FUNDADORES: listar el estado del ciclo de vida (admin). ---
      if (url.pathname === '/v1/fundadores') {
        const filas = await selSafe(env, 'miembros?estado=in.(activo,cancelado,baja,renovado)&select=email,codigo,plan,estado,inicio,fin,aviso1,aviso2,aviso3,baja,borrado&order=fin.asc', []);
        const hoy = new Date();
        const datos = (filas || []).map(m => {
          const d = m.fin ? Math.round((new Date(m.fin + 'T00:00:00Z') - new Date(hoy.toISOString().slice(0, 10) + 'T00:00:00Z')) / 86400000) : null;
          let fase = m.estado || 'activo';
          if (m.borrado) fase = 'borrado';
          else if (m.estado === 'baja') fase = 'baja (pendiente de borrar)';
          else if (m.estado === 'cancelado') fase = 'cancelado (acceso hasta ' + (m.fin || '?') + ')';
          else if (m.estado === 'renovado') fase = 'suscriptor al día';
          else if (d != null && d <= 0) fase = 'vencido (renovar)';
          else if (d != null && d <= 15) fase = 'por vencer (' + d + ' días)';
          return { email: m.email, plan: m.plan, estado: m.estado, inicio: m.inicio, fin: m.fin, dias_para_fin: d, fase };
        });
        return json({ total: datos.length, fundadores: datos }, cors);
      }

      // --- FUNDADORES: fijar/editar la fecha de inicio a mano (admin).
      //     POST /v1/fundador/fecha  {email, inicio:"YYYY-MM-DD"}  (inicio opcional = hoy) ---
      if (url.pathname === '/v1/fundador/fecha' && request.method === 'POST') {
        let b; try { b = await request.json(); } catch (_) { b = {}; }
        const email = (b.email || '').trim().toLowerCase();
        if (!email) return json({ ok: false, error: 'falta_email' }, cors, 400);
        const inicio = (b.inicio || new Date().toISOString().slice(0, 10)).slice(0, 10);
        const fin = new Date(new Date(inicio + 'T00:00:00Z').getTime() + 60 * 86400000).toISOString().slice(0, 10);
        let ya = [];
        try { ya = await selectSupabase(env, 'miembros?email=eq.' + encodeURIComponent(email) + '&select=codigo&limit=1'); } catch (_) {}
        const codigo = (ya && ya[0] && ya[0].codigo) || nuevoCodigo();
        await upsertSupabase(env, 'miembros', [{ codigo, email, activo: true, plan: 'fundador',
          estado: 'activo', inicio, fin, seller: email, aviso1: null, aviso2: null, aviso3: null, borrado: null }]);
        return json({ ok: true, email, codigo, inicio, fin }, cors);
      }

      // --- FUNDADORES: lanzar el barrido AHORA (admin, para probar sin esperar al cron). ---
      if (url.pathname === '/v1/fundadores/run') {
        const r = await procesarFundadores(env);
        return json({ ok: true, resultado: r }, cors);
      }

      // --- FEEDBACK (encuesta de seguimiento). POST público (lo envía el cliente
      //     desde form.html). GET admin: respuestas + agregados para analizar. ---
      if (url.pathname === '/v1/feedback') {
        if (request.method === 'POST') {
          let b; try { b = await request.json(); } catch (_) { b = {}; }
          const email = (b.email || '').trim().toLowerCase();
          const ayuda = (b.ayuda || '').toString().slice(0, 2000);
          const mejora = (b.mejora || '').toString().slice(0, 2000);
          let nps = parseInt(b.nps, 10); if (isNaN(nps) || nps < 0 || nps > 10) nps = null;
          if (!ayuda && !mejora && nps == null) return json({ ok: false, error: 'vacio' }, cors, 400);
          // Ligar la respuesta a su seller si el email es de un miembro.
          let seller = email || null;
          try { const m = await selectSupabase(env, 'miembros?email=eq.' + encodeURIComponent(email) + '&select=seller&limit=1'); if (m && m[0] && m[0].seller) seller = m[0].seller; } catch (_) {}
          await upsertSupabase(env, 'feedback', [{ email: email || null, seller, ayuda, mejora, nps, creado: new Date().toISOString() }]);
          return json({ ok: true }, cors);
        }
        // GET (admin): lista + agregados
        const filas = await selSafe(env, 'feedback?order=creado.desc&limit=500', []);
        const conNps = filas.filter(f => f.nps != null);
        const media = conNps.length ? +(conNps.reduce((a, f) => a + (+f.nps), 0) / conNps.length).toFixed(1) : null;
        const prom = conNps.filter(f => f.nps >= 9).length;
        const det = conNps.filter(f => f.nps <= 6).length;
        const npsScore = conNps.length ? Math.round(100 * (prom - det) / conNps.length) : null;
        return json({ total: filas.length, nps_medio: media, nps_score: npsScore, promotores: prom, detractores: det, respuestas: filas }, cors);
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
        // Desglose de tarifa REAL por PAÍS (v_fee_sku_pais): FBA/ud, comisión/ud e
        // IVA del país. Para comparar con lo que cobra Amazon en cada mercado.
        let feesPais = [];
        try {
          const fp = await selSafe(env, 'v_fee_sku_pais?sku=eq.' + encodeURIComponent(sku) + '&select=pais,uds_liq,fba,com', []);
          feesPais = (fp || []).filter(r => (+r.uds_liq || 0) > 0).map(r => {
            const u = +r.uds_liq || 0;
            const fbaU = +(((+r.fba || 0)) / u).toFixed(2);
            const comU = +(((+r.com || 0)) / u).toFixed(2);
            return { pais: r.pais, uds_liq: u, fba_ud: fbaU, com_ud: comU, total_ud: +(fbaU + comU).toFixed(2), iva_pct: Math.round((ivaPais(r.pais) - 1) * 100) };
          }).sort((a, b) => b.uds_liq - a.uds_liq);
        } catch (_) {}
        return json({ sku, fee: (fee || [])[0] || null, resumen, lineas, feesPais }, cors);
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
          const p = r.pais || 'OTROS';
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
        const filas = await selSafe(env, 'ppc_dia?fecha=gte.' + desde + '&order=fecha.asc', []);
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
        let filas = await selectSupabase(env, 'ppc_terminos?' + filtro + 'order=hasta.desc,gasto.desc&limit=20000');
        // SOLO filas diarias reales (desde = hasta = un día). Excluye los "resúmenes"
        // antiguos (una fila con el total de varios días) que inflaban los rangos cortos.
        // Si NO hay ninguna fila diaria todavía, devolvemos lo que haya (no dejar el panel vacío).
        const diarias = (filas || []).filter(f => f && f.desde != null && f.hasta != null && String(f.desde) === String(f.hasta));
        if (diarias.length) filas = diarias;
        return json({ datos: filas }, cors);
      }

      // --- GASTO de PPC por ASIN × CAMPAÑA en un periodo. Agrupa por ASIN y, dentro,
      //     por campaña, con su estado (activa/parada) y presupuesto. Fuente:
      //     ppc_asin_campana (gasto) + ppc_presupuestos (estado/presupuesto). ---
      if (url.pathname === '/v1/ads/asin-gasto') {
        const hoyISO = new Date().toISOString().slice(0, 10);
        const hace30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const desde = url.searchParams.get('desde') || hace30d;
        const hasta = url.searchParams.get('hasta') || hoyISO;
        const paisQ = (url.searchParams.get('pais') || '').toUpperCase();
        const filas = await selSafe(env, 'ppc_asin_campana?fecha=gte.' + desde + '&fecha=lte.' + hasta + (paisQ ? ('&pais=eq.' + paisQ) : '') + '&limit=40000', []);
        const cat = {}; try { for (const c of (await selectSupabase(env, 'productos_catalogo?select=sku,nombre,asin,imagen'))) cat[c.sku] = c; } catch (_) {}
        const camp = {}; try { for (const c of (await selSafe(env, 'ppc_presupuestos?select=pais,campania,campania_id,estado,presupuesto', []))) camp[(c.pais || '') + '|' + (c.campania || '')] = { id: c.campania_id, estado: c.estado, presupuesto: c.presupuesto }; } catch (_) {}
        const byAsin = {};
        for (const r of (filas || [])) {
          const sku = r.sku || ''; const c = cat[sku] || {};
          const asin = r.asin || c.asin || '';
          const clave = asin || sku;
          if (!byAsin[clave]) byAsin[clave] = { asin, sku, nombre: c.nombre || sku, imagen: c.imagen || null, gasto: 0, clics: 0, ventas_ppc: 0, pedidos_ppc: 0, campanas: {} };
          const a = byAsin[clave];
          a.gasto += +r.gasto || 0; a.clics += +r.clics || 0; a.ventas_ppc += +r.ventas_ppc || 0; a.pedidos_ppc += +r.pedidos_ppc || 0;
          const cn = r.campania || '(sin campaña)';
          if (!a.campanas[cn]) { const m = camp[(r.pais || '') + '|' + cn] || {}; a.campanas[cn] = { campania: cn, pais: r.pais || '', gasto: 0, clics: 0, ventas_ppc: 0, pedidos_ppc: 0, estado: m.estado || '', presupuesto: (m.presupuesto != null ? +m.presupuesto : null), campania_id: m.id || '' }; }
          const cc = a.campanas[cn]; cc.gasto += +r.gasto || 0; cc.clics += +r.clics || 0; cc.ventas_ppc += +r.ventas_ppc || 0; cc.pedidos_ppc += +r.pedidos_ppc || 0;
        }
        const datos = Object.values(byAsin).map(a => ({
          asin: a.asin, sku: a.sku, nombre: a.nombre, imagen: a.imagen,
          gasto: +a.gasto.toFixed(2), clics: a.clics, ventas_ppc: +a.ventas_ppc.toFixed(2), pedidos_ppc: a.pedidos_ppc,
          acos: a.ventas_ppc > 0 ? +(a.gasto / a.ventas_ppc * 100).toFixed(1) : null,
          campanas: Object.values(a.campanas).map(cc => ({ ...cc, gasto: +cc.gasto.toFixed(2), ventas_ppc: +cc.ventas_ppc.toFixed(2), acos: cc.ventas_ppc > 0 ? +(cc.gasto / cc.ventas_ppc * 100).toFixed(1) : null })).sort((x, y) => y.gasto - x.gasto)
        })).sort((x, y) => y.gasto - x.gasto);
        return json({ datos, desde, hasta }, cors);
      }

      // --- Recoger informes de PPC pendientes que ya estén listos en Amazon ---
      //     El frontend lo llama unas veces tras la ingesta; el cron también.
      if (url.pathname === '/v1/ppc/recoger') {
        const rec = await recogerPendientesPPC(env);
        return json({ ok: true, ...rec }, cors);
      }

      // --- FORZAR captura horaria AHORA y devolver diagnóstico (por qué no entra PPC) ---
      if (url.pathname === '/v1/ppc/capturar') {
        const diag = await capturarPPCHora(env);
        return json({ ok: true, hora_utc: new Date().getUTCHours(), diag }, cors);
      }

      // --- CORREGIR el cierre de ayer: Amazon atribuye tarde las últimas horas;
      //     una vez cerrado el día, refleja el total real en la última franja. ---
      if (url.pathname === '/v1/ppc/cierre') {
        const diag = await corregirCierrePPCHora(env);
        return json({ ok: true, diag }, cors);
      }

      // --- Traer presupuestos de campañas (para detectar limitadas por presupuesto) ---
      if (url.pathname === '/v1/ppc/presupuestos') {
        const diag = await traerPresupuestosAds(env);
        const limitadas = await selSafe(env, 'v_ppc_limitadas?order=total_dia.desc', []);
        return json({ ok: true, diag, limitadas }, cors);
      }

      // --- PLAN DE PUJAS A LA BAJA (copiloto PPC · Fase 2). Cruza rendimiento por
      //     keyword + MARGEN REAL del producto (break-even) + campañas limitadas por
      //     presupuesto. Solo sugiere BAJAR (nunca subir): mejora margen y hace que el
      //     presupuesto dure más horas. Solo lectura; el usuario aplica cada cambio. ---
      if (url.pathname === '/v1/ppc/plan-pujas') {
        const kws = await selSafe(env, 'ppc_keywords?select=keyword_id,campania_id,keyword,pais,puja,clics,gasto,ventas,estado', []);
        // mapa campaña → SKUs anunciados (activos)
        const pa = {};
        try { for (const r of (await selSafe(env, 'ppc_product_ads?select=campania_id,sku,estado', []))) { if ((r.estado || '').toUpperCase() !== 'ENABLED') continue; (pa[r.campania_id] = pa[r.campania_id] || new Set()).add(r.sku); } } catch (_) {}
        // ACoS objetivo REAL por SKU (break-even dejando ~10% de margen) — de productosPeriodo
        const hoy = new Date().toISOString().slice(0, 10), hace30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        let prods = []; try { prods = await productosPeriodo(env, hace30, hoy); } catch (_) {}
        const acosObjSku = {}; for (const p of (prods || [])) if (p.acos_obj != null) acosObjSku[p.sku] = +p.acos_obj;
        // campañas limitadas por presupuesto (hora de tope)
        const lim = {}; try { for (const l of (await selSafe(env, 'v_ppc_limitadas?select=pais,campania_id,hora_tope', []))) lim[(l.pais || '') + '|' + l.campania_id] = (l.hora_tope != null ? +l.hora_tope : true); } catch (_) {}
        const plan = [];
        for (const k of (kws || [])) {
          if ((k.estado || '').toLowerCase() !== 'enabled') continue;
          const clics = +k.clics || 0, ventas = +k.ventas || 0, gasto = +k.gasto || 0, puja = +k.puja || 0;
          if (clics < 5 || !(puja > 0)) continue;              // datos insuficientes o sin puja
          // target ACoS = el más EXIGENTE (menor) de los productos que anuncia la campaña
          let target = null; const skus = pa[k.campania_id];
          if (skus) for (const s of skus) { if (acosObjSku[s] != null) target = (target == null) ? acosObjSku[s] : Math.min(target, acosObjSku[s]); }
          if (target == null) target = 20;                     // sin margen conocido → objetivo prudente
          let sug = ventas > 0 ? (ventas / clics) * (target / 100) : Math.max(0.10, puja * 0.5);
          if (sug < 0.10) sug = 0.10;
          if (sug < puja * 0.5) sug = puja * 0.5;              // no recortar más del 50% de golpe
          sug = Math.round(sug * 100) / 100;
          if (sug >= puja - 0.005) continue;                   // SOLO a la baja
          const acosReal = ventas > 0 ? (gasto / ventas * 100) : null;
          const l = lim[(k.pais || '') + '|' + k.campania_id];
          plan.push({ keyword_id: k.keyword_id, keyword: k.keyword, pais: k.pais, campania_id: k.campania_id,
            puja: +puja.toFixed(2), sugerida: sug, acos: acosReal != null ? +acosReal.toFixed(0) : null,
            target: +(+target).toFixed(0), clics, ventas: +ventas.toFixed(2), limitada: l !== undefined ? l : false });
        }
        // prioridad: campañas sin presupuesto primero, luego mayor recorte (€)
        plan.sort((a, b) => (b.limitada !== false ? 1 : 0) - (a.limitada !== false ? 1 : 0) || (b.puja - b.sugerida) - (a.puja - a.sugerida));
        return json({ plan, total: plan.length }, cors);
      }

      // --- PPC por HORAS: patrón por hora del día + serie reciente ---
      //     Se alimenta de las "fotos" horarias del cron (v_ppc_hora / v_ppc_mejores_horas).
      if (url.pathname === '/v1/ppc/horas') {
        const pais = (url.searchParams.get('pais') || '').toUpperCase();
        const camp = (url.searchParams.get('campania') || '').trim();   // id o lista separada por comas
        const desde = url.searchParams.get('desde');   // YYYY-MM-DD (opcional)
        const hasta = url.searchParams.get('hasta');   // YYYY-MM-DD (opcional)
        const f = pais ? 'pais=eq.' + pais + '&' : '';
        // Rango de fechas opcional → permite elegir los días a consultar (los datos
        // se guardan sin límite, así que el histórico completo está disponible).
        let rango = '';
        if (desde) rango += 'fecha=gte.' + encodeURIComponent(desde) + '&';
        if (hasta) rango += 'fecha=lte.' + encodeURIComponent(hasta) + '&';
        const patron = await selSafe(env, 'v_ppc_mejores_horas?' + f + 'order=pais.asc,hora.asc', []);
        // Campañas activas (con gasto reciente) para el selector del front.
        const campanas = await selSafe(env, 'v_ppc_camp_activas?' + f + 'order=gasto.desc', []);
        let reciente;
        if (camp) {
          // Filtrado a campañas concretas → datos por campaña (foto por campaña).
          const ids = camp.split(',').map(s => s.trim()).filter(Boolean).map(encodeURIComponent);
          const inList = ids.length ? 'campania_id=in.(' + ids.join(',') + ')&' : '';
          reciente = await selSafe(env, 'v_ppc_hora_camp?' + f + inList + rango + 'order=fecha.desc,hora.desc&limit=6000', []);
        } else {
          // Sin filtro → total del pais (tiene historico previo a la captura por campaña).
          const lim = rango ? 6000 : 240;
          reciente = await selSafe(env, 'v_ppc_hora?' + f + rango + 'order=fecha.desc,hora.desc&limit=' + lim, []);
        }
        return json({ patron, reciente, campanas }, cors);
      }

      // --- P&L (cuenta de resultados) por periodo, sigue el selector de fechas ---
      if (url.pathname === '/v1/pnl') {
        const desde = url.searchParams.get('desde');
        const hasta = url.searchParams.get('hasta');
        let pnl = {};
        try {
          if (desde && hasta) {
            const r = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/pnl_periodo?desde=' + encodeURIComponent(desde) + '&hasta=' + encodeURIComponent(hasta),
              { headers: { apikey: env.SUPABASE_SERVICE_KEY } });
            if (r.ok) { const arr = await r.json(); pnl = (arr && arr[0]) || {}; }
          }
        } catch (_) {}
        return json({ pnl }, cors);
      }

      // --- COBERTURA de datos REALES: desde/hasta qué fecha hay datos de cada
      //     fuente (ventas, PPC diario, liquidaciones de Amazon). Transparencia:
      //     lo posterior a esas fechas aún no está recogido / liquidado. ---
      if (url.pathname === '/v1/cobertura') {
        const rango = async (tabla, campo) => {
          campo = campo || 'fecha';
          try {
            const mn = await selSafe(env, tabla + '?select=' + campo + '&order=' + campo + '.asc&limit=1', []);
            const mx = await selSafe(env, tabla + '?select=' + campo + '&order=' + campo + '.desc&limit=1', []);
            return { desde: (mn[0] || {})[campo] || null, hasta: (mx[0] || {})[campo] || null };
          } catch (_) { return { desde: null, hasta: null }; }
        };
        const [ventas, ppc, settlement] = await Promise.all([
          rango('v_ventas_dia'), rango('ppc_dia'), rango('settlement_lineas')
        ]);
        return json({ ventas, ppc, settlement }, cors);
      }

      // --- DESGLOSE del P&L: de dónde salen los cargos de una línea (al pinchar).
      //     ?desde&hasta&linea=fba|com|alm|dev|otros|ppc|prod|ventas|iva_rep|iva_sop
      //     Los cubos de settlement salen por CONCEPTO (RPC pnl_desglose). ---
      if (url.pathname === '/v1/pnl/desglose') {
        const desde = (url.searchParams.get('desde') || '').slice(0, 10);
        const hasta = (url.searchParams.get('hasta') || '').slice(0, 10);
        const linea = (url.searchParams.get('linea') || '').toLowerCase();
        if (!desde || !hasta) return json({ error: 'faltan fechas', filas: [] }, cors);
        const cubos = { fba: 'fba', com: 'com', alm: 'alm', dev: 'dev', otros: 'otros' };
        try {
          if (cubos[linea]) {
            const r = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/pnl_desglose?desde=' + encodeURIComponent(desde) + '&hasta=' + encodeURIComponent(hasta) + '&p_cubo=' + encodeURIComponent(cubos[linea]),
              { headers: { apikey: env.SUPABASE_SERVICE_KEY } });
            if (!r.ok) return json({ error: 'rpc ' + r.status + ': ' + (await r.text()).slice(0, 160), hint: 'Ejecuta sql/pnl-desglose.sql en Supabase', filas: [] }, cors);
            const arr = await r.json();
            const filas = (arr || []).map(x => ({ etiqueta: limpiarConcepto(x.concepto), importe: +x.importe || 0, sub: x.sub || '', lineas: +x.lineas || 0 }));
            let nota = '';
            if (linea === 'fba' || linea === 'com') nota = 'Este desglose son los cargos YA LIQUIDADOS (settlement) del periodo. La línea del P&L usa la tarifa REAL por unidad aplicada a las ventas (resuelve el desfase de liquidación), por eso el total puede no coincidir exactamente con la suma de aquí.';
            return json({ linea, desde, hasta, filas, nota }, cors);
          }
          if (linea === 'ppc') {
            const rows = await selSafe(env, 'ppc_dia?fecha=gte.' + desde + '&fecha=lte.' + hasta + '&select=pais,gasto', []);
            const by = {}; for (const x of rows) by[x.pais || '?'] = (by[x.pais || '?'] || 0) + (+x.gasto || 0);
            const filas = Object.entries(by).map(([k, v]) => ({ etiqueta: 'PPC ' + k, importe: +v.toFixed(2) })).sort((a, b) => b.importe - a.importe);
            return json({ linea, desde, hasta, filas, nota: 'Gasto de publicidad por país (Ads API).' }, cors);
          }
          if (linea === 'prod' || linea === 'ventas') {
            const vd = await selSafe(env, 'v_ventas_dia?fecha=gte.' + desde + '&fecha=lte.' + hasta + '&select=sku,uds,ventas', []);
            const by = {};
            for (const x of vd) { const s = x.sku || '?'; if (!by[s]) by[s] = { uds: 0, ventas: 0 }; by[s].uds += (+x.uds || 0); by[s].ventas += (+x.ventas || 0); }
            let filas;
            if (linea === 'ventas') {
              filas = Object.entries(by).map(([s, o]) => ({ etiqueta: s, importe: +o.ventas.toFixed(2), lineas: o.uds })).sort((a, b) => b.importe - a.importe).slice(0, 40);
              return json({ linea, desde, hasta, filas, nota: 'Ventas brutas (con IVA) por producto · «uds» = unidades.' }, cors);
            }
            const cp = await selSafe(env, 'costes_producto?select=sku,coste', []);
            const cm = {}; for (const c of cp) cm[c.sku] = +c.coste || 0;
            filas = Object.entries(by).map(([s, o]) => ({ etiqueta: s, importe: +(o.uds * (cm[s] || 0)).toFixed(2), lineas: o.uds, aviso: cm[s] ? '' : 'sin coste' })).filter(f => f.importe > 0 || f.aviso).sort((a, b) => b.importe - a.importe).slice(0, 40);
            const sinCoste = filas.filter(f => f.aviso).length;
            return json({ linea, desde, hasta, filas, nota: 'Coste de compra por producto (uds × tu coste). ' + (sinCoste ? sinCoste + ' SKU sin coste puesto.' : '') }, cors);
          }
          if (linea === 'iva_rep') return json({ linea, filas: [], nota: 'IVA repercutido = ventas − ventas sin IVA. Es el IVA que cobras al cliente y liquidas a Hacienda; no es un coste tuyo (lo compensas con el IVA soportado).' }, cors);
          if (linea === 'iva_sop') return json({ linea, filas: [], nota: 'IVA soportado = 21% de las tarifas de Amazon (FBA, comisión, almacenaje…). Lo pagas pero lo recuperas en tu declaración, por eso no resta al beneficio.' }, cors);
          return json({ error: 'línea desconocida', filas: [] }, cors);
        } catch (e) { return json({ error: (e && e.message) || String(e), filas: [] }, cors); }
      }

      // --- Ventas y unidades por MES (gráfico tipo Seller Central) ---
      //     ?pais=ES filtra; sin país suma todos. Devuelve [{mes, ventas, uds}].
      if (url.pathname === '/v1/mensual') {
        const pais = (url.searchParams.get('pais') || '').toUpperCase();
        const filtro = pais ? 'pais=eq.' + encodeURIComponent(pais) + '&' : '';
        const rows = await selSafe(env, 'v_ventas_mes?' + filtro + 'order=mes.asc', []);
        const byMes = {};
        for (const r of (rows || [])) {
          if (!byMes[r.mes]) byMes[r.mes] = { mes: r.mes, ventas: 0, uds: 0 };
          byMes[r.mes].ventas += +r.ventas || 0;
          byMes[r.mes].uds += +r.uds || 0;
        }
        return json({ meses: Object.values(byMes).map(m => ({ mes: m.mes, ventas: +m.ventas.toFixed(2), uds: m.uds })) }, cors);
      }

      // --- Serie diaria (ventas/beneficio/PPC) para el gráfico, por periodo ---
      //     Sin fechas → últimos 30 días (v_serie_30d). Con desde/hasta → función.
      if (url.pathname === '/v1/serie') {
        const desde = url.searchParams.get('desde');
        const hasta = url.searchParams.get('hasta');
        let datos = [];
        try {
          if (desde && hasta) {
            const r = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/serie_periodo?desde=' + encodeURIComponent(desde) + '&hasta=' + encodeURIComponent(hasta),
              { headers: { apikey: env.SUPABASE_SERVICE_KEY } });
            if (r.ok) datos = await r.json();
          } else {
            datos = await selSafe(env, 'v_serie_30d', []);
          }
        } catch (_) {}
        return json({ serie: datos }, cors);
      }

      // --- Satisfacción del cliente (a partir de los MOTIVOS DE DEVOLUCIÓN,
      //     único feedback real que Amazon sí da por API). Media de "estrellas"
      //     estimada por producto + alertas de motivos de calidad/defecto. ---
      if (url.pathname === '/v1/satisfaccion') {
        const filas = await selSafe(env, 'v_satisfaccion_producto?order=devoluciones.desc', []);
        const cat = await selSafe(env, 'productos_catalogo?select=sku,nombre,asin,imagen', []);
        const nombres = {};
        for (const c of (cat || [])) nombres[c.sku] = c;
        const datos = (filas || []).map(f => ({
          ...f,
          nombre: (nombres[f.sku] && nombres[f.sku].nombre) || f.sku,
          asin: (nombres[f.sku] && nombres[f.sku].asin) || '',
          imagen: (nombres[f.sku] && nombres[f.sku].imagen) || ''
        }));
        return json({ datos }, cors);
      }

      // --- DEVOLUCIONES por artículo en un RANGO de fechas: uds vendidas,
      //     devoluciones y % de devolución (dev ÷ uds) + motivo principal. ---
      if (url.pathname === '/v1/devoluciones') {
        const desde = url.searchParams.get('desde');
        const hasta = url.searchParams.get('hasta');
        if (!desde || !hasta) return json({ error: 'faltan desde/hasta' }, cors, 400);
        // Uds vendidas por SKU en el rango (fuente limpia: ventas_sku_pais_dia)
        const ventas = await selSafe(env, 'ventas_sku_pais_dia?fecha=gte.' + desde + '&fecha=lte.' + hasta + '&select=sku,uds', []);
        const udsBySku = {};
        for (const r of (ventas || [])) { const s = r.sku || ''; if (!s) continue; udsBySku[s] = (udsBySku[s] || 0) + (+r.uds || 0); }
        // Devoluciones por SKU en el rango (+ motivos)
        const devs = await selSafe(env, 'devoluciones?fecha=gte.' + desde + '&fecha=lte.' + hasta + '&select=sku,cantidad,motivo', []);
        const devBySku = {};
        for (const r of (devs || [])) {
          const s = r.sku || ''; if (!s || /^amzn\.gr\./i.test(s)) continue;
          if (!devBySku[s]) devBySku[s] = { dev: 0, motivos: {} };
          const c = +r.cantidad || 1;
          devBySku[s].dev += c;
          const m = (r.motivo || '').toUpperCase(); if (m) devBySku[s].motivos[m] = (devBySku[s].motivos[m] || 0) + c;
        }
        const cat = {}; try { for (const c of (await selectSupabase(env, 'productos_catalogo?select=sku,nombre,asin,imagen'))) cat[c.sku] = c; } catch (_) {}
        const skus = new Set([...Object.keys(udsBySku), ...Object.keys(devBySku)]);
        const datos = [...skus].filter(s => !/^amzn\.gr\./i.test(s)).map(s => {
          const uds = udsBySku[s] || 0; const d = devBySku[s] || { dev: 0, motivos: {} };
          let motivoTop = '', max = 0; for (const m in d.motivos) { if (d.motivos[m] > max) { max = d.motivos[m]; motivoTop = m; } }
          return {
            sku: s, nombre: (cat[s] && cat[s].nombre) || s, asin: (cat[s] && cat[s].asin) || '', imagen: (cat[s] && cat[s].imagen) || '',
            uds, devoluciones: d.dev, pct: uds > 0 ? +(d.dev / uds * 100).toFixed(1) : null, motivo_top: motivoTop
          };
        }).sort((a, b) => (b.pct || 0) - (a.pct || 0) || b.devoluciones - a.devoluciones);
        return json({ desde, hasta, datos }, cors);
      }

      // --- REEMBOLSOS A CLIENTES (no solo devoluciones físicas): dinero devuelto por
      //     cualquier motivo. Fusiona la Finances API (reembolsos_cliente, casi al
      //     momento) con el settlement (v_reembolsos_cliente, por quincenas). Dedup
      //     por pedido+sku preferiendo Finanzas. Lectura (miembro o admin). ---
      if (url.pathname === '/v1/reembolsos-cliente') {
        const desde = url.searchParams.get('desde'), hasta = url.searchParams.get('hasta');
        if (!desde || !hasta) return json({ error: 'faltan desde/hasta' }, cors, 400);
        const cat = {}; try { for (const c of (await selectSupabase(env, 'productos_catalogo?select=sku,nombre,asin,imagen'))) cat[c.sku] = c; } catch (_) {}
        const hastaFin = hasta + 'T23:59:59Z';
        const fin = await selSafe(env, 'reembolsos_cliente?fecha=gte.' + desde + '&fecha=lte.' + hastaFin + '&select=pedido,sku,asin,fecha,importe_cliente,moneda,uds,motivo', []);
        const set = await selSafe(env, 'v_reembolsos_cliente?fecha=gte.' + desde + '&fecha=lte.' + hastaFin + '&select=pedido,sku,pais,fecha,importe_cliente,impacto_neto', []);
        const byKey = {};
        for (const r of (set || [])) {                 // primero settlement
          byKey[(r.pedido || '') + '|' + (r.sku || '')] = {
            pedido: r.pedido, sku: r.sku, fecha: r.fecha, pais: r.pais || '',
            importe_cliente: +r.importe_cliente || 0, impacto_neto: +r.impacto_neto || 0,
            motivo: '', uds: null, fuente: 'settlement'
          };
        }
        for (const r of (fin || [])) {                 // Finanzas pisa (más fresca + motivo)
          byKey[(r.pedido || '') + '|' + (r.sku || '')] = {
            pedido: r.pedido, sku: r.sku, fecha: r.fecha, pais: '',
            importe_cliente: +r.importe_cliente || 0, impacto_neto: null,
            motivo: r.motivo || '', uds: r.uds != null ? +r.uds : null, fuente: 'finanzas'
          };
        }
        const datos = Object.values(byKey).map(x => ({
          ...x,
          nombre: (cat[x.sku] && cat[x.sku].nombre) || x.sku,
          asin: (cat[x.sku] && cat[x.sku].asin) || '',
          imagen: (cat[x.sku] && cat[x.sku].imagen) || ''
        })).sort((a, b) => (b.fecha || '') < (a.fecha || '') ? -1 : 1);
        const total_cliente = +(datos.reduce((a, x) => a + (+x.importe_cliente || 0), 0)).toFixed(2);
        const hay_finanzas = (fin || []).length > 0;
        return json({ desde, hasta, datos, total_cliente, hay_finanzas, n: datos.length }, cors);
      }

      // --- Ingesta de reembolsos vía Finances API (admin). Requiere rol "Finance
      //     and Accounting" en la app de Amazon; si no está, devuelve rol_falta. ---
      if (url.pathname === '/v1/reembolsos-cliente-ingest') {
        const r = await ingestaReembolsosCliente(env, undefined);
        if (r && r.rol_falta) return json({ ok: false, rol_falta: true, error: r.error,
          nota: 'La cuenta no tiene concedido el rol "Finance and Accounting" en la app de Amazon. Mientras tanto, los reembolsos del settlement sí se ven (con retraso de quincena).' }, cors);
        return json({ ok: !!(r && r.ok), ...r }, cors);
      }

      // --- RESEÑAS: registro de solicitudes + resumen (lectura: miembro o admin). ---
      if (url.pathname === '/v1/resenas') {
        const filas = await selSafe(env, 'resenas_pedidas?order=fecha_solicitud.desc&limit=200', []);
        const resumen = { enviadas: 0, ya_enviadas: 0, pendientes: 0, errores: 0 };
        for (const f of (filas || [])) {
          if (f.estado === 'enviada') resumen.enviadas++;
          else if (f.estado === 'ya_enviada') resumen.ya_enviadas++;
          else if (f.estado === 'pendiente') resumen.pendientes++;
          else resumen.errores++;
        }
        return json({ datos: filas || [], resumen, auto_on: env.RESENAS_AUTO === '1' }, cors);
      }

      // --- Pedir reseñas de los pedidos elegibles AHORA (admin). ---
      if (url.pathname === '/v1/resenas-run') {
        const r = await procesarResenas(env, undefined);
        if (r && r.rol_falta) return json({ ok: false, rol_falta: true,
          nota: 'La app de Amazon no tiene el rol para solicitar reseñas (Orders/Solicitations). Solicítalo en Seller Central → tu app; hasta entonces este botón no puede enviar.' }, cors);
        return json({ ok: !!(r && r.ok), ...r }, cors);
      }

      // --- LISTINGS POR PAÍS: estado + motivo por producto y marketplace (lectura). ---
      if (url.pathname === '/v1/listings') {
        const filas = await selSafe(env, 'listings_pais?order=sku.asc', []);
        const cat = {}; try { for (const c of (await selectSupabase(env, 'productos_catalogo?select=sku,nombre,asin,imagen'))) cat[c.sku] = c; } catch (_) {}
        let actualizado = null;
        const resumen = {};   // pais -> {activo, inactivo, no_publicado}
        for (const f of (filas || [])) {
          if (f.fecha && (!actualizado || f.fecha > actualizado)) actualizado = f.fecha;
          const p = f.pais; if (!resumen[p]) resumen[p] = { pais: p, activo: 0, inactivo: 0, no_publicado: 0 };
          if (resumen[p][f.estado] != null) resumen[p][f.estado]++;
        }
        const datos = (filas || []).map(f => ({ ...f, nombre: (cat[f.sku] && cat[f.sku].nombre) || f.sku, imagen: (cat[f.sku] && cat[f.sku].imagen) || '' }));
        const problemas = datos.filter(f => f.estado === 'inactivo').length;
        return json({ datos, resumen: Object.values(resumen), paises: LISTINGS_MKTS, actualizado, problemas }, cors);
      }

      // --- Ingesta de listings por país (admin). Hace una PRUEBA en directo (1 SKU)
      //     para diagnosticar, y si va bien lanza el resto en segundo plano. ?lote=N ---
      if (url.pathname === '/v1/listings-ingest') {
        if (!(env.SPAPI_SELLER_ID)) return json({ ok: false, falta_sellerid: true,
          nota: 'Falta el Merchant Token. Ponlo en Cloudflare como SPAPI_SELLER_ID (Seller Central → Ajustes → Información de la cuenta → Merchant Token).' }, cors);
        // 1) ¿Hay catálogo?
        let cat = []; try { cat = await selSafe(env, 'productos_catalogo?select=sku,asin&limit=1', []); } catch (_) {}
        const sku0 = (cat[0] && cat[0].sku) || '';
        if (!sku0) return json({ ok: false, sin_catalogo: true, nota: 'No hay productos en el catálogo todavía. Lanza primero la ingesta de ventas/inventario (🚀 Lanzar ingesta) para tener SKUs.' }, cors);
        // 2) Prueba en directo contra Amazon (1 SKU en ES) para ver si hay permiso.
        let probe; try { probe = await getListingEstado(env, env.SPAPI_SELLER_ID, sku0, MARKETPLACES.ES, undefined); } catch (e) { probe = { _err: (e.message || '').slice(0, 200) }; }
        if (probe && probe._rol) return json({ ok: false, rol_falta: true, sku: sku0, detalle: probe._err,
          nota: 'Amazon rechaza por PERMISOS: tu app necesita el rol de gestión de inventario/listings. Solicítalo en Seller Central → tu app (o revisa que el Merchant Token sea el correcto).' }, cors);
        if (probe && probe._err) return json({ ok: false, error: probe._err, sku: sku0,
          nota: 'La Listings API devolvió un error. Suele ser el Merchant Token mal puesto (SPAPI_SELLER_ID) o un SKU que no existe en ES.' }, cors);
        // 3) ¿Se puede ESCRIBIR en la tabla? (si falla → falta el SQL)
        try { await upsertSupabase(env, 'listings_pais', [{ seller: 'venmon', sku: sku0, asin: probe.asin || (cat[0] && cat[0].asin) || null, pais: 'ES', estado: probe.estado, motivo: probe.motivo || '', fecha: new Date().toISOString() }]); }
        catch (e) { return json({ ok: false, sin_tabla: true, error: (e.message || '').slice(0, 200), nota: 'No se pudo guardar. Ejecuta sql/listings-pais.sql en Supabase (la tabla no existe todavía).' }, cors); }
        // 4) Todo OK → lanza el resto en segundo plano.
        const lote = Math.max(1, Math.min(300, +(url.searchParams.get('lote') || 40)));
        ctx.waitUntil(ingestaListingsPais(env, undefined, { lote }).catch(() => {}));
        return json({ ok: true, lanzado: true, prueba_ok: true, sku: sku0, estado_ejemplo: probe.estado,
          nota: 'Prueba correcta. Comprobando el resto en segundo plano (~1 min por lote). Abre «Listings por país» en un momento y pulsa de nuevo para cubrir más.' }, cors);
      }

      // --- CERRAR listing en un país (admin + LISTINGS_WRITE + confirmación). DELETE. ---
      if (url.pathname === '/v1/listings/cerrar' && request.method === 'POST') {
        if (String(env.LISTINGS_WRITE || '') !== '1') return json({ error: 'listings_write_off', nota: 'Escritura de listings desactivada. Pon LISTINGS_WRITE=1 en Cloudflare para permitir cerrar/reabrir.' }, cors, 403);
        if (!env.SPAPI_SELLER_ID) return json({ error: 'falta_sellerid', nota: 'Falta SPAPI_SELLER_ID (Merchant Token) en Cloudflare.' }, cors, 400);
        let b; try { b = await request.json(); } catch (_) { b = {}; }
        const sku = String(b.sku || ''), pais = (b.pais || '').toUpperCase();
        const mkt = MARKETPLACES[pais];
        if (!sku || !mkt) return json({ error: 'faltan_datos' }, cors, 400);
        let r; try { r = await listingWrite(env, 'DELETE', env.SPAPI_SELLER_ID, sku, mkt, null, undefined); } catch (e) { r = { ok: false, status: 0, d: { error: e.message } }; }
        const okAcc = r.ok || r.status === 200 || (r.d && r.d.status === 'ACCEPTED');
        try { await upsertSupabase(env, 'listings_acciones', [{ seller: 'venmon', sku, pais, accion: 'cerrar', estado: okAcc ? 'ok' : 'error', detalle: JSON.stringify(r.d || {}).slice(0, 400), fecha: new Date().toISOString() }]); } catch (_) {}
        if (okAcc) { try { await upsertSupabase(env, 'listings_pais', [{ seller: 'venmon', sku, pais, estado: 'inactivo', motivo: 'Cerrado desde SellerBrain', fecha: new Date().toISOString() }]); } catch (_) {} }
        return json({ ok: okAcc, status: r.status, detalle: r.d }, cors);
      }

      // --- REABRIR listing en un país (best-effort PATCH). Si Amazon lo rechaza,
      //     el front ofrece el enlace a Seller Central para reactivarlo a mano. ---
      if (url.pathname === '/v1/listings/reabrir' && request.method === 'POST') {
        if (String(env.LISTINGS_WRITE || '') !== '1') return json({ error: 'listings_write_off', nota: 'Escritura de listings desactivada. Pon LISTINGS_WRITE=1 en Cloudflare.' }, cors, 403);
        if (!env.SPAPI_SELLER_ID) return json({ error: 'falta_sellerid' }, cors, 400);
        let b; try { b = await request.json(); } catch (_) { b = {}; }
        const sku = String(b.sku || ''), pais = (b.pais || '').toUpperCase(), asin = String(b.asin || '');
        const mkt = MARKETPLACES[pais];
        if (!sku || !mkt) return json({ error: 'faltan_datos' }, cors, 400);
        // Mejor esfuerzo: re-declarar condición + ASIN sugerido (recrea la oferta en catálogos existentes).
        const patch = { productType: 'PRODUCT', patches: [
          { op: 'replace', path: '/attributes/condition_type', value: [{ value: 'new_new', marketplace_id: mkt }] }
        ] };
        if (asin) patch.patches.push({ op: 'replace', path: '/attributes/merchant_suggested_asin', value: [{ value: asin, marketplace_id: mkt }] });
        let r; try { r = await listingWrite(env, 'PATCH', env.SPAPI_SELLER_ID, sku, mkt, patch, undefined); } catch (e) { r = { ok: false, status: 0, d: { error: e.message } }; }
        const okAcc = r.ok || (r.d && r.d.status === 'ACCEPTED');
        try { await upsertSupabase(env, 'listings_acciones', [{ seller: 'venmon', sku, pais, accion: 'reabrir', estado: okAcc ? 'ok' : 'error', detalle: JSON.stringify(r.d || {}).slice(0, 400), fecha: new Date().toISOString() }]); } catch (_) {}
        return json({ ok: okAcc, status: r.status, detalle: r.d,
          seller_central: 'https://sellercentral.amazon.es/inventory' }, cors);
      }

      // --- GENERADOR DE LISTING con IA (admin). Claude + marco COSMO/Rufus +
      //     keywords de Helium 10. Requiere ANTHROPIC_API_KEY en Cloudflare. ---
      if (url.pathname === '/v1/generar-listing' && request.method === 'POST') {
        if (!env.ANTHROPIC_API_KEY) return json({ ok: false, falta_apikey: true,
          nota: 'Falta la clave de IA. Pon ANTHROPIC_API_KEY en Cloudflare (Worker → Variables) para usar el generador.' }, cors);
        let b; try { b = await request.json(); } catch (_) { b = {}; }
        // 16000 tokens: el listing completo (3 títulos, 5 bullets, descripción, 7 briefs de
        // imagen, A+/Q&A, COSMO, backend) es largo; con 5000 el JSON se cortaba a medias.
        const r = await llamarClaude(env, SYSTEM_LISTING, buildPromptListing(b), 16000);
        if (r.error) return json({ ok: false, error: r.error }, cors);
        const raw = String(r.texto || '');
        const diag = 'stop=' + (r.stop || '?') + ' · len=' + raw.length + ' · bloques=' + (r.bloques != null ? r.bloques : '?') + ' · modelo=' + (r.modelo || '?');
        // La IA no devolvió texto → normalmente es acceso al modelo o clave.
        if (!raw.trim()) return json({ ok: false, error: 'ia_sin_texto · ' + diag, stop: r.stop || '', modelo: r.modelo || '',
          nota: 'La IA respondió sin texto. Comprueba que tu ANTHROPIC_API_KEY tenga acceso al modelo «' + (env.LISTING_MODEL || 'claude-sonnet-5') + '» (o pon LISTING_MODEL en Cloudflare con un modelo válido de tu cuenta).' }, cors);
        // Parseo robusto: quita vallas ```json, extrae el objeto y prueba varias reparaciones.
        let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const base = extraerJSON(s);
        const intentos = [base, base.replace(/[\x00-\x1F]+/g, ' '), base.replace(/[\x00-\x1F]+/g, ' ').replace(/,(\s*[}\]])/g, '$1')];
        let data = null;
        for (const cand of intentos) { try { data = JSON.parse(cand); break; } catch (_) {} }
        if (!data) return json({ ok: false, error: 'respuesta_no_json · ' + diag, stop: r.stop || '', modelo: r.modelo || '', len: raw.length, crudo: raw.slice(-1500) }, cors);
        return json({ ok: true, data, uso: r.uso || null }, cors);
      }

      // --- FICHA ACTUAL del listing (título + bullets + descripción + imagen) desde
      //     Amazon, para que el Generador parta de tu ficha real y solo la mejore.
      //     ?sku=XXX (busca el ASIN en el catálogo si no se pasa). ---
      if (url.pathname === '/v1/listing-actual') {
        const sku0 = (url.searchParams.get('sku') || '').trim();
        if (!sku0) return json({ error: 'falta_sku' }, cors, 400);
        const force = url.searchParams.get('force') === '1';
        const tieneContenido = f => !!(f && ((f.bullets && f.bullets.length) || f.description || (f.imagenes && f.imagenes.length)));

        // 0) CACHÉ DE SERVIDOR: si ya la tenemos y no se fuerza, la devolvemos SIN tocar Amazon.
        let cachedFicha = null;
        try {
          const rows = await selSafe(env, 'fichas_actuales?sku=eq.' + encodeURIComponent(sku0) + '&limit=1', []);
          const c = rows && rows[0];
          if (c) cachedFicha = {
            sku: sku0, asin: c.asin || '', title: c.title || '',
            bullets: Array.isArray(c.bullets) ? c.bullets : [], description: c.description || '',
            imagen: c.imagen || '', imagenes: Array.isArray(c.imagenes) ? c.imagenes : [], cacheado: true
          };
        } catch (_) {}
        if (!force && tieneContenido(cachedFicha)) return json(cachedFicha, cors);

        const sellerId = env.SPAPI_SELLER_ID || '';
        if (!sellerId) return json(cachedFicha || { error: 'Falta SPAPI_SELLER_ID (Merchant Token) en Cloudflare.' }, cors);

        let asin = (url.searchParams.get('asin') || '').trim() || (cachedFicha && cachedFicha.asin) || '';
        if (!asin) { try { const c = await selSafe(env, 'productos_catalogo?sku=eq.' + encodeURIComponent(sku0) + '&select=asin&limit=1', []); asin = (c[0] && c[0].asin) || ''; } catch (_) {} }

        // Menos llamadas: solo ES/FR/IT y se PARA en cuanto encuentra el producto (los bullets,
        // si vendes sobre un ASIN existente, vienen del catálogo, no de tu Listings).
        const mkts = [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT];
        let title = '', bullets = [], description = '', imagen = '', imagenes = [];
        const diag = { listings: [], catalog: '' };
        const firstVal = (a) => (Array.isArray(a) && a[0] && a[0].value != null) ? String(a[0].value) : '';
        let token = ''; try { token = await lwaToken(env, 'spapi', ctx); } catch (e) { diag.token = 'err'; }
        for (const mkt of mkts) {
          try {
            const path = '/listings/2021-08-01/items/' + encodeURIComponent(sellerId) + '/' + encodeURIComponent(sku0) +
              '?marketplaceIds=' + encodeURIComponent(mkt) + '&includedData=summaries,attributes';
            const r = await fetch(SPAPI_HOST + path, { headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' } });
            diag.listings.push(mkt.slice(-4) + ':' + r.status);
            if (r.status === 404) continue;          // no está en este mercado → prueba el siguiente
            if (!r.ok) break;                         // 429/403 → no sigas martilleando a Amazon
            const j = await r.json();
            const sum = (j.summaries && j.summaries[0]) || {};
            if (!asin && sum.asin) asin = sum.asin;
            const at = j.attributes || {};
            if (!title) title = sum.itemName || firstVal(at.item_name);
            if (!bullets.length && Array.isArray(at.bullet_point)) bullets = at.bullet_point.map(x => x && x.value).filter(Boolean).slice(0, 5);
            if (!description) description = firstVal(at.product_description);
            break;                                    // producto encontrado → no consultes más mercados
          } catch (_) { diag.listings.push('err'); }
        }
        // Catálogo (1 llamada): imágenes + bullets/descripción de respaldo del ASIN.
        if (asin) {
          try {
            const item = await getCatalogoItem(env, asin, MARKETPLACES.ES);
            diag.catalog = item ? 'ok' : 'vacio';
            const imgs = (item && item.images && item.images[0] && item.images[0].images) || [];
            const main = imgs.find(x => x.variant === 'MAIN') || imgs[0];
            if (main && main.link) imagen = main.link;
            const cat = (item && item.attributes) || {};
            if (!title) title = firstVal(cat.item_name);
            if (!bullets.length && Array.isArray(cat.bullet_point)) bullets = cat.bullet_point.map(x => x && x.value).filter(Boolean).slice(0, 5);
            if (!description) description = firstVal(cat.product_description);
            const vistas = new Set();
            const ordenadas = imgs.slice().sort((a, b) => (a.variant === 'MAIN' ? -1 : b.variant === 'MAIN' ? 1 : 0));
            for (const im of ordenadas) {
              if (!im || !im.link || vistas.has(im.link)) continue;
              if ((im.width || 0) < 100 && (im.height || 0) < 100) continue;
              vistas.add(im.link);
              imagenes.push({ variant: im.variant || '', link: im.link, width: im.width || 0, height: im.height || 0 });
            }
            if (!title && item && item.summaries && item.summaries[0]) title = item.summaries[0].itemName || '';
          } catch (e) { diag.catalog = 'err:' + ((e && e.message) || '').slice(0, 60); }
        } else { diag.catalog = 'sin_asin'; }

        const ficha = { sku: sku0, asin, title, bullets, description, imagen, imagenes };
        // Amazon no dio nada pero teníamos caché → servimos la caché (no dejamos al usuario en blanco).
        if (!tieneContenido(ficha) && tieneContenido(cachedFicha)) return json({ ...cachedFicha, _diag: diag }, cors);
        // Guarda en caché de servidor si hay contenido (para no volver a pedir a Amazon).
        if (tieneContenido(ficha)) {
          try { await upsertSupabase(env, 'fichas_actuales', [{ seller: 'venmon', sku: sku0, asin, title: (title || '').slice(0, 500), bullets, description: (description || '').slice(0, 4000), imagen, imagenes, actualizado: new Date().toISOString() }]); } catch (_) {}
        }
        return json({ ...ficha, _diag: diag }, cors);
      }

      // --- Pedir reseña de UN pedido concreto (admin). ?pedido=...&mkt=... ---
      if (url.pathname === '/v1/resena-pedir') {
        const pedido = url.searchParams.get('pedido') || '';
        const mkt = url.searchParams.get('mkt') || MARKETPLACES.ES;
        if (!pedido) return json({ error: 'falta pedido' }, cors, 400);
        let r; try { r = await solicitarResena(env, pedido, mkt, undefined); } catch (e) { r = { ok: false, estado: 'error', detalle: e.message }; }
        try { await upsertSupabase(env, 'resenas_pedidas', [{ seller: 'venmon', pedido, fecha_solicitud: new Date().toISOString(), estado: r.estado, detalle: r.detalle || '' }]); } catch (_) {}
        return json({ ok: !!r.ok, ...r }, cors);
      }

      // --- STOCK: TODOS los productos con stock real, en camino, salida media
      //     (uds/día 30d) y días de cobertura. El front calcula la fecha límite de
      //     pedido según el método de envío (barco/tren/aire) + recepción Amazon. ---
      if (url.pathname === '/v1/stock') {
        const inv = {}; let snapMax = null;
        try { for (const r of (await selectSupabase(env, 'inventario?select=sku,disponible,entrante,reservado,snapshot'))) { inv[r.sku] = { disp: +r.disponible || 0, ent: +r.entrante || 0, res: +r.reservado || 0 }; if (r.snapshot && (!snapMax || r.snapshot > snapMax)) snapMax = r.snapshot; } } catch (_) {}
        const hace30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const vel = {}, rev = {};                                // uds y ventas (€) por SKU en los últimos 30 días
        try { for (const r of (await selSafe(env, 'ventas_sku_pais_dia?fecha=gte.' + hace30 + '&select=sku,uds,ventas', []))) { const s = r.sku || ''; if (!s) continue; vel[s] = (vel[s] || 0) + (+r.uds || 0); rev[s] = (rev[s] || 0) + (+r.ventas || 0); } } catch (_) {}
        const cat = {};
        try { for (const c of (await selectSupabase(env, 'productos_catalogo?select=sku,nombre'))) cat[c.sku] = c.nombre; } catch (_) {}
        const skus = new Set([...Object.keys(inv), ...Object.keys(vel)]);
        const datos = [...skus].filter(s => !/^amzn\.gr\./i.test(s)).map(s => {
          const disp = (inv[s] && inv[s].disp) || 0, ent = (inv[s] && inv[s].ent) || 0, res = (inv[s] && inv[s].res) || 0;
          const v = (vel[s] || 0) / 30;                          // uds/día (media 30 días)
          const ventaDia = +((rev[s] || 0) / 30).toFixed(2);     // venta media diaria (€/día), mismo periodo que 'vel'
          const dias = v > 0 ? Math.floor(disp / v) : null;      // cobertura; null = sin ventas
          return { sku: s, nombre: cat[s] || s, disponible: disp, entrante: ent, reservado: res, vel: +v.toFixed(2), ventaDia, dias };
        }).sort((a, b) => (a.dias == null ? 99999 : a.dias) - (b.dias == null ? 99999 : b.dias));
        return json({ datos, actualizado: snapMax }, cors);
      }

      // --- SOBRECOSTES de logística (fugas de tarifa cross-border) → tabla + datos
      //     para generar el mensaje de reclamación. Lee la vista v_fuga_tarifa. ---
      if (url.pathname === '/v1/fugas') {
        const filas = await selSafe(env, 'v_fuga_tarifa?order=sobrecoste_mes.desc', []);
        const cat = {}; try { for (const c of (await selectSupabase(env, 'productos_catalogo?select=sku,nombre,asin'))) cat[c.sku] = c; } catch (_) {}
        // Dónde tiene stock cada SKU (Libro Mayor por país) → sustituye el "?" de país.
        const invp = {}; try { for (const r of (await selectSupabase(env, 'v_inventario_pais?select=sku,por_pais'))) invp[r.sku] = r.por_pais; } catch (_) {}
        const datos = (filas || []).map(f => {
          const porPais = invp[f.sku] || null;          // p.ej. "ES:120, FR:18" (dónde está el stock)
          // País de ENVÍO real (de la tarifa/pedido). Si el settlement no lo trae, lo
          // dejamos vacío -> el front muestra "sin determinar" (NO lo mezclamos con el
          // stock por país, que va aparte en por_pais).
          const pais = (f.pais && f.pais !== '?') ? f.pais : '';
          return {
            ...f, pais,
            nombre: (cat[f.sku] && cat[f.sku].nombre) || f.sku,
            asin: (cat[f.sku] && cat[f.sku].asin) || '',
            por_pais: porPais
          };
        });
        const total_mes = +(datos.reduce((a, x) => a + (+x.sobrecoste_mes || 0), 0)).toFixed(2);

        // Reparto del sobrecoste de cada SKU entre sus países de DESTINO, en
        // proporción a las unidades cross-border a cada destino (v_cross_destino_sku).
        // El total no cambia: solo se redistribuye. Lo que no tiene destino conocido
        // cae en "?" (sin determinar). Es la vista accionable: dónde mandar stock.
        const crossDest = {};   // sku -> { destino -> uds }
        try {
          for (const r of (await selSafe(env, 'v_cross_destino_sku?select=sku,destino,uds_cross', []))) {
            const s = r.sku || ''; if (!s) continue;
            (crossDest[s] = crossDest[s] || {})[r.destino || '?'] = (+r.uds_cross || 0);
          }
        } catch (_) {}
        const porDestAgg = {};   // pais -> { pais, sobrecoste_mes, uds, skus:Set }
        const addDest = (pais, mes, uds, sku) => {
          const p = pais || '?';
          if (!porDestAgg[p]) porDestAgg[p] = { pais: p, sobrecoste_mes: 0, uds: 0, skus: new Set() };
          porDestAgg[p].sobrecoste_mes += mes; porDestAgg[p].uds += uds; if (sku) porDestAgg[p].skus.add(sku);
        };
        for (const x of datos) {
          const mes = +x.sobrecoste_mes || 0;
          const dests = crossDest[x.sku] || null;
          const totUds = dests ? Object.values(dests).reduce((a, b) => a + b, 0) : 0;
          if (dests && totUds > 0) {
            for (const dp in dests) addDest(dp, mes * (dests[dp] / totUds), dests[dp], x.sku);
          } else {
            addDest('?', mes, +x.uds || 0, x.sku);   // sin ruta conocida → sin determinar
          }
        }
        const por_destino = Object.values(porDestAgg)
          .map(d => ({ pais: d.pais, sobrecoste_mes: +d.sobrecoste_mes.toFixed(2), uds: d.uds, skus: d.skus.size }))
          .sort((a, b) => b.sobrecoste_mes - a.sobrecoste_mes);

        return json({ datos, total_mes, por_destino }, cors);
      }

      // --- Reembolsos FBA pendientes (Amazon te debe): perdido/dañado − ya reembolsado,
      //     valorado a tu coste, con fecha límite de la ventana de 60 días. ---
      if (url.pathname === '/v1/reembolsos') {
        const filas = await selSafe(env, 'v_reembolsos_pendientes', []);
        const cat = {}; try { for (const c of (await selectSupabase(env, 'productos_catalogo?select=sku,nombre,asin'))) cat[c.sku] = c; } catch (_) {}
        const hoy = new Date();
        const datos = (filas || []).map(f => {
          const lim = f.limite_reclamacion ? new Date(f.limite_reclamacion + 'T00:00:00Z') : null;
          const dias = lim ? Math.round((lim - hoy) / 86400000) : null;
          return { ...f, nombre: (cat[f.sku] && cat[f.sku].nombre) || f.sku, asin: (cat[f.sku] && cat[f.sku].asin) || '', dias_restantes: dias };
        });
        const total = +(datos.reduce((a, x) => a + (+x.importe_pendiente || 0), 0)).toFixed(2);
        const uds = datos.reduce((a, x) => a + (+x.uds_pendientes || 0), 0);
        return json({ datos, total, uds }, cors);
      }

      // --- BUY BOX / competencia por ASIN (lectura). Muestra primero lo problemático. ---
      if (url.pathname === '/v1/buybox') {
        const filas = await selSafe(env, 'buybox?order=tengo_buybox.asc.nullslast,fecha.desc', []);
        // snapshot: fecha más reciente
        let actualizado = null;
        for (const f of (filas || [])) if (f.fecha && (!actualizado || f.fecha > actualizado)) actualizado = f.fecha;
        const conBB = (filas || []).filter(f => f.tengo_buybox).length;
        return json({ datos: filas || [], actualizado, con_buybox: conBB, total: (filas || []).length }, cors);
      }

      // --- Ingesta de Buy Box (admin). ?n=15 procesa un lote (los más desactualizados). ---
      if (url.pathname === '/v1/buybox-ingest') {
        const n = Math.max(1, Math.min(60, +(url.searchParams.get('n') || 15)));
        const r = await ingestaBuyBox(env, undefined, n);
        return json({ ok: true, ...r, nota: 'getListingOffers va limitado; repite para cubrir el resto de SKU.' }, cors);
      }

      // --- VIGILANCIA DE FICHA (hijacking): título por ASIN + cambios + Buy Box. Lectura. ---
      if (url.pathname === '/v1/fichas') {
        const fichas = await selSafe(env, 'fichas?order=cambio_fecha.desc.nullslast', []);
        const bb = {}; try { for (const r of (await selSafe(env, 'buybox?select=asin,nombre,tengo_buybox,n_ofertas', []))) bb[r.asin] = r; } catch (_) {}
        const datos = (fichas || []).map(f => ({ ...f, nombre: (bb[f.asin] && bb[f.asin].nombre) || f.titulo || f.sku || f.asin, tengo_buybox: bb[f.asin] ? bb[f.asin].tengo_buybox : null, n_ofertas: bb[f.asin] ? bb[f.asin].n_ofertas : null }));
        let actualizado = null; for (const f of datos) if (f.fecha && (!actualizado || f.fecha > actualizado)) actualizado = f.fecha;
        const cambios = datos.filter(f => f.cambio_fecha).length;
        return json({ datos, actualizado, cambios }, cors);
      }

      // --- Ingesta de fichas (admin). ?n=15 procesa un lote. ---
      if (url.pathname === '/v1/fichas-ingest') {
        const n = Math.max(1, Math.min(60, +(url.searchParams.get('n') || 15)));
        const r = await ingestaFichas(env, undefined, n);
        return json({ ok: true, ...r, nota: 'Catalog API limitado; repite para cubrir el resto.' }, cors);
      }

      // --- EJECUCIÓN vía Ads API: pausar / reactivar una campaña (SP v3).
      //     Doble seguridad: exige la clave admin (no está en MIEMBRO_OK) Y el
      //     interruptor ADS_WRITE=1. Cambia campañas REALES → siempre con confirmación
      //     en el frontend. body: { pais, campania_id, estado: PAUSED|ENABLED } ---
      if (url.pathname === '/v1/ads/campana-estado' && request.method === 'POST') {
        if (String(env.ADS_WRITE || '') !== '1') return json({ error: 'ads_write_off', nota: 'Escritura desactivada. Pon ADS_WRITE=1 en Cloudflare para permitir cambios en Amazon.' }, cors, 403);
        let b; try { b = await request.json(); } catch (_) { b = {}; }
        const pais = (b.pais || '').toUpperCase(), cid = String(b.campania_id || ''), estado = (b.estado || '').toUpperCase();
        const profileId = ADS_PROFILES[pais];
        if (!profileId) return json({ error: 'pais_sin_perfil', pais }, cors, 400);
        if (!cid) return json({ error: 'falta_campania_id' }, cors, 400);
        if (estado !== 'PAUSED' && estado !== 'ENABLED') return json({ error: 'estado_invalido' }, cors, 400);
        const token = await lwaToken(env, 'ads');
        const r = await fetch(ADS_HOST + '/sp/campaigns', {
          method: 'PUT',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
            'Amazon-Advertising-API-Scope': profileId,
            'Content-Type': 'application/vnd.spCampaign.v3+json',
            'Accept': 'application/vnd.spCampaign.v3+json'
          },
          body: JSON.stringify({ campaigns: [{ campaignId: cid, state: estado }] })
        });
        let d = null; try { d = await r.json(); } catch (_) {}
        const aplicado = !!(d && d.campaigns && d.campaigns.success && d.campaigns.success.length);
        return json({ ok: r.ok, status: r.status, estado, aplicado, detalle: d }, cors);
      }

      // --- EJECUCIÓN vía Ads API: NEGATIVIZAR un término en una campaña (SP v3,
      //     nivel campaña). Misma doble seguridad (admin + ADS_WRITE). Confirmación
      //     en el frontend. body: { pais, campania_id, termino, tipo: EXACT|PHRASE } ---
      if (url.pathname === '/v1/ads/negativo' && request.method === 'POST') {
        if (String(env.ADS_WRITE || '') !== '1') return json({ error: 'ads_write_off', nota: 'Escritura desactivada. Pon ADS_WRITE=1 en Cloudflare.' }, cors, 403);
        let b; try { b = await request.json(); } catch (_) { b = {}; }
        const pais = (b.pais || '').toUpperCase(), cid = String(b.campania_id || ''), termino = (b.termino || '').trim(), tipo = (b.tipo || 'EXACT').toUpperCase();
        const profileId = ADS_PROFILES[pais];
        if (!profileId) return json({ error: 'pais_sin_perfil', pais }, cors, 400);
        if (!cid || !termino) return json({ error: 'faltan_datos' }, cors, 400);
        const matchType = tipo === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT';
        const token = await lwaToken(env, 'ads');
        const r = await fetch(ADS_HOST + '/sp/campaignNegativeKeywords', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
            'Amazon-Advertising-API-Scope': profileId,
            'Content-Type': 'application/vnd.spCampaignNegativeKeyword.v3+json',
            'Accept': 'application/vnd.spCampaignNegativeKeyword.v3+json'
          },
          body: JSON.stringify({ campaignNegativeKeywords: [{ campaignId: cid, keywordText: termino, matchType, state: 'ENABLED' }] })
        });
        let d = null; try { d = await r.json(); } catch (_) {}
        const aplicado = !!(d && d.campaignNegativeKeywords && d.campaignNegativeKeywords.success && d.campaignNegativeKeywords.success.length);
        return json({ ok: r.ok, status: r.status, aplicado, detalle: d }, cors);
      }

      // --- EJECUCIÓN vía Ads API: cambiar el PRESUPUESTO diario de una campaña
      //     (SP campaigns v3). Misma doble seguridad. body: { pais, campania_id, presupuesto } ---
      if (url.pathname === '/v1/ads/presupuesto' && request.method === 'POST') {
        if (String(env.ADS_WRITE || '') !== '1') return json({ error: 'ads_write_off', nota: 'Escritura desactivada. Pon ADS_WRITE=1 en Cloudflare.' }, cors, 403);
        let b; try { b = await request.json(); } catch (_) { b = {}; }
        const pais = (b.pais || '').toUpperCase(), cid = String(b.campania_id || ''), presupuesto = +b.presupuesto;
        const profileId = ADS_PROFILES[pais];
        if (!profileId) return json({ error: 'pais_sin_perfil', pais }, cors, 400);
        if (!cid) return json({ error: 'falta_campania_id' }, cors, 400);
        if (!(presupuesto > 0)) return json({ error: 'presupuesto_invalido' }, cors, 400);
        const token = await lwaToken(env, 'ads');
        const r = await fetch(ADS_HOST + '/sp/campaigns', {
          method: 'PUT',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
            'Amazon-Advertising-API-Scope': profileId,
            'Content-Type': 'application/vnd.spCampaign.v3+json',
            'Accept': 'application/vnd.spCampaign.v3+json'
          },
          body: JSON.stringify({ campaigns: [{ campaignId: cid, budget: { budget: presupuesto, budgetType: 'DAILY' } }] })
        });
        let d = null; try { d = await r.json(); } catch (_) {}
        const aplicado = !!(d && d.campaigns && d.campaigns.success && d.campaigns.success.length);
        return json({ ok: r.ok, status: r.status, aplicado, presupuesto, detalle: d }, cors);
      }

      // --- SEARCH QUERY PERFORMANCE (SQP): tu cuota del embudo por búsqueda. Lectura. ---
      if (url.pathname === '/v1/sqp') {
        const filas = await selSafe(env, 'busquedas_sqp?order=volumen.desc.nullslast&limit=500', []);
        let actualizado = null, semana = null;
        for (const f of (filas || [])) { if (f.fecha && (!actualizado || f.fecha > actualizado)) actualizado = f.fecha; if (f.semana && (!semana || f.semana > semana)) semana = f.semana; }
        return json({ datos: filas || [], actualizado, semana }, cors);
      }

      // --- Ingesta SQP (admin). ~1-4 min. ---
      if (url.pathname === '/v1/sqp-ingest') {
        try { const r = await ingestaSQP(env); return json({ ok: true, ...r }, cors); }
        catch (e) { return json({ error: (e && e.message) || String(e) }, cors, 200); }
      }

      // --- KEYWORDS: lista de palabras clave con su puja actual (para ajustar puja). Lectura. ---
      if (url.pathname === '/v1/ads/keywords') {
        const filas = await selSafe(env, 'ppc_keywords?order=fecha.desc&limit=8000', []);
        // Estado de la CAMPAÑA (de ppc_presupuestos) y nombre, para poder filtrar las
        // keywords de campañas apagadas y mostrar a qué campaña pertenece cada una.
        const camp = {};
        try { for (const c of (await selSafe(env, 'ppc_presupuestos?select=campania_id,campania,estado', []))) camp[c.campania_id] = c; } catch (_) {}
        let actualizado = null;
        const datos = (filas || []).map(f => {
          if (f.fecha && (!actualizado || f.fecha > actualizado)) actualizado = f.fecha;
          const c = camp[f.campania_id];
          return { ...f, campania: (c && c.campania) || '', campania_estado: (c && c.estado) || '' };
        });
        return json({ datos, actualizado }, cors);
      }

      // --- KEYWORDS por RANGO DE FECHAS: rendimiento agregado (gasto, clics,
      //     impresiones, ventas, pedidos → CVR/CTR/CPC/ACoS/ROAS) entre dos días.
      //     Lee ppc_keywords_dia vía RPC kw_perf_rango. Lectura. ---
      if (url.pathname === '/v1/ads/keywords-perf') {
        const hoy = new Date();
        const finDef = new Date(hoy.getTime() - 86400000).toISOString().slice(0, 10);   // ayer
        const iniDef = new Date(hoy.getTime() - 30 * 86400000).toISOString().slice(0, 10); // 30 días
        const desde = (url.searchParams.get('desde') || iniDef).slice(0, 10);
        const hasta = (url.searchParams.get('hasta') || finDef).slice(0, 10);
        // Diagnóstico de la fuente: ¿cuántas filas de términos hay en el rango?
        // (0 → la fuente está vacía; el problema no es la RPC sino que no se ha
        // recogido ningún término todavía.)
        let terminos_filas = 0;
        try { terminos_filas = (await selSafe(env, 'ppc_terminos?fecha=gte.' + desde + '&fecha=lte.' + hasta + '&select=keyword&limit=30000', [])).length; } catch (_) {}
        let datos = [], rpc_ok = false, rpc_error = null;
        try {
          const r = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/kw_perf_rango?desde=' + encodeURIComponent(desde) + '&hasta=' + encodeURIComponent(hasta),
            { headers: { apikey: env.SUPABASE_SERVICE_KEY } });
          if (r.ok) { datos = await r.json(); rpc_ok = true; }
          else { rpc_error = 'rpc ' + r.status + ': ' + (await r.text()).slice(0, 200); }
        } catch (e) { rpc_error = (e && e.message) || String(e); }
        // Normaliza tipos (la RPC devuelve bigint como número) y añade puja num.
        datos = (datos || []).map(d => ({
          keyword_id: d.keyword_id, pais: d.pais, campania_id: d.campania_id,
          keyword: d.keyword || '', concordancia: d.concordancia || '',
          puja: (d.puja != null ? +d.puja : null), estado: d.estado || '',
          campania: d.campania || '', campania_estado: d.campania_estado || '',
          clics: +d.clics || 0, impresiones: +d.impresiones || 0,
          gasto: d.gasto != null ? +d.gasto : 0, ventas: d.ventas != null ? +d.ventas : 0,
          pedidos: +d.pedidos || 0, dias: +d.dias || 0
        }));
        return json({ datos, desde, hasta, terminos_filas, rpc_ok, rpc_error }, cors);
      }

      // --- Ingesta de keywords + rendimiento (admin). En segundo plano (el informe
      //     de rendimiento tarda). ?pais=ES opcional. ---
      if (url.pathname === '/v1/ads/keywords-ingest') {
        const pais = (url.searchParams.get('pais') || '').toUpperCase() || undefined;
        ctx.waitUntil(ingestaKeywords(env, { pais }).catch(() => {}));
        // Refresca también los TÉRMINOS de búsqueda: es la fuente del rendimiento
        // por keyword del panel (clics/gasto/ventas por keyword y campaña).
        ctx.waitUntil(ingestaPPC(env, { solo: 'terminos', pais }).catch(() => {}));
        return json({ ok: true, lanzado: true, nota: 'Trayendo keywords, su rendimiento y los términos en segundo plano (1-3 min). Ábrelo en «PPC → Keywords» en un momento.' }, cors);
      }

      // --- DIAGNÓSTICO (admin): ejecuta el informe de RENDIMIENTO de keywords para
      //     UN mercado de forma SÍNCRONA y devuelve qué contesta Amazon (status,
      //     nº de filas diarias, keywords con datos y una muestra). Sirve para ver
      //     por qué salen «—»: si el informe falla, tarda o vuelve vacío. ---
      if (url.pathname === '/v1/ads/keywords-perf-probe') {
        const pais = (url.searchParams.get('pais') || 'ES').toUpperCase();
        const profileId = ADS_PROFILES[pais];
        if (!profileId) return json({ error: 'sin perfil de Ads para ' + pais, paises: Object.keys(ADS_PROFILES) }, cors);
        const hoy = new Date(), fin = new Date(hoy.getTime() - 86400000);
        const ini = new Date(fin.getTime() - 29 * 86400000);
        const desde = ini.toISOString().slice(0, 10), hasta = fin.toISOString().slice(0, 10);
        // Fuente REAL del panel: los términos de búsqueda ya recogidos (ppc_terminos).
        let terminos_filas = 0;
        try { terminos_filas = (await selSafe(env, 'ppc_terminos?pais=eq.' + encodeURIComponent(pais) + '&fecha=gte.' + desde + '&fecha=lte.' + hasta + '&select=keyword&limit=20000', [])).length; } catch (_) {}
        try {
          const rep = await adsInformeKeywordPerf(env, profileId, desde, hasta);
          const map = (rep && rep.map) || {}, dias = (rep && rep.dias) || [];
          const ids = Object.keys(map);
          const muestra = ids.slice(0, 5).map(id => ({ keyword_id: id, ...map[id] }));
          return json({ ok: true, pais, desde, hasta, keywords_con_datos: ids.length, filas_diarias: dias.length, terminos_filas, muestra }, cors);
        } catch (e) {
          return json({ ok: false, pais, desde, hasta, terminos_filas, error: (e && e.message) || String(e), pista: 'El panel usa los TÉRMINOS (ppc_terminos): si terminos_filas>0 el panel tendrá datos aunque el informe spKeywords falle.' }, cors);
        }
      }

      // --- Ingesta del mapa producto↔campaña (admin). Para el auto-apagado. ---
      if (url.pathname === '/v1/ads/productads-ingest') {
        const pais = (url.searchParams.get('pais') || '').toUpperCase() || undefined;
        const r = await ingestaProductAds(env, { pais });
        return json({ ok: true, ...r }, cors);
      }

      // --- BACKFILL del gasto de PPC por DÍA (admin). Rellena ppc_dia del histórico
      //     para que el PPC del dashboard sea el gasto real repartido por días.
      //     ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&pais=ES (por defecto ~4 meses). ---
      if (url.pathname === '/v1/ads/ppc-backfill') {
        const pais = (url.searchParams.get('pais') || '').toUpperCase() || undefined;
        const hasta = (url.searchParams.get('hasta') || '').slice(0, 10) || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const desde = (url.searchParams.get('desde') || '').slice(0, 10) || new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
        ctx.waitUntil(ingestaPPCrango(env, desde, hasta, { pais }).catch(() => {}));
        return json({ ok: true, lanzado: true, desde, hasta, nota: 'Rellenando el gasto de PPC por día en segundo plano (varios minutos según el rango). Recarga el P&L en un rato.' }, cors);
      }

      // --- BACKFILL de NOMBRES (admin). Rellena productos_catalogo.nombre de los
      //     SKU que salen como código (sin nombre) usando la API de Listings de
      //     Amazon (busca en ES, y si no, en FR/IT/DE/NL/BE). En segundo plano. ---
      if (url.pathname === '/v1/catalogo-nombres') {
        const sellerId = env.SPAPI_SELLER_ID || '';
        if (!sellerId) return json({ error: 'Falta SPAPI_SELLER_ID (Merchant Token) en Cloudflare.' }, cors);
        ctx.waitUntil((async () => {
          let cat = [];
          try { cat = await selSafe(env, 'productos_catalogo?select=sku,nombre,asin&limit=3000', []); } catch (_) {}
          const faltan = (cat || []).filter(c => { const n = (c.nombre || '').trim(); const s = (c.sku || '').trim(); return s && (!n || n === s); }).slice(0, 40);
          const mkts = [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT, MARKETPLACES.DE, MARKETPLACES.NL, MARKETPLACES.BE];
          for (const c of faltan) {
            let nombre = '', asin = c.asin || '', imagen = '';
            // 1) Listings por SKU: coge el nombre y, muy importante, el ASIN aunque no venga nombre.
            for (const mkt of mkts) {
              try {
                const r = await getListingEstado(env, sellerId, c.sku, mkt, undefined);
                if (r && r.asin && !asin) asin = r.asin;
                if (r && r.itemName) { nombre = r.itemName; break; }
              } catch (_) {}
            }
            // 2) Si sigue sin nombre pero ya tenemos ASIN → Catálogo por ASIN: título real + imagen.
            //    Funciona aunque el listing esté inactivo (misma fuente que las miniaturas).
            if ((!nombre || !imagen) && asin) {
              for (const mkt of mkts) {
                try {
                  const item = await getCatalogoItem(env, asin, mkt);
                  const t = (item && item.summaries && item.summaries[0] && item.summaries[0].itemName) || '';
                  const imgs = (item && item.images && item.images[0] && item.images[0].images) || [];
                  const main = imgs.find(x => x.variant === 'MAIN') || imgs[0];
                  if (t && !nombre) nombre = t;
                  if (main && main.link && !imagen) imagen = main.link;
                  if (nombre && imagen) break;
                } catch (_) {}
              }
            }
            // Guarda solo los campos con valor: nunca pisa un dato bueno con uno vacío.
            const fila = { seller: 'venmon', sku: c.sku };
            if (nombre) fila.nombre = nombre.slice(0, 300);
            if (asin) fila.asin = asin;
            if (imagen) fila.imagen = imagen;
            if (nombre || asin || imagen) { try { await upsertSupabase(env, 'productos_catalogo', [fila]); } catch (_) {} }
          }
        })().catch(() => {}));
        return json({ ok: true, lanzado: true, nota: 'Rellenando nombres, ASIN e imágenes que faltan desde Amazon (Listings + Catálogo, en segundo plano ~1-2 min). Si quedan más, vuelve a pulsarlo; luego pulsa "Rellenar imágenes" para el resto.' }, cors);
      }

      // --- EJECUCIÓN vía Ads API: cambiar la PUJA de una keyword (SP keywords v3).
      //     Doble seguridad (admin + ADS_WRITE). body: { pais, keyword_id, puja } ---
      if (url.pathname === '/v1/ads/puja' && request.method === 'POST') {
        if (String(env.ADS_WRITE || '') !== '1') return json({ error: 'ads_write_off', nota: 'Escritura desactivada. Pon ADS_WRITE=1 en Cloudflare.' }, cors, 403);
        let b; try { b = await request.json(); } catch (_) { b = {}; }
        const pais = (b.pais || '').toUpperCase(), kid = String(b.keyword_id || ''), puja = +b.puja;
        const profileId = ADS_PROFILES[pais];
        if (!profileId) return json({ error: 'pais_sin_perfil', pais }, cors, 400);
        if (!kid) return json({ error: 'falta_keyword_id' }, cors, 400);
        if (!(puja > 0)) return json({ error: 'puja_invalida' }, cors, 400);
        const token = await lwaToken(env, 'ads');
        const r = await fetch(ADS_HOST + '/sp/keywords', {
          method: 'PUT',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
            'Amazon-Advertising-API-Scope': profileId,
            'Content-Type': 'application/vnd.spKeyword.v3+json',
            'Accept': 'application/vnd.spKeyword.v3+json'
          },
          body: JSON.stringify({ keywords: [{ keywordId: kid, bid: puja }] })
        });
        let d = null; try { d = await r.json(); } catch (_) {}
        const aplicado = !!(d && d.keywords && d.keywords.success && d.keywords.success.length);
        // Refleja la nueva puja en la tabla si Amazon la aceptó.
        if (aplicado) { try { await upsertSupabase(env, 'ppc_keywords', [{ seller: 'venmon', keyword_id: kid, puja }]); } catch (_) {} }
        return json({ ok: r.ok, status: r.status, aplicado, puja, detalle: d }, cors);
      }

      // --- PLACEMENT: ACoS por ubicación del anuncio (Top of Search vs resto). Lectura. ---
      if (url.pathname === '/v1/ads/placement') {
        const filas = await selSafe(env, 'ppc_placement?order=gasto.desc', []);
        let actualizado = null;
        for (const f of (filas || [])) if (f.fecha && (!actualizado || f.fecha > actualizado)) actualizado = f.fecha;
        return json({ datos: filas || [], actualizado }, cors);
      }

      // --- Ingesta de placement (admin). El informe tarda 1-3 min POR PAÍS, así que
      //     NO se espera en la petición (se colgaría): se lanza en segundo plano y se
      //     devuelve al instante. ?pais=ES procesa solo uno. ---
      if (url.pathname === '/v1/ads/placement-ingest') {
        const pais = (url.searchParams.get('pais') || '').toUpperCase() || undefined;
        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(ingestaPlacement(env, { pais }).catch(() => {}));
          return json({ ok: true, lanzado: true, nota: 'Lanzado en segundo plano (el informe tarda 1-3 min por país). Abre «Rendimiento por ubicación» en unos minutos.' }, cors);
        }
        const r = await ingestaPlacement(env, { pais });
        return json({ ok: true, ...r }, cors);
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
          seller: email, email, refresh_token: await cifrar(env, tok.refresh_token),
          estado: 'activa', creado: new Date().toISOString()
        }]);
        return new Response('<html><head><meta charset="UTF-8"></head><body style="font-family:sans-serif;background:#0D0D0D;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h1 style="color:#FF7A00">&#10003; Amazon Ads conectado</h1><p>Ya puedes cerrar esta pesta&ntilde;a y volver a SellerBrain.</p></div></body></html>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // --- OAuth SP-API para CLIENTES (multicuenta): inicio ---
      //     El vendedor pulsa "Conectar Amazon" → consiente en Seller Central →
      //     Amazon redirige a /auth/spapi/callback con spapi_oauth_code.
      //     Requiere env.SPAPI_APP_ID (Application ID de tu app SP-API) y registrar
      //     la Redirect URI …/auth/spapi/callback en la app.
      if (url.pathname === '/auth/spapi/start') {
        const email = (url.searchParams.get('email') || '').trim().toLowerCase();
        if (!email || !env.SPAPI_APP_ID) return json({ error: 'falta email o SPAPI_APP_ID' }, cors, 400);
        const consentBase = env.SPAPI_CONSENT_URL || 'https://sellercentral.amazon.es/apps/authorize/consent';
        const params = new URLSearchParams({
          application_id: env.SPAPI_APP_ID,
          state: btoa(email),
          redirect_uri: url.origin + '/auth/spapi/callback'
        });
        // Mientras la app esté en BORRADOR/beta (sin publicar), Amazon exige version=beta.
        if (env.SPAPI_APP_BETA !== 'false') params.set('version', 'beta');
        return Response.redirect(consentBase + '?' + params.toString(), 302);
      }

      // --- OAuth SP-API: callback → intercambia el code por refresh token (cifrado) ---
      if (url.pathname === '/auth/spapi/callback') {
        const code = url.searchParams.get('spapi_oauth_code');
        const sellingPartnerId = url.searchParams.get('selling_partner_id') || '';
        const email = (atob(url.searchParams.get('state') || '') || 'desconocido').trim().toLowerCase();
        if (!code) return json({ error: 'sin spapi_oauth_code' }, cors, 400);
        const r = await fetch(LWA_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code', code,
            redirect_uri: url.origin + '/auth/spapi/callback',
            client_id: env.LWA_CLIENT_ID, client_secret: env.LWA_CLIENT_SECRET
          })
        });
        if (!r.ok) return json({ error: 'token exchange: ' + await r.text() }, cors, 500);
        const tok = await r.json();
        await upsertSupabase(env, 'cuentas_spapi', [{
          seller: email, email, selling_partner_id: sellingPartnerId,
          refresh_token: await cifrar(env, tok.refresh_token),
          estado: 'activa', creado: new Date().toISOString()
        }]);
        return new Response('<html><head><meta charset="UTF-8"></head><body style="font-family:sans-serif;background:#0D0D0D;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h1 style="color:#FF7A00">&#10003; Amazon conectado</h1><p>Tu cuenta de Amazon ya est&aacute; enlazada con SellerBrain. Puedes cerrar esta pesta&ntilde;a.</p></div></body></html>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // --- Ingesta manual (para probar sin esperar al cron) ---
      if (url.pathname === '/v1/ingest' && request.method === 'POST') {
        const res = await ingestaDiaria(env);
        return json(res, cors);
      }

      // --- Prueba del email de acceso (admin): /v1/email-test?to=tucorreo ---
      if (url.pathname === '/v1/email-test') {
        const to = (url.searchParams.get('to') || '').trim();
        if (!to) return json({ error: 'falta ?to=email' }, cors, 400);
        const r = await enviarAccesoEmail(env, to, 'SB-TEST-0000');
        return json({ enviado: r, nota: r && r.saltado ? 'Falta RESEND_API_KEY en Cloudflare' : 'Revisa tu bandeja (y spam)' }, cors);
      }

      // --- ALERTAS por email (admin/prueba): calcula las alertas del día y, si hay,
      //     las envía. /v1/alertas-test?to=tucorreo (sin 'to' solo las devuelve, no envía) ---
      if (url.pathname === '/v1/alertas-test') {
        const to = (url.searchParams.get('to') || '').trim();
        const seller = (url.searchParams.get('seller') || '').trim();   // opcional: prueba un vendedor concreto (su email)
        const alertas = await calcularAlertas(env, seller || undefined);
        if (!to) return json({ seller: seller || '(cuenta propia)', alertas, nota: 'Vista previa (no se ha enviado). Añade ?to=email para enviar.' }, cors);
        if (!alertas.length) return json({ alertas, nota: 'No hay alertas hoy → no se envía correo.' }, cors);
        const r = await enviarEmailAlertas(env, to, alertas);
        return json({ alertas, enviado: r, nota: r && r.saltado ? 'Falta RESEND_API_KEY en Cloudflare' : 'Revisa tu bandeja (y spam)' }, cors);
      }

      // --- Preferencias de ALERTAS del vendedor (opt-in + umbrales). El vendedor
      //     lo gestiona desde Ajustes con su token de login. GET lee, POST guarda. ---
      if (url.pathname === '/v1/alertas-prefs') {
        const auth = (request.headers.get('Authorization') || '').replace('Bearer ', '');
        const payload = await verificarJWT(env, auth);
        let email = ((payload && payload.email) || '').trim().toLowerCase();
        // Admin (clave maestra) puede gestionar/probar un vendedor con ?seller=
        if (!email && url.searchParams.get('seller')) email = url.searchParams.get('seller').trim().toLowerCase();
        if (!email) return json({ error: 'sin_sesion' }, cors, 401);
        const defs = { on: true, stock_dias: +(env.ALERTAS_STOCK_DIAS || 14), acos: +(env.ALERTAS_ACOS || 40), sobrecoste: +(env.ALERTAS_SOBRECOSTE || 20), margen_min: +(env.ALERTAS_MARGEN_MIN || 10) };
        if (request.method === 'POST') {
          let b; try { b = await request.json(); } catch (_) { b = {}; }
          const clamp = (v, lo, hi, d) => v == null || v === '' ? null : Math.max(lo, Math.min(hi, isFinite(+v) ? +v : d));
          const row = {
            seller: email, email,
            activo: b.on === false ? false : true,
            stock_dias: clamp(b.stock_dias, 1, 120, defs.stock_dias),
            acos: clamp(b.acos, 5, 300, defs.acos),
            sobrecoste: clamp(b.sobrecoste, 0, 100000, defs.sobrecoste),
            margen_min: clamp(b.margen_min, 0, 90, defs.margen_min),
            actualizado: new Date().toISOString()
          };
          try { await upsertSupabase(env, 'alertas_prefs', [row]); } catch (e) { return json({ error: 'no_guardado', detalle: e.message }, cors, 500); }
          return json({ ok: true, prefs: { on: row.activo, stock_dias: row.stock_dias ?? defs.stock_dias, acos: row.acos ?? defs.acos, sobrecoste: row.sobrecoste ?? defs.sobrecoste, margen_min: row.margen_min ?? defs.margen_min } }, cors);
        }
        // GET
        let m = null; try { m = (await selSafe(env, 'alertas_prefs?seller=eq.' + encodeURIComponent(email) + '&select=activo,stock_dias,acos,sobrecoste,margen_min&limit=1', []))[0]; } catch (_) {}
        const prefs = {
          on: m && m.activo != null ? !!m.activo : defs.on,
          stock_dias: m && m.stock_dias != null ? +m.stock_dias : defs.stock_dias,
          acos: m && m.acos != null ? +m.acos : defs.acos,
          sobrecoste: m && m.sobrecoste != null ? +m.sobrecoste : defs.sobrecoste,
          margen_min: m && m.margen_min != null ? +m.margen_min : defs.margen_min
        };
        return json({ ok: true, email, prefs, defaults: defs }, cors);
      }

      // --- DEMO de correos (admin): envía uno o TODOS los correos del ciclo para verlos.
      //     /v1/email-demo?to=tucorreo&tipo=todos   (tipo: acceso|seguimiento|renovacion|ultimo|cancelacion|todos) ---
      if (url.pathname === '/v1/email-demo') {
        const to = (url.searchParams.get('to') || '').trim();
        if (!to) return json({ error: 'falta ?to=email' }, cors, 400);
        const tipo = (url.searchParams.get('tipo') || 'todos').toLowerCase();
        const hoy = new Date();
        const dISO = (n) => new Date(hoy.getTime() + n * 86400000).toISOString().slice(0, 10);
        const m = { email: to, codigo: 'SB-DEMO-0000' };
        const res = {};
        const run = async (t) => {
          if (t === 'acceso') res.acceso = await enviarAccesoEmail(env, to, 'SB-DEMO-0000');
          else if (t === 'seguimiento') res.seguimiento = await enviarSeguimiento(env, { ...m, fin: dISO(15) });
          else if (t === 'renovacion') res.renovacion = await enviarRenovacion(env, { ...m, fin: dISO(0) });
          else if (t === 'ultimo') res.ultimo = await enviarUltimoAviso(env, { ...m, fin: dISO(-7) });
          else if (t === 'cancelacion') res.cancelacion = await enviarCancelacion(env, m, dISO(18));
        };
        const lista = tipo === 'todos' ? ['acceso', 'seguimiento', 'renovacion', 'ultimo', 'cancelacion'] : [tipo];
        for (const t of lista) { try { await run(t); } catch (e) { res[t] = { error: e.message }; } }
        return json({ enviado_a: to, tipos: lista, resultado: res, nota: 'Revisa tu bandeja (y spam)' }, cors);
      }

      // --- Ingesta COMPLETA multicuenta (VENMON + cada vendedor conectado). Admin. ---
      if (url.pathname === '/v1/ingest-todas' && request.method === 'POST') {
        const res = await ingestaDiariaTodas(env, 'manual');
        return json({ cuentas: res.length, res }, cors);
      }

      // --- Refresco LIGERO de ventas del día (solo pedidos). Barato: lo llama el
      //     cron cada hora y el dashboard puede llamarlo al abrir para ver el día
      //     al momento sin la ingesta completa. ---
      if (url.pathname === '/v1/ingest-ventas') {
        const res = await ingestaVentasHoy(env);
        return json(res, cors);
      }

      // --- PRUEBA multicuenta: refresco ligero de VENMON + cada vendedor conectado.
      //     Devuelve el resultado por vendedor (para ver que cada token trae SUS datos). ---
      if (url.pathname === '/v1/ingest-ventas-todas') {
        const res = await ingestaVentasTodas(env);
        return json({ cuentas: res.length, res }, cors);
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

      // --- Stock por país (informe paneuropeo) — fuerza la ingesta y devuelve
      //     diagnóstico (columnas + muestra) para verificar que llega bien. ---
      if (url.pathname === '/v1/inventario-pais') {
        const diag = await ingestaInventarioPais(env);
        // Aprovechamos para traer también los reembolsos ya recibidos (mismo botón).
        try { const rr = await ingestaReembolsos(env); diag.reembolsos = rr.reembolsos; } catch (e) { diag.reembolsos_error = e.message; }
        return json({ ok: true, ...diag }, cors);
      }

      // --- Ingesta del país de SALIDA (informe de envíos) → tabla envios_fc ---
      //     UNA ventana por llamada: ?dias=29&off=0 (el front encadena varias).
      if (url.pathname === '/v1/envios-ingest') {
        const dias = +url.searchParams.get('dias') || 29;
        const off = +url.searchParams.get('off') || 0;
        const diag = await ingestaEnvios(env, null, dias, off);
        return json({ ok: true, ...diag }, cors);
      }

      // --- SONDA IVA (admin): ¿tu cuenta genera el "Informe de transacciones de IVA"
      //     (GET_VAT_TRANSACTION_DATA)? Trae país de SALIDA y de LLEGADA por venta →
      //     clave para el sobrecoste por país de envío y para el módulo OSS/Ventanilla
      //     Única. Solo diagnostica: no guarda nada. ---
      if (url.pathname === '/v1/iva-check') {
        const diag = {};
        const hasta = new Date().toISOString();
        const desde = new Date(Date.now() - 30 * 86400000).toISOString();
        try {
          const tsv = await pedirInforme(env, 'GET_VAT_TRANSACTION_DATA', desde, hasta,
            [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT, MARKETPLACES.DE, MARKETPLACES.NL, MARKETPLACES.BE]);
          const filas = parseTSV(tsv);
          const cols = filas[0] ? Object.keys(filas[0]) : [];
          diag.disponible = true;
          diag.filas = filas.length;
          diag.lineas_crudas = (tsv || '').split('\n').length;
          diag.columnas = cols;
          diag.col_salida = cols.filter(c => c.indexOf('depart') > -1);      // país de salida
          diag.col_llegada = cols.filter(c => c.indexOf('arriv') > -1);      // país de llegada
          diag.col_pais = cols.filter(c => c.indexOf('country') > -1);
          diag.col_scheme = cols.filter(c => c.indexOf('scheme') > -1 || c.indexOf('vat') > -1);
          diag.crudo = (tsv || '').slice(0, 900);
          diag.muestra = filas.slice(0, 5);
        } catch (e) {
          diag.disponible = false;
          diag.error = e.message;   // 403 → la app no tiene el rol fiscal; FATAL → informe no generable
        }
        return json({ ok: true, ...diag }, cors);
      }

      // --- SONDA ENVÍOS (admin): Informe de Envíos Gestionados por Amazon
      //     (GET_AMAZON_FULFILLED_SHIPMENTS_DATA). Trae fulfillment-center-id (→ país
      //     de SALIDA) y ship-country (país de LLEGADA), SIN necesitar el rol fiscal.
      //     Alternativa accesible al informe de IVA para el sobrecoste por país y OSS. ---
      if (url.pathname === '/v1/envios-check') {
        const diag = {};
        const hasta = new Date().toISOString();
        const desde = new Date(Date.now() - 30 * 86400000).toISOString();
        const tipos = ['GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL', 'GET_AMAZON_FULFILLED_SHIPMENTS_DATA'];
        for (const tipo of tipos) {
          try {
            const tsv = await pedirInforme(env, tipo, desde, hasta,
              [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT, MARKETPLACES.DE, MARKETPLACES.NL, MARKETPLACES.BE]);
            const filas = parseTSV(tsv);
            const cols = filas[0] ? Object.keys(filas[0]) : [];
            diag.disponible = true;
            diag.tipo = tipo;
            diag.filas = filas.length;
            diag.columnas = cols;
            diag.col_centro = cols.filter(c => c.indexOf('fulfillment-center') > -1 || c.indexOf('fulfillment_center') > -1 || c.indexOf('center') > -1);
            diag.col_destino = cols.filter(c => c.indexOf('ship-country') > -1 || c.indexOf('ship_country') > -1 || (c.indexOf('country') > -1));
            // Centros logísticos vistos (los primeros caracteres del FC indican el país)
            const fcCol = diag.col_centro[0];
            if (fcCol) diag.centros = Array.from(new Set(filas.map(f => f[fcCol]).filter(Boolean))).slice(0, 20);
            diag.crudo = (tsv || '').slice(0, 900);
            break;
          } catch (e) {
            diag.disponible = false;
            diag['error_' + tipo] = e.message;
          }
        }
        return json({ ok: true, ...diag }, cors);
      }

      // --- Stock por país (LECTURA ligera del Libro Mayor ya guardado) + fecha de
      //     actualización. Para el aviso de "stock en país sin IVA". ---
      if (url.pathname === '/v1/stock-pais') {
        const rows = await selSafe(env, 'inventario_pais?select=pais,unidades,actualizado', []);
        const byP = {}; let act = null;
        for (const r of (rows || [])) {
          const p = (r.pais || '').toUpperCase(); if (!p) continue;
          byP[p] = (byP[p] || 0) + (+r.unidades || 0);
          if (r.actualizado && (!act || r.actualizado > act)) act = r.actualizado;
        }
        const paises = Object.keys(byP).map(p => ({ pais: p, unidades: byP[p] }))
          .filter(x => x.unidades > 0).sort((a, b) => b.unidades - a.unidades);
        return json({ paises, total: paises.reduce((a, x) => a + x.unidades, 0), actualizado: act }, cors);
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
        // Potencial total en €/mes = suma de todos los importes en € de las acciones
        // (negativizaciones + sobrecostes de logística recuperables + …).
        const potencial_mes = +(acciones.reduce((a, x) => {
          const m = /([\d.,]+)\s*€/.exec(x.v || '');
          return a + (m ? parseFloat(m[1].replace(/\./g, '').replace(',', '.')) : 0);
        }, 0)).toFixed(2);
        try {
          const plan = await generarPlanClaude(env, acciones, contexto);
          if (!plan) return json({ plan: null, mensaje: 'IA no disponible (falta ANTHROPIC_API_KEY).', acciones, potencial_mes }, cors);
          return json({ plan, modelo: 'SellerBrain IA', potencial_mes, generado: new Date().toISOString(), n_acciones: acciones.length }, cors);
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

      // --- Investigación de mercado / nichos (IA) para crecimiento de marca ---
      // Uso: POST /v1/nichos {objetivo, nicho, senales:{...}, resenas:"..."}
      if (url.pathname === '/v1/nichos' && request.method === 'POST') {
        let body; try { body = await request.json(); } catch (_) { body = {}; }
        if (!env.ANTHROPIC_API_KEY) return json({ error: 'IA no disponible (falta ANTHROPIC_API_KEY).' }, cors, 400);
        if (!(body.nicho || body.resenas)) return json({ error: 'Escribe el nicho/producto o pega reseñas.' }, cors, 400);
        try {
          const analisis = await generarAnalisisNicho(env, body);
          if (!analisis) return json({ error: 'sin_analisis' }, cors, 200);
          return json({ analisis, modelo: MODELO_IA, generado: new Date().toISOString() }, cors);
        } catch (e) {
          return json({ error: e.message }, cors, 200);
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
          pais, fecha: t.date || hasta, desde: t.date || desde, hasta: t.date || hasta,
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
          pais, fecha: t.date || hasta, desde: t.date || desde, hasta: t.date || hasta,
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
    // Configura en Cloudflare un cron HORARIO: "0 * * * *".
    //  · Cada hora → foto del PPC del día (para el análisis por horas).
    //  · A las 03:00 UTC → ingesta completa (SP-API + PPC + recoger pendientes).
    const hora = new Date(event.scheduledTime || Date.now()).getUTCHours();
    ctx.waitUntil((async () => {
      try { await capturarPPCHora(env); } catch (_) {}
      // Recoger informes async listos CADA hora (antes solo a las 3 UTC → un
      // informe que no estaba listo esperaba 24h). Ahora entra en la hora siguiente.
      try { await recogerPendientesPPC(env); } catch (_) {}
      // Refresco LIGERO de las ventas del día CADA hora (aprovecha esta misma
      // pasada del cron; solo pedidos → coste mínimo). Así el dashboard está al
      // día sin lanzar la ingesta a mano. A las 03:00 no hace falta porque la
      // ingesta completa de abajo ya trae los pedidos.
      if (hora !== 3) { try { await ingestaVentasTodas(env); } catch (_) {} }
      if (hora === 3) {
        await ingestaDiariaTodas(env, 'cron');   // VENMON + cada vendedor conectado
        try { await ingestaPPC(env, {}); } catch (_) {}
      }
      // A las 04:00 UTC, con el día de ayer ya cerrado, corrige el gasto de las
      // últimas horas que Amazon atribuyó tarde (opción "cierre real") y refresca
      // los presupuestos de las campañas (para detectar las limitadas del día).
      if (hora === 4) {
        try { await corregirCierrePPCHora(env); } catch (_) {}
        try { await traerPresupuestosAds(env); } catch (_) {}
      }
      // A las 02:00 UTC: vigilancia de ficha (título/imagen por ASIN → hijacking).
      if (hora === 2) { try { await ingestaFichasTodas(env); } catch (_) {} }
      // Buy Box / competencia por SKU (SP-API Pricing): AUTOMÁTICO CADA HORA, por
      // lotes rotando por antigüedad (los más desactualizados primero). getListingOffers
      // va limitado (~1 cada 2s), así que se hace por tandas: el catálogo entero se
      // refresca solo en unas pocas horas, sin pulsar ningún botón. Como el PPC por horas.
      try { await ingestaBuyBoxLoteTodas(env, 40); } catch (_) {}
      // A las 06:00 UTC: placement (ACoS por ubicación del anuncio, Ads API).
      if (hora === 6) { try { await ingestaPlacement(env); } catch (_) {} try { await ingestaKeywords(env); } catch (_) {} try { await ingestaProductAds(env); } catch (_) {} }
      // A las 10:00 UTC: listings por país (estado + motivo). Solo si hay Merchant Token.
      if (hora === 10 && env.SPAPI_SELLER_ID) { try { await ingestaListingsPais(env, undefined, {}); } catch (_) {} }
      // Lunes 06:00 UTC: Search Query Performance (Brand Analytics, semanal).
      if (hora === 6 && new Date().getUTCDay() === 1) { try { await ingestaSQP(env); } catch (_) {} }
      // A las 09:00 UTC: pedir reseña (Solicitations API) de los pedidos que hoy
      // entran en ventana. SOLO si RESENAS_AUTO=1 (opt-in). Amazon filtra la
      // elegibilidad real; si falta el rol, no hace nada (no rompe).
      if (hora === 9 && env.RESENAS_AUTO === '1') { try { await procesarResenas(env, undefined); } catch (_) {} }
      // A las 07:00 UTC (~09:00 España): alertas proactivas por email (stock bajo,
      // ACoS alto, sobrecostes recuperables). Solo si ALERTAS_EMAIL=1. Digest diario.
      if (hora === 7) { try { await procesarAlertas(env); } catch (_) {} }
      // A las 08:00 UTC (~10:00 España): ciclo de vida de fundadores — correos de
      // seguimiento/renovación/último aviso, bajas y (si BORRADO_AUTO=1) borrado.
      if (hora === 8) { try { await procesarFundadores(env); } catch (_) {} }
    })());
  }
};

/* =====================================================================
 * CIFRADO DE TOKENS (AES-GCM) — los refresh_token de cada cliente se guardan
 * CIFRADOS en Supabase; nunca en claro. La clave (TOKEN_ENC_KEY, 32 bytes en
 * base64) es un secreto de Cloudflare y jamás sale del Worker.
 * Requisito de la Data Protection Policy de Amazon y del RGPD.
 * =================================================================== */
async function _claveAES(env) {
  const raw = Uint8Array.from(atob(env.TOKEN_ENC_KEY), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function cifrar(env, texto) {
  if (!texto || !env.TOKEN_ENC_KEY) return texto;      // sin clave (dev) → se guarda tal cual
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await _claveAES(env);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(texto)));
  const buf = new Uint8Array(iv.length + ct.length); buf.set(iv); buf.set(ct, iv.length);
  let bin = ''; for (const b of buf) bin += String.fromCharCode(b);
  return 'enc:' + btoa(bin);
}
async function descifrar(env, dato) {
  if (!dato || !String(dato).startsWith('enc:')) return dato;   // compat: no cifrado
  if (!env.TOKEN_ENC_KEY) throw new Error('falta TOKEN_ENC_KEY para descifrar');
  const buf = Uint8Array.from(atob(String(dato).slice(4)), c => c.charCodeAt(0));
  const iv = buf.slice(0, 12), ct = buf.slice(12);
  const key = await _claveAES(env);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/* =====================================================================
 * TOKENS
 * =================================================================== */
const _tokenCache = {}; // {cacheKey:{token,exp}} — evita pedir token en cada llamada (menos subrequests)
// ctx (opcional, multicuenta): { seller, spapiToken, adsToken }. Sin ctx → cuenta
// propia (VENMON) con los secretos del entorno. La caché se separa por vendedor.
async function lwaToken(env, scope, ctx) {
  const seller = (ctx && ctx.seller) || 'venmon';
  const refresh = ctx
    ? (scope === 'ads' ? ctx.adsToken : ctx.spapiToken)
    : (scope === 'ads' ? env.ADS_REFRESH_TOKEN : env.SPAPI_REFRESH_TOKEN);
  const cacheKey = scope + '|' + seller;
  const c = _tokenCache[cacheKey];
  if (c && c.exp > Date.now() + 60000) return c.token;   // token aún válido (>1 min)
  if (!refresh) throw new Error('LWA token ' + scope + ': sin refresh_token (' + seller + ')');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refresh,
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
  _tokenCache[cacheKey] = { token: j.access_token, exp: Date.now() + ((j.expires_in || 3600) * 1000) };
  return j.access_token;
}

// Helpers multicuenta ------------------------------------------------------
// Añade el `seller` a cada fila antes de guardar (para el aislamiento por cuenta).
function conSeller(filas, seller) { return (filas || []).map(f => ({ ...f, seller: seller || 'venmon' })); }
// Lee las cuentas SP-API conectadas (activas) y descifra su refresh_token.
async function cuentasSpapiActivas(env) {
  let filas = [];
  try { filas = await selectSupabase(env, 'cuentas_spapi?estado=eq.activa&select=seller,refresh_token'); } catch (_) { return []; }
  const out = [];
  for (const c of (filas || [])) {
    if (!c.seller || !c.refresh_token) continue;
    try { out.push({ seller: c.seller, spapiToken: await descifrar(env, c.refresh_token) }); } catch (_) { /* token ilegible → se omite */ }
  }
  return out;
}

/* =====================================================================
 * SP-API — Reports (2021-06-30)
 * Flujo: createReport → poll → getReportDocument → descargar (gzip)
 * =================================================================== */
async function spapiCall(env, path, opts = {}, ctx) {
  const token = await lwaToken(env, 'spapi', ctx);
  const esperas = [30000, 60000, 90000];   // backoff ante 429 (createReport se rellena ~1/min)
  for (let intento = 0; ; intento++) {
    const r = await fetch(SPAPI_HOST + path, {
      ...opts,
      headers: {
        'x-amz-access-token': token,
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    if (r.ok) return r.json();
    if (r.status === 429 && intento < esperas.length) { await sleep(esperas[intento]); continue; }
    throw new Error('SP-API ' + path + ': ' + r.status + ' ' + await r.text());
  }
}

// Inventario FBA en TIEMPO REAL (FBA Inventory API) — sin generar informe, así
// evita el FATAL del report GET_FBA_MYI_*. Trae stock + nombre + ASIN de todos
// los SKUs de un marketplace, paginado.
// Stock POR PAÍS: informe paneuropeo GET_AFN_INVENTORY_DATA_BY_COUNTRY. Parseo
// defensivo (los nombres de columna pueden variar) + diagnóstico para verificar.
async function ingestaInventarioPais(env, ctx) {
  const seller = (ctx && ctx.seller) || 'venmon';
  const diag = { filas: 0, muestra: [], columnas: [] };
  // Libro Mayor de Inventario agregado POR PAÍS (saldo final = stock actual por país).
  // OJO (bug conocido de este informe): con timestamps con hora y pidiendo hasta
  // "ahora" devuelve vacío por desfase horario, y la vista MENSUAL sobre ventana a
  // mitad de mes también. Solución: vista DIARIA, rango alineado a días completos y
  // terminando AYER (el ledger no tiene el día en curso). Nos quedamos con el saldo
  // del día MÁS RECIENTE por sku|país = el stock actual en cada país.
  const hoy = new Date();
  const fin = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() - 1)); // ayer 00:00Z
  const ini = new Date(fin.getTime() - 30 * 86400000);
  const desde = ini.toISOString().slice(0, 10) + 'T00:00:00Z';
  const hasta = fin.toISOString().slice(0, 10) + 'T23:59:59Z';
  const pedir = async (periodo) => {
    try {
      return await pedirInforme(env, 'GET_LEDGER_SUMMARY_VIEW_DATA', desde, hasta,
        [MARKETPLACES.ES], { aggregateByLocation: 'COUNTRY', aggregatedByTimePeriod: periodo }, ctx);
    } catch (e) { diag['error_' + periodo] = e.message; return ''; }
  };
  let periodo = 'DAILY';
  let tsv = await pedir('DAILY');
  let filas = parseTSV(tsv);
  if (!filas.length) { periodo = 'MONTHLY'; tsv = await pedir('MONTHLY'); filas = parseTSV(tsv); } // respaldo
  diag.periodo = periodo;
  diag.rango = desde + ' → ' + hasta;
  if (filas[0]) diag.columnas = Object.keys(filas[0]).slice(0, 30);
  // Diagnóstico en crudo: ver qué devuelve Amazon exactamente (vacío, cabeceras, otro formato…)
  diag.lineas_crudas = (tsv || '').split('\n').length;
  diag.crudo = (tsv || '').slice(0, 700);
  diag.filas_parseadas = filas.length;
  // parseTSV pone las claves en minúscula (y ya quita comillas). "Location" es el
  // país (COUNTRY); "ending warehouse balance" el saldo; fecha en MM/DD/YYYY.
  const fSort = s => { const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? m[3] + m[1] + m[2] : String(s); };
  const byKey = {};   // sku|pais -> { bal, date }
  for (const r of filas) {
    const disp = (r['disposition'] || '').toUpperCase();
    if (disp && disp !== 'SELLABLE') continue;   // solo stock VENDIBLE (no dañado/perdido)
    const sku = r['msku'] || r['seller-sku'] || r['sku'] || '';
    const pais = String(r['location'] || r['country'] || '').trim().toUpperCase();
    const bal = +(r['ending warehouse balance'] || r['ending-warehouse-balance'] || 0) || 0;
    const date = fSort(r['date']);
    if (!sku || pais.length !== 2) continue;    // país = código ISO de 2 letras (no el FC completo)
    const k = sku + '|' + pais;
    if (!byKey[k] || date > byKey[k].date) byKey[k] = { bal, date };   // el saldo del día más reciente
  }
  const rows = Object.keys(byKey).map(k => {
    const i = k.lastIndexOf('|');
    return { sku: k.slice(0, i), pais: k.slice(i + 1), unidades: byKey[k].bal, actualizado: new Date().toISOString() };
  }).filter(r => r.unidades > 0);   // solo donde queda stock
  if (rows.length) await upsertSupabase(env, 'inventario_pais', conSeller(rows, seller));
  diag.filas = rows.length;
  diag.muestra = rows.slice(0, 8);

  // AJUSTES para el detector de reembolsos: unidades perdidas/dañadas/encontradas
  // por Amazon (columnas Lost/Damaged/Found del mismo Libro Mayor). Agregamos por
  // sku|país|día; el upsert conserva el histórico (clave sku,pais,fecha).
  try {
    const ajMap = {};
    for (const r of filas) {
      const sku = r['msku'] || r['seller-sku'] || r['sku'] || '';
      const pais = String(r['location'] || r['country'] || '').trim().toUpperCase();
      if (!sku || pais.length !== 2) continue;
      const perdido = +(r['lost'] || 0) || 0;
      const danado = +(r['damaged'] || 0) || 0;
      const encontrado = +(r['found'] || 0) || 0;
      if (!perdido && !danado && !encontrado) continue;
      const m = String(r['date']).match(/(\d{2})\/(\d{2})\/(\d{4})/);
      const fecha = m ? m[3] + '-' + m[1] + '-' + m[2] : null;
      if (!fecha) continue;
      const k = sku + '|' + pais + '|' + fecha;
      if (!ajMap[k]) ajMap[k] = { sku, pais, fecha, perdido: 0, danado: 0, encontrado: 0 };
      ajMap[k].perdido += perdido; ajMap[k].danado += danado; ajMap[k].encontrado += encontrado;
    }
    const aj = Object.values(ajMap);
    if (aj.length) await upsertSupabase(env, 'inventario_ajustes', conSeller(aj, seller));
    diag.ajustes = aj.length;
  } catch (e) { diag.ajustes_error = e.message; }
  return diag;
}

// Reembolsos que Amazon YA te ha hecho (para restarlos de lo reclamable). Informe
// GET_FBA_REIMBURSEMENTS_DATA de los últimos ~180 días.
async function ingestaReembolsos(env, ctx) {
  const seller = (ctx && ctx.seller) || 'venmon';
  const planCompleto = ctx ? !!ctx.spapiToken : !!(env.LWA_CLIENT_ID && env.SPAPI_REFRESH_TOKEN);
  if (!planCompleto) return { saltado: 'sin SP-API' };
  const desde = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';
  const hasta = new Date().toISOString();
  const tsv = await pedirInforme(env, 'GET_FBA_REIMBURSEMENTS_DATA', desde, hasta,
    [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT, MARKETPLACES.BE], undefined, ctx);
  const filas = parseTSV(tsv);
  const map = {};
  for (const r of filas) {
    const id = r['reimbursement-id'] || r['reimbursement_id'] || '';
    if (!id) continue;
    const sku = r['sku'] || r['merchant-sku'] || r['seller-sku'] || '';
    const uds = +(r['quantity-reimbursed-total'] || r['quantity-reimbursed-cash'] || 0) || 0;
    const importe = +((r['amount-total'] || '0').toString().replace(',', '.')) || 0;
    const fechaRaw = r['approval-date'] || r['reimbursement-date'] || r['date'] || '';
    const fecha = (String(fechaRaw).slice(0, 10)) || null;
    // Una reimbursement-id puede tener varias líneas (una por sku); las juntamos por id+sku.
    // El reembolso_id lleva el seller delante para que no colisione entre vendedores
    // (su PK es reembolso_id, no lleva seller).
    const k = seller + '|' + id + '|' + sku;
    if (!map[k]) map[k] = { reembolso_id: k, fecha, sku, motivo: r['reason'] || '', uds: 0, importe: 0, moneda: r['currency-unit'] || '', seller };
    map[k].uds += uds; map[k].importe += importe;
  }
  const rows = Object.values(map);
  if (rows.length) await upsertSupabase(env, 'reembolsos', rows);
  return { reembolsos: rows.length };
}

/* =====================================================================
 * REEMBOLSOS A CLIENTES vía Finances API (listFinancialEvents → RefundEventList).
 * Capta dinero devuelto al cliente por CUALQUIER motivo (entrega fallida, A-to-z,
 * garantía…), no solo devoluciones físicas. Es casi al momento (horas), a
 * diferencia del settlement (quincenas). REQUIERE el rol "Finance and Accounting"
 * en la app de Amazon: si no está concedido, Amazon responde 403 y devolvemos
 * { rol_falta:true } SIN romper el resto de la ingesta. Guarda en reembolsos_cliente.
 * =================================================================== */
async function ingestaReembolsosCliente(env, ctx) {
  const seller = (ctx && ctx.seller) || 'venmon';
  const planCompleto = ctx ? !!ctx.spapiToken : !!(env.LWA_CLIENT_ID && env.SPAPI_REFRESH_TOKEN);
  if (!planCompleto) return { ok: false, saltado: 'sin SP-API' };
  const desde = new Date(Date.now() - 30 * 86400000).toISOString();
  const CHARGES_CLIENTE = { Principal: 1, Shipping: 1, Tax: 1, ShippingTax: 1, GiftWrap: 1, GiftWrapTax: 1 };
  const acc = {};   // pedido|sku -> fila
  let next = null, paginas = 0;
  try {
    do {
      const path = next
        ? '/finances/v0/financialEvents?NextToken=' + encodeURIComponent(next)
        : '/finances/v0/financialEvents?PostedAfter=' + encodeURIComponent(desde) + '&MaxResultsPerPage=100';
      const j = await spapiCall(env, path, {}, ctx);
      const ev = (j && j.payload && j.payload.FinancialEvents) || {};
      for (const r of (ev.RefundEventList || [])) {
        const pedido = r.AmazonOrderId || '';
        const fecha = r.PostedDate || null;
        for (const it of (r.ShipmentItemAdjustmentList || r.ShipmentItemList || [])) {
          const sku = it.SellerSKU || '';
          if (!pedido || !sku) continue;
          let imp = 0, moneda = 'EUR';
          for (const c of (it.ItemChargeAdjustmentList || it.ItemChargeList || [])) {
            if (CHARGES_CLIENTE[c.ChargeType] && c.ChargeAmount) { imp += (+c.ChargeAmount.CurrencyAmount || 0); moneda = c.ChargeAmount.CurrencyCode || moneda; }
          }
          const uds = Math.abs(+it.QuantityShipped || 0) || 1;
          const k = pedido + '|' + sku;
          if (!acc[k]) acc[k] = { seller, pedido, sku, asin: '', fecha, importe_cliente: 0, moneda, uds: 0, motivo: '', fuente: 'finanzas' };
          acc[k].importe_cliente += -imp;   // los reembolsos vienen en negativo → lo pasamos a positivo
          acc[k].uds += uds;
        }
      }
      next = (j && j.payload && j.payload.NextToken) || null;
      paginas++;
      if (next) await sleep(2100);   // rate limit de Finances API
    } while (next && paginas < 20);
  } catch (e) {
    const msg = e.message || '';
    const rolFalta = /\s40[13]\s|Unauthorized|Forbidden|Access to requested resource is denied/i.test(msg);
    return { ok: false, error: msg, rol_falta: rolFalta };
  }
  const rows = Object.values(acc)
    .map(r => ({ ...r, importe_cliente: +r.importe_cliente.toFixed(2) }))
    .filter(r => r.importe_cliente > 0);
  if (rows.length) await upsertSupabase(env, 'reembolsos_cliente', rows);
  return { ok: true, reembolsos: rows.length, paginas };
}

/* =====================================================================
 * PEDIR RESEÑA (permitido) — Orders API + Solicitations API de Amazon.
 * Amazon tiene una API oficial para solicitar reseña: envía SU mensaje estándar
 * (el mismo que el botón "Solicitar una reseña" de Seller Central), una vez por
 * pedido y dentro de la ventana que fija Amazon (≈4-30 días tras la entrega). NO
 * toca datos del cliente ni manda correos propios → 100% dentro de política.
 * =================================================================== */

// Lista pedidos recientes (Orders API) candidatos a pedir reseña: enviados/entregados
// dentro de la ventana. Solo IDs + fecha + estado (sin datos personales del comprador).
async function listarPedidosResena(env, ctx, dias) {
  const mkts = [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT, MARKETPLACES.BE].join(',');
  const desde = new Date(Date.now() - (dias || 30) * 86400000).toISOString();
  const out = [];
  let next = null, pag = 0;
  do {
    const path = next
      ? '/orders/v0/orders?NextToken=' + encodeURIComponent(next) + '&MarketplaceIds=' + encodeURIComponent(mkts)
      : '/orders/v0/orders?MarketplaceIds=' + encodeURIComponent(mkts) + '&CreatedAfter=' + encodeURIComponent(desde) +
        '&OrderStatuses=Shipped&MaxResultsPerPage=100';
    const j = await spapiCall(env, path, {}, ctx);
    const p = (j && j.payload) || {};
    for (const o of (p.Orders || [])) {
      if (!o.AmazonOrderId) continue;
      out.push({ pedido: o.AmazonOrderId, fecha: o.PurchaseDate || null, estado: o.OrderStatus || '', mkt: o.MarketplaceId || MARKETPLACES.ES });
    }
    next = p.NextToken || null;
    pag++;
    if (next) await sleep(2500);   // Orders API va muy limitado
  } while (next && pag < 10);
  return out;
}

// Envía la solicitud de reseña oficial para UN pedido. Amazon decide si es elegible
// (ventana/ya enviada): 201 = enviada; 400 = no elegible/ya pedida; 403 = falta rol.
async function solicitarResena(env, pedido, mkt, ctx) {
  const token = await lwaToken(env, 'spapi', ctx);
  const path = '/solicitations/v1/orders/' + encodeURIComponent(pedido) +
    '/solicitations/productReviewAndSellerFeedback?marketplaceIds=' + encodeURIComponent(mkt || MARKETPLACES.ES);
  const r = await fetch(SPAPI_HOST + path, { method: 'POST', headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' } });
  if (r.status === 201 || r.ok) return { ok: true, estado: 'enviada' };
  const txt = await r.text();
  if (r.status === 403) return { ok: false, rol_falta: true, estado: 'error', detalle: txt.slice(0, 200) };
  // 400 típico: fuera de ventana, ya solicitada, o el comprador optó por no recibir.
  const yaEnviada = /already|previously|no.*eligible|not.*eligible/i.test(txt);
  return { ok: false, estado: yaEnviada ? 'ya_enviada' : 'pendiente', detalle: txt.slice(0, 200) };
}

// Recorre los pedidos elegibles y pide reseña de los que aún no hemos cerrado.
// Amazon es el que filtra la elegibilidad real; nosotros no repetimos los ya
// 'enviada'/'ya_enviada'. Tope por ejecución para respetar el rate limit.
async function procesarResenas(env, ctx) {
  const seller = (ctx && ctx.seller) || 'venmon';
  const planCompleto = ctx ? !!ctx.spapiToken : !!(env.LWA_CLIENT_ID && env.SPAPI_REFRESH_TOKEN);
  if (!planCompleto) return { ok: false, saltado: 'sin SP-API' };
  let pedidos;
  try { pedidos = await listarPedidosResena(env, ctx, 30); }
  catch (e) {
    const rol = /\s40[13]\s|Unauthorized|Forbidden|denied/i.test(e.message || '');
    return { ok: false, rol_falta: rol, error: (e.message || '').slice(0, 200) };
  }
  // Ya cerrados (no repetir).
  const cerrado = {};
  try { for (const r of (await selSafe(env, 'resenas_pedidas?seller=eq.' + encodeURIComponent(seller) + '&select=pedido,estado', []))) { if (r.estado === 'enviada' || r.estado === 'ya_enviada') cerrado[r.pedido] = 1; } } catch (_) {}
  // Ventana aproximada: 4-30 días desde la compra (Amazon afina la real).
  const ahora = Date.now();
  const elegibles = pedidos.filter(p => {
    if (cerrado[p.pedido]) return false;
    if (!p.fecha) return true;
    const d = (ahora - new Date(p.fecha).getTime()) / 86400000;
    return d >= 4 && d <= 30;
  });
  const res = { ok: true, revisados: pedidos.length, elegibles: elegibles.length, enviadas: 0, ya_enviadas: 0, pendientes: 0, errores: 0 };
  const filas = [];
  const TOPE = 80;
  for (const p of elegibles.slice(0, TOPE)) {
    let r;
    try { r = await solicitarResena(env, p.pedido, p.mkt, ctx); }
    catch (e) { r = { ok: false, estado: 'error', detalle: (e.message || '').slice(0, 200) }; }
    if (r.rol_falta) return { ...res, ok: false, rol_falta: true };
    if (r.estado === 'enviada') res.enviadas++;
    else if (r.estado === 'ya_enviada') res.ya_enviadas++;
    else if (r.estado === 'pendiente') res.pendientes++;
    else res.errores++;
    filas.push({ seller, pedido: p.pedido, fecha_pedido: p.fecha, fecha_solicitud: new Date().toISOString(), estado: r.estado, detalle: r.detalle || '' });
    await sleep(1100);   // Solicitations API ~1 req/s
  }
  if (filas.length) await upsertSupabase(env, 'resenas_pedidas', filas);
  return res;
}

/* =====================================================================
 * LISTINGS POR PAÍS — Listings Items API (getListingsItem). Por cada SKU y
 * marketplace, saca el estado (activo/inactivo/no publicado) y el MOTIVO (issues
 * de Amazon). Requiere el Merchant Token en env.SPAPI_SELLER_ID. Solo lectura.
 * =================================================================== */
const LISTINGS_MKTS = ['ES', 'FR', 'IT', 'DE', 'BE'];   // marketplaces a comprobar

// Un SKU en un marketplace: estado + motivo. 404 = no publicado en ese país.
async function getListingEstado(env, sellerId, sku, mkt, ctx) {
  // issueLocale: Amazon devuelve los MOTIVOS ya traducidos a este idioma (el del
  // vendedor), aunque el país sea DE/IT/FR. Por defecto español. Configurable con
  // la variable LISTINGS_LOCALE (p.ej. en_GB, fr_FR…).
  const locale = env.LISTINGS_LOCALE || 'es_ES';
  const path = '/listings/2021-08-01/items/' + encodeURIComponent(sellerId) + '/' + encodeURIComponent(sku) +
    '?marketplaceIds=' + encodeURIComponent(mkt) + '&includedData=summaries,issues&issueLocale=' + encodeURIComponent(locale);
  const token = await lwaToken(env, 'spapi', ctx);
  let r;
  for (let intento = 0; intento < 3; intento++) {
    r = await fetch(SPAPI_HOST + path, { headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' } });
    if (r.status !== 429) break;
    await sleep(1500 * (intento + 1));    // Amazon satura → backoff y reintento
  }
  if (r.status === 404) return { estado: 'no_publicado', motivo: '', asin: '' };
  if (r.status === 403 || r.status === 401) { const t = await r.text(); return { _rol: true, _err: t.slice(0, 160) }; }
  if (!r.ok) return { _err: 'HTTP ' + r.status };
  const j = await r.json();
  const sum = (j.summaries && j.summaries[0]) || {};
  const asin = sum.asin || '';
  const status = sum.status || [];                       // p.ej. ["BUYABLE"], ["DISCOVERABLE"]
  const buyable = Array.isArray(status) ? status.indexOf('BUYABLE') > -1 : false;
  // Motivo: errores primero (los que tumban el listing), luego avisos.
  const issues = j.issues || [];
  const errs = issues.filter(i => (i.severity || '').toUpperCase() === 'ERROR').map(i => i.message);
  const warns = issues.filter(i => (i.severity || '').toUpperCase() === 'WARNING').map(i => i.message);
  const motivo = (errs.length ? errs : warns).slice(0, 2).join(' · ').slice(0, 300);
  return { estado: buyable ? 'activo' : 'inactivo', motivo, asin, itemName: (sum.itemName || '').slice(0, 300) };
}

async function ingestaListingsPais(env, ctx, opts) {
  const seller = (ctx && ctx.seller) || 'venmon';
  const sellerId = (ctx && ctx.sellerId) || env.SPAPI_SELLER_ID || '';
  if (!sellerId) return { ok: false, falta_sellerid: true };
  let cat = [];
  try { cat = await selSafe(env, 'productos_catalogo?select=sku,asin&limit=3000', []); } catch (_) {}
  const seen = {}, skus = [];
  for (const c of (cat || [])) { const s = (c.sku || '').trim(); if (!s || seen[s]) continue; seen[s] = 1; skus.push({ sku: s, asin: c.asin || '' }); }
  // Rota: los menos frescos primero (para el modo por lotes).
  const prev = {};
  try { for (const r of (await selSafe(env, 'listings_pais?select=sku,fecha', []))) { const f = r.fecha || ''; if (!prev[r.sku] || f < prev[r.sku]) prev[r.sku] = f; } } catch (_) {}
  skus.sort((a, b) => (prev[a.sku] || '') < (prev[b.sku] || '') ? -1 : 1);
  const lote = (opts && opts.lote) ? skus.slice(0, opts.lote) : skus;
  let ok = 0, err = 0, rolFalta = false, guardados = 0;
  // IMPORTANTE: guardamos PRODUCTO A PRODUCTO (no todo al final). Así, si Cloudflare
  // corta la tarea en segundo plano, el progreso ya guardado se conserva y la
  // rotación (más antiguos primero) avanza en la siguiente pulsación.
  for (const it of lote) {
    // Los 5 países del producto EN PARALELO (burst permitido) → ~5× más rápido.
    let results = [];
    try {
      results = await Promise.all(LISTINGS_MKTS.map(p =>
        getListingEstado(env, sellerId, it.sku, MARKETPLACES[p], ctx).then(e => ({ p, e })).catch(() => ({ p, e: { _err: 'fetch' } }))
      ));
    } catch (_) { results = []; }
    const skuRows = [];
    for (const { p, e } of results) {
      if (e._rol) { rolFalta = true; continue; }
      if (e._err) { err++; continue; }
      skuRows.push({ seller, sku: it.sku, asin: e.asin || it.asin || null, pais: p, estado: e.estado, motivo: e.motivo || '', fecha: new Date().toISOString() });
      ok++;
    }
    if (skuRows.length) { try { await upsertSupabase(env, 'listings_pais', skuRows); guardados += skuRows.length; } catch (_) {} }
    if (rolFalta) break;
    await sleep(500);   // entre productos, para no pasar el ritmo sostenido (~5/s)
  }
  if (rolFalta) return { ok: false, rol_falta: true, guardados };
  return { ok: true, skus: lote.length, guardados, ok_calls: ok, err };
}

// Escritura sobre un listing (Listings Items API). method DELETE = cerrar; PATCH = reabrir.
// Requiere el rol de gestión de listings en la app; si falta, Amazon responde 403.
async function listingWrite(env, method, sellerId, sku, mkt, body, ctx) {
  const token = await lwaToken(env, 'spapi', ctx);
  const path = '/listings/2021-08-01/items/' + encodeURIComponent(sellerId) + '/' + encodeURIComponent(sku) +
    '?marketplaceIds=' + encodeURIComponent(mkt);
  const r = await fetch(SPAPI_HOST + path, {
    method,
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, ok: r.ok, d };
}

/* =====================================================================
 * GENERADOR DE LISTING con IA (Claude) — marco COSMO/Rufus (paper SIGMOD 2024
 * + método Libertad Virtual). Requiere ANTHROPIC_API_KEY. Solo admin.
 * =================================================================== */
async function llamarClaude(env, system, userText, maxTokens) {
  const model = env.LISTING_MODEL || 'claude-sonnet-5';
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens || 4000, system, messages: [{ role: 'user', content: userText }] })
    });
  } catch (e) { return { error: 'red: ' + (e.message || '') }; }
  let j = null; try { j = await r.json(); } catch (_) {}
  if (!r || !r.ok) return { error: (j && j.error && j.error.message) || ('HTTP ' + (r ? r.status : '0')) };
  // Junta el texto de TODOS los bloques de tipo "text" (no solo el primero): si el
  // modelo devuelve el contenido troceado o precedido de otro bloque, content[0].text
  // sería vacío y saldría "largo: 0" pese a haberse gastado tokens.
  let txt = '';
  if (j && Array.isArray(j.content)) {
    txt = j.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
  }
  return { texto: txt, uso: (j && j.usage) || null, stop: (j && j.stop_reason) || '', modelo: (j && j.model) || '', bloques: (j && Array.isArray(j.content)) ? j.content.length : 0 };
}
// Extrae el objeto JSON de la respuesta (quita ```json … ``` si viene con vallas).
function extraerJSON(s) {
  if (!s) return '';
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  return (i > -1 && j > i) ? s.slice(i, j + 1) : s;
}
function buildPromptListing(b) {
  b = b || {};
  const kws = Array.isArray(b.keywords) ? b.keywords : [];
  const kwTxt = kws.length ? kws.slice(0, 40).map(k => '- ' + (k.frase || k.keyword || '') +
    ' (volumen: ' + (k.volumen != null ? k.volumen : '?') + ', competencia: ' + (k.competencia != null ? k.competencia : '?') +
    (k.densidad != null ? ', title density: ' + k.densidad : '') + ')').join('\n') : '(no aportadas)';
  // Ficha ACTUAL del vendedor en Amazon (si se aportó): la IA la MEJORA, no parte de cero.
  const la = b.listing_actual || null;
  const laTxt = (la && (la.title || (la.bullets && la.bullets.length) || la.description)) ?
    ('\nFICHA ACTUAL EN AMAZON (MEJÓRALA — conserva lo que funcione, corrige lo flojo y potencia con las keywords; no empieces de cero):\n' +
      'Título actual: ' + (la.title || '(sin título)') + '\n' +
      'Bullets actuales:\n' + ((la.bullets || []).map(x => '- ' + x).join('\n') || '(ninguno)') + '\n' +
      'Descripción actual: ' + ((la.description || '(ninguna)').slice(0, 1500)) + '\n' +
      'Imágenes actuales: ' + ((la.imagenes && la.imagenes.length) ? (la.imagenes.length + ' (variantes: ' + la.imagenes.map(x => (x && x.variant) || '').filter(Boolean).slice(0, 12).join(', ') + '). Ten en cuenta lo que YA está cubierto visualmente al proponer los 7 briefs de imagen.') : '(sin datos de imágenes)')) : '';
  return [
    'PRODUCTO: ' + (b.producto || ''),
    'TIPO DE PRODUCTO: ' + (b.tipo || ''),
    'MARCA: ' + (b.marca || ''),
    'CATEGORÍA: ' + (b.categoria || ''),
    'MARKETPLACE / IDIOMA DE SALIDA: ' + (b.idioma || 'es_ES'),
    'PRECIO: ' + (b.precio || ''),
    'MATERIAL / CARACTERÍSTICAS CLAVE: ' + (b.caracteristicas || b.material || ''),
    'USOS PRINCIPALES: ' + (b.usos || ''),
    'USOS ALTERNATIVOS: ' + (b.usos_alt || ''),
    'AUDIENCIA / CLIENTE OBJETIVO: ' + (b.audiencia || ''),
    'OCASIONES DE USO: ' + (b.ocasiones || ''),
    'CERTIFICACIONES: ' + (b.certificaciones || ''),
    'CONTENIDO DE LA CAJA / GARANTÍA: ' + (b.caja || ''),
    'DOLORES Y OBJECIONES REALES (de reseñas de competidores):\n' + (b.resenas || '(no aportadas)'),
    laTxt,
    '',
    'KEYWORDS DE HELIUM 10 (prioriza MAYOR volumen y MENOR competencia; colócalas por peso: título → bullets → descripción → backend; NUNCA hagas keyword stuffing):',
    kwTxt,
    '',
    'Genera el listing y devuelve SOLO el JSON del esquema, escrito en el idioma del marketplace.'
  ].join('\n');
}
const SYSTEM_LISTING = `Eres un experto en listings de Amazon optimizados para COSMO (el grafo de intención de Amazon, paper SIGMOD 2024) y para Rufus/Alexa for Shopping (el asistente de compra con IA que responde leyendo el listing). Sigues el método de Libertad Virtual.

OBJETIVO: crear un listing que cubra los 15 atributos/relaciones COSMO, evite los penalizadores de Rufus y use las keywords de Helium 10 aportadas colocándolas por peso (mayor volumen y menor competencia primero) sin stuffing.

LOS 15 ATRIBUTOS COSMO (el listing debe responder todos, repartidos entre título, bullets, descripción, A+ y backend):
1 used_for_func (función principal) · 2 used_for_eve (evento/actividad) · 3 used_for_aud (audiencia por función) · 4 capable_of (capacidad concreta) · 5 used_to (tarea específica) · 6 used_as (uso alternativo) · 7 is_a (tipo de producto) · 8 used_on (temporada/momento) · 9 used_in_loc (ubicación/entorno) · 10 used_in_body (parte del cuerpo) · 11 used_with (compatibilidad/complemento) · 12 used_by (quién lo usa) · 13 xInterested_in (interés del comprador) · 14 xIs_a (identidad de la audiencia) · 15 xWant (resultado buscado).

REGLAS POR ELEMENTO:
- TÍTULO: 3 opciones. REGLA DURA DE AMAZON (obligatoria desde el 27-jul-2026, NO la incumplas): MÁXIMO 75 caracteres cada título (cuenta los espacios); si te pasas, recórtalo. Empieza SIEMPRE por la marca. Sin símbolos prohibidos (! $ ? _ { } ^ ¬ ¦ ~ # * % € @). Sin lenguaje promocional (nada de "oferta", "gratis", "el mejor", "garantía", "100%", "barato", "premium", "más vendido"…). Sin poner en MAYÚSCULAS palabras enteras y sin repetir un carácter 3+ veces. Estructura dentro de esos 75 car.: marca + tipo de producto + 1 dato medible clave + caso de uso o audiencia. Keyword principal cuanto antes. Prioriza que quepa lo esencial: si no cabe todo, quédate con marca + producto + beneficio principal.
- BULLETS: exactamente 5, con roles fijos: (1) diferenciador principal con especificación nombrada [capable_of]; (2) materiales, seguridad y certificaciones como entidades nombradas [is_a, used_in_body]; (3) caso de uso + audiencia explícita [used_for_eve, used_by, xIs_a]; (4) compatibilidad y dimensiones exactas [used_with]; (5) contenido de la caja + garantía + resultado esperado [xWant]. Empieza cada bullet con una etiqueta en MAYÚSCULAS + beneficio desarrollado, un dato medible por bullet, beneficio antes que característica, sin repetir frases.
- DESCRIPCIÓN: 1500-2000 caracteres, 4 párrafos, sin repetir los bullets: (1) propuesta de valor en prosa; (2) 2-3 escenarios de uso con contexto; (3) neutralización de objeciones reales de reseñas; (4) marca, origen, certificaciones y garantía. Usa puentes semánticos (característica → beneficio directo → beneficio inferible).
- IMÁGENES: 7 conceptos (principal fondo blanco; lifestyle con demográfico visible; infografía con datos; dimensiones/comparativa; uso alternativo; materiales/certificaciones; contenido de la caja/resultado). Por cada una da un brief y el texto overlay (frases nominales legibles por OCR, coherentes con el copy).
- A+ / A+ PREMIUM: una tabla comparativa (contra tu propia gama), 5 preguntas Q&A de alta intención (cada una refuerza varios atributos COSMO y responde una objeción), y un brand story breve con certificaciones y origen. ≥500 palabras rastreables en total.
- BACKEND: términos de búsqueda de intención/contexto que NO estén ya en el copy visible (sin repetir título/bullets), separados por espacios.

PENALIZADORES A EVITAR (Rufus): claims sin dato ("premium", "la mejor calidad"), keyword stuffing, vaguedad ("ideal para cocinar" → concreta), contradicción con reseñas. Usa siempre datos medibles.

DEVUELVE SOLO ESTE JSON (sin texto fuera, sin vallas de código):
{
 "titulos": ["op1","op2","op3"],
 "bullets": ["b1","b2","b3","b4","b5"],
 "descripcion": "…",
 "imagenes": [{"n":1,"tipo":"principal","brief":"…","overlay":"…"}],
 "aplus": {"tabla_comparativa":"…","qa":[{"q":"…","a":"…"}],"brand_story":"…"},
 "backend": ["término1","término2"],
 "cosmo": [{"n":1,"attr":"used_for_func","cubierto":true,"donde":"bullet 1"}],
 "avisos": ["recomendación o dato que falta para mejorar"]
}
El array "cosmo" DEBE tener las 15 relaciones con cubierto true/false y dónde queda cubierta cada una. Si algún dato de entrada falta, indícalo en "avisos" y usa un placeholder claro entre [corchetes].`;

async function traerInventarioFBA(env, marketplaceId, ctx) {
  const inv = {}, cat = {};
  let nextToken = null, pag = 0;
  do {
    const qs = new URLSearchParams({ details: 'true', granularityType: 'Marketplace', granularityId: marketplaceId, marketplaceIds: marketplaceId });
    if (nextToken) qs.set('nextToken', nextToken);
    // La API de inventario tiene una cuota baja: espaciamos las páginas y
    // reintentamos con backoff si Amazon devuelve 429 (QuotaExceeded).
    if (pag > 0) await sleep(2000);
    let j = null;
    for (let intento = 0; intento < 4; intento++) {
      try { j = await spapiCall(env, '/fba/inventory/v1/summaries?' + qs.toString(), {}, ctx); break; }
      catch (e) {
        if (String(e.message || '').indexOf('429') > -1 && intento < 3) { await sleep(3000 * (intento + 1)); continue; }
        throw e;
      }
    }
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

async function pedirInforme(env, reportType, dataStartTime, dataEndTime, marketplaceIds, reportOptions, ctx) {
  // Los informes "snapshot" (p.ej. inventario) NO aceptan rango de fechas:
  // se piden con dataStartTime/dataEndTime a null y solo se manda el tipo.
  // ctx opcional: multicuenta (usa el token del vendedor).
  const body = { reportType, marketplaceIds };
  if (dataStartTime) body.dataStartTime = dataStartTime;
  if (dataEndTime) body.dataEndTime = dataEndTime;
  if (reportOptions) body.reportOptions = reportOptions;   // p.ej. { aggregateByLocation:'COUNTRY' }
  const { reportId } = await spapiCall(env, '/reports/2021-06-30/reports', {
    method: 'POST',
    body: JSON.stringify(body)
  }, ctx);
  // Poll hasta DONE (máx ~4 min; los settlement suelen estar ya generados)
  for (let i = 0; i < 24; i++) {
    await sleep(10000);
    const rep = await spapiCall(env, '/reports/2021-06-30/reports/' + reportId, {}, ctx);
    if (rep.processingStatus === 'DONE') return descargarDocumento(env, rep.reportDocumentId, ctx);
    if (['CANCELLED', 'FATAL'].includes(rep.processingStatus)) {
      throw new Error('Informe ' + reportType + ': ' + rep.processingStatus);
    }
  }
  throw new Error('Informe ' + reportType + ': timeout');
}

// Los settlement NO se piden: Amazon los genera solo. Se listan y descargan.
async function listarSettlements(env, desdeISO, ctx) {
  const q = new URLSearchParams({
    reportTypes: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
    processingStatuses: 'DONE',
    createdSince: desdeISO
  });
  const { reports } = await spapiCall(env, '/reports/2021-06-30/reports?' + q, {}, ctx);
  return reports || [];
}

async function descargarDocumento(env, documentId, ctx) {
  const doc = await spapiCall(env, '/reports/2021-06-30/documents/' + documentId, {}, ctx);
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

// Crea un informe de Ads y devuelve su reportId. Si Amazon responde 425
// (ya existe uno igual hoy), reutiliza ese informe en vez de fallar.
// Trae el PRESUPUESTO diario de cada campaña (API de campañas SP v3, distinta del
// endpoint de informes) y lo guarda en ppc_presupuestos. Con eso detectamos las
// campañas limitadas por presupuesto (v_ppc_limitadas).
async function traerPresupuestosAds(env) {
  const diag = [];
  const token = await lwaToken(env, 'ads');
  for (const [pais, profileId] of Object.entries(ADS_PROFILES)) {
    try {
      const headers = {
        'Authorization': 'Bearer ' + token,
        'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        'Accept': 'application/vnd.spCampaign.v3+json'
      };
      const r = await fetch(ADS_HOST + '/sp/campaigns/list', {
        method: 'POST', headers,
        body: JSON.stringify({ maxResults: 500, stateFilter: { include: ['ENABLED', 'PAUSED'] } })
      });
      if (!r.ok) { diag.push({ pais, estado: 'error', http: r.status, msg: (await r.text()).slice(0, 140) }); continue; }
      const j = await r.json();
      const camps = j.campaigns || [];
      const filas = camps.map(c => {
        let bud = 0;
        if (c.budget && typeof c.budget === 'object') bud = +c.budget.budget || 0;
        else bud = +c.budget || +c.dailyBudget || 0;
        return { pais, campania_id: String(c.campaignId || ''), campania: c.name || '', presupuesto: bud, estado: c.state || '', actualizado: new Date().toISOString() };
      }).filter(x => x.campania_id);
      if (filas.length) await upsertSupabase(env, 'ppc_presupuestos', filas);
      diag.push({ pais, estado: 'ok', campanas: filas.length });
    } catch (e) { diag.push({ pais, estado: 'error', msg: ((e && e.message) || String(e)).slice(0, 150) }); }
  }
  return diag;
}

async function crearReporteAds(headers, body) {
  const r = await fetch(ADS_HOST + '/reporting/reports', { method: 'POST', headers, body: JSON.stringify(body) });
  if (r.status === 425) {
    const t = await r.text();
    const m = t.match(/duplicate of\s*:?\s*([0-9a-fA-F-]{20,})/);
    if (m) return m[1];                              // reutiliza el informe existente
    throw new Error('Ads report: 425 ' + t);
  }
  if (!r.ok) throw new Error('Ads report: ' + r.status + ' ' + await r.text());
  return (await r.json()).reportId;
}

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
  const reportId = await crearReporteAds(headers, body);
  // Poll: pocas consultas pero espaciadas (menos subpeticiones en plan gratis)
  for (let i = 0; i < 16; i++) {
    await sleep(15000);
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
  const reportId = await crearReporteAds(headers, body);
  for (let i = 0; i < 16; i++) {
    await sleep(15000);
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

// Rendimiento por KEYWORD (clics, gasto, ventas, pedidos) — informe spKeywords,
// groupBy keyword. Para la puja sugerida. Devuelve mapa keywordId -> métricas.
async function adsInformeKeywordPerf(env, profileId, desde, hasta) {
  const token = await lwaToken(env, 'ads');
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
    'Amazon-Advertising-API-Scope': profileId,
    'Content-Type': 'application/vnd.createasyncreportrequest.v3+json'
  };
  const body = {
    name: 'sb-kwperf-' + desde + '-' + hasta,
    startDate: desde, endDate: hasta,
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['keyword'],
      // DAILY (una fila por keyword y día) para poder guardar el detalle diario en
      // ppc_keywords_dia y luego filtrar por rango de fechas en el panel.
      columns: ['date', 'keywordId', 'campaignId', 'cost', 'clicks', 'impressions', 'sales14d', 'purchases14d'],
      reportTypeId: 'spKeywords',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON'
    }
  };
  const reportId = await crearReporteAds(headers, body);
  for (let i = 0; i < 16; i++) {
    await sleep(15000);
    const st = await fetch(ADS_HOST + '/reporting/reports/' + reportId, { headers });
    const j = await st.json();
    if (j.status === 'COMPLETED') {
      const gz = await fetch(j.url);
      const ds = new DecompressionStream('gzip');
      const txt = await new Response(new Response(await gz.arrayBuffer()).body.pipeThrough(ds)).text();
      const arr = JSON.parse(txt);
      const map = {};    // resumen por keyword (suma del periodo) → puja sugerida y columnas de ppc_keywords
      const dias = [];   // filas diarias → ppc_keywords_dia (para el filtro por fechas)
      for (const r of (arr || [])) {
        const id = String(r.keywordId || '');
        if (!id) continue;
        const clics = +r.clicks || 0, gasto = +r.cost || 0, ventas = +r.sales14d || 0, pedidos = +r.purchases14d || 0, impresiones = +r.impressions || 0;
        const m = map[id] || (map[id] = { clics: 0, gasto: 0, ventas: 0, pedidos: 0, impresiones: 0 });
        m.clics += clics; m.gasto += gasto; m.ventas += ventas; m.pedidos += pedidos; m.impresiones += impresiones;
        const fecha = String(r.date || '').slice(0, 10);
        if (fecha) dias.push({ keyword_id: id, campania_id: String(r.campaignId || ''), fecha, clics, gasto: +gasto.toFixed(2), ventas: +ventas.toFixed(2), pedidos, impresiones });
      }
      return { map, dias };
    }
    if (j.status === 'FAILURE') throw new Error('Ads spKeywords FAILURE');
  }
  throw new Error('timeout kwperf · reportId=' + reportId);
}

/* =====================================================================
 * PLACEMENT (Top of Search vs resto vs páginas de producto) — informe de Ads
 * spCampaigns agrupado por campaignPlacement (David #8). Con esto sabemos dónde
 * convierte mejor tu publicidad y si conviene subir el ajuste de puja de
 * "Top of Search". Se guarda en ppc_placement. Cuenta propia (Ads single-tenant).
 * =================================================================== */
async function adsInformePlacement(env, profileId, desde, hasta) {
  const token = await lwaToken(env, 'ads');
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
    'Amazon-Advertising-API-Scope': profileId,
    'Content-Type': 'application/vnd.createasyncreportrequest.v3+json'
  };
  const body = {
    name: 'sb-placement-' + desde + '-' + hasta,
    startDate: desde, endDate: hasta,
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['campaignPlacement'],
      columns: ['campaignName', 'placementClassification', 'cost', 'clicks', 'impressions', 'sales14d', 'purchases14d'],
      reportTypeId: 'spCampaigns',
      timeUnit: 'SUMMARY',
      format: 'GZIP_JSON'
    }
  };
  const reportId = await crearReporteAds(headers, body);
  for (let i = 0; i < 16; i++) {
    await sleep(15000);
    const st = await fetch(ADS_HOST + '/reporting/reports/' + reportId, { headers });
    const j = await st.json();
    if (j.status === 'COMPLETED') {
      const gz = await fetch(j.url);
      const ds = new DecompressionStream('gzip');
      const txt = await new Response(new Response(await gz.arrayBuffer()).body.pipeThrough(ds)).text();
      return JSON.parse(txt);
    }
    if (j.status === 'FAILURE') throw new Error('Ads placement FAILURE');
  }
  throw new Error('timeout placement · reportId=' + reportId);
}

async function ingestaPlacement(env, opts) {
  opts = opts || {};
  const hasta = new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10);   // ayer
  const desde = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);  // 30 días
  const perfiles = opts.pais ? (ADS_PROFILES[opts.pais] ? { [opts.pais]: ADS_PROFILES[opts.pais] } : {}) : ADS_PROFILES;
  const res = { desde, hasta, pasos: [] };
  for (const [pais, profileId] of Object.entries(perfiles)) {
    try {
      const data = await adsInformePlacement(env, profileId, desde, hasta);
      const rows = (data || []).map(r => ({
        seller: 'venmon', pais,
        campania: r.campaignName || '',
        placement: r.placementClassification || '?',
        gasto: +(+r.cost || 0).toFixed(2), clics: +r.clicks || 0, impresiones: +r.impressions || 0,
        ventas_ppc: +(+r.sales14d || 0).toFixed(2), pedidos_ppc: +r.purchases14d || 0,
        desde, hasta, fecha: new Date().toISOString()
      }));
      if (rows.length) await upsertSupabase(env, 'ppc_placement', rows);
      res.pasos.push({ pais, filas: rows.length });
    } catch (e) { res.pasos.push({ pais, error: e.message }); }
  }
  return res;
}

/* =====================================================================
 * KEYWORDS y PUJAS (Ads API, SP) — lista de palabras clave con su keywordId y
 * su puja actual (David: ajustar puja). Necesario para poder CAMBIAR la puja
 * desde el panel. Se listan con POST /sp/keywords/list (paginado) y se guardan
 * en ppc_keywords. Cuenta propia (Ads single-tenant).
 * =================================================================== */
async function spKeywordsList(env, profileId) {
  const token = await lwaToken(env, 'ads');
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
    'Amazon-Advertising-API-Scope': profileId,
    'Content-Type': 'application/vnd.spKeyword.v3+json',
    'Accept': 'application/vnd.spKeyword.v3+json'
  };
  const out = []; let nextToken = null, guard = 0;
  do {
    const body = { maxResults: 500 };
    if (nextToken) body.nextToken = nextToken;
    const r = await fetch(ADS_HOST + '/sp/keywords/list', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('sp keywords/list ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    for (const k of (j.keywords || [])) out.push(k);
    nextToken = j.nextToken || null; guard++;
  } while (nextToken && guard < 12);
  return out;
}

async function ingestaKeywords(env, opts) {
  opts = opts || {};
  const perfiles = opts.pais ? (ADS_PROFILES[opts.pais] ? { [opts.pais]: ADS_PROFILES[opts.pais] } : {}) : ADS_PROFILES;
  const res = { pasos: [] };
  // Mercados EN PARALELO: cada informe de rendimiento tarda 1-4 min; hacerlos a la
  // vez (en vez de en serie) evita que el trabajo en segundo plano se corte antes
  // de guardar el rendimiento de todos los países.
  await Promise.all(Object.entries(perfiles).map(async ([pais, profileId]) => {
    try {
      const ks = await spKeywordsList(env, profileId);
      // Rendimiento por keyword (últimos 30 días) para la puja sugerida. Si el
      // informe falla o tarda, seguimos igual con la lista de pujas (sin métricas).
      let perf = {};
      try {
        const hoy = new Date(), fin = new Date(hoy.getTime() - 86400000);
        const ini = new Date(fin.getTime() - 29 * 86400000);
        const rep = await adsInformeKeywordPerf(env, profileId, ini.toISOString().slice(0, 10), fin.toISOString().slice(0, 10));
        perf = (rep && rep.map) || {};
        // Detalle DIARIO por keyword → ppc_keywords_dia (para el filtro por fechas).
        // PK (seller,pais,keyword_id,fecha): el upsert acumula histórico sin borrar.
        const dias = (rep && rep.dias) || [];
        if (dias.length) {
          const drows = dias.map(d => ({ seller: 'venmon', pais, keyword_id: d.keyword_id, campania_id: d.campania_id, fecha: d.fecha, clics: d.clics, impresiones: d.impresiones, gasto: d.gasto, ventas: d.ventas, pedidos: d.pedidos }));
          for (let i = 0; i < drows.length; i += 500) { try { await upsertSupabase(env, 'ppc_keywords_dia', drows.slice(i, i + 500)); } catch (_) {} }
          res.pasos.push({ pais, dias: drows.length });
        }
      } catch (e) { res.pasos.push({ pais, perf_error: (e.message || '').slice(0, 120) }); }
      const rows = ks.map(k => {
        const id = String(k.keywordId || '');
        const m = perf[id] || {};
        return {
          seller: 'venmon', pais,
          keyword_id: id,
          campania_id: String(k.campaignId || ''),
          adgroup_id: String(k.adGroupId || ''),
          keyword: k.keywordText || '',
          concordancia: k.matchType || '',
          puja: (k.bid != null ? +k.bid : null),
          estado: k.state || '',
          clics: m.clics != null ? m.clics : null,
          gasto: m.gasto != null ? +(+m.gasto).toFixed(2) : null,
          ventas: m.ventas != null ? +(+m.ventas).toFixed(2) : null,
          pedidos: m.pedidos != null ? m.pedidos : null,
          impresiones: m.impresiones != null ? m.impresiones : null,
          fecha: new Date().toISOString()
        };
      }).filter(r => r.keyword_id);
      if (rows.length) await upsertSupabase(env, 'ppc_keywords', rows);
      res.pasos.push({ pais, filas: rows.length, con_rendimiento: Object.keys(perf).length });
    } catch (e) { res.pasos.push({ pais, error: e.message }); }
  }));
  return res;
}

/* =====================================================================
 * MAPA PRODUCTO ↔ CAMPAÑA (Sponsored Products) + AUTO-APAGADO por rentabilidad.
 * =================================================================== */
async function spProductAdsList(env, profileId) {
  const token = await lwaToken(env, 'ads');
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
    'Amazon-Advertising-API-Scope': profileId,
    'Content-Type': 'application/vnd.spProductAd.v3+json',
    'Accept': 'application/vnd.spProductAd.v3+json'
  };
  const out = []; let next = null, g = 0;
  do {
    const body = { maxResults: 500 };
    if (next) body.nextToken = next;
    const r = await fetch(ADS_HOST + '/sp/productAds/list', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('productAds/list ' + r.status + ' ' + (await r.text()).slice(0, 150));
    const j = await r.json();
    for (const a of (j.productAds || [])) out.push(a);
    next = j.nextToken || null; g++;
  } while (next && g < 12);
  return out;
}
async function ingestaProductAds(env, opts) {
  opts = opts || {};
  const perfiles = opts.pais ? (ADS_PROFILES[opts.pais] ? { [opts.pais]: ADS_PROFILES[opts.pais] } : {}) : ADS_PROFILES;
  const res = { pasos: [] };
  for (const [pais, profileId] of Object.entries(perfiles)) {
    try {
      const ads = await spProductAdsList(env, profileId);
      const rows = ads.map(a => ({
        seller: 'venmon', pais, campania_id: String(a.campaignId || ''), adgroup_id: String(a.adGroupId || ''),
        sku: (a.sku || ''), asin: (a.asin || ''), estado: a.state || '', fecha: new Date().toISOString()
      })).filter(r => r.campania_id && (r.sku || r.asin));
      if (rows.length) await upsertSupabase(env, 'ppc_product_ads', rows);
      res.pasos.push({ pais, filas: rows.length });
    } catch (e) { res.pasos.push({ pais, error: (e.message || '').slice(0, 120) }); }
  }
  return res;
}
// Cambia el estado de UNA campaña (para el auto-apagado). PUT SP campaigns v3.
async function adsCampanaEstado(env, pais, cid, estado) {
  const profileId = ADS_PROFILES[pais]; if (!profileId) return { ok: false, error: 'sin_perfil' };
  const token = await lwaToken(env, 'ads');
  const r = await fetch(ADS_HOST + '/sp/campaigns', {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + token, 'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID, 'Amazon-Advertising-API-Scope': profileId, 'Content-Type': 'application/vnd.spCampaign.v3+json', 'Accept': 'application/vnd.spCampaign.v3+json' },
    body: JSON.stringify({ campaigns: [{ campaignId: cid, state: estado }] })
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { ok: r.ok, aplicado: !!(d && d.campaigns && d.campaigns.success && d.campaigns.success.length) };
}
// Auto-apagado por baja rentabilidad (solo cuenta propia). Devuelve líneas de
// alerta para el email. Solo PAUSA de verdad si PPC_AUTOPAUSE=1 y ADS_WRITE=1, y
// solo cuando el SKU lo anuncia UNA sola campaña activa (si son varias, avisa).
async function autopausaPorRentabilidad(env) {
  const lines = [];
  const owner = env.OWNER_SELLER || 'venmon';
  let margenMin = +(env.ALERTAS_MARGEN_MIN || 10);
  try { const p = (await selSafe(env, 'alertas_prefs?seller=eq.' + encodeURIComponent(owner) + '&select=margen_min&limit=1', []))[0]; if (p && p.margen_min != null) margenMin = +p.margen_min; } catch (_) {}
  const hoy = new Date().toISOString().slice(0, 10), hace30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  let prods = []; try { prods = await productosPeriodo(env, hace30, hoy); } catch (_) { return lines; }
  const LOSS_MIN = +(env.ALERTAS_PERDIDA_MIN || 30);
  const flojos = [];
  for (const p of (prods || [])) {
    if (!(p.coste > 0)) continue;
    const ventas = +p.ventas || 0; if (ventas < LOSS_MIN) continue;
    const net = (+p.ben || 0) - (+p.ppc || 0);
    const mg = ventas > 0 ? (net / ventas * 100) : 0;
    if (net >= 0 && mg < margenMin) flojos.push({ sku: p.sku, nom: p.nom, mg: +mg.toFixed(1) });
  }
  if (!flojos.length) return lines;
  const bySku = {};
  try { for (const r of (await selSafe(env, 'ppc_product_ads?select=sku,campania_id,pais,estado', []))) { if ((r.estado || '').toUpperCase() !== 'ENABLED') continue; const s = r.sku || ''; if (!s) continue; (bySku[s] = bySku[s] || []).push(r); } } catch (_) {}
  const canWrite = env.ADS_WRITE === '1' && env.PPC_AUTOPAUSE === '1';
  for (const it of flojos) {
    const uniq = {}; (bySku[it.sku] || []).forEach(c => uniq[c.pais + '|' + c.campania_id] = c);
    const lista = Object.values(uniq);
    if (lista.length === 1) {
      const c = lista[0];
      if (canWrite) {
        let r = {}; try { r = await adsCampanaEstado(env, c.pais, c.campania_id, 'PAUSED'); } catch (_) {}
        lines.push({ nivel: 'critico', cat: 'autopausa', ic: '⏸️', titulo: 'Campaña PAUSADA por baja rentabilidad: ' + it.nom, detalle: 'Margen ' + it.mg + '% (por debajo de ' + margenMin + '%). Pausé automáticamente su única campaña (' + c.pais + ') ' + (r.aplicado ? '✓.' : '— revisa, Amazon no lo confirmó.') });
      } else {
        // Botón "Pausar esta campaña" en el correo: enlace firmado (caduca en 7 días).
        let accion = null;
        try {
          const tok = await firmarToken(env, { a: 'pausa', pais: c.pais, cid: c.campania_id, nom: it.nom, exp: Math.floor(Date.now() / 1000) + 7 * 86400 });
          if (tok) accion = { url: (env.WORKER_URL || 'https://sellerbrain-api.info-venmon.workers.dev') + '/a/' + tok, texto: '⏸️ Pausar esta campaña' };
        } catch (_) {}
        lines.push({ nivel: 'aviso', cat: 'autopausa', ic: '⏸️', titulo: 'Recomendado pausar: ' + it.nom, detalle: 'Margen ' + it.mg + '% (por debajo de ' + margenMin + '%). Solo lo anuncia 1 campaña (' + c.pais + '). Puedes pausarla desde aquí, o pon PPC_AUTOPAUSE=1 para que se haga solo.', accion });
      }
    } else if (lista.length > 1) {
      lines.push({ nivel: 'aviso', cat: 'autopausa', ic: '⚠️', titulo: 'Rentabilidad baja (varias campañas): ' + it.nom, detalle: 'Margen ' + it.mg + '% (por debajo de ' + margenMin + '%). Lo anuncian ' + lista.length + ' campañas: NO pauso automáticamente (ambiguo). Decide tú cuál bajar o pausar.' });
    }
  }
  return lines;
}

/* =====================================================================
 * SEARCH QUERY PERFORMANCE (SQP) — informe de Brand Analytics (SP-API) que
 * compara, por búsqueda, tu cuota en cada paso del embudo (impresiones →
 * clics → compras) frente al total del mercado. David #E. Requiere Brand
 * Registry (rol Brand Analytics ya aprobado). Formato JSON anidado → parseo
 * TOLERANTE (varios nombres de campo posibles). Semanal.
 * =================================================================== */
async function ingestaSQP(env, ctx) {
  const seller = (ctx && ctx.seller) || 'venmon';
  const fin = new Date(Date.now() - 2 * 86400000);          // margen para que el dato ya exista
  const ini = new Date(fin.getTime() - 6 * 86400000);
  const iniS = ini.toISOString().slice(0, 10), finS = fin.toISOString().slice(0, 10);
  const txt = await pedirInforme(env, 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
    iniS + 'T00:00:00Z', finS + 'T23:59:59Z', [MARKETPLACES.ES], { reportPeriod: 'WEEK' }, ctx);
  let j; try { j = JSON.parse(txt); } catch (_) { j = {}; }
  const arr = j.dataByAsin || j.dataByDepartmentAndSearchQuery || j.dataBySearchQuery || j.data || [];
  const num = v => (v == null || v === '' ? null : (+v || 0));
  const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return null; };
  const rows = [];
  for (const r of arr) {
    const q = pick(r, ['searchQuery', 'search_query']) || (r.searchQueryData && r.searchQueryData.searchQuery) || '';
    if (!q) continue;
    const vol = num(pick(r, ['searchQueryVolume']) || (r.searchQueryData && r.searchQueryData.searchQueryVolume));
    const imp = r.impressionData || {}, clk = r.clickData || {}, pur = r.purchaseData || {};
    rows.push({
      seller, semana: iniS, query: String(q).slice(0, 200), volumen: vol,
      imp_share: num(pick(imp, ['asinImpressionShare', 'impressionShare'])),
      click_share: num(pick(clk, ['asinClickShare', 'clickShare'])),
      purchase_share: num(pick(pur, ['asinPurchaseShare', 'purchaseShare'])),
      compras_total: num(pick(pur, ['totalPurchaseCount', 'totalCount'])),
      fecha: new Date().toISOString()
    });
  }
  if (rows.length) await upsertSupabase(env, 'busquedas_sqp', rows.slice(0, 2000));
  return { semana: iniS, filas: rows.length, formato: arr.length ? 'ok' : 'vacio_o_formato_distinto' };
}

/* =====================================================================
 * PPC DESACOPLADO — los informes de Ads pueden tardar >4 min en generarse.
 * En vez de esperar bloqueados (y agotar el tiempo del Worker), CREAMOS el
 * informe, guardamos su reportId como "pendiente", sondeamos un poco y, si aún
 * no está, lo dejamos para recogerlo en la siguiente pasada (botón o cron).
 * Así el PPC entra SIEMPRE, tarde lo que tarde Amazon.
 * =================================================================== */
async function deleteSupabase(env, filtro) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + filtro, {
    method: 'DELETE',
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Prefer: 'return=minimal' }
  });
  if (!r.ok && r.status !== 404) throw new Error('Supabase DELETE ' + filtro + ': ' + r.status);
}

async function cabecerasAds(env, profileId) {
  const token = await lwaToken(env, 'ads');
  return {
    'Authorization': 'Bearer ' + token,
    'Amazon-Advertising-API-ClientId': env.ADS_CLIENT_ID,
    'Amazon-Advertising-API-Scope': profileId,
    'Content-Type': 'application/vnd.createasyncreportrequest.v3+json'
  };
}

function cuerpoAdsDia(fecha) {
  return {
    name: 'sb-sp-daily-' + fecha,
    startDate: fecha, endDate: fecha,
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS', groupBy: ['campaign'],
      columns: ['date', 'campaignId', 'campaignName', 'cost', 'clicks', 'impressions', 'sales14d', 'purchases14d'],
      reportTypeId: 'spCampaigns', timeUnit: 'DAILY', format: 'GZIP_JSON'
    }
  };
}

function cuerpoAdsTerminos(desde, hasta) {
  return {
    name: 'sb-terminos-' + desde + '-' + hasta,
    startDate: desde, endDate: hasta,
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS', groupBy: ['searchTerm'],
      columns: ['date', 'searchTerm', 'keyword', 'matchType', 'campaignName', 'cost', 'clicks', 'impressions', 'sales14d', 'purchases14d'],
      reportTypeId: 'spSearchTerm', timeUnit: 'DAILY', format: 'GZIP_JSON'
    }
  };
}

// Informe "Advertised Product": gasto y ventas de PPC POR SKU → permite el ACoS
// real por producto y compararlo con su break-even.
function cuerpoAdsProducto(desde, hasta) {
  return {
    name: 'sb-adprod-' + desde + '-' + hasta,
    startDate: desde, endDate: hasta,
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS', groupBy: ['advertiser'],
      columns: ['date', 'advertisedSku', 'advertisedAsin', 'campaignName', 'cost', 'clicks', 'impressions', 'sales14d', 'purchases14d'],
      reportTypeId: 'spAdvertisedProduct', timeUnit: 'DAILY', format: 'GZIP_JSON'
    }
  };
}

async function descargarInformeAds(urlInforme) {
  const gz = await fetch(urlInforme);
  const ds = new DecompressionStream('gzip');
  const txt = await new Response(new Response(await gz.arrayBuffer()).body.pipeThrough(ds)).text();
  return JSON.parse(txt);
}

// Sondea un informe unas pocas veces. Devuelve los datos si COMPLETED; null si
// aún no está listo (para dejarlo pendiente). Lanza si Amazon marca FAILURE.
async function sondearInformeAds(headers, reportId, veces, ms) {
  for (let i = 0; i < veces; i++) {
    await sleep(ms);
    const st = await fetch(ADS_HOST + '/reporting/reports/' + reportId, { headers });
    const j = await st.json();
    if (j.status === 'COMPLETED') return await descargarInformeAds(j.url);
    if (j.status === 'FAILURE') throw new Error('Ads report FAILURE');
  }
  return null;
}

async function guardarPPCdia(env, ads, pais, fecha) {
  const tot = (ads || []).reduce((a, c) => ({
    gasto: a.gasto + (c.cost || 0), clics: a.clics + (c.clicks || 0),
    impresiones: a.impresiones + (c.impressions || 0),
    ventas: a.ventas + (c.sales14d || 0), pedidos: a.pedidos + (c.purchases14d || 0)
  }), { gasto: 0, clics: 0, impresiones: 0, ventas: 0, pedidos: 0 });
  await upsertSupabase(env, 'ppc_dia', [{
    fecha, pais, gasto: +tot.gasto.toFixed(2), clics: tot.clics,
    impresiones: tot.impresiones, ventas_ppc: +tot.ventas.toFixed(2), pedidos_ppc: tot.pedidos
  }]);
  await upsertSupabase(env, 'ppc_campanas', (ads || []).map(c => ({
    fecha, pais, campania_id: String(c.campaignId || ''), nombre: c.campaignName || '',
    gasto: +(c.cost || 0).toFixed(2), clics: c.clicks || 0, impresiones: c.impressions || 0,
    ventas_ppc: +(c.sales14d || 0).toFixed(2), pedidos_ppc: c.purchases14d || 0
  })));
  return (ads || []).length;
}

// Ventanas de N días entre dos fechas (para no pasarnos del rango que admite el
// informe de Ads). Determinista (fechas dadas), sin Date.now/new Date() vacío.
function ventanasFechas(desde, hasta, dias) {
  const out = [];
  let ini = new Date(desde + 'T00:00:00Z');
  const fin = new Date(hasta + 'T00:00:00Z');
  let guard = 0;
  while (ini <= fin && guard++ < 60) {
    let f2 = new Date(ini.getTime() + (dias - 1) * 86400000);
    if (f2 > fin) f2 = fin;
    out.push([ini.toISOString().slice(0, 10), f2.toISOString().slice(0, 10)]);
    ini = new Date(f2.getTime() + 86400000);
  }
  return out;
}

// BACKFILL del gasto de PPC POR DÍA (ppc_dia) en un rango: pide el informe diario
// de spCampaigns por ventanas y guarda cada día. Así el PPC del dashboard sale del
// gasto real repartido por días (no del recibo mensual del settlement).
async function ingestaPPCrango(env, desde, hasta, opts) {
  opts = opts || {};
  const perfiles = opts.pais ? (ADS_PROFILES[opts.pais] ? { [opts.pais]: ADS_PROFILES[opts.pais] } : {}) : ADS_PROFILES;
  const ventanas = ventanasFechas(desde, hasta, 30);
  const res = { desde, hasta, ventanas: ventanas.length, pasos: [] };
  await Promise.all(Object.entries(perfiles).map(async ([pais, profileId]) => {
    let dias = 0, err = null;
    try {
      const headers = await cabecerasAds(env, profileId);
      for (const [d1, d2] of ventanas) {
        try {
          const reportId = await crearReporteAds(headers, { ...cuerpoAdsDia(d1), name: 'sb-ppc-bf-' + d1 + '-' + d2, startDate: d1, endDate: d2 });
          const data = await sondearInformeAds(headers, reportId, 20, 15000);   // ~5 min máx por ventana
          if (!data) { err = 'timeout ' + d1; continue; }
          const byDay = {};
          for (const r of data) { const f = String(r.date || '').slice(0, 10); if (!f) continue; (byDay[f] = byDay[f] || []).push(r); }
          for (const [f, rows] of Object.entries(byDay)) { await guardarPPCdia(env, rows, pais, f); dias++; }
        } catch (e) { err = (e.message || '').slice(0, 80); }
      }
    } catch (e) { err = (e.message || '').slice(0, 120); }
    res.pasos.push({ pais, dias, ...(err ? { error: err } : {}) });
  }));
  return res;
}

async function guardarPPCterminos(env, filas, pais, desde, hasta) {
  await upsertSupabase(env, 'ppc_terminos', (filas || []).map(t => ({
    pais, fecha: t.date || hasta, desde: t.date || desde, hasta: t.date || hasta,
    termino: t.searchTerm || '', keyword: t.keyword || '', tipo: t.matchType || '',
    campania: t.campaignName || '',
    gasto: +(t.cost || 0).toFixed(2), clics: t.clicks || 0, impresiones: t.impressions || 0,
    ventas_ppc: +(t.sales14d || 0).toFixed(2), pedidos_ppc: t.purchases14d || 0
  })));
  return (filas || []).length;
}

// Agrega el informe Advertised Product por SKU y lo guarda (una fila por SKU/país/ventana).
async function guardarPPCproducto(env, filas, pais, desde, hasta) {
  const byKey = {};   // clave sku|fecha → una fila por SKU y día (DAILY) o por SKU y ventana (SUMMARY)
  for (const t of (filas || [])) {
    const sku = t.advertisedSku || t.advertisedAsin || '';
    if (!sku) continue;
    const fecha = t.date || hasta;
    const k = sku + '|' + fecha;
    if (!byKey[k]) byKey[k] = { pais, sku, fecha, desde: t.date || desde, hasta: t.date || hasta, gasto: 0, clics: 0, impresiones: 0, ventas_ppc: 0, pedidos_ppc: 0 };
    byKey[k].gasto += (t.cost || 0);
    byKey[k].clics += (t.clicks || 0);
    byKey[k].impresiones += (t.impressions || 0);
    byKey[k].ventas_ppc += (t.sales14d || 0);
    byKey[k].pedidos_ppc += (t.purchases14d || 0);
  }
  const rows = Object.values(byKey).map(x => ({
    ...x, gasto: +x.gasto.toFixed(2), ventas_ppc: +x.ventas_ppc.toFixed(2), actualizado: new Date().toISOString()
  }));
  await upsertSupabase(env, 'ppc_producto', rows);
  // Además: gasto partido por CAMPAÑA × SKU/ASIN (el informe ya trae campaignName).
  // En tabla aparte para no tocar ppc_producto. Si la tabla no existe aún, no rompe.
  try {
    const byCamp = {};
    for (const t of (filas || [])) {
      const sku = t.advertisedSku || t.advertisedAsin || ''; if (!sku) continue;
      const fecha = t.date || hasta;
      const camp = t.campaignName || '';
      const k = camp + '|' + sku + '|' + fecha;
      if (!byCamp[k]) byCamp[k] = { pais, campania: camp, sku, asin: t.advertisedAsin || '', fecha, gasto: 0, clics: 0, impresiones: 0, ventas_ppc: 0, pedidos_ppc: 0 };
      byCamp[k].gasto += (t.cost || 0); byCamp[k].clics += (t.clicks || 0); byCamp[k].impresiones += (t.impressions || 0);
      byCamp[k].ventas_ppc += (t.sales14d || 0); byCamp[k].pedidos_ppc += (t.purchases14d || 0);
    }
    const rows2 = Object.values(byCamp).map(x => ({ ...x, gasto: +x.gasto.toFixed(2), ventas_ppc: +x.ventas_ppc.toFixed(2), actualizado: new Date().toISOString() }));
    if (rows2.length) await upsertSupabase(env, 'ppc_asin_campana', rows2);
  } catch (_) { /* tabla ppc_asin_campana aún no creada → se ignora */ }
  return rows.length;
}

async function guardarPendientePPC(env, row) {
  try { await upsertSupabase(env, 'ppc_pendientes', [{ ...row, creado: new Date().toISOString() }]); }
  catch (_) { /* si no existe la tabla aún, no rompe la ingesta */ }
}
async function borrarPendientePPC(env, reportId) {
  try { await deleteSupabase(env, 'ppc_pendientes?report_id=eq.' + encodeURIComponent(reportId)); } catch (_) {}
}

// Recorre los informes pendientes; los que ya estén listos, los ingesta y borra.
// Los que Amazon marque como fallidos, se descartan. El resto sigue esperando.
async function recogerPendientesPPC(env) {
  const pend = await selSafe(env, 'ppc_pendientes?order=creado.asc', []);
  let recogidos = 0, fallidos = 0;
  for (const p of (pend || [])) {
    const profileId = ADS_PROFILES[p.pais];
    if (!profileId) continue;
    try {
      const headers = await cabecerasAds(env, profileId);
      const st = await fetch(ADS_HOST + '/reporting/reports/' + p.report_id, { headers });
      const j = await st.json();
      if (j.status === 'COMPLETED') {
        const data = await descargarInformeAds(j.url);
        if (p.tipo === 'dia') await guardarPPCdia(env, data, p.pais, p.fecha);
        else if (p.tipo === 'producto') await guardarPPCproducto(env, data, p.pais, p.desde, p.hasta);
        else if (p.tipo === 'hora') await guardarPPChoraSnap(env, data, p.pais, p.fecha, p.hora);
        else await guardarPPCterminos(env, data, p.pais, p.desde, p.hasta);
        await borrarPendientePPC(env, p.report_id); recogidos++;
      } else if (j.status === 'FAILURE') {
        await borrarPendientePPC(env, p.report_id); fallidos++;
      }
    } catch (_) { /* transitorio: se reintenta en la próxima pasada */ }
  }
  return { recogidos, fallidos, pendientes: (pend || []).length - recogidos - fallidos };
}

// Captura una "foto" del PPC acumulado del día de HOY por país y la guarda con
// la hora UTC actual. Restando fotos consecutivas (vista v_ppc_hora) sacamos lo
// ocurrido en cada franja. Aproximado (Amazon reajusta datos), pero al promediar
// una semana revela patrones por hora del día. La llama el cron cada hora.
async function capturarPPCHora(env) {
  const hoy = new Date().toISOString().slice(0, 10);
  const hora = new Date().getUTCHours();
  const diag = [];   // diagnóstico por país (para ver por qué no entra PPC)
  if (!Object.keys(ADS_PROFILES).length) diag.push({ estado: 'sin_perfiles_ads' });
  for (const [pais, profileId] of Object.entries(ADS_PROFILES)) {
    try {
      const headers = await cabecerasAds(env, profileId);
      const reportId = await crearReporteAds(headers, cuerpoAdsDia(hoy));
      // Deja el informe en PENDIENTE antes de sondear: si Amazon tarda >~48s en
      // generarlo, la recogida (ahora horaria) lo guardará en la próxima pasada,
      // en vez de perderse (que es lo que dejaba ppc_hora_snap vacío).
      await guardarPendientePPC(env, { report_id: reportId, pais, tipo: 'hora', fecha: hoy, hora });
      const data = await sondearInformeAds(headers, reportId, 4, 12000);   // ~48s
      if (!data) { diag.push({ pais, estado: 'pendiente' }); continue; }
      const r = await guardarPPChoraSnap(env, data, pais, hoy, hora);
      await borrarPendientePPC(env, reportId);
      diag.push({ pais, estado: 'ok', gasto: r.gasto, campanas: r.campanas });
    } catch (e) { diag.push({ pais, estado: 'error', msg: ((e && e.message) || String(e)).slice(0, 180) }); }
  }
  return diag;
}

// Guarda una foto horaria (total país + por campaña) a partir del informe diario.
// La usan tanto la captura en vivo como la recogida de pendientes de tipo 'hora'.
async function guardarPPChoraSnap(env, data, pais, fecha, hora) {
  const t = (data || []).reduce((a, c) => ({
    g: a.g + (c.cost || 0), cl: a.cl + (c.clicks || 0), im: a.im + (c.impressions || 0),
    v: a.v + (c.sales14d || 0), pe: a.pe + (c.purchases14d || 0)
  }), { g: 0, cl: 0, im: 0, v: 0, pe: 0 });
  const ts = new Date().toISOString();
  await upsertSupabase(env, 'ppc_hora_snap', [{
    pais, fecha, hora,
    gasto: +t.g.toFixed(2), clics: t.cl, impresiones: t.im,
    ventas: +t.v.toFixed(2), pedidos: t.pe, ts
  }]);
  const filasCamp = (data || [])
    .filter(c => c.campaignId != null)
    .map(c => ({
      pais, fecha, hora,
      campania_id: String(c.campaignId), campania: c.campaignName || '',
      gasto: +(c.cost || 0).toFixed(2), clics: c.clicks || 0, impresiones: c.impressions || 0,
      ventas: +(c.sales14d || 0).toFixed(2), pedidos: c.purchases14d || 0, ts
    }));
  if (filasCamp.length) await upsertSupabase(env, 'ppc_hora_camp_snap', filasCamp);
  return { gasto: +t.g.toFixed(2), campanas: filasCamp.length };
}

// Corrige el CIERRE de AYER. Amazon atribuye tarde las últimas horas del día, así
// que la última foto capturada quedó congelada por debajo del total real. Una vez
// el día está cerrado, pedimos el informe de ayer (ya completo) y fijamos su total
// en la franja 23:00 → v_ppc_hora recupera el gasto que faltaba (no se pierde nada).
// Se lanza en el cron a las 04:00 UTC (tras la ingesta diaria) y a mano en /v1/ppc/cierre.
async function corregirCierrePPCHora(env) {
  const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const diag = [];
  for (const [pais, profileId] of Object.entries(ADS_PROFILES)) {
    try {
      const headers = await cabecerasAds(env, profileId);
      const reportId = await crearReporteAds(headers, cuerpoAdsDia(ayer));
      await guardarPendientePPC(env, { report_id: reportId, pais, tipo: 'hora', fecha: ayer, hora: 23 });
      const data = await sondearInformeAds(headers, reportId, 5, 12000);   // ~60s
      if (!data) { diag.push({ pais, estado: 'pendiente' }); continue; }
      const r = await guardarPPChoraSnap(env, data, pais, ayer, 23);   // fija el cierre real en la última franja
      await borrarPendientePPC(env, reportId);
      diag.push({ pais, estado: 'ok', gasto_cierre: r.gasto });
    } catch (e) { diag.push({ pais, estado: 'error', msg: ((e && e.message) || String(e)).slice(0, 180) }); }
  }
  return diag;
}

/* =====================================================================
 * INGESTA DIARIA → Supabase
 * =================================================================== */
async function ingestaDiaria(env, origen, ctx) {
  const seller = (ctx && ctx.seller) || 'venmon';
  const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const planCompleto = ctx ? !!ctx.spapiToken : !!(env.LWA_CLIENT_ID && env.SPAPI_REFRESH_TOKEN); // Plan 2
  const resultado = { fecha: ayer, seller, origen: origen || 'manual', plan: planCompleto ? 'completo' : 'analisis(ads-only)', pasos: [] };

  // 1. Pedidos — AYER + HOY (parcial) por día real, para que el día en curso no
  //    salga siempre vacío en el dashboard. agregarPedidosPorDia agrupa por la
  //    fecha real de cada línea, así ayer y hoy quedan en filas separadas.
  if (planCompleto) try {
    const tsv = await pedirInforme(env,
      'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      ayer + 'T00:00:00Z', new Date().toISOString(),
      [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT, MARKETPLACES.BE], undefined, ctx);
    const filas = parseTSV(tsv);
    await upsertSupabase(env, 'pedidos_dia', conSeller(agregarPedidosPorDia(filas), seller));
    await upsertSupabase(env, 'ventas_sku_pais_dia', conSeller(agregarVentasSkuPais(filas), seller)); // total y por país
    await upsertSupabase(env, 'productos_catalogo', conSeller(catalogoDePedidos(filas), seller)); // nombres
    resultado.pasos.push({ pedidos: filas.length });
  } catch (e) { resultado.pasos.push({ pedidos_error: e.message }); }

  // 2. Settlements nuevos (tarifas FBA REALES por unidad + devoluciones + ajustes) — solo Plan 2
  //    Tope por ejecución: cada settlement gasta varias subpeticiones; procesar
  //    muchos de golpe agota el límite del plan gratis y tumba devoluciones/
  //    inventario. Se procesan de a pocos; el resto entra en la siguiente
  //    ejecución (existeEnSupabase salta los ya hechos).
  if (planCompleto) try {
    const hace15d = new Date(Date.now() - 15 * 86400000).toISOString();
    const reps = await listarSettlements(env, hace15d, ctx);
    const topeSettle = 4;
    let procS = 0;
    for (const rep of reps) {
      if (procS >= topeSettle) break;
      const yaProcesado = await existeEnSupabase(env, 'settlements', 'report_id', rep.reportId);
      if (yaProcesado) continue;
      const tsv = await descargarDocumento(env, rep.reportDocumentId, ctx);
      const lineas = parseTSV(tsv);
      // La CABECERA primero (settlement_lineas tiene FK a settlements).
      await upsertSupabase(env, 'settlements', [{ report_id: rep.reportId, procesado: new Date().toISOString(), seller }]);
      await upsertSupabase(env, 'settlement_lineas', mapearSettlement(lineas, rep.reportId, seller));
      procS++;
    }
    resultado.pasos.push({ settlements: procS + (procS >= topeSettle ? ' (quedan más para la próxima)' : '') });
  } catch (e) { resultado.pasos.push({ settlements_error: e.message }); }

  // 3. Devoluciones FBA — solo Plan 2
  if (planCompleto) try {
    const hace30d = new Date(Date.now() - 30 * 86400000).toISOString();
    const tsv = await pedirInforme(env, 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
      hace30d, ayer + 'T23:59:59Z', [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT, MARKETPLACES.BE], undefined, ctx);
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
    const nDev = await guardarDevoluciones(env, Object.values(devMap), seller);
    resultado.pasos.push({ devoluciones: nDev });
  } catch (e) { resultado.pasos.push({ devoluciones_error: e.message }); }

  // 3c. Inventario FBA (tiempo real, FBA Inventory API — sin informe → sin FATAL).
  //     Trae stock + nombre + ASIN de TODOS los SKUs (hayan vendido o no).
  if (planCompleto) try {
    const { inv, cat } = await traerInventarioFBA(env, MARKETPLACES.ES, ctx);
    if (Object.keys(inv).length) await upsertSupabase(env, 'inventario', conSeller(Object.values(inv), seller));
    if (Object.keys(cat).length) await upsertSupabase(env, 'productos_catalogo', conSeller(Object.values(cat), seller));
    resultado.pasos.push({ inventario: Object.keys(inv).length });
  } catch (e) { resultado.pasos.push({ inventario_error: e.message }); }

  // 3d. Stock POR PAÍS (informe paneuropeo GET_AFN_INVENTORY_DATA_BY_COUNTRY) →
  //     dónde está almacenado cada SKU. Para el detector de sobrecostes y stock por país.
  if (planCompleto) try {
    const r = await ingestaInventarioPais(env, ctx);
    resultado.pasos.push({ inventario_pais: r.filas || 0, ajustes: r.ajustes || 0 });
  } catch (e) { resultado.pasos.push({ inventario_pais_error: e.message }); }

  // 3e. Reembolsos FBA ya recibidos (para el detector "Amazon te debe").
  if (planCompleto) try {
    const r = await ingestaReembolsos(env, ctx);
    resultado.pasos.push({ reembolsos: r.reembolsos || 0 });
  } catch (e) { resultado.pasos.push({ reembolsos_error: e.message }); }

  // 3e-bis. Reembolsos A CLIENTES (Finances API) — dinero devuelto por cualquier
  //     motivo, no solo devoluciones físicas. Si falta el rol "Finance and
  //     Accounting", NO rompe la ingesta (se marca rol_falta y seguimos).
  if (planCompleto) try {
    const r = await ingestaReembolsosCliente(env, ctx);
    resultado.pasos.push({ reembolsos_cliente: r.rol_falta ? 'rol_finanzas_no_concedido' : (r.reembolsos || 0) });
  } catch (e) { resultado.pasos.push({ reembolsos_cliente_error: e.message }); }

  // 3f. País de SALIDA por pedido (informe de envíos) → base del sobrecoste por país.
  //     Ventana corta (7 días): envios_fc persiste, el histórico ya está guardado.
  if (planCompleto) try {
    const r = await ingestaEnvios(env, ctx, 7);
    resultado.pasos.push({ envios_fc: r.filas || 0, fc_desconocidos: r.desconocidos });
  } catch (e) { resultado.pasos.push({ envios_error: e.message }); }

  // 3b. Keywords reales de Amazon (Brand Analytics — requiere Brand Registry y rol aprobado)
  //     Solo lunes: gasta subrequests y suele fallar sin Brand Registry; no hace falta a diario.
  if (planCompleto && new Date().getUTCDay() === 1) try {
    const iniSemana = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const tsv = await pedirInforme(env, 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT',
      iniSemana + 'T00:00:00Z', ayer + 'T23:59:59Z', [MARKETPLACES.ES], undefined, ctx);
    // Este informe llega en JSON dentro del documento; si es TSV el parser genérico también sirve
    let filas;
    try { filas = JSON.parse(tsv).dataByDepartmentAndSearchTerm || []; }
    catch (_) { filas = parseTSV(tsv); }
    await upsertSupabase(env, 'busquedas_marca', filas.slice(0, 2000).map(r => ({
      semana: iniSemana,
      termino: r.searchTerm || r['search-term'] || '',
      ranking: +(r.searchFrequencyRank || r['search-frequency-rank'] || 0),
      asin1: r.clickedAsin || r['#1-clicked-asin'] || '',
      seller
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
      resumen: JSON.stringify(resultado.pasos).slice(0, 2000),
      seller
    }]);
  } catch (e) { /* si falla el log, no rompe la ingesta */ }

  return resultado;
}

// Orquestador de la ingesta COMPLETA multicuenta: VENMON (cuenta propia) + cada
// vendedor conectado, cada uno con su token y sus datos etiquetados por seller.
async function ingestaDiariaTodas(env, origen) {
  const res = [];
  try { res.push(await ingestaDiaria(env, origen)); } catch (e) { res.push({ seller: 'venmon', error: e.message }); }
  for (const c of await cuentasSpapiActivas(env)) {
    try { res.push(await ingestaDiaria(env, origen, c)); } catch (e) { res.push({ seller: c.seller, error: e.message }); }
  }
  return res;
}

/* =====================================================================
 * REFRESCO LIGERO HORARIO — solo los PEDIDOS de ayer + hoy, que es lo único
 * que cambia intradía. Es barato (1 informe de pedidos, como la foto de PPC),
 * así el dashboard muestra las ventas del día al momento SIN lanzar la ingesta
 * completa a mano. El histórico pesado (settlements, devoluciones, inventario,
 * stock por país) sigue una vez al día en ingestaDiaria (03:00 UTC).
 * =================================================================== */
async function ingestaVentasHoy(env, ctx) {
  const seller = (ctx && ctx.seller) || 'venmon';
  // Con ctx (vendedor conectado) usa su token; sin ctx, la cuenta propia (secretos).
  const planCompleto = ctx ? !!ctx.spapiToken : !!(env.LWA_CLIENT_ID && env.SPAPI_REFRESH_TOKEN);
  if (!planCompleto) return { seller, saltado: 'sin SP-API' };
  const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const tsv = await pedirInforme(env,
    'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
    ayer + 'T00:00:00Z', new Date().toISOString(),
    [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT, MARKETPLACES.BE], undefined, ctx);
  const filas = parseTSV(tsv);
  await upsertSupabase(env, 'pedidos_dia', conSeller(agregarPedidosPorDia(filas), seller));
  await upsertSupabase(env, 'ventas_sku_pais_dia', conSeller(agregarVentasSkuPais(filas), seller));
  await upsertSupabase(env, 'productos_catalogo', conSeller(catalogoDePedidos(filas), seller));
  return { seller, pedidos: filas.length };
}

// Orquestador multicuenta del refresco ligero: VENMON (cuenta propia) + cada
// vendedor conectado (cuentas_spapi), cada uno con su token y etiquetado por seller.
async function ingestaVentasTodas(env) {
  const res = [];
  try { res.push(await ingestaVentasHoy(env)); } catch (e) { res.push({ seller: 'venmon', error: e.message }); }
  for (const c of await cuentasSpapiActivas(env)) {
    try { res.push(await ingestaVentasHoy(env, c)); } catch (e) { res.push({ seller: c.seller, error: e.message }); }
  }
  return res;
}

/* =====================================================================
 * BUY BOX / COMPETENCIA por SKU (SP-API Product Pricing, rol "Pricing").
 * IMPORTANTE: usamos getListingOffers (por TU SKU), NO getItemOffers (por ASIN).
 * getItemOffers anonimiza las ofertas y NO marca de forma fiable cuál es la tuya
 * (MyOffer), lo que hacía que TODO saliera "no tengo la Buy Box" y que tu propio
 * precio se contara como "competidor". Consultando por TU SKU, Amazon sí marca tu
 * oferta como propia (MyOffer=true) y sabemos si la Buy Box es tuya. Además, si
 * eres el único vendedor del listing, la Buy Box es tuya y NO hay competidor.
 * getListingOffers va limitado, por eso se pausa entre llamadas y las manuales
 * procesan un lote (los SKU más desactualizados). Se guarda en la tabla `buybox`.
 * =================================================================== */
async function ingestaBuyBox(env, ctx, limite) {
  const seller = (ctx && ctx.seller) || 'venmon';
  const mkt = MARKETPLACES.ES;                     // Buy Box del marketplace principal (ES)
  let cat = [];
  try { cat = await selSafe(env, 'productos_catalogo?select=sku,asin,nombre&limit=3000', []); } catch (_) {}
  const seen = {}, items = [];
  // Necesitamos SKU para consultar por listing. Si un ASIN no tiene SKU, se omite.
  for (const c of (cat || [])) {
    const a = (c.asin || '').trim(), s = (c.sku || '').trim();
    if (!s || seen[s]) continue; seen[s] = 1;
    items.push({ asin: a, sku: s, nombre: c.nombre });
  }
  // Rota: procesa primero los SKU que llevan más tiempo sin refrescar.
  const prev = {};
  try { for (const r of (await selSafe(env, 'buybox?select=sku,fecha', []))) prev[r.sku] = r.fecha || ''; } catch (_) {}
  items.sort((a, b) => (prev[a.sku] || '') < (prev[b.sku] || '') ? -1 : 1);
  const lote = limite ? items.slice(0, limite) : items;
  const rows = []; let ok = 0, err = 0;
  for (const it of lote) {
    try {
      const j = await spapiCall(env, '/products/pricing/v0/listings/' + encodeURIComponent(it.sku) + '/offers?MarketplaceId=' + mkt + '&ItemCondition=New', {}, ctx);
      const p = (j && j.payload) || {};
      const sum = p.Summary || {}, offers = p.Offers || [];
      const bb = (sum.BuyBoxPrices && sum.BuyBoxPrices[0] && sum.BuyBoxPrices[0].LandedPrice) || null;
      const bbPrecio = bb ? +bb.Amount : null;
      const moneda = (bb && bb.CurrencyCode) || 'EUR';
      const totalOfertas = sum.TotalOfferCount || offers.length || 0;

      let miPrecio = null, minComp = null, tengoBB = null, vistaMia = false, gananBB = false;
      for (const o of offers) {
        const precio = ((o.ListingPrice && +o.ListingPrice.Amount) || 0) + ((o.Shipping && +o.Shipping.Amount) || 0);
        if (o.MyOffer) {                             // esta oferta es MÍA (fiable por consultar por SKU)
          vistaMia = true; miPrecio = precio;
          if (o.IsBuyBoxWinner) gananBB = true;
        } else if (precio > 0) {                     // oferta de otro vendedor
          if (minComp == null || precio < minComp) minComp = precio;
        }
      }

      // ¿Tengo yo la Buy Box?
      if (gananBB) {
        tengoBB = true;                              // mi oferta es la ganadora → sí
      } else if (totalOfertas <= 1) {
        tengoBB = true;                              // soy el único vendedor → la Buy Box es mía
      } else if (vistaMia) {
        tengoBB = false;                             // estoy en el listing pero no gano la Buy Box → la he perdido
      } else {
        tengoBB = null;                              // no pude identificar mi oferta → sin dato (no marcar "perdida")
      }

      // Si soy el único vendedor no hay "competidor": mi propio precio NO cuenta.
      if (totalOfertas <= 1) minComp = null;
      // Si no reconocí mi oferta pero solo hay 1, ese precio es el mío.
      if (miPrecio == null && totalOfertas <= 1 && bbPrecio != null) miPrecio = bbPrecio;

      rows.push({
        seller, asin: it.asin || null, sku: it.sku, nombre: it.nombre || null,
        tengo_buybox: tengoBB, buybox_precio: bbPrecio, mi_precio: miPrecio,
        min_competidor: minComp, n_ofertas: totalOfertas,
        moneda, fecha: new Date().toISOString()
      });
      ok++;
    } catch (_) { err++; }
    await sleep(2100);   // rate limit de getListingOffers
  }
  if (rows.length) await upsertSupabase(env, 'buybox', rows);
  return { seller, procesados: lote.length, ok, err, total_skus: items.length };
}

async function ingestaBuyBoxTodas(env) {
  const res = [];
  try { res.push(await ingestaBuyBox(env)); } catch (e) { res.push({ seller: 'venmon', error: e.message }); }
  for (const c of await cuentasSpapiActivas(env)) {
    try { res.push(await ingestaBuyBox(env, c)); } catch (e) { res.push({ seller: c.seller, error: e.message }); }
  }
  return res;
}

// Igual que ingestaBuyBoxTodas pero por LOTE (los más desactualizados primero),
// para el cron horario: refresca un trozo cada hora sin bloquear ni gastar el
// rate limit de golpe. Rotando por antigüedad, el catálogo entero se cubre solo
// en unas pocas horas — automático, sin pulsar ningún botón.
async function ingestaBuyBoxLoteTodas(env, lote) {
  try { await ingestaBuyBox(env, undefined, lote); } catch (_) {}
  for (const c of await cuentasSpapiActivas(env)) {
    try { await ingestaBuyBox(env, c, lote); } catch (_) {}
  }
}

/* =====================================================================
 * VIGILANCIA DE FICHA / HIJACKING — snapshot del TÍTULO (e imagen) de cada ASIN
 * vía Catalog Items API. Si el título cambia entre ejecuciones, se marca la
 * fecha del cambio (posible edición no autorizada / hijack). Combinado con la
 * pérdida de Buy Box (tabla buybox) da la señal de David. Se guarda en `fichas`.
 * =================================================================== */
async function ingestaFichas(env, ctx, limite) {
  const seller = (ctx && ctx.seller) || 'venmon';
  const mkt = MARKETPLACES.ES;
  let cat = [];
  try { cat = await selSafe(env, 'productos_catalogo?select=sku,asin&limit=3000', []); } catch (_) {}
  const seen = {}, asins = [];
  for (const c of (cat || [])) { const a = (c.asin || '').trim(); if (!a || seen[a]) continue; seen[a] = 1; asins.push({ asin: a, sku: c.sku }); }
  const prev = {};
  try { for (const r of (await selSafe(env, 'fichas?select=asin,titulo,titulo_prev,cambio_fecha,fecha', []))) prev[r.asin] = r; } catch (_) {}
  asins.sort((a, b) => ((prev[a.asin] && prev[a.asin].fecha) || '') < ((prev[b.asin] && prev[b.asin].fecha) || '') ? -1 : 1);
  const lote = limite ? asins.slice(0, limite) : asins;
  const rows = []; let ok = 0, err = 0, cambios = 0; const ahora = new Date().toISOString();
  for (const it of lote) {
    try {
      const item = await getCatalogoItem(env, it.asin, mkt);
      const titulo = (item && item.summaries && item.summaries[0] && item.summaries[0].itemName) || '';
      const imgs = (item && item.images && item.images[0] && item.images[0].images) || [];
      const main = imgs.find(x => x.variant === 'MAIN') || imgs[0];
      const imagen = (main && main.link) || null;
      const pr = prev[it.asin] || {};
      let titulo_prev = pr.titulo_prev || null, cambio_fecha = pr.cambio_fecha || null;
      if (pr.titulo && titulo && pr.titulo !== titulo) { titulo_prev = pr.titulo; cambio_fecha = ahora; cambios++; }
      rows.push({ seller, asin: it.asin, sku: it.sku || null, titulo: titulo || null, imagen, titulo_prev, cambio_fecha, fecha: ahora });
      ok++;
    } catch (_) { err++; }
    await sleep(700);   // rate limit Catalog Items API
  }
  if (rows.length) await upsertSupabase(env, 'fichas', rows);
  return { seller, procesados: lote.length, ok, err, cambios, total_asins: asins.length };
}
async function ingestaFichasTodas(env) {
  const res = [];
  try { res.push(await ingestaFichas(env)); } catch (e) { res.push({ seller: 'venmon', error: e.message }); }
  for (const c of await cuentasSpapiActivas(env)) {
    try { res.push(await ingestaFichas(env, c)); } catch (e) { res.push({ seller: c.seller, error: e.message }); }
  }
  return res;
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

  const esLunes = new Date().getUTCDay() === 1;

  // 1. PPC del día por país (DESACOPLADO: crea informe → guarda pendiente →
  //    sondea corto → si listo ingesta; si no, se recoge en la próxima pasada).
  if (!solo || solo === 'dia') for (const [pais, profileId] of Object.entries(perfiles)) {
    try {
      const headers = await cabecerasAds(env, profileId);
      const reportId = await crearReporteAds(headers, cuerpoAdsDia(ayer));
      await guardarPendientePPC(env, { report_id: reportId, pais, tipo: 'dia', fecha: ayer });
      const data = await sondearInformeAds(headers, reportId, 6, 12000);   // ~72s
      if (data) {
        const n = await guardarPPCdia(env, data, pais, ayer);
        await borrarPendientePPC(env, reportId);
        resultado.pasos.push({ ['ppc_' + pais]: 'ok · ' + n + ' campañas' });
      } else {
        resultado.pasos.push({ ['ppc_' + pais]: 'pendiente · Amazon aún genera el informe; se recogerá solo' });
      }
    } catch (e) { resultado.pasos.push({ ['ppc_' + pais + '_error']: e.message }); }
  }

  // 2. Términos de búsqueda (30 días, DAILY) — AHORA A DIARIO: es la fuente del
  //    rendimiento por keyword del panel, así que se recoge en cada ingesta (no
  //    solo los lunes). Patrón desacoplado: si el informe no está listo, se
  //    recoge en la siguiente pasada horaria. Idempotente (PK incluye fecha).
  if (solo === 'terminos' || !solo) {
    const hastaT = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const desdeT = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    for (const [pais, profileId] of Object.entries(perfiles)) {
      try {
        const headers = await cabecerasAds(env, profileId);
        const reportId = await crearReporteAds(headers, cuerpoAdsTerminos(desdeT, hastaT));
        await guardarPendientePPC(env, { report_id: reportId, pais, tipo: 'terminos', desde: desdeT, hasta: hastaT });
        const data = await sondearInformeAds(headers, reportId, 6, 12000);
        if (data) {
          const n = await guardarPPCterminos(env, data, pais, desdeT, hastaT);
          await borrarPendientePPC(env, reportId);
          resultado.pasos.push({ ['terminos_' + pais]: n });
        } else {
          resultado.pasos.push({ ['terminos_' + pais]: 'pendiente · se recogerá solo' });
        }
      } catch (e) { resultado.pasos.push({ ['terminos_' + pais + '_error']: e.message }); }
    }
  }

  // 2b. Gasto/ventas de PPC POR PRODUCTO (Advertised Product, 30 días) → ACoS
  //     real por SKU para compararlo con su break-even. Mismo patrón desacoplado.
  if (solo === 'producto' || (!solo && (forzarTerminos || esLunes))) {
    const hastaP = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const desdeP = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    for (const [pais, profileId] of Object.entries(perfiles)) {
      try {
        const headers = await cabecerasAds(env, profileId);
        const reportId = await crearReporteAds(headers, cuerpoAdsProducto(desdeP, hastaP));
        await guardarPendientePPC(env, { report_id: reportId, pais, tipo: 'producto', desde: desdeP, hasta: hastaP });
        const data = await sondearInformeAds(headers, reportId, 6, 12000);
        if (data) {
          const n = await guardarPPCproducto(env, data, pais, desdeP, hastaP);
          await borrarPendientePPC(env, reportId);
          resultado.pasos.push({ ['producto_' + pais]: n });
        } else {
          resultado.pasos.push({ ['producto_' + pais]: 'pendiente · se recogerá solo' });
        }
      } catch (e) { resultado.pasos.push({ ['producto_' + pais + '_error']: e.message }); }
    }
  }

  // 3. De paso, intenta recoger pendientes de pasadas anteriores que ya estén listos.
  try {
    const rec = await recogerPendientesPPC(env);
    if (rec.recogidos) resultado.pasos.push({ recogidos_pendientes: rec.recogidos });
  } catch (_) {}

  return resultado;
}

/* =====================================================================
 * CONSTRUIR EL PAYLOAD DEL DASHBOARD (contrato SB_DEMO)
 * =================================================================== */
// Lectura tolerante: si la vista no existe o está vacía, devuelve el defecto
// en vez de tumbar todo el endpoint (evita el "no pude leer tus datos").
// Traduce el concepto crudo del settlement de Amazon a una etiqueta legible.
function limpiarConcepto(c) {
  c = String(c || '').trim();
  const base = c.indexOf('/') > -1 ? c.slice(c.lastIndexOf('/') + 1) : c;
  const map = {
    FBAPerUnitFulfillmentFee: 'Tarifa FBA por unidad',
    FBAPerOrderFulfillmentFee: 'Tarifa FBA por pedido',
    FBAWeightBasedFee: 'Tarifa FBA por peso',
    Commission: 'Comisión (referral)',
    RefundCommission: 'Comisión devuelta (devolución)',
    FBAInboundTransportationFee: 'Envío de stock a Amazon (inbound)',
    FBAInboundTransportationProgramFee: 'Programa transporte de entrada',
    FBAInboundConvenienceFee: 'Servicio de entrada',
    FBARemovalFee: 'Retirada de inventario',
    FBADisposalFee: 'Destrucción de inventario',
    FBAStorageFee: 'Almacenaje',
    StorageFee: 'Almacenaje',
    FBALongTermStorageFee: 'Almacenaje largo plazo',
    ShippingChargeback: 'Ajuste de envío',
    Subscription: 'Suscripción (cuenta Pro)',
    VariableClosingFee: 'Tarifa de cierre',
    RefundFBAPerUnitFulfillmentFee: 'Gestión devolución (FBA)',
    DigitalServicesFee: 'Tasa servicios digitales'
  };
  return map[base] || base;
}

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
  let ped = await selSafe(env, 'ventas_sku_pais_dia?fecha=gte.' + desde + '&fecha=lte.' + hasta + filtroPais + '&select=sku,fecha,pais,uds,ventas', []);
  let hayPais = !!(ped && ped.length);
  if (!hayPais) {
    ped = await selSafe(env, 'pedidos_dia?fecha=gte.' + desde + '&fecha=lte.' + hasta + '&select=sku,fecha,uds,ventas', []);
  }
  const bySku = {};
  let tv = 0;
  for (const r of (ped || [])) {
    const s = r.sku || '';
    if (!s || /^amzn\.gr\./i.test(s)) continue;   // ignora reacondicionados de Amazon
    if (!bySku[s]) bySku[s] = { sku: s, uds: 0, ventas: 0, neto: 0, dias: {}, udsPais: {}, ventasPais: {} };
    const u = +r.uds || 0;
    const pz = r.pais || pais || 'ES';          // país de la venta (para IVA y tarifa correctos)
    const g = (+r.ventas || 0);                 // VENTA CON IVA (lo que se muestra, como Seller Central)
    const v = g / ivaPais(pz);                  // VENTA SIN IVA (base real del margen)
    bySku[s].uds += u;
    bySku[s].ventas += g;                        // display: bruto CON IVA
    bySku[s].neto += v;                          // beneficio: neto SIN IVA
    bySku[s].udsPais[pz] = (bySku[s].udsPais[pz] || 0) + u;
    bySku[s].ventasPais[pz] = (bySku[s].ventasPais[pz] || 0) + v;   // neto (para el fallback de tarifa 15%)
    bySku[s].dias[String(r.fecha).slice(0, 10)] = (bySku[s].dias[String(r.fecha).slice(0, 10)] || 0) + u;
    tv += v;
  }
  // TARIFA REAL POR UNIDAD (de v_fee_sku, todo el histórico) → se aplica a las
  // unidades vendidas. Resuelve el desfase de liquidación de Amazon: aunque este
  // mes no estén liquidadas todas las unidades, el €/ud es el real y CUADRA.
  // Tarifa por unidad POR PAÍS (v_fee_sku_pais): la tarifa FBA y el IVA cambian
  // según el país (ES 21%, FR 20%, IT 22%), y el settlement ya trae el país.
  const feePais = {};   // {sku: {ES:{fbaU,comU}, FR:{...}, ...}}
  try {
    for (const r of (await selectSupabase(env, 'v_fee_sku_pais?select=sku,pais,uds_liq,fba,com'))) {
      const u = +r.uds_liq || 0;
      if (u <= 0) continue;
      if (!feePais[r.sku]) feePais[r.sku] = {};
      feePais[r.sku][r.pais] = { fbaU: (+r.fba || 0) / u, comU: (+r.com || 0) / u };
    }
  } catch (_) { /* aún sin v_fee_sku_pais → usa el blend de abajo */ }
  // Blend de respaldo (todo el histórico, sin país) para productos/países sin
  // liquidación propia todavía (settlements viejos sin país).
  const feeUnit = {};   // {sku: {fbaU, comU}}
  try {
    for (const r of (await selectSupabase(env, 'v_fee_sku?select=sku,uds_liq,fba,com'))) {
      const u = +r.uds_liq || 0;
      if (u > 0) feeUnit[r.sku] = { fbaU: (+r.fba || 0) / u, comU: (+r.com || 0) / u };
    }
  } catch (_) { /* sin v_fee_sku → se estima con % abajo */ }
  const costes = {}; try { for (const c of (await selectSupabase(env, 'costes_producto?select=sku,coste'))) costes[c.sku] = +c.coste || 0; } catch (_) {}
  const cat = {}; try { for (const c of (await selectSupabase(env, 'productos_catalogo?select=sku,nombre,imagen'))) cat[c.sku] = c; } catch (_) {}
  // PPC real por SKU (informe Advertised Product, ventana más reciente) → ACoS real.
  const ppcProd = {};
  try {
    const rows = await selectSupabase(env, 'ppc_producto?order=hasta.desc&limit=8000');
    const tieneFecha = (rows || []).some(r => r.fecha);   // el backend ya guarda por día
    const maxHasta = (rows && rows[0]) ? rows[0].hasta : null;
    for (const r of (rows || [])) {
      if (tieneFecha) { if (!(r.fecha && r.fecha >= desde && r.fecha <= hasta)) continue; } // ventana = rango pedido
      else if (r.hasta !== maxHasta) continue;       // legacy (resumen): solo la ventana más reciente
      if (pais && r.pais !== pais) continue;         // respeta el filtro de país
      if (!ppcProd[r.sku]) ppcProd[r.sku] = { gasto: 0, ventas: 0, clics: 0, pedidos: 0 };
      ppcProd[r.sku].gasto += +r.gasto || 0;
      ppcProd[r.sku].ventas += +r.ventas_ppc || 0;
      ppcProd[r.sku].clics += +r.clics || 0;
      ppcProd[r.sku].pedidos += +r.pedidos_ppc || 0;
    }
  } catch (_) { /* aún sin ppc_producto */ }
  // Devoluciones por SKU en el rango → % de devolución del producto (dev ÷ uds).
  const devSku = {};
  try { for (const r of (await selSafe(env, 'devoluciones?fecha=gte.' + desde + '&fecha=lte.' + hasta + '&select=sku,cantidad', []))) { const s = r.sku || ''; if (!s) continue; devSku[s] = (devSku[s] || 0) + (+r.cantidad || 1); } } catch (_) {}
  const fin = new Date(hasta + 'T00:00:00Z');
  const dias10 = [];
  for (let i = 9; i >= 0; i--) dias10.push(new Date(fin.getTime() - i * 86400000).toISOString().slice(0, 10));
  return Object.values(bySku).map(p => {
    const coste = costes[p.sku];
    const nocoste = coste === undefined;
    const costeTot = +(p.uds * (coste || 0)).toFixed(2);
    const fu = feeUnit[p.sku];
    const fp = feePais[p.sku];
    const real = !!(fu || fp);                            // ¿tenemos tarifa/ud real?
    let fba, com;
    if (real) {
      // Suma por país: tarifa del país (fp) → si falta, el blend (fu) → si no,
      // estima 15%+15% sobre las ventas de ese país.
      fba = 0; com = 0;
      for (const pz of Object.keys(p.udsPais)) {
        const u = p.udsPais[pz];
        const f = (fp && fp[pz]) || fu;
        if (f) { fba += f.fbaU * u; com += f.comU * u; }
        else { const vpz = p.ventasPais[pz] || 0; fba += vpz * 0.15; com += vpz * 0.15; }
      }
      fba = +fba.toFixed(2); com = +com.toFixed(2);
    } else {
      fba = +(p.neto * 0.15).toFixed(2);
      com = +(p.neto * 0.15).toFixed(2);
    }
    const dev = 0;
    const amazon = +(com + fba + dev).toFixed(2);        // lo que se queda Amazon (sin IVA)
    // Beneficio sobre la venta SIN IVA (el IVA repercutido va a Hacienda, no es tuyo).
    // El margen % se muestra sobre la venta CON IVA (la que ves en pantalla).
    const ben = +(p.neto - costeTot - amazon).toFixed(2);   // beneficio ANTES de PPC
    const mg = p.ventas > 0 ? +(ben / p.ventas * 100).toFixed(1) : 0;
    // BREAK-EVEN ACoS: % máximo que puedes gastar en publicidad de una venta sin
    // perder dinero = el margen ANTES de ads (beneficio/ventas). Si el ACoS real
    // de la campaña es menor → ganas; si es mayor → pierdes en esas ventas.
    // acos_obj = ACoS objetivo dejando ~10 puntos de margen neto de colchón.
    const breakeven = (nocoste || p.ventas <= 0 || ben <= 0) ? null : mg;
    const acos_obj = breakeven === null ? null : Math.max(0, +(breakeven - 10).toFixed(1));
    // ACoS REAL de la publicidad de este SKU (Advertised Product) + veredicto vs break-even.
    const pp = ppcProd[p.sku];
    const ppcGasto = pp ? +pp.gasto.toFixed(2) : 0;
    const acos_real = (pp && pp.ventas > 0) ? +(pp.gasto / pp.ventas * 100).toFixed(1) : null;
    // CVR de la publicidad de este SKU = pedidos ÷ clics (informe Advertised Product).
    const cvr = (pp && pp.clics > 0) ? +(pp.pedidos / pp.clics * 100).toFixed(1) : null;
    const ppcClics = pp ? pp.clics : 0;
    let ppc_estado = null;   // gn = rentable, am = ajustado, rd = en pérdida
    if (acos_real != null && breakeven != null) {
      ppc_estado = acos_real <= acos_obj ? 'gn' : acos_real <= breakeven ? 'am' : 'rd';
    }
    // BENEFICIO REAL por artículo = beneficio (antes de ads) − gasto de publicidad de ESE SKU.
    // Es lo que pidió David: el beneficio por producto al 100% (ya descontada su publicidad).
    const ben_ppc = +(ben - ppcGasto).toFixed(2);
    const mg_ppc = p.ventas > 0 ? +(ben_ppc / p.ventas * 100).toFixed(1) : 0;
    const c = cat[p.sku] || {};
    return {
      nom: (c.nombre || p.sku), sku: p.sku, emoji: '📦', imagen: c.imagen || null,
      uds: p.uds, ventas: +p.ventas.toFixed(2),
      coste: costeTot, comision: com, fba, devol: dev, amazon,
      real, ppc: ppcGasto, ppc_ventas: pp ? +(pp.ventas || 0).toFixed(2) : 0, acos_real, cvr, ppc_clics: ppcClics, ppc_estado, ben, mg, ben_ppc, mg_ppc, breakeven, acos_obj,
      devol_uds: devSku[p.sku] || 0, pct_devol: p.uds > 0 ? +((devSku[p.sku] || 0) / p.uds * 100).toFixed(1) : null,
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

  // --- 3) Acciones por FUGA DE TARIFA (envío transfronterizo) ---
  // Si parte de las unidades se sirven desde otro país, pagas gestión más cara
  // que la local. v_fuga_tarifa cuantifica el sobrecoste; acción con €/mes real.
  try {
    const nombres = {};
    try { for (const c of (await selectSupabase(env, 'productos_catalogo?select=sku,nombre'))) nombres[c.sku] = c.nombre; } catch (_) {}
    const fugas = await selectSupabase(env, 'v_fuga_tarifa?order=sobrecoste_mes.desc&limit=15');
    for (const g of (fugas || [])) {
      const mes = +g.sobrecoste_mes || 0;
      if (mes < 3) continue;                              // fugas mínimas: no molestar
      const nom = (nombres[g.sku] || g.sku).slice(0, 42);
      acciones.push({
        _v: mes * 12,                                     // peso alto: es dinero recurrente y recuperable
        ic: '📦', bg: 'rgba(245,166,35,.15)', c: 'var(--am)',
        t: 'Mete stock en ' + g.pais + ' para «' + nom + '»',
        v: '+' + mes.toFixed(2).replace('.', ',') + '€/mes',
        p: g.pct_caras + '% de las ventas se sirven cross-border (tarifa ' + (+g.fee_medio).toFixed(2).replace('.', ',') +
           '€ vs ' + (+g.fee_local).toFixed(2).replace('.', ',') + '€ local). Manda inventario a ' + g.pais + ' o activa PAN-EU.'
      });
    }
  } catch (e) { /* aún sin v_fuga_tarifa o sin settlements → el motor sigue */ }

  // --- 4) Campañas LIMITADAS POR PRESUPUESTO (dejan de anunciarse por la tarde) ---
  try {
    const limitadas = await selectSupabase(env, 'v_ppc_limitadas?order=total_dia.desc&limit=15');
    for (const c of (limitadas || [])) {
      const gastado = +c.total_dia || 0, bud = +c.presupuesto || 0;
      if (bud <= 0) continue;
      const horaEs = (c.hora_tope != null) ? ((+c.hora_tope + 2) % 24) : null;  // UTC→España (verano, aprox)
      acciones.push({
        _v: gastado,
        ic: '💸', bg: 'rgba(245,166,35,.15)', c: 'var(--am)',
        t: 'Presupuesto agotado: «' + (c.campania || c.campania_id).slice(0, 42) + '»' + (c.pais ? ' · ' + c.pais : ''),
        v: gastado.toFixed(2).replace('.', ',') + '€ / ' + bud.toFixed(0) + '€',
        p: 'Gasta el ' + (c.pct_budget || 100) + '% del budget' + (horaEs != null ? ' hacia las ' + horaEs + 'h' : '') +
           ': tarde/noche deja de anunciarse. Sube el presupuesto o baja pujas de día si esas horas convierten.'
      });
    }
  } catch (e) { /* aún sin v_ppc_limitadas / presupuestos → el motor sigue */ }

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
    'y accionable. Estructura: (1) un TITULAR con el potencial total en €/mes = SUMA de TODOS ' +
    'los importes en € de las acciones que te paso (negativizaciones + sobrecostes de logística ' +
    'recuperables); di además de dónde sale (cuánto de ahorro en PPC y cuánto de logística). ' +
    '(2) "Haz primero" (máximo 5): cada línea con su € o ACoS y la CONSECUENCIA (qué ganas si lo ' +
    'haces o qué pierdes si no). (3) "Vigila" (máximo 3). Nada de relleno ni de introducciones.';
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

// INVESTIGACIÓN DE MERCADO / NICHOS (crecimiento de marca). Trabaja SOLO con lo que
// aporta el usuario (señales de validación + reseñas de la competencia). No inventa
// datos de mercado; el valor está en analizar las reseñas → problema + diferenciación.
async function generarAnalisisNicho(env, d) {
  if (!env.ANTHROPIC_API_KEY) return null;
  const sys =
    'Eres analista de investigación de mercado para vendedores de Amazon FBA, con enfoque en el ' +
    'CRECIMIENTO DE MARCA. Trabajas SOLO con los datos que te da el usuario: unas señales de ' +
    'validación (que él estima) y, sobre todo, RESEÑAS de productos de la competencia. Reglas ' +
    'estrictas: NO inventes cifras de mercado ni ventas de la competencia; si faltan datos, dilo con ' +
    'claridad; no prometas resultados ni rentabilidad. Tu mayor valor es LEER LAS RESEÑAS y extraer ' +
    'los DOLORES reales del cliente (lo que falla, lo que piden) para convertirlos en diferenciación. ' +
    'Responde en español, en Markdown, conciso y accionable, con ESTA estructura exacta:\n' +
    '## Validación\nUn semáforo (🟢 validado / 🟡 dudoso / 🔴 saturado o sin demanda) y 1-2 frases ' +
    'justificándolo SOLO con las señales dadas (demanda vs saturación/competencia/precio). Si las ' +
    'señales son pobres, dilo y pide cuáles faltan.\n' +
    '## El problema que resuelve\nLos 3-5 dolores recurrentes que detectas en las reseñas, cada uno ' +
    'con un indicio/cita textual breve. Si no hay reseñas, dilo y explica qué reseñas pedir.\n' +
    '## Diferenciación\n3-5 ángulos concretos para destacar, atando CADA uno a un dolor de arriba ' +
    '(mejora X, añade Y, reposiciona Z, packaging, bundle, instrucciones, material…).\n' +
    '## Veredicto\nPuntuación de oportunidad (0-10) + GO / NO-GO + por qué en 1-2 frases, y 3 ' +
    'próximos pasos concretos. Nada de relleno ni introducciones.';
  const user =
    'Objetivo: ' + (d.objetivo || 'crecimiento de marca en el nicho') + '\n' +
    'Nicho / producto: ' + (d.nicho || '(sin especificar)') + '\n' +
    'Señales de validación (estimadas por el vendedor): ' + JSON.stringify(d.senales || {}) + '\n' +
    'Reseñas de la competencia (analiza para sacar el problema y la diferenciación):\n' +
    ((d.resenas || '(no aportadas)').toString().slice(0, 9000));
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODELO_IA, max_tokens: 1900, system: sys, messages: [{ role: 'user', content: user }] })
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
  // Algunos informes (p.ej. el Libro Mayor) vienen con CADA campo entre comillas
  // dobles: "Date"\t"Location"… Quitamos un par de comillas envolventes si las hay
  // (los informes sin comillas, como los pedidos, quedan igual).
  const unq = s => {
    s = (s || '').trim();
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).replace(/""/g, '"');
    return s;
  };
  const headers = lineas[0].split('\t').map(h => unq(h).toLowerCase());
  return lineas.slice(1).map(l => {
    const vals = l.split('\t');
    const o = {};
    headers.forEach((h, i) => o[h] = unq(vals[i]));
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
    const sku = (r['sku'] || '').trim();
    if (!sku) continue;
    const nombre = (r['product-name'] || '').trim();
    const asin = (r['asin'] || '').trim();
    if (!cat[sku]) cat[sku] = { sku, asin, nombre: nombre.slice(0, 300) };
    else {
      // Rellena huecos con CUALQUIER fila que traiga el dato (no solo la primera).
      if (!cat[sku].nombre && nombre) cat[sku].nombre = nombre.slice(0, 300);
      if (!cat[sku].asin && asin) cat[sku].asin = asin;
    }
  }
  // Solo devolvemos los que tienen NOMBRE: así el upsert (merge-duplicates, que
  // sobrescribe columnas) nunca pisa un nombre bueno con uno vacío.
  return Object.values(cat).filter(x => x.nombre);
}

// Guarda devoluciones tolerando el constraint real de la tabla: si choca
// (error 21000 = dos filas del lote comparten la clave única), reagrupa por
// una clave más gruesa y reintenta. Así funciona sea cual sea el constraint.
async function guardarDevoluciones(env, rows, seller) {
  if (!rows || !rows.length) return 0;
  seller = seller || 'venmon';
  const reagrupar = (arr, campos) => {
    const m = {};
    for (const d of arr) {
      const k = campos.map(c => d[c]).join('|');
      if (m[k]) m[k].cantidad += d.cantidad;
      else m[k] = { fecha: d.fecha, sku: d.sku, asin: d.asin, motivo: d.motivo, estado: d.estado, disposicion: d.disposicion, cantidad: d.cantidad, seller };
    }
    return Object.values(m);
  };
  rows = rows.map(d => ({ ...d, seller }));
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
  // Diagnóstico: cuántos productos hay con/sin ASIN (para saber si el problema
  // es que faltan ASIN o que el Catalog API falla).
  let sinAsin = 0;
  try {
    const r = await fetch(env.SUPABASE_URL + '/rest/v1/productos_catalogo?imagen=is.null&or=(asin.is.null,asin.eq.)&select=sku',
      { headers: { apikey: env.SUPABASE_SERVICE_KEY, Prefer: 'count=exact' } });
    sinAsin = +(r.headers.get('content-range') || '').split('/')[1] || 0;
  } catch (_) {}
  let ok = 0; const errores = [];
  const markets = [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT, MARKETPLACES.BE];
  for (const p of (pend || [])) {
    const asin = (p.asin || '').trim();
    if (!asin) continue;
    let imagen = null, nombre = p.nombre || null, err = null;
    for (const mk of markets) {                      // el ASIN puede tener imagen en otro marketplace
      try {
        const item = await getCatalogoItem(env, asin, mk);
        const imgs = (item && item.images && item.images[0] && item.images[0].images) || [];
        const main = imgs.find(x => x.variant === 'MAIN') || imgs[0];
        if (main && main.link) {
          imagen = main.link;
          nombre = (item.summaries && item.summaries[0] && item.summaries[0].itemName) || nombre;
          break;
        }
      } catch (e) { err = String(e.message || e).slice(0, 140); }
    }
    if (imagen) { await upsertSupabase(env, 'productos_catalogo', [{ sku: p.sku, imagen, nombre }]); ok++; }
    else if (err) errores.push({ asin, err });
  }
  // hayMas solo si esta tanda trajo algo (evita bucle infinito si todo falla).
  return {
    procesados: ok, pendientes: (pend || []).length, sin_asin: sinAsin,
    hayMas: ok > 0 && (pend || []).length >= 8,
    errores: errores.slice(0, 3)
  };
}

async function getCatalogoItem(env, asin, marketplaceId) {
  return spapiCall(env, '/catalog/2022-04-01/items/' + encodeURIComponent(asin) +
    '?marketplaceIds=' + marketplaceId + '&includedData=images,summaries,attributes');
}

// Rellena el histórico de UN tipo en UN rango. Lo llama el navegador mes a mes.
async function backfillRango(env, tipo, desde, hasta) {
  const planCompleto = !!(env.LWA_CLIENT_ID && env.SPAPI_REFRESH_TOKEN);
  if (!planCompleto) throw new Error('SP-API no configurada (faltan secretos LWA/SPAPI)');
  const MKT = [MARKETPLACES.ES, MARKETPLACES.FR, MARKETPLACES.IT, MARKETPLACES.BE];

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

// El informe de transacciones (settlement) trae el marketplace en cada línea:
// "Amazon.es", "Amazon.fr", "Amazon.it"… → lo normalizamos a ES/FR/IT para
// aplicar la tarifa y el IVA correctos de cada país.
// Divisor de IVA por país (para pasar ventas/tarifas a base SIN IVA).
function ivaPais(p) {
  switch ((p || '').toUpperCase()) {
    case 'FR': return 1.20; case 'IT': return 1.22; case 'DE': return 1.19;
    case 'PT': return 1.23; case 'PL': return 1.23; case 'NL': return 1.21;
    case 'BE': return 1.21; case 'SE': return 1.25; case 'GB': return 1.20;
    case 'IE': return 1.23; default: return 1.21;
  }
}

function paisDeMarketplace(nombre) {
  const s = (nombre || '').toLowerCase();
  if (s.indexOf('.com.be') > -1 || /\.be(\b|$)/.test(s)) return 'BE';
  if (s.indexOf('.co.uk') > -1 || /\.uk(\b|$)/.test(s)) return 'GB';
  if (/\.es(\b|$)/.test(s)) return 'ES';
  if (/\.fr(\b|$)/.test(s)) return 'FR';
  if (/\.it(\b|$)/.test(s)) return 'IT';
  if (/\.de(\b|$)/.test(s)) return 'DE';
  if (/\.nl(\b|$)/.test(s)) return 'NL';
  if (/\.pl(\b|$)/.test(s)) return 'PL';
  if (/\.se(\b|$)/.test(s)) return 'SE';
  return '';
}

function mapearSettlement(lineas, reportId, seller) {
  return lineas
    .filter(l => l['transaction-type'])
    .map(l => ({
      report_id: reportId,
      fecha: aISO(l['posted-date']),
      tipo: l['transaction-type'],
      pedido: l['order-id'] || '',
      sku: l['sku'] || '',
      pais: paisDeMarketplace(l['marketplace-name']),
      concepto: l['amount-type'] + '/' + l['amount-description'],
      importe: +(l['amount'] || '0').replace(',', '.'),
      cantidad: +l['quantity-purchased'] || 0,
      seller: seller || 'venmon'
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
  const body = { ...payload, iat: now, exp: now + 60 * 60 * 24 * 30 }; // 30 días
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
// Token de ACCIÓN firmado (para botones "pausar/bajar" en el correo). HMAC sobre
// el payload JSON. No es un JWT completo: es una capacidad de un solo propósito.
async function firmarToken(env, obj) {
  if (!env.SB_JWT_SECRET) return null;
  const body = b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SB_JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return body + '.' + b64url(new Uint8Array(sig));
}
async function verificarToken(env, token) {
  if (!env.SB_JWT_SECRET || !token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SB_JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  if (b64url(new Uint8Array(s)) !== sig) return null;
  try { const o = JSON.parse(new TextDecoder().decode(b64urlDecode(body))); if (o.exp && o.exp < Math.floor(Date.now() / 1000)) return null; return o; } catch (_) { return null; }
}
function paginaAccion(titulo, msg, ok) {
  const color = ok ? '#14663f' : '#c0392b';
  return new Response('<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:Arial,sans-serif;background:#0D0D0D;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center;max-width:420px;padding:24px"><h1 style="color:' + color + ';font-size:22px">' + titulo + '</h1><p style="color:#bbb;font-size:14px;line-height:1.6">' + msg + '</p><a href="https://sellersbrain.io/dashboard.html" style="color:#2EE6A0;font-size:13px">Abrir SellerBrain</a></div></body></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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

// Verifica la firma del webhook de Stripe (HMAC-SHA256 sobre "t.body" con el
// secreto whsec_...). Rechaza si la firma no coincide o el evento es viejo (>5 min).
async function verificarStripe(secret, sigHeader, rawBody) {
  if (!secret || !sigHeader) return false;
  const parts = {};
  for (const kv of sigHeader.split(',')) { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - (+t)) > 300) return false;   // anti-replay
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + rawBody));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  // comparación de longitud fija
  if (hex.length !== v1.length) return false;
  let dif = 0; for (let i = 0; i < hex.length; i++) dif |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return dif === 0;
}

// Código de acceso nuevo, no adivinable: SB-XXXX-XXXX.
function nuevoCodigo() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const s = [...b].map(x => (x % 36).toString(36)).join('').toUpperCase();
  return 'SB-' + s.slice(0, 4) + '-' + s.slice(4, 8);
}

// La cuenta de Stripe se usa para varios negocios. Este filtro comprueba que un
// checkout es de un PRODUCTO de SellerBrain antes de crear/renovar un miembro.
//   · SB_STRIPE_PRODUCTS = lista de IDs de producto permitidos (prod_...,prod_...)
//   · STRIPE_SECRET_KEY  = clave (o clave restringida de solo lectura) para leer las líneas
// Si no hay lista configurada, NO filtra (comportamiento anterior). Ante error de
// red, no bloquea (mejor crear un alta de más que perder un cliente que pagó).
async function esCheckoutSellerBrain(env, sessionId) {
  const permitidos = (env.SB_STRIPE_PRODUCTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!permitidos.length) return true;            // sin lista → no filtra
  if (!env.STRIPE_SECRET_KEY || !sessionId) return true;
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId) +
      '/line_items?limit=20&expand[]=data.price.product',
      { headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY } });
    const d = await r.json();
    const items = (d && d.data) || [];
    return items.some(it => {
      const p = it.price && it.price.product;
      const prodId = typeof p === 'string' ? p : (p && p.id);
      return prodId && permitidos.indexOf(prodId) > -1;
    });
  } catch (_) { return true; }                    // ante fallo: no bloquear el alta
}

// ¿Los productos de una suscripción son de SellerBrain? (usa el propio objeto del
// evento, sin llamada extra). Doble seguridad para cancelaciones en cuenta compartida.
function suscripcionEsSellerBrain(env, sub) {
  const permitidos = (env.SB_STRIPE_PRODUCTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!permitidos.length) return true;
  const items = (sub && sub.items && sub.items.data) || [];
  return items.some(it => {
    const p = it.price && it.price.product;
    const prodId = typeof p === 'string' ? p : (p && p.id);
    return prodId && permitidos.indexOf(prodId) > -1;
  });
}

// ¿La suscripción es ANUAL? (por el intervalo del precio: 'year' vs 'month').
function suscripcionEsAnual(sub) {
  const items = (sub && sub.items && sub.items.data) || [];
  return items.some(it => {
    const rec = (it.price && it.price.recurring) || it.plan || {};
    return rec.interval === 'year';
  });
}

/* =====================================================================
 * ALERTAS PROACTIVAS POR EMAIL — "fuera de la app" (petición del informe de
 * David). Detecta stock bajo/rotura, ACoS fuera de rango y sobrecostes
 * recuperables, y manda un resumen diario. Se activa con ALERTAS_EMAIL=1 y
 * se envía a ALERTAS_TO (o al soporte). Umbrales configurables por env.
 * =================================================================== */
// Calcula las alertas de UN vendedor. seller = su identificador (en SellerBrain,
// el email de registro). Las tablas de stock/ventas se filtran por seller. Las
// alertas de ACoS y sobrecostes (PPC/settlement) hoy son de la cuenta propia
// (aún no multi-tenant), así que solo se calculan para el owner → nunca se mezcla
// ni se filtra el dato de un vendedor a otro.
async function calcularAlertas(env, seller, opts) {
  const A = [];
  opts = opts || {};
  const STOCK_DIAS = +(opts.stock_dias != null ? opts.stock_dias : (env.ALERTAS_STOCK_DIAS || 14));
  const ACOS_MAX = +(opts.acos != null ? opts.acos : (env.ALERTAS_ACOS || 40));
  const SOBRE_MIN = +(opts.sobrecoste != null ? opts.sobrecoste : (env.ALERTAS_SOBRECOSTE || 20));
  const ownerSeller = env.OWNER_SELLER || 'venmon';
  const esOwner = !seller || seller === ownerSeller;
  const sf = '&seller=eq.' + encodeURIComponent(seller || ownerSeller);   // filtro de tablas con columna seller

  // 1) STOCK bajo / rotura (misma lógica que /v1/stock: uds/día 30d → cobertura). Por vendedor.
  try {
    const inv = {};
    for (const r of (await selSafe(env, 'inventario?select=sku,disponible,entrante' + sf, []))) {
      inv[r.sku] = { disp: +r.disponible || 0, ent: +r.entrante || 0 };
    }
    const hace30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const vel = {};
    for (const r of (await selSafe(env, 'ventas_sku_pais_dia?fecha=gte.' + hace30 + '&select=sku,uds' + sf, []))) {
      const s = r.sku || ''; if (!s) continue; vel[s] = (vel[s] || 0) + (+r.uds || 0);
    }
    const cat = {};
    try { for (const c of (await selSafe(env, 'productos_catalogo?select=sku,nombre' + sf, []))) cat[c.sku] = c.nombre; } catch (_) {}
    const items = [];
    for (const s of new Set([...Object.keys(inv), ...Object.keys(vel)])) {
      if (/^amzn\.gr\./i.test(s)) continue;
      const disp = (inv[s] && inv[s].disp) || 0, ent = (inv[s] && inv[s].ent) || 0;
      const v = (vel[s] || 0) / 30;
      if (v <= 0) continue;                       // sin ventas → no hay riesgo de rotura
      const dias = Math.floor(disp / v);
      if (dias <= STOCK_DIAS) items.push({ sku: s, nombre: cat[s] || s, dias, disp, ent, v: +v.toFixed(2) });
    }
    items.sort((a, b) => a.dias - b.dias);
    for (const it of items.slice(0, 15)) {
      const critico = it.disp === 0 || it.dias <= Math.max(3, Math.round(STOCK_DIAS / 3));
      A.push({
        nivel: critico ? 'critico' : 'aviso', cat: 'stock', ic: '📦',
        titulo: it.disp === 0 ? ('Sin stock: ' + it.nombre) : (it.nombre + ' — ' + it.dias + ' días de cobertura'),
        detalle: it.disp + ' uds' + (it.ent ? (' (+' + it.ent + ' en camino)') : ' · sin reposición registrada') + ' · vende ' + it.v + ' uds/día'
      });
    }
  } catch (_) {}

  // 2) y 3) ACoS y sobrecostes: hoy PPC y settlement son de la cuenta propia
  // (aún no multi-tenant) → solo se calculan para el owner. Así ningún vendedor
  // recibe datos de otro por error.
  if (!esOwner) return A;

  // 2) ACoS fuera de rango (últimos 7 días: global y peor país)
  try {
    const hace7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const filas = await selSafe(env, 'ppc_dia?fecha=gte.' + hace7 + '&select=pais,gasto,ventas_ppc', []);
    let g = 0, v = 0; const porPais = {};
    for (const r of (filas || [])) {
      const gg = +r.gasto || 0, vv = +r.ventas_ppc || 0; g += gg; v += vv;
      const p = r.pais || '?'; if (!porPais[p]) porPais[p] = { g: 0, v: 0 }; porPais[p].g += gg; porPais[p].v += vv;
    }
    if (v > 0) {
      const acos = g / v * 100;
      if (acos > ACOS_MAX) A.push({
        nivel: acos > ACOS_MAX * 1.3 ? 'critico' : 'aviso', cat: 'acos', ic: '📣',
        titulo: 'ACoS alto: ' + acos.toFixed(0) + '% (últimos 7 días)',
        detalle: 'Gasto ' + g.toFixed(2) + '€ frente a ' + v.toFixed(2) + '€ de ventas de publicidad. Objetivo por debajo del ' + ACOS_MAX + '%.'
      });
      // peor país (si hay varios y alguno se dispara aún más)
      let peor = null;
      for (const p of Object.keys(porPais)) { const x = porPais[p]; if (x.v > 0) { const a = x.g / x.v * 100; if (a > ACOS_MAX && (!peor || a > peor.a)) peor = { p, a, g: x.g }; } }
      if (peor && peor.p !== '?' && Object.keys(porPais).length > 1) A.push({
        nivel: 'aviso', cat: 'acos', ic: '🌍',
        titulo: 'ACoS por país: ' + peor.p + ' al ' + peor.a.toFixed(0) + '%',
        detalle: 'Es el mercado con peor ACoS esta semana (gasto ' + peor.g.toFixed(2) + '€). Revisa sus campañas.'
      });
    }
  } catch (_) {}

  // 3) Sobrecostes de logística recuperables
  try {
    const filas = await selSafe(env, 'v_fuga_tarifa?select=sobrecoste_mes', []);
    const tot = (filas || []).reduce((a, x) => a + (+x.sobrecoste_mes || 0), 0);
    if (tot >= SOBRE_MIN) A.push({
      nivel: 'aviso', cat: 'sobrecoste', ic: '🔍',
      titulo: 'Sobrecostes de logística recuperables: ≈' + tot.toFixed(0) + '€/mes',
      detalle: 'Amazon está cobrando tarifa cross-border en parte de tus envíos. Ábrelo en el Detector de sobrecostes y reclama.'
    });
  } catch (_) {}

  // 4) Productos EN PÉRDIDAS (beneficio − PPC < 0) en los últimos 30 días
  try {
    const LOSS_MIN = +(env.ALERTAS_PERDIDA_MIN || 30);   // ventas mínimas para no avisar por ruido
    const hoy = new Date().toISOString().slice(0, 10);
    const hace30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const prods = await productosPeriodo(env, hace30d, hoy);
    const perdedores = [];
    for (const p of (prods || [])) {
      if (!(p.coste > 0)) continue;                       // sin coste conocido → no se puede afirmar pérdida
      const net = (+p.ben || 0) - (+p.ppc || 0);          // beneficio DESPUÉS de publicidad
      if (net < 0 && (+p.ventas || 0) >= LOSS_MIN) perdedores.push({ nom: p.nom, net: +net.toFixed(2), mg: p.mg, ppc: +p.ppc || 0 });
    }
    perdedores.sort((a, b) => a.net - b.net);
    for (const it of perdedores.slice(0, 10)) {
      A.push({
        nivel: 'critico', cat: 'perdida', ic: '🔻',
        titulo: 'Producto en pérdidas: ' + it.nom,
        detalle: 'Pierde ' + Math.abs(it.net).toFixed(2) + '€ en 30 días (margen ' + it.mg + '%' + (it.ppc ? ', ' + it.ppc.toFixed(2) + '€ de PPC' : '') + '). Sube precio, baja coste o revisa la publicidad.'
      });
    }

    // 4b) RENTABILIDAD BAJA (preventivo): margen neto DESPUÉS de PPC por debajo del
    //     umbral (por defecto 10%) pero todavía positivo. El punto clave que pediste:
    //     antes de entrar en pérdidas ya avisa para que actúes (o apagues la campaña).
    const MARGEN_MIN = +(opts.margen_min != null ? opts.margen_min : (env.ALERTAS_MARGEN_MIN || 10));
    const flojos = [];
    for (const p of (prods || [])) {
      if (!(p.coste > 0)) continue;
      const ventas = +p.ventas || 0; if (ventas < LOSS_MIN) continue;
      const net = (+p.ben || 0) - (+p.ppc || 0);
      const mgNeto = ventas > 0 ? (net / ventas * 100) : 0;
      if (net >= 0 && mgNeto < MARGEN_MIN) flojos.push({ nom: p.nom, mg: +mgNeto.toFixed(1), ppc: +p.ppc || 0 });
    }
    flojos.sort((a, b) => a.mg - b.mg);
    for (const it of flojos.slice(0, 10)) {
      A.push({
        nivel: 'aviso', cat: 'margen', ic: '⚠️',
        titulo: 'Rentabilidad baja: ' + it.nom,
        detalle: 'Su margen neto (tras PPC) ha bajado a ' + it.mg + '%, por debajo de tu umbral (' + MARGEN_MIN + '%)' + (it.ppc ? '. La publicidad se está comiendo el beneficio (' + it.ppc.toFixed(2) + '€ de PPC)' : '') + '. Revisa la campaña: baja pujas o pausa antes de entrar en pérdidas.'
      });
    }
  } catch (_) {}

  // 5) HIJACKING: cambio de ficha reciente + Buy Box perdida.
  try {
    const hace7 = Date.now() - 7 * 86400000;
    const fichas = await selSafe(env, 'fichas?select=asin,sku,titulo,cambio_fecha', []);
    let nCambio = 0;
    for (const f of (fichas || [])) {
      if (f.cambio_fecha && new Date(f.cambio_fecha).getTime() >= hace7 && nCambio < 10) {
        nCambio++;
        A.push({ nivel: 'critico', cat: 'ficha', ic: '🛡️',
          titulo: 'Posible cambio de ficha: ' + (f.titulo || f.sku || f.asin),
          detalle: 'El título de este producto ha cambiado esta semana. Comprueba que no sea un hijack o una edición no autorizada.' });
      }
    }
    const bb = await selSafe(env, 'buybox?select=asin,nombre,tengo_buybox,n_ofertas', []);
    let nBB = 0;
    for (const b of (bb || [])) {
      if (b.tengo_buybox === false && (+b.n_ofertas || 0) > 1 && nBB < 10) {
        nBB++;
        A.push({ nivel: 'aviso', cat: 'buybox', ic: '🏆',
          titulo: 'Buy Box perdida: ' + (b.nombre || b.asin),
          detalle: 'Otro vendedor tiene la Buy Box (' + (b.n_ofertas || 0) + ' ofertas). Revisa tu precio y el estado del producto.' });
      }
    }
  } catch (_) {}

  return A;
}

// Orquestador diario (07:00 UTC): solo actúa si ALERTAS_EMAIL=1. MULTI-TENANT —
// cada vendedor recibe SUS alertas en SU email de registro (en SellerBrain el
// identificador de vendedor ES su email). La cuenta propia (VENMON) se envía a
// ALERTAS_TO si está configurado. Solo se manda correo a quien tenga algo que revisar.
async function procesarAlertas(env) {
  if (String(env.ALERTAS_EMAIL || '') !== '1') return { saltado: 'ALERTAS_EMAIL != 1' };
  const ownerSeller = env.OWNER_SELLER || 'venmon';
  const lista = [];
  // 1) Cada miembro activo → sus alertas a su email (seller = su email).
  try {
    const socios = await selSafe(env, 'miembros?estado=in.(activo,renovado)&select=email,seller', []);
    for (const m of (socios || [])) {
      const email = (m.email || '').trim();
      if (email) lista.push({ email, seller: (m.seller || email) });
    }
  } catch (_) {}
  // 2) Cuenta propia (VENMON): a ALERTAS_TO si está configurado.
  const ownerTo = (env.ALERTAS_TO || '').trim();
  if (ownerTo) lista.push({ email: ownerTo, seller: ownerSeller });

  // Preferencias por vendedor (opt-in + umbrales). Se cargan de una vez.
  const prefs = {};
  try { for (const p of (await selSafe(env, 'alertas_prefs?select=seller,activo,stock_dias,acos,sobrecoste,margen_min', []))) prefs[p.seller] = p; } catch (_) {}

  // Auto-apagado por rentabilidad (solo cuenta propia): se calcula una vez y se
  // adjunta al correo del dueño.
  let autoLines = [];
  try { autoLines = await autopausaPorRentabilidad(env); } catch (_) {}

  const vistos = new Set(), res = [];
  for (const d of lista) {
    const key = d.email.toLowerCase();
    if (vistos.has(key)) continue; vistos.add(key);
    const p = prefs[d.seller] || prefs[d.email] || null;
    if (p && p.activo === false) continue;   // el vendedor ha desactivado sus alertas
    const opts = p ? { stock_dias: p.stock_dias, acos: p.acos, sobrecoste: p.sobrecoste, margen_min: p.margen_min } : {};
    let alertas = [];
    try { alertas = await calcularAlertas(env, d.seller, opts); } catch (_) {}
    if (d.seller === ownerSeller && autoLines.length) alertas = autoLines.concat(alertas);   // el auto-apagado es de la cuenta propia
    if (!alertas.length) continue;
    const r = await enviarEmailAlertas(env, d.email, alertas);
    res.push({ email: d.email, enviadas: alertas.length, ok: !!(r && r.ok) });
  }
  return { ok: true, correos: res.length, detalle: res };
}

// Email de resumen de alertas (HTML compatible con clientes de correo).
async function enviarEmailAlertas(env, email, alertas) {
  if (!env.RESEND_API_KEY) return { saltado: 'sin RESEND_API_KEY' };
  const from = env.EMAIL_FROM || 'SellerBrain <hola@sellersbrain.io>';
  const soporte = env.EMAIL_SOPORTE || 'hola@sellersbrain.io';
  const replyTo = env.EMAIL_REPLYTO || soporte;
  const portalBase = env.PORTAL_URL || 'https://sellersbrain.io/portal.html';
  let panel = 'https://sellersbrain.io/dashboard.html';
  try { panel = new URL(portalBase).origin + '/dashboard.html'; } catch (_) {}
  const nCrit = alertas.filter(a => a.nivel === 'critico').length;
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const filas = alertas.map(a => {
    const col = a.nivel === 'critico' ? '#c0392b' : '#b8860b';
    const bg = a.nivel === 'critico' ? '#fdecea' : '#fdf6e3';
    return '<tr><td style="padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top">' +
      '<div style="font-size:15px">' + a.ic + '</div></td>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #eee">' +
      '<div style="font-weight:700;color:' + col + ';font-size:14px">' + esc(a.titulo) + '</div>' +
      '<div style="color:#5b6b63;font-size:12.5px;margin-top:2px">' + esc(a.detalle) + '</div>' +
      (a.accion && a.accion.url ? '<div style="margin-top:9px"><a href="' + a.accion.url + '" style="background:#14663f;color:#fff;text-decoration:none;font-weight:700;font-size:12px;padding:8px 15px;border-radius:8px;display:inline-block">' + esc(a.accion.texto || 'Aplicar') + '</a></div>' : '') +
      '</td>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right"><span style="font-size:10px;font-weight:700;text-transform:uppercase;color:' + col + ';background:' + bg + ';padding:2px 8px;border-radius:100px">' + (a.nivel === 'critico' ? 'crítico' : 'aviso') + '</span></td></tr>';
  }).join('');
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1c2b24">' +
    '<div style="padding:18px 4px"><span style="font-family:Arial;font-weight:800;font-size:18px">Seller<span style="color:#14663f">Brain</span></span></div>' +
    '<div style="background:#14663f;color:#fff;border-radius:12px 12px 0 0;padding:18px 20px">' +
    '<div style="font-size:18px;font-weight:800">Tus alertas de hoy</div>' +
    '<div style="font-size:13px;opacity:.9;margin-top:3px">' + alertas.length + ' cosa' + (alertas.length > 1 ? 's' : '') + ' que revisar' + (nCrit ? (' · ' + nCrit + ' crítica' + (nCrit > 1 ? 's' : '')) : '') + '</div></div>' +
    '<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3ece7;border-top:none">' + filas + '</table>' +
    '<div style="text-align:center;padding:20px 0"><a href="' + panel + '" style="background:#14663f;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:10px;display:inline-block">Abrir el panel</a></div>' +
    '<div style="color:#8a978f;font-size:11px;line-height:1.6;padding:0 4px 20px">Resumen diario automático de SellerBrain. Se envía solo cuando hay algo que revisar. ¿No quieres recibirlo? Responde a este correo. · Soporte: ' + esc(soporte) + '</div>' +
    '</div>';
  const text = 'Tus alertas de hoy (' + alertas.length + '):\n\n' +
    alertas.map(a => '- [' + (a.nivel === 'critico' ? 'CRITICO' : 'aviso') + '] ' + a.titulo + ' — ' + a.detalle).join('\n') +
    '\n\nAbre el panel: ' + panel + '\n\nSellerBrain · VENMON NATURALMENTE SL';
  const asunto = (nCrit ? '⚠️ ' : '') + 'SellerBrain — ' + alertas.length + ' alerta' + (alertas.length > 1 ? 's' : '') + ' hoy';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [email], subject: asunto, html, text, reply_to: replyTo })
  });
  let detalle = null; try { detalle = await r.json(); } catch (_) {}
  return { ok: r.ok, status: r.status, detalle };
}

// Envía el email de acceso vía Resend (si hay RESEND_API_KEY). Si no, no rompe:
// el código queda creado en la tabla (lo puedes ver en Supabase o reenviar).
async function enviarAccesoEmail(env, email, codigo) {
  if (!env.RESEND_API_KEY) return { saltado: 'sin RESEND_API_KEY' };
  const from = env.EMAIL_FROM || 'SellerBrain <hola@sellersbrain.io>';
  const portalBase = env.PORTAL_URL || 'https://sellersbrain.io/portal.html';
  const portal = portalBase + '?login=1';
  const soporte = env.EMAIL_SOPORTE || 'hola@sellersbrain.io';
  // A dónde llegan las RESPUESTAS del cliente. Ojo: Resend solo ENVÍA; para que
  // hola@ reciba de verdad hay que montar reenvío en el DNS. Hasta entonces,
  // pon EMAIL_REPLYTO a un buzón que sí leas (p.ej. tu Gmail) y no se pierde nada.
  const replyTo = env.EMAIL_REPLYTO || soporte;
  // Logo del email: PNG absoluto (Gmail/Outlook NO pintan SVG). Por defecto lo sirve
  // el mismo origen del portal (Netlify hoy, sellersbrain.io el día que migre).
  let logo = env.EMAIL_LOGO;
  if (!logo) { try { logo = new URL(portalBase).origin + '/assets/logo.png'; } catch (_) { logo = 'https://sellersbrain.io/assets/logo.png'; } }
  const html = emailAccesoHTML({ email, codigo, portal, soporte, logo });
  // Versión de texto plano (mejora la entregabilidad y sirve si el cliente no pinta HTML)
  const text =
    'Bienvenido a SellerBrain\n\n' +
    'Gracias por tu compra. Ya puedes entrar con tu email y este codigo de acceso:\n\n' +
    '  ' + codigo + '\n\n' +
    'Entra aqui: ' + portal + '\n' +
    'Usuario: ' + email + '  ·  Codigo: ' + codigo + '\n\n' +
    'Guarda este codigo: es tu llave de acceso.\n' +
    'Soporte: ' + soporte + '\n\n' +
    'SellerBrain · VENMON NATURALMENTE SL';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [email], subject: 'Tu acceso a SellerBrain', html, text,
      reply_to: replyTo
    })
  });
  let detalle = null; try { detalle = await r.json(); } catch (_) {}
  return { ok: r.ok, status: r.status, from, detalle };   // detalle = motivo exacto si falla
}

// Plantilla del email de bienvenida/acceso. HTML compatible con clientes de correo
// (tablas + estilos en línea): se ve igual en Gmail, Apple Mail y Outlook.
function emailAccesoHTML({ email, codigo, portal, soporte, logo }) {
  const verde = '#14663f', verdeClaro = '#f2f7f4', gris = '#5b6b63', borde = '#e3ece7';
  const beneficio = (icono, titulo, texto) =>
    '<tr>' +
      '<td width="34" valign="top" style="font-size:20px;line-height:24px;padding:6px 10px 6px 0">' + icono + '</td>' +
      '<td valign="top" style="padding:6px 0">' +
        '<div style="font-weight:bold;color:#173a2b;font-size:14px">' + titulo + '</div>' +
        '<div style="color:' + gris + ';font-size:13px;line-height:19px">' + texto + '</div>' +
      '</td>' +
    '</tr>';
  return '' +
  '<!doctype html><html><body style="margin:0;padding:0;background:#eef2f0">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f0;padding:24px 12px">' +
  '<tr><td align="center">' +
    '<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ' + borde + '">' +

      // Cabecera de marca (logo PNG + wordmark)
      '<tr><td style="background:' + verde + ';padding:24px 28px">' +
        '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
          '<td valign="middle" style="padding-right:14px">' +
            '<img src="' + logo + '" width="46" height="46" alt="SellerBrain" style="display:block;width:46px;height:46px;border:0;border-radius:11px">' +
          '</td>' +
          '<td valign="middle">' +
            '<div style="font-family:Arial,Helvetica,sans-serif;color:#ffffff;font-size:22px;font-weight:bold;letter-spacing:.5px">SellerBrain</div>' +
            '<div style="font-family:Arial,Helvetica,sans-serif;color:#bfe0cf;font-size:13px;margin-top:2px">Tu beneficio real de Amazon, claro y al día</div>' +
          '</td>' +
        '</tr></table>' +
      '</td></tr>' +

      // Cuerpo
      '<tr><td style="padding:30px 28px 8px;font-family:Arial,Helvetica,sans-serif">' +
        '<h1 style="margin:0 0 8px;color:#173a2b;font-size:22px">¡Bienvenido a bordo! 🎉</h1>' +
        '<p style="margin:0 0 18px;color:' + gris + ';font-size:15px;line-height:22px">Gracias por tu compra. Tu cuenta ya está lista. Entra con tu email y este <b>código de acceso</b>:</p>' +

        // Código destacado
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
          '<tr><td style="background:' + verdeClaro + ';border:1px dashed ' + verde + ';border-radius:10px;padding:16px;text-align:center">' +
            '<div style="color:' + gris + ';font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Tu código de acceso</div>' +
            '<div style="font-family:Consolas,Menlo,monospace;font-size:26px;font-weight:bold;letter-spacing:3px;color:' + verde + '">' + codigo + '</div>' +
          '</td></tr>' +
        '</table>' +

        // Botón
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 6px"><tr><td align="center">' +
          '<a href="' + portal + '" style="display:inline-block;background:' + verde + ';color:#ffffff;font-size:16px;font-weight:bold;padding:14px 30px;border-radius:10px;text-decoration:none">Entrar en SellerBrain →</a>' +
        '</td></tr></table>' +
        '<p style="margin:0 0 22px;text-align:center;color:#8a9a92;font-size:12px">Usuario: <b>' + email + '</b> · Código: <b>' + codigo + '</b></p>' +

        // Qué puedes hacer
        '<div style="height:1px;background:' + borde + ';margin:6px 0 18px"></div>' +
        '<div style="font-weight:bold;color:#173a2b;font-size:15px;margin-bottom:10px">Esto es lo que verás dentro:</div>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
          beneficio('📊', 'Beneficio real por producto', 'Descuenta comisiones, FBA, PPC y devoluciones. Sabes qué te deja cada referencia.') +
          beneficio('💸', 'Reembolsos pendientes', 'Detecta stock perdido o dañado por Amazon que te deben abonar.') +
          beneficio('🌍', 'Stock por país y PPC', 'Inventario por marketplace y control de tus campañas de publicidad.') +
          beneficio('✅', 'Cumplimiento UE', 'Títulos, EPR/GPSR y avisos de las últimas normas de Amazon.') +
        '</table>' +

      '</td></tr>' +

      // Ayuda
      '<tr><td style="padding:18px 28px 0;font-family:Arial,Helvetica,sans-serif">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#f7faf8;border:1px solid ' + borde + ';border-radius:10px;padding:14px 16px">' +
          '<div style="font-size:13px;color:' + gris + ';line-height:20px">💡 <b>Guarda este código</b>, es tu llave de acceso. ¿Dudas o algo no cuadra? Escríbenos a <a href="mailto:' + soporte + '" style="color:' + verde + ';text-decoration:none"><b>' + soporte + '</b></a> y te ayudamos.</div>' +
        '</td></tr></table>' +
      '</td></tr>' +

      // Pie
      '<tr><td style="padding:22px 28px 26px;font-family:Arial,Helvetica,sans-serif;text-align:center">' +
        '<div style="color:#9aa8a1;font-size:12px;line-height:18px">SellerBrain · VENMON NATURALMENTE SL<br>' +
        'Este email se ha enviado a ' + email + ' porque tienes una cuenta en SellerBrain.</div>' +
      '</td></tr>' +

    '</table>' +
  '</td></tr></table>' +
  '</body></html>';
}

/* =====================================================================
 * FUNDADORES — ciclo de vida: correos de seguimiento/renovación/último aviso,
 * baja al no renovar y (si BORRADO_AUTO=1) borrado de datos. Barrido diario
 * desde el cron (procesarFundadores). Ver sql/fundadores.sql.
 * =================================================================== */

// Config común de email (remite, soporte, logo, enlaces de pago).
function cfgEmail(env) {
  const from = env.EMAIL_FROM || 'SellerBrain <hola@sellersbrain.io>';
  const soporte = env.EMAIL_SOPORTE || 'hola@sellersbrain.io';
  const replyTo = env.EMAIL_REPLYTO || soporte;
  const portalBase = env.PORTAL_URL || 'https://sellersbrain.io/portal.html';
  let logo = env.EMAIL_LOGO;
  if (!logo) { try { logo = new URL(portalBase).origin + '/assets/logo.png'; } catch (_) { logo = 'https://sellersbrain.io/assets/logo.png'; } }
  return { from, soporte, replyTo, logo, portal: portalBase + '?login=1',
    linkMensual: env.STRIPE_LINK_MENSUAL || '', linkAnual: env.STRIPE_LINK_ANUAL || '',
    formSeguimiento: env.FORM_SEGUIMIENTO || '' };   // enlace al formulario de feedback
}

// Envío genérico por Resend. Devuelve {ok,status,detalle}.
async function enviarResend(env, to, subject, html, text) {
  if (!env.RESEND_API_KEY) return { saltado: 'sin RESEND_API_KEY' };
  const c = cfgEmail(env);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: c.from, to: [to], subject, html, text, reply_to: c.replyTo })
  });
  let detalle = null; try { detalle = await r.json(); } catch (_) {}
  return { ok: r.ok, status: r.status, detalle };
}

// Shell de marca compartido (cabecera con logo + pie). `cuerpo` es HTML.
function shellEmail({ logo, soporte, titulo, cuerpo }) {
  const verde = '#14663f', borde = '#e3ece7';
  return '<!doctype html><html><body style="margin:0;padding:0;background:#eef2f0">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f0;padding:24px 12px"><tr><td align="center">' +
    '<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#fff;border-radius:14px;overflow:hidden;border:1px solid ' + borde + '">' +
      '<tr><td style="background:' + verde + ';padding:22px 28px">' +
        '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
          '<td valign="middle" style="padding-right:12px"><img src="' + logo + '" width="40" height="40" alt="SellerBrain" style="display:block;width:40px;height:40px;border:0;border-radius:10px"></td>' +
          '<td valign="middle"><div style="font-family:Arial,Helvetica,sans-serif;color:#fff;font-size:20px;font-weight:bold">SellerBrain</div></td>' +
        '</tr></table>' +
      '</td></tr>' +
      '<tr><td style="padding:28px;font-family:Arial,Helvetica,sans-serif">' +
        '<h1 style="margin:0 0 12px;color:#173a2b;font-size:21px">' + titulo + '</h1>' + cuerpo +
      '</td></tr>' +
      '<tr><td style="padding:6px 28px 26px;font-family:Arial,Helvetica,sans-serif;text-align:center">' +
        '<div style="color:#9aa8a1;font-size:12px;line-height:18px">SellerBrain · VENMON NATURALMENTE SL<br>¿Dudas? <a href="mailto:' + soporte + '" style="color:' + verde + '">' + soporte + '</a></div>' +
      '</td></tr>' +
    '</table>' +
  '</td></tr></table></body></html>';
}

function botonHTML(url, texto, color) {
  return '<a href="' + url + '" style="display:inline-block;background:' + (color || '#14663f') + ';color:#fff;font-size:15px;font-weight:bold;padding:12px 22px;border-radius:9px;text-decoration:none">' + texto + '</a>';
}

// Preguntas del correo de seguimiento (configurables por env, separadas por '|').
function preguntasSeguimiento(env) {
  const ls = (env.PREGUNTAS_SEGUIMIENTO || '').split('|').map(s => s.trim()).filter(Boolean);
  return ls.length ? ls : [
    '¿Qué es lo que más te ayuda?',
    '¿Qué te falta o cambiarías?',
    'Del 0 al 10, ¿lo recomendarías?'
  ];
}

// Días desde hoy hasta una fecha YYYY-MM-DD (positivo = futuro, negativo = pasado).
function diasHasta(fechaISO) {
  if (!fechaISO) return null;
  const f = new Date(fechaISO + 'T00:00:00Z');
  const hoy = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  return Math.round((f - hoy) / 86400000);
}

async function enviarSeguimiento(env, m) {
  const c = cfgEmail(env);
  const dias = diasHasta(m.fin);
  const preguntas = preguntasSeguimiento(env).map(p => '<li style="margin:6px 0;color:#173a2b">' + p + '</li>').join('');
  // Si hay formulario configurado, el cliente contesta ahí (para analizarlo junto);
  // le pasamos su email para atribuir la respuesta. Si no, cae a "responde a este correo".
  let urlForm = c.formSeguimiento;
  if (urlForm) { urlForm += (urlForm.indexOf('?') > -1 ? '&' : '?') + 'e=' + encodeURIComponent(m.email); }
  const cta = urlForm
    ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 4px"><tr><td>' +
        botonHTML(urlForm, 'Responder la encuesta (2 min) →') +
      '</td></tr></table>'
    : '<p style="color:#5b6b63;font-size:14px">Cuéntanoslo <b>respondiendo a este correo</b>.</p>';
  const cuerpo =
    '<p style="color:#5b6b63;font-size:15px;line-height:22px">Llevas unas semanas con SellerBrain y nos encantaría saber cómo te va. Tu acceso fundador termina en <b>' + dias + ' días</b>.</p>' +
    '<p style="color:#5b6b63;font-size:15px;margin-bottom:4px">Son 3 preguntas rápidas:</p>' +
    '<ul style="font-size:15px;line-height:22px;padding-left:20px">' + preguntas + '</ul>' +
    cta +
    '<p style="color:#5b6b63;font-size:14px;margin-top:12px">Gracias por ser de los primeros. Leemos todas las respuestas y nos ayudan a mejorar.</p>';
  const html = shellEmail({ logo: c.logo, soporte: c.soporte, titulo: '¿Qué tal tus primeras semanas? 👀', cuerpo });
  const text = 'Tu acceso fundador termina en ' + dias + ' días. 3 preguntas:\n- ' +
    preguntasSeguimiento(env).join('\n- ') +
    (c.formSeguimiento ? ('\n\nResponde aquí: ' + c.formSeguimiento) : '\n\nResponde a este correo.');
  return enviarResend(env, m.email, '¿Cómo te va con SellerBrain? (2 min)', html, text);
}

async function enviarRenovacion(env, m) {
  const c = cfgEmail(env);
  const opciones =
    (c.linkMensual ? '<tr><td style="padding:6px 0">' + botonHTML(c.linkMensual, 'Seguir por 20 €/mes (sin permanencia) →') + '</td></tr>' : '') +
    (c.linkAnual ? '<tr><td style="padding:6px 0">' + botonHTML(c.linkAnual, 'Pagar el año: 200 € (2 meses de regalo) →', '#0f4e30') + '</td></tr>' : '');
  const cuerpo =
    '<p style="color:#5b6b63;font-size:15px;line-height:22px">Hoy termina tu acceso fundador. Si SellerBrain te está ayudando, elige cómo seguir — <b>sin permanencia</b>, te das de baja cuando quieras:</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0">' + opciones + '</table>' +
    '<p style="color:#5b6b63;font-size:14px;line-height:21px;margin-top:14px">Como fundador, tu precio queda <b>bloqueado</b>. Si no renuevas, en unos días cerraremos tu cuenta y borraremos tus datos.</p>';
  const html = shellEmail({ logo: c.logo, soporte: c.soporte, titulo: 'Tu acceso fundador termina hoy', cuerpo });
  const text = 'Hoy termina tu acceso fundador. Renueva:\n- 20 €/mes (sin permanencia): ' + (c.linkMensual || '(enlace)') + '\n- 200 €/año (2 meses gratis): ' + (c.linkAnual || '(enlace)');
  return enviarResend(env, m.email, 'Tu acceso a SellerBrain termina hoy', html, text);
}

async function enviarUltimoAviso(env, m) {
  const c = cfgEmail(env);
  const opciones =
    (c.linkMensual ? '<tr><td style="padding:6px 0">' + botonHTML(c.linkMensual, 'Reactivar por 20 €/mes →') + '</td></tr>' : '') +
    (c.linkAnual ? '<tr><td style="padding:6px 0">' + botonHTML(c.linkAnual, 'Reactivar el año: 200 € →', '#0f4e30') + '</td></tr>' : '');
  const cuerpo =
    '<p style="color:#5b6b63;font-size:15px;line-height:22px">Tu acceso terminó hace 7 días y hemos <b>pausado tu cuenta</b>. Aún estás a tiempo de reactivarla y conservar tus datos y tu precio de fundador:</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0">' + opciones + '</table>' +
    '<p style="color:#a23;font-size:14px;line-height:21px;margin-top:14px">⚠️ Si no reactivas, tu cuenta y tus datos se borrarán definitivamente en los próximos días.</p>';
  const html = shellEmail({ logo: c.logo, soporte: c.soporte, titulo: 'Última oportunidad para conservar tu cuenta', cuerpo });
  const text = 'Tu cuenta está pausada. Reactívala:\n- 20 €/mes: ' + (c.linkMensual || '(enlace)') + '\n- 200 €/año: ' + (c.linkAnual || '(enlace)') + '\nSi no, tus datos se borrarán en unos días.';
  return enviarResend(env, m.email, 'Última oportunidad — tu cuenta de SellerBrain', html, text);
}

// Cancelación de suscripción: agradece la confianza y explica el proceso
// (acceso hasta el fin de lo pagado, luego borrado tras el margen de gracia).
async function enviarCancelacion(env, m, finAcceso) {
  const c = cfgEmail(env);
  const gracia = +(env.GRACIA_BORRADO_DIAS || 14);
  const reactivar =
    (c.linkMensual ? '<tr><td style="padding:6px 0">' + botonHTML(c.linkMensual, 'Reactivar por 20 €/mes →') + '</td></tr>' : '') +
    (c.linkAnual ? '<tr><td style="padding:6px 0">' + botonHTML(c.linkAnual, 'Reactivar el año: 200 € →', '#0f4e30') + '</td></tr>' : '');
  const cuerpo =
    '<p style="color:#5b6b63;font-size:15px;line-height:22px">Hemos recibido tu cancelación. Ante todo, <b>gracias por confiar en SellerBrain</b> durante este tiempo — ha sido un placer acompañarte. 🙏</p>' +
    '<div style="background:#f7faf8;border:1px solid #e3ece7;border-radius:10px;padding:14px 16px;margin:14px 0">' +
      '<div style="font-weight:bold;color:#173a2b;font-size:14px;margin-bottom:6px">Qué pasa ahora</div>' +
      '<ul style="margin:0;padding-left:18px;color:#5b6b63;font-size:14px;line-height:21px">' +
        '<li>Mantienes el acceso hasta el <b>' + finAcceso + '</b> (lo que ya has pagado).</li>' +
        '<li>Después, tu cuenta se cierra y, pasados <b>' + gracia + ' días</b>, se borran tus datos (PPC, histórico, etc.).</li>' +
        '<li>Si vuelves antes de esa fecha, lo recuperas todo. Después, habría que reconectar y empezar de nuevo.</li>' +
      '</ul>' +
    '</div>' +
    '<p style="color:#5b6b63;font-size:15px;line-height:22px">Si cambias de idea, reactivar es un clic — y conservas tus datos:</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0">' + reactivar + '</table>' +
    '<p style="color:#5b6b63;font-size:14px;line-height:21px;margin-top:14px">Y si te vas: gracias de corazón. Nos encantaría saber en qué podemos mejorar — puedes responder a este correo. Te deseamos muchas ventas. 🚀</p>';
  const html = shellEmail({ logo: c.logo, soporte: c.soporte, titulo: 'Gracias por estos meses juntos', cuerpo });
  const text = 'Hemos recibido tu cancelacion. Gracias por confiar en SellerBrain.\n' +
    'Mantienes el acceso hasta el ' + finAcceso + '. Despues se cierra la cuenta y, pasados ' + gracia + ' dias, se borran tus datos.\n' +
    'Si vuelves antes, lo recuperas todo. Reactivar:\n- 20 €/mes: ' + (c.linkMensual || '(enlace)') + '\n- 200 €/año: ' + (c.linkAnual || '(enlace)');
  return enviarResend(env, m.email, 'Gracias por estos meses — tu cancelación en SellerBrain', html, text);
}

// Barrido diario del ciclo de vida de fundadores (lo llama el cron a las 08:00 UTC).
async function procesarFundadores(env) {
  const gracia = +(env.GRACIA_BORRADO_DIAS || 14);          // días tras la baja antes de borrar
  const borradoAuto = String(env.BORRADO_AUTO || '') === '1';
  const res = { seguimiento: 0, renovacion: 0, ultimo: 0, bajas: 0, borrados: 0, pendientes_borrado: 0 };
  const ahora = new Date().toISOString();
  let socios = [];
  // Procesamos: fundadores en curso (activo), suscriptores que cancelaron (cancelado)
  // y cuentas ya dadas de baja pendientes de borrar. Los 'renovado' (al día) se excluyen.
  try { socios = await selectSupabase(env, 'miembros?estado=in.(activo,cancelado,baja)&select=codigo,email,seller,plan,fin,estado,aviso1,aviso2,aviso3,baja,borrado'); } catch (_) { return res; }
  for (const m of (socios || [])) {
    const d = diasHasta(m.fin);
    try {
      // --- Ciclo de correos del FUNDADOR en curso (solo plan fundador + activo) ---
      if (m.plan === 'fundador' && m.estado === 'activo' && d != null) {
        if (!m.aviso1 && d <= 15 && d >= 1) {               // E-15: seguimiento (antes del fin)
          await enviarSeguimiento(env, m);
          await upsertSupabase(env, 'miembros', [{ codigo: m.codigo, aviso1: ahora }]);
          await upsertSupabase(env, 'fundador_avisos', [{ email: m.email, tipo: 'seguimiento', fin: m.fin }]);
          res.seguimiento++;
        }
        if (!m.aviso2 && d <= 0) {                          // E: renovación con enlaces
          await enviarRenovacion(env, m);
          await upsertSupabase(env, 'miembros', [{ codigo: m.codigo, aviso2: ahora }]);
          await upsertSupabase(env, 'fundador_avisos', [{ email: m.email, tipo: 'renovacion', fin: m.fin }]);
          res.renovacion++;
        }
        if (!m.aviso3 && d <= -7) {                         // E+7: último aviso + BAJA
          await enviarUltimoAviso(env, m);
          await upsertSupabase(env, 'miembros', [{ codigo: m.codigo, aviso3: ahora, estado: 'baja', activo: false, baja: ahora }]);
          await upsertSupabase(env, 'fundador_avisos', [{ email: m.email, tipo: 'ultimo_aviso', fin: m.fin }]);
          m.estado = 'baja'; m.baja = ahora;
          res.bajas++;
        }
      }
      // --- Suscriptor que CANCELÓ: al terminar lo pagado, se corta el acceso (baja) ---
      if (m.estado === 'cancelado' && d != null && d <= 0) {
        await upsertSupabase(env, 'miembros', [{ codigo: m.codigo, estado: 'baja', activo: false, baja: ahora }]);
        m.estado = 'baja'; m.baja = ahora;
        res.bajas++;
      }
      // --- BORRADO de datos: pasados `gracia` días desde la BAJA (si BORRADO_AUTO=1) ---
      if (m.estado === 'baja' && !m.borrado && m.baja) {
        const diasDesdeBaja = -(diasHasta(String(m.baja).slice(0, 10)) || 0);
        if (diasDesdeBaja >= gracia) {
          if (borradoAuto) {
            const tablas = await borrarDatosSeller(env, m.seller || m.email);
            await upsertSupabase(env, 'miembros', [{ codigo: m.codigo, borrado: ahora }]);
            await upsertSupabase(env, 'fundador_bajas', [{ seller: m.seller || m.email, email: m.email, motivo: 'no_renovado', tablas: tablas.join(',') }]);
            res.borrados++;
          } else {
            res.pendientes_borrado++;                        // BORRADO_AUTO apagado → solo se marca
          }
        }
      }
    } catch (_) { /* un fallo en un socio no corta el barrido */ }
  }
  return res;
}

// Borra los DATOS de negocio de un seller (RGPD). No borra la fila de miembro
// (queda como histórico con estado='baja' y fecha de borrado).
async function borrarDatosSeller(env, seller) {
  const tablas = ['pedidos_dia', 'ventas_sku_pais_dia', 'settlement_lineas', 'settlements',
    'devoluciones', 'inventario_pais', 'inventario_ajustes', 'reembolsos',
    'ppc_dia', 'ppc_campanas', 'ppc_terminos', 'ppc_horas', 'productos',
    'productos_catalogo', 'costes_producto', 'busquedas_marca', 'ingestas',
    'cuentas_spapi', 'cuentas_ads'];
  const hechas = [];
  for (const t of tablas) {
    try { await deleteSupabase(env, t + '?seller=eq.' + encodeURIComponent(seller)); hechas.push(t); }
    catch (_) { /* la tabla puede no tener columna seller o no existir → se ignora */ }
  }
  return hechas;
}

// IDENTIDAD: resuelve QUÉ vendedor está viendo, para FILTRAR los datos por su seller.
// La credencial puede venir por la cabecera (auth) o por ?key= (key).
//  · admin con SB_API_KEY           → 'venmon' (dueño, ve sus datos).
//  · JWT de un email ADMIN          → 'venmon' (el equipo de VENMON ve los datos propios).
//  · JWT de un miembro/cliente       → su miembros.seller (y si no consta, su propio email,
//                                       que es como se etiquetan sus datos al conectarse).
// IMPORTANTE (aislamiento multicuenta): un cliente externo NUNCA cae por defecto a 'venmon';
// si no se puede identificar, devuelve un valor imposible ('__nadie__') para que no vea NADA.
async function sellerDeLogin(env, auth, key) {
  if (env.SB_API_KEY && (auth === env.SB_API_KEY || key === env.SB_API_KEY)) return 'venmon';
  const payload = (await verificarJWT(env, auth)) || (key ? await verificarJWT(env, key) : null);
  if (!payload || !payload.email) return '__nadie__';
  const email = String(payload.email).toLowerCase();
  const admins = String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (admins.includes(email)) return 'venmon';
  try {
    const filas = await selectSupabase(env,
      'miembros?email=eq.' + encodeURIComponent(email) + '&select=seller&limit=1');
    return (filas && filas[0] && filas[0].seller) || email;
  } catch (_) { return email; }
}

/* ===== utils ===== */
function json(obj, headers, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
