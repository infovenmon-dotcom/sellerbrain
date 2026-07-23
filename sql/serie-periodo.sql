-- =====================================================================
-- Serie diaria (ventas / beneficio / PPC) para CUALQUIER periodo
-- Ejecuta en Supabase -> SQL Editor. Permite que el grafico del dashboard
-- siga el selector de fechas y muestre el dia concreto al pasar el raton.
-- =====================================================================

create or replace function serie_periodo(desde date, hasta date)
returns table(fecha date, v numeric, b numeric, p numeric)
language sql stable as $$
  select
    g.dia::date as fecha,
    round(coalesce(vt.v,0),2) as v,
    round(coalesce(vt.v,0) - coalesce(pp.p,0) - coalesce(sc.t,0) - coalesce(cg.c,0), 2) as b,
    round(coalesce(pp.p,0),2) as p
  from generate_series(desde, hasta, interval '1 day') g(dia)
  left join (select fecha, sum(ventas) v from v_ventas_dia group by fecha) vt on vt.fecha = g.dia::date
  left join (select fecha, sum(gasto) p from ppc_dia group by fecha) pp on pp.fecha = g.dia::date
  left join (select fecha, -sum(importe)/1.21 t from v_settle_clasificado
             where cubo not in ('ignorar','ppc') group by fecha) sc on sc.fecha = g.dia::date
  left join (select vd.fecha, sum(vd.uds*cp.coste) c from v_ventas_dia vd
             left join costes_producto cp on cp.sku=vd.sku group by vd.fecha) cg on cg.fecha = g.dia::date
  order by g.dia;
$$;

-- Redefinimos la vista de 30 dias para que use la funcion (ahora incluye fecha)
drop view if exists v_serie_30d cascade;
create or replace view v_serie_30d as
  select * from serie_periodo(current_date - 29, current_date);

-- Comprobar:
-- select * from serie_periodo(date '2026-07-01', date '2026-07-23');
