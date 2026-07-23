-- =====================================================================
-- VISTAS DEL DASHBOARD — convierten los datos crudos (pedidos, settlements,
-- devoluciones, ppc, inventario) en el contrato que consume el frontend.
--
-- Ejecuta ENTERO en Supabase → SQL Editor (desactiva la traducción del
-- navegador). Es idempotente: puedes re-ejecutarlo cuando quieras.
--
-- El Worker (/v1/dashboard) lee estas vistas: v_periodos, v_pnl_mes,
-- v_productos_mes, v_serie_30d, v_stock_riesgo. Además dejo v_comparativa
-- y v_calidad_datos para el panel de comparativas y el chequeo de datos.
--
-- ⚠️ CLASIFICACIÓN DE TARIFAS: Amazon nombra cada línea del settlement con
-- un 'amount-description' (aquí guardado dentro de 'concepto'). Uso los
-- nombres ESTÁNDAR (Commission, FBAPerUnitFulfillmentFee, Storage, Refund…).
-- Si al ver tus datos reales algún concepto no encaja, ajusta los ILIKE de
-- la vista v_settle_clasificado (está todo comentado y en un solo sitio).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0) COSTES DE PRODUCTO (COGS) — Amazon NO conoce tu coste de compra.
--    Lo mete el vendedor (a mano en el dashboard, o aquí). Sin coste, el
--    margen es "margen tras tarifas de Amazon" (aún sin descontar compra).
-- ---------------------------------------------------------------------
create table if not exists costes_producto (
  sku         text primary key,
  coste       numeric not null default 0,   -- coste unitario de compra (€)
  actualizado timestamptz not null default now()
);
-- RLS activada: invisible desde el navegador (claves anon/authenticated).
-- El Worker usa la service key, que SIEMPRE se salta la RLS → sigue leyendo/escribiendo.
alter table costes_producto enable row level security;

-- ---------------------------------------------------------------------
-- 0b) INVENTARIO FBA (snapshot) — lo rellena la ingesta del Worker.
--     Se usa para días de cobertura / rotura de stock.
-- ---------------------------------------------------------------------
create table if not exists inventario (
  sku        text primary key,
  disponible integer not null default 0,   -- unidades vendibles en FBA
  entrante   integer not null default 0,   -- unidades en camino (inbound)
  reservado  integer not null default 0,
  snapshot   timestamptz not null default now()
);
-- RLS activada (igual que costes_producto): invisible desde el navegador; el
-- Worker (service key) se la salta y sigue funcionando.
alter table inventario enable row level security;

-- ---------------------------------------------------------------------
-- 0c) CATÁLOGO — nombre e imagen por SKU. El nombre lo captura la ingesta
--     de pedidos (viene gratis en el informe). La imagen la trae el Worker
--     desde el catálogo de Amazon por ASIN (botón / endpoint aparte).
-- ---------------------------------------------------------------------
create table if not exists productos_catalogo (
  sku         text primary key,
  asin        text,
  nombre      text,
  imagen      text,                        -- URL de la miniatura principal
  actualizado timestamptz not null default now()
);
alter table productos_catalogo enable row level security;

-- ---------------------------------------------------------------------
-- 0d) VENTAS GRANULARES por (día · SKU · país) — fuente fiable para el
--     total y el desglose por país (pedidos_dia colapsa el marketplace y
--     no sirve para separar países). Lo llena la ingesta/backfill de pedidos.
-- ---------------------------------------------------------------------
create table if not exists ventas_sku_pais_dia (
  fecha   date    not null,
  sku     text    not null,
  pais    text    not null,
  uds     integer not null default 0,
  ventas  numeric not null default 0,
  pedidos integer not null default 0,
  primary key (fecha, sku, pais)
);
alter table ventas_sku_pais_dia enable row level security;
create index if not exists idx_vspd_fecha on ventas_sku_pais_dia (fecha);


