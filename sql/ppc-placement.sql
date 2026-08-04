-- =====================================================================
-- PLACEMENT: rendimiento del PPC por UBICACIÓN del anuncio (Top of Search /
-- páginas de producto / resto). Lo rellena el Worker con el informe de Ads
-- (spCampaigns groupBy campaignPlacement), ventana de 30 días. Ejecuta en Supabase.
-- =====================================================================

create table if not exists ppc_placement (
  seller       text not null default 'venmon',
  pais         text not null,
  campania     text not null,
  placement    text not null,          -- p.ej. "Top of Search on-Amazon"
  gasto        numeric,
  clics        int,
  impresiones  int,
  ventas_ppc   numeric,
  pedidos_ppc  int,
  desde        date,
  hasta        date,
  fecha        timestamptz,            -- momento de la última ingesta
  primary key (seller, pais, campania, placement)
);

alter table ppc_placement enable row level security;

-- Comprobar:
-- select placement, round(sum(gasto),2) gasto, round(sum(ventas_ppc),2) ventas,
--        case when sum(ventas_ppc)>0 then round(sum(gasto)/sum(ventas_ppc)*100,1) end acos
-- from ppc_placement group by placement order by gasto desc;
