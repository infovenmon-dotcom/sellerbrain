-- =====================================================================
-- MARGEN REAL: todo SIN IVA (misma base) + PPC desde Ads API
-- Ejecuta en Supabase -> SQL Editor. Es EL arreglo de los margenes.
--
-- Regla: el margen real se calcula SIN IVA en todo (el IVA repercutido va a
-- Hacienda; el IVA soportado de tarifas/costes es recuperable y se muestra
-- aparte). Antes las VENTAS iban CON IVA y las tarifas SIN IVA -> inconsistente.
--
-- Divisor de IVA por pais: ES 1.21, FR 1.20, IT 1.22, DE 1.19, PT/PL 1.23,
-- NL/BE 1.21, SE 1.25, GB 1.20, IE 1.23, resto 1.21.
-- =====================================================================

-- 1) VENTAS DIARIAS SIN IVA (base de tarjetas, P&L, grafico y serie)
create or replace view v_ventas_dia as
select
  fecha, sku,
  sum(uds) as uds,
  round(sum(ventas / (case pais
    when 'FR' then 1.20 when 'IT' then 1.22 when 'DE' then 1.19
    when 'PT' then 1.23 when 'PL' then 1.23 when 'NL' then 1.21
    when 'BE' then 1.21 when 'SE' then 1.25 when 'GB' then 1.20
    when 'IE' then 1.23 else 1.21 end)), 2) as ventas,
  sum(pedidos) as pedidos
from ventas_sku_pais_dia
group by fecha, sku;

-- 2) VENTAS MENSUALES SIN IVA (grafico de barras Seller Central)
create or replace view v_ventas_mes as
select
  to_char(fecha,'YYYY-MM') as mes,
  coalesce(nullif(pais,''),'?') as pais,
  round(sum(ventas / (case coalesce(nullif(pais,''),'?')
    when 'FR' then 1.20 when 'IT' then 1.22 when 'DE' then 1.19
    when 'PT' then 1.23 when 'PL' then 1.23 when 'NL' then 1.21
    when 'BE' then 1.21 when 'SE' then 1.25 when 'GB' then 1.20
    when 'IE' then 1.23 else 1.21 end)), 2) as ventas,
  sum(uds) as uds
from ventas_sku_pais_dia
where fecha is not null
group by 1, 2
order by 1;

-- 3) P&L DEL MES: ventas ya sin IVA (via v_ventas_dia); PPC desde Ads API (ppc_dia)
create or replace view v_pnl_mes as
with mes as (select date_trunc('month', current_date)::date as ini),
v as (select coalesce(sum(ventas),0) ventas from v_ventas_dia, mes where fecha >= mes.ini),
cogs as (select coalesce(sum(vd.uds*cp.coste),0) prod
         from v_ventas_dia vd join mes on vd.fecha >= mes.ini
         left join costes_producto cp on cp.sku = vd.sku),
s as (select
    coalesce(-sum(importe) filter (where cubo='fba'),0)/1.21   fba,
    coalesce(-sum(importe) filter (where cubo='com'),0)/1.21   com,
    coalesce(-sum(importe) filter (where cubo='alm'),0)/1.21   alm,
    coalesce(-sum(importe) filter (where cubo='dev'),0)/1.21   dev,
    coalesce(sum(importe)  filter (where cubo='otros'),0)/1.21 otros
  from v_settle_clasificado, mes where fecha >= mes.ini),
p as (select coalesce((select sum(gasto) from ppc_dia, mes m2 where ppc_dia.fecha >= m2.ini),0) ppc)
select round(v.ventas,2) ventas, round(cogs.prod,2) prod, round(s.fba,2) fba,
       round(s.com,2) com, round(p.ppc,2) ppc, round(s.dev,2) dev,
       round(s.alm,2) alm, 0::numeric iva, round(s.otros,2) otros,
       round((s.fba + s.com + s.alm + s.dev + abs(s.otros)) * 0.21, 2) as iva_sop
from v, cogs, s, p;

-- 4) P&L POR PERIODO: igual, ventas sin IVA + PPC Ads API
create or replace function pnl_periodo(desde date, hasta date)
returns table(ventas numeric, prod numeric, fba numeric, com numeric,
              ppc numeric, dev numeric, alm numeric, iva numeric,
              otros numeric, iva_sop numeric)
language sql stable as $$
  with rango as (select desde ini, hasta fin),
  v as (select coalesce(sum(ventas),0) ventas from v_ventas_dia, rango where fecha >= ini and fecha <= fin),
  cogs as (select coalesce(sum(vd.uds*cp.coste),0) prod from v_ventas_dia vd join rango on vd.fecha >= ini and vd.fecha <= fin
           left join costes_producto cp on cp.sku = vd.sku),
  s as (select
      coalesce(-sum(importe) filter (where cubo='fba'),0)/1.21   fba,
      coalesce(-sum(importe) filter (where cubo='com'),0)/1.21   com,
      coalesce(-sum(importe) filter (where cubo='alm'),0)/1.21   alm,
      coalesce(-sum(importe) filter (where cubo='dev'),0)/1.21   dev,
      coalesce(sum(importe)  filter (where cubo='otros'),0)/1.21 otros
    from v_settle_clasificado, rango where fecha >= ini and fecha <= fin),
  p as (select coalesce((select sum(gasto) from ppc_dia, rango r2 where ppc_dia.fecha >= r2.ini and ppc_dia.fecha <= r2.fin),0) ppc)
  select round(v.ventas,2), round(cogs.prod,2), round(s.fba,2), round(s.com,2),
         round(p.ppc,2), round(s.dev,2), round(s.alm,2), 0::numeric, round(s.otros,2),
         round((s.fba + s.com + s.alm + s.dev + abs(s.otros)) * 0.21, 2)
  from v, cogs, s, p;
$$;

-- Comprobar (ventas sin IVA deben ser ~20% menos que con IVA):
-- select round(sum(ventas),2) from v_ventas_dia where fecha >= '2026-07-01';
