-- =====================================================================
-- KEYWORDS · RENDIMIENTO POR RANGO DE FECHAS. Sale del informe de TÉRMINOS DE
-- BÚSQUEDA (ppc_terminos), que YA se recoge a diario por keyword+campaña y SÍ
-- trae datos (clics, gasto, ventas, pedidos). Con esto el panel filtra "de este
-- día a este día" y calcula CVR/CTR/CPC/ACoS/ROAS por palabra — sin depender del
-- informe spKeywords, que en esta cuenta venía vacío. Ejecuta en Supabase.
-- (La tabla ppc_keywords_dia queda como histórico opcional; el panel usa la RPC.)
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
  ventas       numeric,
  pedidos      int,
  primary key (seller, pais, keyword_id, fecha)
);
alter table ppc_keywords_dia enable row level security;
create index if not exists ppc_keywords_dia_fecha_idx on ppc_keywords_dia (fecha);

-- Rendimiento por keyword agregando ppc_terminos entre dos fechas. Base = términos
-- (una fila por keyword+campaña con datos reales); se le pega la puja/estado/id
-- actuales desde ppc_keywords para poder ajustar la puja. Una keyword en varias
-- campañas → sale una fila por campaña (el nombre viene de términos). Llamada por
-- GET (PostgREST) con ?desde&hasta.
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
  with agg as (
    select t.pais,
           t.campania,
           t.keyword,
           upper(coalesce(t.tipo,'')) as tipo,
           sum(coalesce(t.clics,0))::bigint         as clics,
           sum(coalesce(t.impresiones,0))::bigint   as impresiones,
           round(sum(coalesce(t.gasto,0))::numeric, 2)      as gasto,
           round(sum(coalesce(t.ventas_ppc,0))::numeric, 2) as ventas,
           sum(coalesce(t.pedidos_ppc,0))::bigint   as pedidos,
           count(distinct t.fecha)::bigint          as dias
      from ppc_terminos t
     where t.fecha >= desde and t.fecha <= hasta
       and coalesce(t.keyword,'') <> ''
     group by t.pais, t.campania, t.keyword, upper(coalesce(t.tipo,''))
  )
  select
    k.keyword_id,
    a.pais,
    coalesce(p.campania_id, k.campania_id)   as campania_id,
    a.keyword,
    coalesce(k.concordancia, a.tipo)         as concordancia,
    k.puja,
    coalesce(k.estado, 'enabled')            as estado,
    a.campania,
    coalesce(p.estado, 'ENABLED')            as campania_estado,
    a.clics, a.impresiones, a.gasto, a.ventas, a.pedidos, a.dias
  from agg a
  left join ppc_presupuestos p
         on p.campania = a.campania and p.pais = a.pais
  left join lateral (
    select kk.keyword_id, kk.puja, kk.estado, kk.concordancia, kk.campania_id
      from ppc_keywords kk
     where kk.keyword = a.keyword
       and upper(coalesce(kk.concordancia,'')) = a.tipo
       and kk.pais = a.pais
       and (p.campania_id is null or kk.campania_id = p.campania_id)
     order by kk.fecha desc nulls last
     limit 1
  ) k on true;
$$;

-- Comprobar:
-- select * from kw_perf_rango(current_date - 30, current_date) order by gasto desc limit 30;
-- Si sale vacío: comprueba que ppc_terminos tiene filas → select count(*) from ppc_terminos;
