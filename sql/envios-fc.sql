-- =====================================================================
-- ENVÍOS · país de SALIDA por pedido/SKU (del Informe de Envíos Gestionados).
-- Base para atribuir el sobrecoste logístico al país correcto: cruzando el
-- order-id de las líneas del settlement con el país de salida de aquí.
-- Ejecuta en Supabase → SQL Editor ANTES de pegar el worker que ingesta envios.
-- Idempotente.
-- =====================================================================
create table if not exists envios_fc (
  seller        text not null default 'venmon',
  order_id      text not null,
  sku           text not null,
  fc            text,          -- fulfillment-center-id (p.ej. MAD7, MXP6, ORY4)
  pais_salida   text,          -- país del FC (ES/IT/FR…) o '?' si no mapeado
  pais_destino  text,          -- ship-country
  uds           numeric default 0,
  fecha         date,
  primary key (seller, order_id, sku)
);
create index if not exists idx_envios_fc_salida  on envios_fc (pais_salida);
create index if not exists idx_envios_fc_order    on envios_fc (order_id);
create index if not exists idx_envios_fc_fecha    on envios_fc (fecha);

-- Comprobar tras la primera ingesta:
-- select pais_salida, count(*) from envios_fc group by 1 order by 2 desc;
-- select fc, count(*) from envios_fc where pais_salida='?' group by 1 order by 2 desc;  -- FCs por mapear
