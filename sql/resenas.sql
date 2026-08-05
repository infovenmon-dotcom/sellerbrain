-- =====================================================================
-- PEDIR RESEÑA (permitido por Amazon) — registro de solicitudes.
-- Usa la Solicitations API oficial de Amazon: envía SU solicitud estándar de
-- reseña + valoración (la misma que el botón "Solicitar una reseña" de Seller
-- Central). Una por pedido, dentro de la ventana que fija Amazon (≈4-30 días tras
-- la entrega). NO toca datos del cliente ni manda correos por tu cuenta.
-- Esta tabla solo guarda QUÉ pedidos ya hemos solicitado y con qué resultado,
-- para no repetir. Ejecuta en Supabase. Idempotente.
-- =====================================================================

create table if not exists resenas_pedidas (
  seller          text not null default 'venmon',
  pedido          text not null,
  fecha_pedido    timestamptz,
  fecha_solicitud timestamptz,          -- cuándo pedimos la reseña
  estado          text,                 -- 'enviada' | 'ya_enviada' | 'pendiente' | 'error'
  detalle         text,                 -- respuesta de Amazon (motivo si no elegible)
  primary key (seller, pedido)
);
alter table resenas_pedidas enable row level security;

-- Comprobar:
-- select estado, count(*) from resenas_pedidas group by estado;
-- select fecha_solicitud, pedido, estado, detalle from resenas_pedidas order by fecha_solicitud desc limit 50;
