-- =====================================================================
-- KEYWORDS · RENDIMIENTO DIARIO. Una fila por keyword y DÍA (informe spKeywords
-- con timeUnit=DAILY). Permite FILTRAR POR RANGO DE FECHAS en el panel: de este
-- día a este día → gasto, clics, impresiones, ventas, pedidos… y de ahí CVR,
-- CTR, CPC, ACoS y ROAS para trabajar conversión y rentabilidad por palabra.
-- Lo rellena el Worker (ingestaKeywords). Ejecuta en Supabase. Idempotente.
-- =====================================================================

create table if not exists ppc_keywords_dia (
  seller       text not null default 'venmon',
  pais         text not null,
  keyword_id   text not null,
  campania_id  text,
  fecha        date not null,
  clics        int,
  impresiones  int,
  gasto        numeric,
  ventas       numeric,          -- ventas atribuidas (sales14d)
  pedidos      int,              -- conversiones (purchases14d) → CVR = pedidos/clics
  primary key (seller, pais, keyword_id, fecha)
);
alter table ppc_keywords_dia enable row level security;

create index if not exists ppc_keywords_dia_fecha_idx on ppc_keywords_dia (fecha);

-- Agregación por RANGO: suma el rendimiento de cada keyword entre dos fechas y
-- adjunta nombre de keyword/campaña y su puja/estado actuales. Una keyword que
-- vive en varias campañas tiene un keyword_id distinto en cada una → sale una
-- fila por campaña automáticamente. Se llama por GET (PostgREST) con ?desde&hasta.
create or replace function kw_perf_rango(desde date, hasta date)
returns table (
  keyword_id       text,
  pais             text,
  campania_id      text,
  keyword          text,
  concordancia     text,
  puja             numeric,
  estado           text,
  campania         text,
  campania_estado  text,
  clics            bigint,
  impresiones      bigint,
  gasto            numeric,
  ventas           numeric,
  pedidos          bigint,
  dias             bigint
) language sql stable as $$
  select d.keyword_id,
         d.pais,
         d.campania_id,
         k.keyword,
         k.concordancia,
         k.puja,
         k.estado,
         p.campania,
         p.estado as campania_estado,
         sum(coalesce(d.clics,0))::bigint       as clics,
         sum(coalesce(d.impresiones,0))::bigint as impresiones,
         round(sum(coalesce(d.gasto,0))::numeric, 2)  as gasto,
         round(sum(coalesce(d.ventas,0))::numeric, 2) as ventas,
         sum(coalesce(d.pedidos,0))::bigint     as pedidos,
         count(distinct d.fecha)::bigint        as dias
    from ppc_keywords_dia d
    left join ppc_keywords k
           on k.keyword_id = d.keyword_id and k.seller = d.seller
    left join ppc_presupuestos p
           on p.campania_id = d.campania_id and p.pais = d.pais
   where d.fecha >= desde and d.fecha <= hasta
   group by d.keyword_id, d.pais, d.campania_id,
            k.keyword, k.concordancia, k.puja, k.estado, p.campania, p.estado;
$$;

-- Comprobar:
-- select * from kw_perf_rango(current_date - 30, current_date) order by gasto desc limit 30;
