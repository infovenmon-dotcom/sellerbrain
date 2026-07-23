-- =====================================================================
-- Limpieza de nombres con acentos rotos (mojibake)
-- Ejecuta en Supabase → SQL Editor (incógnito).
--
-- Qué arregla: nombres tipo "Desodorante SÃ³lido AlgodÃ³n" → "Desodorante
-- Sólido Algodón". Es UTF-8 que en su día se leyó como Latin-1 (filas viejas;
-- la ingesta actual ya guarda bien). Solo toca las filas con el patrón roto
-- ('Ã' o 'Â'); las correctas NO se tocan. Es idempotente (re-ejecutar es seguro).
-- =====================================================================

-- 1) Ver cuántas filas están rotas (antes de tocar nada)
select count(*) as filas_rotas
from productos_catalogo
where nombre like '%Ã%' or nombre like '%Â%';

-- 2) Reparar (reinterpreta los bytes: Latin-1 → UTF-8)
update productos_catalogo
set nombre = convert_from(convert_to(nombre, 'LATIN1'), 'UTF8')
where nombre like '%Ã%' or nombre like '%Â%';

-- 3) Comprobar que ya no quedan rotas (debe dar 0)
-- select count(*) from productos_catalogo where nombre like '%Ã%' or nombre like '%Â%';

-- NOTA: si el paso 2 diera un error de codificación en alguna fila suelta
-- (algún carácter raro fuera de Latin-1), no pasa nada: no cambia nada y me
-- lo dices para afinar esa fila en concreto.
