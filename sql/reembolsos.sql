-- =====================================================================
-- REEMBOLSOS FBA — "Amazon te debe". Ejecuta en Supabase → SQL Editor. Idempotente.
--
-- Dos fuentes que alimenta el Worker:
--   · inventario_ajustes: unidades PERDIDAS/DAÑADAS/ENCONTRADAS por SKU (Libro Mayor).
--   · reembolsos: lo que Amazon YA te ha reembolsado (informe GET_FBA_REIMBURSEMENTS_DATA).
-- La vista cruza ambas y deja lo PENDIENTE de reclamar, valorado a TU COSTE
-- (la política 2025 reembolsa sobre coste de fabricación, no sobre precio de venta).
-- =====================================================================

create table if not exists inventario_ajustes (
  sku        text not null,
  pais       text not null,
  fecha      date not null,
  perdido    integer default 0,   -- Lost
  danado     integer default 0,   -- Damaged
  encontrado integer default 0,   -- Found (compensa pérdidas previas)
  primary key (sku, pais, fecha)
);
alter table inventario_ajustes enable row level security;

create table if not exists reembolsos (
  reembolso_id text primary key,
  fecha        date,
  sku          text,
  motivo       text,
  uds          integer default 0,     -- quantity-reimbursed-total
  importe      numeric default 0,     -- amount-total
  moneda       text
);
alter table reembolsos enable row level security;

-- Pendiente de reembolso por SKU: (perdido + dañado − encontrado) − ya reembolsado,
-- valorado a tu coste. Incluye la fecha límite de la ventana de 60 días.
create or replace view v_reembolsos_pendientes as
with aj as (
  select sku,
    sum(perdido)    as perdido,
    sum(danado)     as danado,
    sum(encontrado) as encontrado,
    greatest(sum(perdido) + sum(danado) - sum(encontrado), 0) as uds_reclamables,
    max(fecha)      as ultima_fecha
  from inventario_ajustes
  group by sku
),
re as (
  select sku, sum(uds) as uds_reembolsadas, sum(importe) as importe_reembolsado
  from reembolsos group by sku
),
co as ( select sku, coste from costes_producto )
select
  aj.sku,
  aj.perdido, aj.danado, aj.encontrado,
  aj.uds_reclamables,
  coalesce(re.uds_reembolsadas, 0)                                          as uds_reembolsadas,
  greatest(aj.uds_reclamables - coalesce(re.uds_reembolsadas, 0), 0)        as uds_pendientes,
  co.coste,
  round(greatest(aj.uds_reclamables - coalesce(re.uds_reembolsadas, 0), 0) * coalesce(co.coste, 0), 2) as importe_pendiente,
  aj.ultima_fecha,
  (aj.ultima_fecha + interval '60 days')::date                             as limite_reclamacion
from aj
left join re on re.sku = aj.sku
left join co on co.sku = aj.sku
where greatest(aj.uds_reclamables - coalesce(re.uds_reembolsadas, 0), 0) > 0
order by importe_pendiente desc nulls last;

-- Comprobar:
-- select * from v_reembolsos_pendientes;
-- select * from inventario_ajustes order by fecha desc;
-- select * from reembolsos order by fecha desc;
