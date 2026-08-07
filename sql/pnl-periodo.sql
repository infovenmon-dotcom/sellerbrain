-- =====================================================================
-- P&L (cuenta de resultados) para CUALQUIER periodo.
--
-- CLAVE: FBA y comisión salen de v_tarifa_dia = TARIFA REAL POR UNIDAD
-- (del settlement, €/ud) aplicada a las unidades vendidas; si un SKU aún no
-- tiene liquidación, estima 15%+15%. Esto RESUELVE EL DESFASE de liquidación:
-- antes se sumaban los settlements que caían en el periodo, y como Amazon
-- liquida cada ~2 semanas, un mes reciente (o el año entero sin backfill) salía
-- con FBA/comisión casi a cero → beneficio inflado. Ahora el P&L usa el MISMO
-- criterio que las tarjetas (v_periodos) → CUADRAN entre sí.
--
-- Devuelve iva_rep (IVA repercutido) que el dashboard resta en la cascada, para
-- que el beneficio sea real (ventas SIN IVA − costes SIN IVA).
-- Ejecuta en Supabase → SQL Editor. Requiere v_tarifa_dia (sql/margen-real.sql).
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
  -- FBA + comisión con TARIFA REAL POR UNIDAD (v_tarifa_dia). Mismo criterio que
  -- las tarjetas → el P&L cuadra con ellas y no se infla en periodos recientes.
  t as (
    select coalesce(sum(fba),0) fba, coalesce(sum(com),0) com
    from v_tarifa_dia, rango where fecha >= ini and fecha <= fin
  ),
  -- Almacenaje, devoluciones y otros: del settlement (menos sensibles al desfase).
  s as (
    select
      coalesce(-sum(importe) filter (where cubo='alm'),0)/1.21   alm,
      coalesce(-sum(importe) filter (where cubo='dev'),0)/1.21   dev,
      coalesce(sum(importe)  filter (where cubo='otros'),0)/1.21 otros
    from v_settle_clasificado, rango where fecha >= ini and fecha <= fin
  ),
  -- PPC = gasto DIARIO real (ppc_dia). NO el recibo del settlement: Amazon factura
  -- la publicidad 1 vez al mes y la cobra de golpe el día de facturación, lo que
  -- inflaba el periodo. Ver docs/PPC-facturacion.md.
  p as (
    select coalesce((select sum(gasto) from ppc_dia, rango r2 where ppc_dia.fecha >= r2.ini and ppc_dia.fecha <= r2.fin),0) ppc
  )
  select round(v.ventas,2), round(cogs.prod,2), round(t.fba,2), round(t.com,2),
         round(p.ppc,2), round(s.dev,2), round(s.alm,2), 0::numeric, round(s.otros,2),
         round((t.fba + t.com + s.alm + s.dev + abs(s.otros)) * 0.21, 2),  -- IVA soportado
         round(v.ventas - vn.neto, 2)                                       -- IVA repercutido
  from v, vn, cogs, t, s, p;
$$;

-- Comprobar (el margen debe parecerse al de la tarjeta del mismo periodo):
-- select * from pnl_periodo(date_trunc('month',current_date)::date, current_date);