-- ---------------------------------------------------------------------
-- LIMPIEZA — borra las vistas si existían de un intento anterior. Hace
-- falta porque CREATE OR REPLACE VIEW no permite cambiar el TIPO de una
-- columna (p.ej. uds de numeric a integer). CASCADE quita las dependientes.
-- Es seguro: las vistas no guardan datos, solo se recalculan al recrearse.
-- ---------------------------------------------------------------------
drop view if exists v_calidad_datos   cascade;
drop view if exists v_comparativa     cascade;
drop view if exists v_stock_riesgo    cascade;
drop view if exists v_serie_30d       cascade;
drop view if exists v_productos_mes   cascade;
drop view if exists v_periodos        cascade;
drop view if exists v_pnl_mes         cascade;
drop view if exists v_fee_sku         cascade;
drop view if exists v_settle_clasificado cascade;
drop view if exists v_ventas_dia      cascade;


-- ---------------------------------------------------------------------
-- 1) CLASIFICADOR DE LÍNEAS DE SETTLEMENT → cubos de coste
--    (fba, com=comisión, alm=almacenaje, dev=devoluciones, otros).
--    Las tarifas llegan con importe NEGATIVO; el coste = -sum(importe).
-- ---------------------------------------------------------------------
-- Clasificación basada en los nombres REALES de la cuenta (amount-type/description).
-- 'ppc' = publicidad (Cost of Advertising) para no mezclarla ni doblarla.
create or replace view v_settle_clasificado as
select
  fecha, sku, importe,
  case
    -- NO son coste: reservas y transferencias (dinero retenido/movido, no gasto).
    when concepto ilike '%reserve%' or tipo ilike '%transfer%'
         or concepto ilike '%balance%'                                      then 'ignorar'
    -- Ingresos / pass-through: precio de venta, IVA del producto, envío cobrado.
    when concepto ilike 'ItemPrice/%'                                       then 'ignorar'
    -- Reembolsos de Amazon a tu favor (pérdida/daño de inventario): crédito.
    when concepto ilike '%Reimbursement%'                                   then 'ignorar'
    -- Publicidad: se cuenta aparte (Ads API); cubo propio para no doblar.
    when concepto ilike '%Cost of Advertising%' or concepto ilike '%advertising%' then 'ppc'
    -- Devoluciones
    when tipo ilike '%refund%'                                              then 'dev'
    -- Almacenaje (storage, incl. su IVA "Tax on fee")
    when concepto ilike '%storage%'                                         then 'alm'
    -- Comisión (referral) — incluye RefundCommission
    when concepto ilike '%commission%' or concepto ilike '%referral%'       then 'com'
    -- FBA: cumplimiento por unidad, logística de entrada, retirada
    when concepto ilike '%fulfillment%' or concepto ilike '%fbaperunit%'
         or concepto ilike '%inboundtransportation%' or concepto ilike '%partnered carrier%'
         or concepto ilike '%removal%' or concepto ilike '%pick%pack%'
         or concepto ilike '%weight%handl%'                                 then 'fba'
    -- Resto de ItemFees (servicios digitales, shipping chargeback…) = coste
    when concepto ilike 'ItemFees/%'                                        then 'com'
    -- Promociones / cupones = coste de marketing
    when concepto ilike 'Promotion/%' or concepto ilike '%coupon%'          then 'otros'
    -- Suscripción, EPR y cualquier otro cargo negativo → 'otros' (coste)
    when importe < 0                                                        then 'otros'
    else 'ignorar'
  end as cubo
from settlement_lineas
where fecha is not null;


