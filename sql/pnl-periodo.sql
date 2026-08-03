-- =====================================================================
-- P&L (cuenta de resultados) para CUALQUIER periodo — mismo criterio que
-- v_pnl_mes pero con rango de fechas. Permite que el "P&L del periodo" del
-- dashboard siga el selector de fechas. Ejecuta en Supabase -> SQL Editor.
--
-- IMPORTANTE: devuelve iva_rep (IVA repercutido = ventas − neto). El
-- dashboard lo RESTA en la cascada del P&L, así el "Beneficio neto" es real
-- (ventas SIN IVA − costes SIN IVA). Si esta columna faltara o fuera 0, el
-- beneficio saldría inflado (casi bruto). Debe coincidir con sql/margen-real.sql.
-- =====================================================================

drop function if exists pnl_periodo(date, date);
create function pnl_periodo(desde date, hasta date)
returns table(ventas numeric, prod numeric, fba numeric, com numeric,
              ppc numeric, dev numeric, alm numeric, iva numeric,
              otros numeric, iva_sop numeric, iva_rep numeric)
language sql stable as $$
  with rango as (select desde ini, hasta fin),
  v  as (select coalesce(sum(ventas),0) ventas from v_ventas_dia, rango where fecha >= ini and fecha <= fin),
  vn as (select coalesce(sum(neto),0)   neto   from v_neto_dia,   rango where fecha >= ini and fecha <= fin),
  cogs as (
    select coalesce(sum(vd.uds*cp.coste),0) prod
    from v_ventas_dia vd join rango on vd.fecha >= ini and vd.fecha <= fin
    left join costes_producto cp on cp.sku = vd.sku
  ),
  s as (
    select
      coalesce(-sum(importe) filter (where cubo='fba'),0)/1.21   fba,
      coalesce(-sum(importe) filter (where cubo='com'),0)/1.21   com,
      coalesce(-sum(importe) filter (where cubo='alm'),0)/1.21   alm,
      coalesce(-sum(importe) filter (where cubo='dev'),0)/1.21   dev,
      coalesce(sum(importe)  filter (where cubo='otros'),0)/1.21 otros
    from v_settle_clasificado, rango where fecha >= ini and fecha <= fin
  ),
  p as (
    select greatest(
      coalesce((select sum(gasto) from ppc_dia, rango r2 where ppc_dia.fecha >= r2.ini and ppc_dia.fecha <= r2.fin),0),
      coalesce((select -sum(importe)/1.21 from v_settle_clasificado sc, rango r3 where sc.cubo='ppc' and sc.fecha >= r3.ini and sc.fecha <= r3.fin),0)
    ) ppc
  )
  select round(v.ventas,2), round(cogs.prod,2), round(s.fba,2), round(s.com,2),
         round(p.ppc,2), round(s.dev,2), round(s.alm,2), 0::numeric, round(s.otros,2),
         round((s.fba + s.com + s.alm + s.dev + abs(s.otros)) * 0.21, 2),
         round(v.ventas - vn.neto, 2)                     -- IVA repercutido (a Hacienda)
  from v, vn, cogs, s, p;
$$;

-- Comprobar (la 11ª columna, iva_rep, debe ser > 0 si has vendido):
-- select * from pnl_periodo(date '2026-06-01', date '2026-06-30');
