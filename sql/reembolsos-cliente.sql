-- =====================================================================
-- REEMBOLSOS A CLIENTES — dinero devuelto al cliente por CUALQUIER motivo
-- (entrega fallida, A-to-z, garantía, precio…), NO solo devoluciones físicas.
-- El informe de "Devoluciones de clientes" (FBA Customer Returns) solo recoge
-- lo que el cliente devuelve físicamente al almacén; muchos reembolsos (p.ej.
-- "Livraison impossible / no se pudo entregar") no aparecen ahí. Aquí los juntamos.
--
-- Dos fuentes, que el worker fusiona (dedup por pedido+sku, preferimos Finanzas):
--   1) v_reembolsos_cliente  → del settlement (ya lo descargamos; va por quincenas).
--   2) reembolsos_cliente    → de la Finances API (casi al momento; requiere rol
--                              "Finance and Accounting" en la app de Amazon).
-- Ejecuta en Supabase. Idempotente.
-- =====================================================================

-- 1) Vista desde el settlement (sin ingesta nueva: usa settlement_lineas).
--    importe_cliente = lo que se le devolvió al cliente (líneas ItemPrice, en positivo).
--    impacto_neto    = efecto neto en tu cuenta (incluye comisión devuelta, tasa de reembolso…).
drop view if exists v_reembolsos_cliente;
create view v_reembolsos_cliente as
select
  pedido,
  sku,
  max(pais)                                                                as pais,
  min(fecha)                                                               as fecha,
  round(-sum(case when concepto ilike 'ItemPrice/%' then importe else 0 end), 2) as importe_cliente,
  round(sum(importe), 2)                                                    as impacto_neto,
  count(*)                                                                  as lineas
from settlement_lineas
where tipo ilike 'Refund%'
  and coalesce(sku,'') <> ''
  and fecha >= (current_date - 120)
group by pedido, sku
having -sum(case when concepto ilike 'ItemPrice/%' then importe else 0 end) <> 0;

-- 2) Tabla que rellena la Finances API (near-real-time). fuente='finanzas'.
create table if not exists reembolsos_cliente (
  seller          text not null default 'venmon',
  pedido          text not null,
  sku             text not null,
  asin            text,
  fecha           timestamptz,
  importe_cliente numeric,               -- lo devuelto al cliente (principal+envío), en positivo
  moneda          text default 'EUR',
  uds             int,
  motivo          text,                  -- Finanzas no siempre trae motivo textual
  fuente          text default 'finanzas',
  primary key (seller, pedido, sku)
);
alter table reembolsos_cliente enable row level security;

-- Comprobar (settlement):
-- select fecha, pedido, sku, importe_cliente, impacto_neto from v_reembolsos_cliente order by fecha desc limit 50;
-- Comprobar (finanzas):
-- select fecha, pedido, sku, importe_cliente, motivo from reembolsos_cliente order by fecha desc limit 50;