-- ---------------------------------------------------------------------
-- 1b) TARIFA REAL POR UNIDAD y SKU (de TODO el histórico de settlements).
--     Resuelve el desfase: Amazon liquida con retraso, así que en vez de sumar
--     lo liquidado en el periodo (incompleto), calculamos €/unidad de cada
--     producto y lo aplicamos a las unidades vendidas.
--     fba, com = magnitudes positivas (coste); uds_liq = unidades liquidadas.
-- ---------------------------------------------------------------------
create or replace view v_fee_sku as
-- IVA_TARIFAS = 1.21: el settlement guarda las tarifas CON IVA (21% ES) y el
-- vendedor lo desgrava → dividimos por 1.21 para dejar el coste real (base).
select sku,
  sum(case when concepto ilike 'ItemPrice/Principal' then cantidad else 0 end) as uds_liq,
  -- FBA por unidad VENDIDA: cumplimiento + logística de entrada. NO incluye la
  -- RETIRADA/ELIMINACIÓN de inventario (removal/disposal): es un coste puntual
  -- de sacar stock, no una tarifa por venta → si se repartía entre las uds
  -- vendidas, inflaba el €/unidad y hundía el margen. Se excluye aquí.
  round(-sum(importe) filter (where (concepto ilike '%fulfillment%' or concepto ilike '%fbaperunit%'
        or concepto ilike '%inboundtransportation%' or concepto ilike '%partnered carrier%'
        or concepto ilike '%pick%pack%' or concepto ilike '%weight%handl%')
        and concepto not ilike '%removal%' and concepto not ilike '%disposal%') / 1.21, 2) as fba,
  round(-sum(importe) filter (where concepto ilike '%commission%' or concepto ilike '%referral%'
        or (concepto ilike 'ItemFees/%'
            and concepto not ilike '%fulfillment%' and concepto not ilike '%fbaperunit%')) / 1.21, 2) as com,
  -- Retirada/eliminación de inventario, como DATO APARTE (para verlo claro y no
  -- mezclarlo con la tarifa por venta).
  round(-sum(importe) filter (where concepto ilike '%removal%' or concepto ilike '%disposal%') / 1.21, 2) as retiro
from settlement_lineas
where sku is not null and sku <> '' and sku not ilike 'amzn.gr.%'
group by sku;


-- ---------------------------------------------------------------------
-- 2) VENTAS POR DÍA Y SKU (base para casi todo) — desde pedidos_dia.
-- ---------------------------------------------------------------------
create or replace view v_ventas_dia as
select fecha, sku,
       sum(unidades) as uds,
       sum(ventas)   as ventas,
       sum(pedidos)  as pedidos
from pedidos_dia
group by fecha, sku;


-- ---------------------------------------------------------------------
-- 3) v_pnl_mes — P&L del MES EN CURSO (una sola fila, la lee pnl[0]).
--    Campos exactos que pinta el frontend: ventas, prod, fba, com, ppc,
--    dev, alm, iva, otros. Son magnitudes de coste (positivo = coste).
-- ---------------------------------------------------------------------
create or replace view v_pnl_mes as
with mes as (select date_trunc('month', current_date)::date as ini),
v as (  -- ventas y unidades del mes
  select coalesce(sum(ventas),0) ventas, coalesce(sum(uds),0) uds
  from v_ventas_dia, mes where fecha >= mes.ini
),
cogs as (  -- coste de compra = uds vendidas * coste unitario
  select coalesce(sum(vd.uds * cp.coste),0) prod
  from v_ventas_dia vd join mes on vd.fecha >= mes.ini
  left join costes_producto cp on cp.sku = vd.sku
),
s as (  -- tarifas del mes por cubo, SIN IVA (÷1.21, el IVA se desgrava)
  select
    coalesce(-sum(importe) filter (where cubo='fba'),0)/1.21   fba,
    coalesce(-sum(importe) filter (where cubo='com'),0)/1.21   com,
    coalesce(-sum(importe) filter (where cubo='alm'),0)/1.21   alm,
    coalesce(-sum(importe) filter (where cubo='dev'),0)/1.21   dev,
    -- 'otros' va CON SIGNO (el frontend lo pinta tal cual): negativo = coste,
    -- positivo = crédito/ajuste a favor. Las demás son magnitudes positivas.
    coalesce(sum(importe) filter (where cubo='otros'),0)/1.21  otros
  from v_settle_clasificado, mes where fecha >= mes.ini
),
p as (  -- gasto PPC del mes: el mayor entre Ads API y el 'Cost of Advertising'
        -- del settlement (este último suele ser el total real facturado).
  select greatest(
    coalesce((select sum(gasto) from ppc_dia, mes m2 where ppc_dia.fecha >= m2.ini),0),
    coalesce((select -sum(importe)/1.21 from v_settle_clasificado sc, mes m3 where sc.cubo='ppc' and sc.fecha >= m3.ini),0)
  ) ppc
)
select round(v.ventas,2) ventas, round(cogs.prod,2) prod, round(s.fba,2) fba,
       round(s.com,2) com, round(p.ppc,2) ppc, round(s.dev,2) dev,
       round(s.alm,2) alm, 0::numeric iva, round(s.otros,2) otros,
       -- IVA soportado recuperable: el 21% de las tarifas (base neta × 0.21).
       -- NO resta al beneficio (Hacienda te lo devuelve); es informativo.
       round((s.fba + s.com + s.alm + s.dev + abs(s.otros)) * 0.21, 2) as iva_sop
