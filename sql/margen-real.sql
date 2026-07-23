-- =====================================================================
-- MARGEN REAL v4 — Venta CON IVA (como Seller Central) + margen correcto
-- Ejecuta en Supabase -> SQL Editor. Idempotente. NO borra vistas del panel.
--
-- Se MUESTRA la venta CON IVA (9.603,87 = lo que ves en Seller Central).
-- El IVA repercutido se resta como una linea (va a Hacienda) para que el
-- BENEFICIO sea real. Tarifas por unidad (sin desfase). PPC de Ads API.
--
-- IMPORTANTE (por que v4): no se puede cambiar el NOMBRE de una columna de
-- una vista con "create or replace" (Postgres lo prohibe). Por eso el neto
-- vive en una vista APARTE (v_neto_dia) y v_ventas_dia / v_tarifa_dia
-- conservan sus columnas de siempre. Asi no hace falta borrar nada.
-- =====================================================================

-- 1) VENTAS DIARIAS = CON IVA (display). Mismas columnas de siempre (5).
create or replace view v_ventas_dia as
select
  fecha, sku,
  sum(uds) as uds,
  round(sum(ventas), 2) as ventas,        -- CON IVA (lo que reconoces, como Seller Central)
  sum(pedidos) as pedidos
from ventas_sku_pais_dia
group by fecha, sku;

-- 1b) VENTA NETA (SIN IVA) por dia y sku, en vista APARTE (para el beneficio).
--     El IVA se quita por pais (ES 21%, FR 20%, IT 22%, DE 19%...).
create or replace view v_neto_dia as
select
  fecha, sku,
  round(sum(ventas / (case pais
    when 'FR' then 1.20 when 'IT' then 1.22 when 'DE' then 1.19
    when 'PT' then 1.23 when 'PL' then 1.23 when 'NL' then 1.21
    when 'BE' then 1.21 when 'SE' then 1.25 when 'GB' then 1.20
    when 'IE' then 1.23 else 1.21 end)), 2) as neto
from ventas_sku_pais_dia
group by fecha, sku;

-- 2) VENTAS MENSUALES (barras) = CON IVA
create or replace view v_ventas_mes as
select to_char(fecha,'YYYY-MM') as mes, coalesce(nullif(pais,''),'?') as pais,
  round(sum(ventas),2) as ventas, sum(uds) as uds
from ventas_sku_pais_dia where fecha is not null
group by 1,2 order by 1;

-- 3) TARIFA POR UNIDAD APLICADA POR DIA (sin desfase). Fallback sobre venta SIN IVA.
--    La 4a columna se sigue llamando "ventas" (aqui lleva el NETO) para no
--    renombrar columnas y que "create or replace" no falle.
create or replace view v_tarifa_dia as
select
  v.fecha, v.sku, v.uds, coalesce(n.neto,0) as ventas,
  case when f.uds_liq > 0 then round(v.uds * f.fba / f.uds_liq, 2) else round(coalesce(n.neto,0) * 0.15, 2) end as fba,
  case when f.uds_liq > 0 then round(v.uds * f.com / f.uds_liq, 2) else round(coalesce(n.neto,0) * 0.15, 2) end as com
from v_ventas_dia v
left join v_neto_dia n on n.fecha = v.fecha and n.sku = v.sku
left join v_fee_sku f on f.sku = v.sku;

-- 4) TARJETAS: venta CON IVA; beneficio sobre SIN IVA (resta el IVA repercutido)
create or replace view v_periodos as
with rangos(id, nom, ini, fin, etiqueta, orden) as (
  values
   ('hoy',    'Hoy',        current_date,                              current_date + 1,                     to_char(current_date,'DD/MM'), 1),
   ('ayer',   'Ayer',       current_date - 1,                          current_date,                         to_char(current_date-1,'DD/MM'), 2),
   ('mes',    'Este mes',   date_trunc('month',current_date)::date,    current_date + 1,                     to_char(current_date,'"1-"DD" "TMMon'), 3),
   ('mespas', 'Mes pasado', (date_trunc('month',current_date)-interval '1 month')::date, date_trunc('month',current_date)::date, to_char(date_trunc('month',current_date)-interval '1 month','TMMon'), 4),
   ('anio',   'Este año',   date_trunc('year',current_date)::date,     current_date + 1,                     to_char(current_date,'YYYY'), 5),
   ('aniopas','Año pasado', (date_trunc('year',current_date)-interval '1 year')::date, date_trunc('year',current_date)::date, to_char(date_trunc('year',current_date)-interval '1 year','YYYY'), 6)
),
agg as (
  select r.id, r.nom, r.etiqueta, r.orden,
    coalesce((select sum(ventas)  from v_ventas_dia v where v.fecha >= r.ini and v.fecha < r.fin),0) ventas,
    coalesce((select sum(neto)    from v_neto_dia   n where n.fecha >= r.ini and n.fecha < r.fin),0) neto,
    coalesce((select sum(uds)     from v_ventas_dia v where v.fecha >= r.ini and v.fecha < r.fin),0) uds,
    coalesce((select sum(pedidos) from v_ventas_dia v where v.fecha >= r.ini and v.fecha < r.fin),0) pedidos,
    coalesce((select sum(gasto)   from ppc_dia p where p.fecha >= r.ini and p.fecha < r.fin),0) ppc,
    coalesce((select sum(vd.uds*cp.coste) from v_ventas_dia vd left join costes_producto cp on cp.sku=vd.sku
              where vd.fecha >= r.ini and vd.fecha < r.fin),0) cogs,
    coalesce((select sum(fba+com) from v_tarifa_dia t where t.fecha >= r.ini and t.fecha < r.fin),0)
    + coalesce((select -sum(importe)/1.21 from v_settle_clasificado s where s.cubo in ('alm','dev','otros') and s.fecha >= r.ini and s.fecha < r.fin),0) tarifas
  from rangos r
)
select id, nom, etiqueta as fecha, round(ventas,2) ventas, uds::int, pedidos::int,
       round(ppc,2) ppc,
       round(neto - cogs - tarifas - ppc, 2) ben,     -- beneficio sobre SIN IVA
       case when ventas>0 then round((neto - cogs - tarifas - ppc)/ventas*100,1) else 0 end mg
