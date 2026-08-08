-- =====================================================================
-- Serie diaria (ventas / beneficio / PPC) para CUALQUIER periodo — alimenta el
-- gráfico "Beneficio vs Ventas". Ahora usa EL MISMO CRITERIO que las tarjetas y
-- el P&L (pnl_periodo / v_periodos) para que el gráfico CUADRE con ellos:
--   beneficio = neto (SIN IVA) − coste − (FBA+comisión por unidad real) −
--               (alm+dev+otros del settlement) − PPC(mayor de Ads y liquidado)
-- Antes calculaba mal: usaba ventas CON IVA, tarifas del settlement (no por
-- unidad) y PPC solo de ppc_dia → daba un beneficio distinto al del P&L.
-- Ejecuta en Supabase → SQL Editor. Requiere v_tarifa_dia (sql/margen-real.sql).
-- =====================================================================

-- Dependencia: TARIFA REAL POR UNIDAD por día (fba+com). Se crea aquí también
-- (idempotente) para que este fichero funcione aunque no hayas corrido antes
-- margen-real.sql. Necesita v_ventas_dia, v_neto_dia y v_fee_sku (ya existentes).
create or replace view v_tarifa_dia as
select
  v.fecha, v.sku, v.uds, coalesce(n.neto,0) as ventas,
  case when f.uds_liq > 0 then round(v.uds * f.fba / f.uds_liq, 2) else round(coalesce(n.neto,0) * 0.15, 2) end as fba,
  case when f.uds_liq > 0 then round(v.uds * f.com / f.uds_liq, 2) else round(coalesce(n.neto,0) * 0.15, 2) end as com
from v_ventas_dia v
left join v_neto_dia n on n.fecha = v.fecha and n.sku = v.sku
left join v_fee_sku f on f.sku = v.sku;

drop function if exists serie_periodo(date, date);
create function serie_periodo(desde date, hasta date)
returns table(fecha date, v numeric, b numeric, p numeric,
              neto numeric, coste numeric, tarifas numeric, gastos numeric)
language sql stable as $$
  select
    g.dia::date as fecha,
    round(coalesce(vt.v,0),2) as v,                                  -- ventas CON IVA (línea superior)
    round(
      coalesce(nt.neto,0)                                            -- ventas SIN IVA (base del beneficio)
      - coalesce(cg.c,0)                                             -- coste de producto
      - coalesce(tf.t,0)                                             -- FBA + comisión (tarifa REAL por unidad)
      - coalesce(sc.t,0)                                             -- almacenaje + devoluciones + otros (settlement)
      - coalesce(pp.p,0)                                             -- PPC = gasto DIARIO real (ppc_dia), NO el recibo del settlement
    , 2) as b,
    round(coalesce(pp.p,0),2) as p,
    -- Desglose del día (para el tooltip: de dónde viene la pérdida)
    round(coalesce(nt.neto,0),2) as neto,                            -- ventas sin IVA
    round(coalesce(cg.c,0),2)    as coste,                           -- coste de producto
    round(coalesce(tf.t,0),2)    as tarifas,                         -- FBA + comisión
    round(coalesce(sc.t,0),2)    as gastos                           -- almacenaje + devoluciones + otros (reembolsos, envíos…)
  from generate_series(desde, hasta, interval '1 day') g(dia)
  left join (select fecha, sum(ventas) v from v_ventas_dia group by fecha) vt on vt.fecha = g.dia::date
  left join (select fecha, sum(neto)   neto from v_neto_dia group by fecha) nt on nt.fecha = g.dia::date
  left join (select fecha, sum(gasto)  p from ppc_dia group by fecha) pp on pp.fecha = g.dia::date
  left join (select fecha, sum(fba+com) t from v_tarifa_dia group by fecha) tf on tf.fecha = g.dia::date
  left join (select fecha, -sum(importe)/1.21 t from v_settle_clasificado where cubo in ('alm','dev','otros') group by fecha) sc on sc.fecha = g.dia::date
  left join (select vd.fecha, sum(vd.uds*cp.coste) c from v_ventas_dia vd
             left join costes_producto cp on cp.sku=vd.sku group by vd.fecha) cg on cg.fecha = g.dia::date
  order by g.dia;
$$;

-- Redefinimos la vista de 30 días para que use la función (ahora incluye fecha)
drop view if exists v_serie_30d cascade;
create or replace view v_serie_30d as
  select * from serie_periodo(current_date - 29, current_date);

-- Comprobar (la suma de b debe parecerse al beneficio del P&L del mismo rango):
-- select round(sum(b),2) beneficio_grafico from serie_periodo(date '2026-07-01', date '2026-07-31');