from v, cogs, s, p;


-- ---------------------------------------------------------------------
-- 4) v_periodos — tarjetas Hoy / Ayer / Este mes / Mes pasado / Este año
--    / Año pasado. Campos: id, nom, fecha, ventas, uds, pedidos, ppc,
--    ben, mg. ben = ventas - cogs - tarifas(fba+com+alm+dev+otros) - ppc.
-- ---------------------------------------------------------------------
create or replace view v_periodos as
with rangos(id, nom, ini, fin, etiqueta, orden) as (
  values
   ('hoy',    'Hoy',        current_date,                              current_date + 1,                     to_char(current_date,'DD/MM'), 1),
   ('ayer',   'Ayer',       current_date - 1,                          current_date,                         to_char(current_date-1,'DD/MM'), 2),
   ('mes',    'Este mes',   date_trunc('month',current_date)::date,    current_date + 1,                     to_char(current_date,'"1–"DD" "TMMon'), 3),
   ('mespas', 'Mes pasado', (date_trunc('month',current_date)-interval '1 month')::date, date_trunc('month',current_date)::date, to_char(date_trunc('month',current_date)-interval '1 month','TMMon'), 4),
   ('anio',   'Este año',   date_trunc('year',current_date)::date,     current_date + 1,                     to_char(current_date,'YYYY'), 5),
   ('aniopas','Año pasado', (date_trunc('year',current_date)-interval '1 year')::date, date_trunc('year',current_date)::date, to_char(date_trunc('year',current_date)-interval '1 year','YYYY'), 6)
),
agg as (
  select r.id, r.nom, r.etiqueta, r.orden,
    coalesce((select sum(ventas)  from v_ventas_dia v where v.fecha >= r.ini and v.fecha < r.fin),0) ventas,
    coalesce((select sum(uds)     from v_ventas_dia v where v.fecha >= r.ini and v.fecha < r.fin),0) uds,
    coalesce((select sum(pedidos) from v_ventas_dia v where v.fecha >= r.ini and v.fecha < r.fin),0) pedidos,
    greatest(
      coalesce((select sum(gasto) from ppc_dia p where p.fecha >= r.ini and p.fecha < r.fin),0),
      coalesce((select -sum(importe)/1.21 from v_settle_clasificado s where s.cubo='ppc' and s.fecha >= r.ini and s.fecha < r.fin),0)
    ) ppc,
    coalesce((select sum(vd.uds*cp.coste) from v_ventas_dia vd left join costes_producto cp on cp.sku=vd.sku
              where vd.fecha >= r.ini and vd.fecha < r.fin),0) cogs,
    -- tarifas (fba+com+alm+dev+otros) SIN IVA y SIN publicidad (va en ppc aparte)
    coalesce((select -sum(importe)/1.21 from v_settle_clasificado s where s.cubo not in ('ignorar','ppc') and s.fecha >= r.ini and s.fecha < r.fin),0) tarifas
  from rangos r
)
select id, nom, etiqueta as fecha, round(ventas,2) ventas, uds::int, pedidos::int,
       round(ppc,2) ppc,
       round(ventas - cogs - tarifas - ppc, 2) ben,
       case when ventas>0 then round((ventas - cogs - tarifas - ppc)/ventas*100,1) else 0 end mg
from agg order by orden;