from agg order by orden;

-- 5) P&L DEL MES: venta CON IVA + linea "IVA repercutido"; tarifas por unidad; PPC Ads API
create or replace view v_pnl_mes as
with mes as (select date_trunc('month', current_date)::date as ini),
v  as (select coalesce(sum(ventas),0) ventas from v_ventas_dia, mes where fecha >= mes.ini),
vn as (select coalesce(sum(neto),0)   neto   from v_neto_dia,   mes where fecha >= mes.ini),
cogs as (select coalesce(sum(vd.uds*cp.coste),0) prod from v_ventas_dia vd join mes on vd.fecha >= mes.ini
         left join costes_producto cp on cp.sku = vd.sku),
tp as (select coalesce(sum(fba),0) fba, coalesce(sum(com),0) com from v_tarifa_dia, mes where fecha >= mes.ini),
s as (select
    coalesce(-sum(importe) filter (where cubo='alm'),0)/1.21   alm,
    coalesce(-sum(importe) filter (where cubo='dev'),0)/1.21   dev,
    coalesce(sum(importe)  filter (where cubo='otros'),0)/1.21 otros
  from v_settle_clasificado, mes where fecha >= mes.ini),
p as (select coalesce((select sum(gasto) from ppc_dia, mes m2 where ppc_dia.fecha >= m2.ini),0) ppc)
select round(v.ventas,2) ventas, round(cogs.prod,2) prod, round(tp.fba,2) fba,
       round(tp.com,2) com, round(p.ppc,2) ppc, round(s.dev,2) dev,
       round(s.alm,2) alm, 0::numeric iva, round(s.otros,2) otros,
       round((tp.fba + tp.com + s.alm + s.dev + abs(s.otros)) * 0.21, 2) as iva_sop,
       round(v.ventas - vn.neto, 2) as iva_rep          -- IVA repercutido (a Hacienda)
from v, vn, cogs, tp, s, p;

-- 6) P&L POR PERIODO (mismo criterio, con iva_rep). Se recrea (cambia la firma).
drop function if exists pnl_periodo(date, date);
create function pnl_periodo(desde date, hasta date)
returns table(ventas numeric, prod numeric, fba numeric, com numeric,
              ppc numeric, dev numeric, alm numeric, iva numeric,
              otros numeric, iva_sop numeric, iva_rep numeric)
language sql stable as $$
  with rango as (select desde ini, hasta fin),
  v  as (select coalesce(sum(ventas),0) ventas from v_ventas_dia, rango where fecha >= ini and fecha <= fin),
  vn as (select coalesce(sum(neto),0)   neto   from v_neto_dia,   rango where fecha >= ini and fecha <= fin),
  cogs as (select coalesce(sum(vd.uds*cp.coste),0) prod from v_ventas_dia vd join rango on vd.fecha >= ini and vd.fecha <= fin
           left join costes_producto cp on cp.sku = vd.sku),
  tp as (select coalesce(sum(fba),0) fba, coalesce(sum(com),0) com from v_tarifa_dia, rango where fecha >= ini and fecha <= fin),
  s as (select
      coalesce(-sum(importe) filter (where cubo='alm'),0)/1.21   alm,
      coalesce(-sum(importe) filter (where cubo='dev'),0)/1.21   dev,
      coalesce(sum(importe)  filter (where cubo='otros'),0)/1.21 otros
    from v_settle_clasificado, rango where fecha >= ini and fecha <= fin),
  p as (select coalesce((select sum(gasto) from ppc_dia, rango r2 where ppc_dia.fecha >= r2.ini and ppc_dia.fecha <= r2.fin),0) ppc)
  select round(v.ventas,2), round(cogs.prod,2), round(tp.fba,2), round(tp.com,2),
         round(p.ppc,2), round(s.dev,2), round(s.alm,2), 0::numeric, round(s.otros,2),
         round((tp.fba + tp.com + s.alm + s.dev + abs(s.otros)) * 0.21, 2),
         round(v.ventas - vn.neto, 2)
  from v, vn, cogs, tp, s, p;
$$;
