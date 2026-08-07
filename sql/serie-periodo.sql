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

create or replace function serie_periodo(desde date, hasta date)
returns table(fecha date, v numeric, b numeric, p numeric)
language sql stable as $$
  select
    g.dia::date as fecha,
    round(coalesce(vt.v,0),2) as v,                                  -- ventas CON IVA (línea superior)
    round(
      coalesce(nt.neto,0)                                            -- ventas SIN IVA (base del beneficio)
      - coalesce(cg.c,0)                                             -- coste de producto
      - coalesce(tf.t,0)                                             -- FBA + comisión (tarifa REAL por unidad)
      - coalesce(sc.t,0)                                             -- almacenaje + devoluciones + otros (settlement)
      - greatest(coalesce(pp.p,0), coalesce(sp.p,0))                 -- PPC (mayor de Ads y liquidado)
    , 2) as b,
    round(greatest(coalesce(pp.p,0), coalesce(sp.p,0)),2) as p
  from generate_series(desde, hasta, interval '1 day') g(dia)
  left join (select fecha, sum(ventas) v from v_ventas_dia group by fecha) vt on vt.fecha = g.dia::date
  left join (select fecha, sum(neto)   neto from v_neto_dia group by fecha) nt on nt.fecha = g.dia::date
  left join (select fecha, sum(gasto)  p from ppc_dia group by fecha) pp on pp.fecha = g.dia::date
  left join (select fecha, -sum(importe)/1.21 p from v_settle_clasificado where cubo='ppc' group by fecha) sp on sp.fecha = g.dia::date
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