-- ---------------------------------------------------------------------
-- 5) v_productos_mes — tabla de productos del MES EN CURSO. Campos:
--    nom, sku, emoji, uds, ventas, ppc, ben, mg, trend[10], estado, txt.
--    (ppc por producto = 0: Amazon Ads no se atribuye por SKU de forma
--    fiable; el motor de PPC trabaja aparte con ppc_terminos.)
-- ---------------------------------------------------------------------
-- Nota sobre tarifas por producto: NO se usan las líneas de settlement crudas
-- por SKU, porque llegan desfasadas (las tarifas de este mes corresponden a
-- ventas de semanas anteriores) y provocaban falsas pérdidas / falsos 100%.
-- En su lugar se reparte con el RATIO de tarifa a nivel de cuenta del mes
-- (tarifas totales ÷ ventas totales); si aún no hay settlements, estima 15%+15%.
create or replace view v_productos_mes as
with mes as (select date_trunc('month', current_date)::date ini),
base as (
  select vd.sku,
    sum(vd.uds) uds, sum(vd.ventas) ventas,
    max(cp.coste) coste
  from v_ventas_dia vd
  cross join mes
  left join costes_producto cp on cp.sku = vd.sku
  where vd.fecha >= mes.ini
  group by vd.sku
),
tot as (  -- totales de cuenta del mes en curso
  select
    coalesce((select sum(ventas) from v_ventas_dia vd, mes where vd.fecha >= mes.ini),0) tv,
    coalesce((select -sum(importe) from v_settle_clasificado s, mes where cubo='fba' and s.fecha >= mes.ini),0) tf,
    coalesce((select -sum(importe) from v_settle_clasificado s, mes where cubo='com' and s.fecha >= mes.ini),0) tc
),
r as (  -- ratio de tarifas; si no hay settlements (o sale absurdo), estima 15%+15%
  select
    (case when tv>0 and tf>0 and tf/tv <= 0.6 then tf/tv else 0.15 end
     + case when tv>0 and tc>0 and tc/tv <= 0.4 then tc/tv else 0.15 end) as feeR
  from tot
),
calc as (
  select b.sku,
    b.uds, round(b.ventas,2) ventas, coalesce(b.coste,0) coste, b.coste is null nocoste,
    round(b.ventas - b.uds*coalesce(b.coste,0) - b.ventas*r.feeR, 2) ben
  from base b cross join r
)
select
  coalesce(nullif(pc.nombre,''), c.sku) as nom,   -- nombre real; si no hay, el SKU
  c.sku, '📦' as emoji, pc.imagen, c.uds, c.ventas, 0::numeric ppc, c.ben,
  case when c.ventas>0 then round(c.ben/c.ventas*100,1) else 0 end mg,
  -- trend: unidades de los últimos 10 días con datos (rellena a 0 si faltan)
  coalesce((
    select array_agg(coalesce(d.u,0) order by g.dia)
    from generate_series(current_date-9, current_date, interval '1 day') g(dia)
    left join (select fecha, sum(uds) u from v_ventas_dia where sku=c.sku group by fecha) d
      on d.fecha = g.dia::date
  ), array[0,0,0,0,0,0,0,0,0,0]) as trend,
  case when c.nocoste then 'am'   -- sin coste = margen incompleto → ámbar, no verde
       when (case when c.ventas>0 then c.ben/c.ventas*100 else 0 end) < 0 then 'rd'
       when (case when c.ventas>0 then c.ben/c.ventas*100 else 0 end) < 15 then 'am' else 'gn' end estado,
  case when c.nocoste then 'Sin coste ➜ clic'
       when (case when c.ventas>0 then c.ben/c.ventas*100 else 0 end) < 0 then 'Pierde'
       when (case when c.ventas>0 then c.ben/c.ventas*100 else 0 end) < 15 then 'Margen bajo' else 'OK' end txt
from calc c
left join productos_catalogo pc on pc.sku = c.sku
order by c.ventas desc
limit 30;


-- ---------------------------------------------------------------------
-- 6) v_serie_30d — serie de los últimos 30 días. Campos: v (ventas),
--    b (beneficio), p (gasto ppc). Beneficio ≈ v - ppc - tarifas - cogs.
-- ---------------------------------------------------------------------
create or replace view v_serie_30d as
select
  coalesce(vt.v,0) v,
  round(coalesce(vt.v,0) - coalesce(pp.p,0) - coalesce(sc.t,0) - coalesce(cg.c,0), 2) b,
  round(coalesce(pp.p,0),2) p
from generate_series(current_date-29, current_date, interval '1 day') g(dia)
left join (select fecha, sum(ventas) v from v_ventas_dia group by fecha) vt on vt.fecha = g.dia::date
left join (select fecha, sum(gasto) p from ppc_dia group by fecha) pp on pp.fecha = g.dia::date
left join (select fecha, -sum(importe)/1.21 t from v_settle_clasificado where cubo not in ('ignorar','ppc') group by fecha) sc on sc.fecha = g.dia::date
left join (select vd.fecha, sum(vd.uds*cp.coste) c from v_ventas_dia vd left join costes_producto cp on cp.sku=vd.sku group by vd.fecha) cg on cg.fecha = g.dia::date
order by g.dia;


