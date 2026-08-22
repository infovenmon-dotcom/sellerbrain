-- =====================================================================
-- AISLAMIENTO MULTICUENTA · FASE 3 (tablas). Ejecuta en Supabase → SQL Editor.
-- Hazlo ANTES de desplegar el worker nuevo.
--
-- 1) Añade la columna `seller` que le faltaba a ppc_asin_campana (con default
--    'venmon' y etiquetando lo ya existente), para que el filtro por cliente
--    funcione también en el panel «Gasto por ASIN».
-- 2) COMPROBACIÓN: cuenta, por tabla, cuántas filas hay, cuántas son de 'venmon'
--    y cuántas se quedaron SIN seller. Antes de activar filtros, TODO debe ser
--    'venmon' y 0 sin_seller (si no, hay que etiquetar).
-- =====================================================================

-- 1) Columna seller en ppc_asin_campana ------------------------------------
alter table ppc_asin_campana add column if not exists seller text not null default 'venmon';
update ppc_asin_campana set seller = 'venmon' where seller is null;
create index if not exists ppc_asin_campana_seller_idx on ppc_asin_campana (seller);

-- 2) COMPROBACIÓN DE ETIQUETADO (solo lee) ---------------------------------
select 'ventas_sku_pais_dia' t, count(*) total, count(*) filter (where seller='venmon') venmon, count(*) filter (where seller is null) sin_seller from ventas_sku_pais_dia
union all select 'pedidos_dia',        count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from pedidos_dia
union all select 'settlement_lineas',  count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from settlement_lineas
union all select 'costes_producto',    count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from costes_producto
union all select 'productos_catalogo', count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from productos_catalogo
union all select 'devoluciones',       count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from devoluciones
union all select 'reembolsos',         count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from reembolsos
union all select 'reembolsos_cliente', count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from reembolsos_cliente
union all select 'inventario',         count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from inventario
union all select 'inventario_pais',    count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from inventario_pais
union all select 'buybox',             count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from buybox
union all select 'fichas',             count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from fichas
union all select 'fichas_actuales',    count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from fichas_actuales
union all select 'listings_pais',      count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from listings_pais
union all select 'resenas_pedidas',    count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from resenas_pedidas
union all select 'busquedas_sqp',      count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from busquedas_sqp
union all select 'ppc_dia',            count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from ppc_dia
union all select 'ppc_campanas',       count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from ppc_campanas
union all select 'ppc_terminos',       count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from ppc_terminos
union all select 'ppc_keywords',       count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from ppc_keywords
union all select 'ppc_placement',      count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from ppc_placement
union all select 'ppc_presupuestos',   count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from ppc_presupuestos
union all select 'ppc_product_ads',    count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from ppc_product_ads
union all select 'ppc_producto',       count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from ppc_producto
union all select 'ppc_asin_campana',   count(*), count(*) filter (where seller='venmon'), count(*) filter (where seller is null) from ppc_asin_campana
order by 1;

-- Cómo leerlo:
-- · Si en TODAS las filas total = venmon y sin_seller = 0 → PERFECTO, despliega el worker.
-- · Si alguna tiene sin_seller > 0 → etiqueta esa tabla antes de desplegar, p.ej.:
--     update ppc_dia set seller='venmon' where seller is null;
--   (repite con la tabla que lo necesite).
