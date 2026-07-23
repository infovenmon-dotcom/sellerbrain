-- =====================================================================
-- Limpieza de nombres con acentos rotos (mojibake) - metodo chr() infalible
-- Ejecuta en Supabase -> SQL Editor. Todo en codigos numericos: ASCII puro,
-- preciso y sin errores de codificacion. Cubre ES/FR/DE. Idempotente.
--   chr(195)=A~ (marcador C3),  chr(194)=A^ (marcador C2),  chr(226)=a^ (E2)
-- =====================================================================

-- ---- Minusculas (C3 xx) ----
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(161), chr(225)); -- a
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(169), chr(233)); -- e
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(173), chr(237)); -- i
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(179), chr(243)); -- o
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(186), chr(250)); -- u
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(177), chr(241)); -- n~
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(188), chr(252)); -- u..
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(164), chr(228)); -- a..
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(182), chr(246)); -- o..
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(171), chr(235)); -- e..
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(175), chr(239)); -- i..
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(160), chr(224)); -- a`
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(168), chr(232)); -- e`
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(167), chr(231)); -- c,
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(170), chr(234)); -- e^
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(162), chr(226)); -- a^
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(174), chr(238)); -- i^
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(180), chr(244)); -- o^
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(185), chr(249)); -- u`
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(187), chr(251)); -- u^
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(159), chr(223)); -- ss (mal decodificado como U+0178, pero cubrimos 159 por si acaso)
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(376), chr(223)); -- ss (C3 9F -> U+0178)

-- ---- Mayusculas (C3 xx, segundo byte cae en zona de puntuacion CP1252) ----
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(129),  chr(193)); -- A' (81)
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(8240), chr(201)); -- E' (89 -> por-mil)
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(141),  chr(205)); -- I' (8D)
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(8220), chr(211)); -- O' (93 -> comilla)
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(353),  chr(218)); -- U' (9A -> s caron)
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(8216), chr(209)); -- N~ may (91)
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(8211), chr(214)); -- O.. (96 -> guion)
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(339),  chr(220)); -- U.. may (9C -> oe)
update productos_catalogo set nombre = replace(nombre, chr(195)||chr(8222), chr(196)); -- A.. may (84)

-- ---- Simbolos (C2 xx) ----
update productos_catalogo set nombre = replace(nombre, chr(194)||chr(186), chr(186)); -- o (masc)
update productos_catalogo set nombre = replace(nombre, chr(194)||chr(170), chr(170)); -- a (fem)
update productos_catalogo set nombre = replace(nombre, chr(194)||chr(183), chr(183)); -- punto medio
update productos_catalogo set nombre = replace(nombre, chr(194)||chr(174), chr(174)); -- (R)
update productos_catalogo set nombre = replace(nombre, chr(194)||chr(176), chr(176)); -- grados
update productos_catalogo set nombre = replace(nombre, chr(194)||chr(160), ' ');       -- espacio duro

-- ---- Puntuacion tipografica (E2 80 xx) ----
update productos_catalogo set nombre = replace(nombre, chr(226)||chr(8364)||chr(8220), chr(8211)); -- guion largo
update productos_catalogo set nombre = replace(nombre, chr(226)||chr(8364)||chr(8221), chr(8212)); -- raya
update productos_catalogo set nombre = replace(nombre, chr(226)||chr(8364)||chr(8482), chr(8217)); -- comilla der
update productos_catalogo set nombre = replace(nombre, chr(226)||chr(8364)||chr(8216), chr(8216)); -- comilla izq
update productos_catalogo set nombre = replace(nombre, chr(226)||chr(8364)||chr(339),  chr(8220)); -- comilla dobles izq
update productos_catalogo set nombre = replace(nombre, chr(226)||chr(8364)||chr(157),  chr(8221)); -- comilla dobles der
update productos_catalogo set nombre = replace(nombre, chr(226)||chr(8364)||chr(166),  chr(8230)); -- puntos suspensivos

-- Comprobar (idealmente 0)
select count(*) as filas_rotas_restantes
from productos_catalogo
where strpos(nombre, chr(195)) > 0 or strpos(nombre, chr(194)) > 0
   or strpos(nombre, chr(226)||chr(8364)) > 0;