-- ---------------------------------------------------------------------
-- 7) v_stock_riesgo — días de cobertura por SKU. Campos: nom, dias, pct,
--    c (color), nota. Velocidad = uds/día de los últimos 30 días.
-- ---------------------------------------------------------------------
create or replace view v_stock_riesgo as
with vel as (
  select sku, sum(uds)/30.0 vd
  from v_ventas_dia where fecha >= current_date - 30 group by sku
)
select
  i.sku as nom,
  case when coalesce(v.vd,0) > 0 then floor(i.disponible / v.vd)::int else 999 end dias,
  least(100, greatest(4, round( (case when coalesce(v.vd,0)>0 then i.disponible/v.vd else 90 end) / 90.0 * 100 )))::int pct,
  case when coalesce(v.vd,0) > 0 and i.disponible/v.vd < 15 then 'var(--rd)'
       when coalesce(v.vd,0) > 0 and i.disponible/v.vd < 30 then 'var(--am)'
       else 'var(--gn)' end c,
  case when coalesce(v.vd,0) > 0 and i.disponible/v.vd < 15 then 'PIDE YA · '||i.disponible||' uds'
       when coalesce(v.vd,0) > 0 and i.disponible/v.vd < 30 then 'Pedir esta semana'
       else 'OK · '||i.disponible||' uds' end nota
from inventario i
left join vel v on v.sku = i.sku
where (i.disponible > 0 or coalesce(v.vd,0) > 0)
  and i.sku not ilike 'amzn.gr.%'   -- excluye reacondicionados que revende Amazon
order by dias asc
limit 20;


-- ---------------------------------------------------------------------
-- 8) v_comparativa — este mes vs mes pasado vs mismo mes del año pasado,
--    y este año vs año pasado. Para el panel de comparativas.
-- ---------------------------------------------------------------------
create or replace view v_comparativa as
with r(clave, nom, ini, fin, orden) as (
  values
   ('mes_actual',   'Este mes',            date_trunc('month',current_date)::date, current_date+1, 1),
   ('mes_anterior', 'Mes pasado',          (date_trunc('month',current_date)-interval '1 month')::date, date_trunc('month',current_date)::date, 2),
   ('mes_anio_ant', 'Mismo mes año pasado',(date_trunc('month',current_date)-interval '1 year')::date, (date_trunc('month',current_date)-interval '1 year'+interval '1 month')::date, 3),
   ('anio_actual',  'Este año',            date_trunc('year',current_date)::date, current_date+1, 4),
   ('anio_ant',     'Año pasado',          (date_trunc('year',current_date)-interval '1 year')::date, date_trunc('year',current_date)::date, 5)
)
select r.clave, r.nom, r.orden,
  coalesce((select sum(ventas) from v_ventas_dia v where v.fecha>=r.ini and v.fecha<r.fin),0) ventas,
  coalesce((select sum(uds)    from v_ventas_dia v where v.fecha>=r.ini and v.fecha<r.fin),0) uds,
  coalesce((select sum(gasto)  from ppc_dia p    where p.fecha>=r.ini and p.fecha<r.fin),0) ppc
from r order by r.orden;


-- ---------------------------------------------------------------------
-- 9) v_calidad_datos — qué meses tienen datos (para saber si el backfill
--    trajo todo o algún informe de Amazon falló).
-- ---------------------------------------------------------------------
create or replace view v_calidad_datos as
select
  to_char(fecha,'YYYY-MM') mes,
  count(distinct fecha) dias_con_ventas,
  round(sum(ventas),2) ventas,
  sum(uds) uds
from v_ventas_dia
group by 1 order by 1 desc;


-- =====================================================================
-- Comprobaciones rápidas (descomenta para verlas):
-- select * from v_periodos;
-- select * from v_pnl_mes;
-- select * from v_productos_mes limit 10;
-- select * from v_calidad_datos;
-- select * from v_comparativa;
-- =====================================================================
