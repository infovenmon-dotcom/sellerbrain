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
 * CRON (wrangler.toml) — HORARIO, no diario:
 *   [triggers]
 *   crons = ["0 * * * *"]   # cada hora: foto PPC + refresco de ventas; 03:00 ingesta completa
 *   (Si pegas el worker a mano, cambia el Cron Trigger en el panel de Cloudflare a "0 * * * *".)
 * =====================================================================
 */

const SB_VERSION = 'v74-429-backoff'; // súbelo al cambiar el Worker (para verificar despliegue)
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
      // POST /v1/feedback es público (lo envía el navegador del cliente desde el formulario).
      const feedbackPublico = url.pathname === '/v1/feedback' && request.method === 'POST';
      if (url.pathname.startsWith('/v1/') && url.pathname !== '/v1/login' && !feedbackPublico) {
        const auth = (request.headers.get('Authorization') || '').replace('Bearer ', '');
        const key = auth || url.searchParams.get('key') || '';
        let ok = env.SB_API_KEY && key === env.SB_API_KEY;
        // Endpoints de LECTURA que un miembro puede consultar con su token de
        // login (JWT). Los de admin (ingest, ads, terminos…) siguen exigiendo
        // la SB_API_KEY maestra — la clave maestra nunca sale al navegador.
        const MIEMBRO_OK = url.pathname.startsWith('/v1/ppc') || url.pathname === '/v1/dashboard' || url.pathname === '/v1/plan' || url.pathname === '/v1/keywords' || url.pathname === '/v1/nichos' || url.pathname === '/v1/costes' || url.pathname === '/v1/comparativa' || url.pathname === '/v1/productos' || url.pathname === '/v1/ventas-pais' || url.pathname === '/v1/producto-detalle' || url.pathname === '/v1/satisfaccion' || url.pathname === '/v1/serie' || url.pathname === '/v1/mensual' || url.pathname === '/v1/pnl' || url.pathname === '/v1/devoluciones' || url.pathname === '/v1/fugas' || url.pathname === '/v1/stock' || url.pathname === '/v1/stock-pais' || url.pathname === '/v1/ingest-ventas' || url.pathname === '/v1/reembolsos';
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
        const filas = await selectSupabase(env, 'ppc_terminos?' + filtro + 'order=hasta.desc,gasto.desc&limit=8000');
        return json({ datos: filas }, cors);
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

      // --- STOCK: TODOS los productos con stock real, en camino, salida media
      //     (uds/día 30d) y días de cobertura. El front calcula la fecha límite de
      //     pedido según el método de envío (barco/tren/aire) + recepción Amazon. ---
      if (url.pathname === '/v1/stock') {
        const inv = {}; let snapMax = null;
        try { for (const r of (await selectSupabase(env, 'inventario?select=sku,disponible,entrante,reservado,snapshot'))) { inv[r.sku] = { disp: +r.disponible || 0, ent: +r.entrante || 0, res: +r.reservado || 0 }; if (r.snapshot && (!snapMax || r.snapshot > snapMax)) snapMax = r.snapshot; } } catch (_) {}
        const hace30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const vel = {};
        try { for (const r of (await selSafe(env, 'ventas_sku_pais_dia?fecha=gte.' + hace30 + '&select=sku,uds', []))) { const s = r.sku || ''; if (!s) continue; vel[s] = (vel[s] || 0) + (+r.uds || 0); } } catch (_) {}
        const cat = {};
        try { for (const c of (await selectSupabase(env, 'productos_catalogo?select=sku,nombre'))) cat[c.sku] = c.nombre; } catch (_) {}
        const skus = new Set([...Object.keys(inv), ...Object.keys(vel)]);
        const datos = [...skus].filter(s => !/^amzn\.gr\./i.test(s)).map(s => {
          const disp = (inv[s] && inv[s].disp) || 0, ent = (inv[s] && inv[s].ent) || 0, res = (inv[s] && inv[s].res) || 0;
          const v = (vel[s] || 0) / 30;                          // uds/día (media 30 días)
          const dias = v > 0 ? Math.floor(disp / v) : null;      // cobertura; null = sin ventas
          return { sku: s, nombre: cat[s] || s, disponible: disp, entrante: ent, reservado: res, vel: +v.toFixed(2), dias };
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
        return json({ datos, total_mes }, cors);
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
  const esperas = [15000, 30000, 45000];   // backoff ante 429 (createReport tiene cupo bajo)
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

  // 2. Términos de búsqueda (resumen 30 días) — solo lunes UTC o si se fuerza.
  if (solo === 'terminos' || (!solo && (forzarTerminos || esLunes))) {
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
    const c = cat[p.sku] || {};
    return {
      nom: (c.nombre || p.sku), sku: p.sku, emoji: '📦', imagen: c.imagen || null,
      uds: p.uds, ventas: +p.ventas.toFixed(2),
      coste: costeTot, comision: com, fba, devol: dev, amazon,
      real, ppc: ppcGasto, acos_real, cvr, ppc_clics: ppcClics, ppc_estado, ben, mg, breakeven, acos_obj,
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
    '?marketplaceIds=' + marketplaceId + '&includedData=images,summaries');
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

// IDENTIDAD (fase 3, aún SIN activar en la lectura): resuelve QUÉ vendedor está
// viendo, para poder filtrar los datos por su seller.
//  · admin con SB_API_KEY  → 'venmon' (ve los datos propios).
//  · miembro con su JWT     → su miembros.seller (por defecto 'venmon' si no consta).
// El default 'venmon' hace que el equipo de VENMON no se quede sin datos.
async function sellerDeLogin(env, auth) {
  if (auth && env.SB_API_KEY && auth === env.SB_API_KEY) return 'venmon';
  const payload = await verificarJWT(env, auth);
  if (!payload || !payload.email) return 'venmon';
  try {
    const filas = await selectSupabase(env,
      'miembros?email=eq.' + encodeURIComponent(payload.email) + '&select=seller&limit=1');
    return (filas && filas[0] && filas[0].seller) || 'venmon';
  } catch (_) { return 'venmon'; }
}

/* ===== utils ===== */
function json(obj, headers, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
