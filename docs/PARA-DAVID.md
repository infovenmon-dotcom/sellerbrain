# SellerBrain — Qué hay nuevo (para revisar in situ)

> David: entras con la clave de VENMON y ves todo. Aquí tienes, por bloques,
> **qué es cada cosa, dónde está y cómo comprobar que funciona**.
> Fecha: agosto 2026 · Worker en producción: **v102-generador-ia**.

---

## A) Lo que pediste en tu informe — estado

| # | Petición de tu informe | Estado | Dónde verlo |
|---|---|---|---|
| 1 | Bug de NaN en cálculos | ✅ Hecho | Beneficio por producto (sin NaN) |
| 2 | Umbrales de confianza en veredictos + techo de puja | ✅ Hecho | PPC · Calculadora |
| 3 | Botón copiar término | ✅ Hecho | PPC · términos |
| 4 | Renombrar a "Salud del producto" | ✅ Hecho | Dashboard · Salud del producto |
| 5 | Tooltip de sincronización | ✅ Hecho | Cabecera "Datos: hace X min" |
| 6 | Alertas por email (stock/ACoS/sobrecostes/pérdidas/hijacking) | ✅ Hecho | Ajustes · Alertas (opt-in) |
| 7 | Tooltips de supuestos del P&L | ✅ Hecho | Beneficio por producto |
| 8 | Dependencia de PPC | ✅ Hecho | Dashboard |
| 9 | Buy Box | ✅ Hecho + corregido | Buy Box y competencia |
| 10 | Objetivo de campaña + match type | ✅ Hecho | PPC · En vivo |
| 11 | Placement (Top of Search) | ✅ Hecho | PPC · Rendimiento por ubicación |
| 12 | Keywords y pujas | ✅ Hecho + puja sugerida | PPC · Keywords |
| 13 | Ejecución de campañas (pausar/puja/presupuesto/negativizar) | ✅ Hecho | PPC · En vivo (botones ⏸/▶/💰) |
| 14 | Vigilancia de ficha (hijacking) | ✅ Hecho | Vigilancia de ficha |
| — | SQP (Search Query Performance) | ⚠️ Beta | PPC · SQP (Amazon a veces lo rechaza) |
| — | Sponsored Brands / Display | ⏳ Pendiente | (solo Sponsored Products por ahora) |
| — | Comparativa interanual | ⏳ Pendiente | — |

---

## B) Novedades grandes de este ciclo (posteriores al informe)

### 1. Buy Box — corregido de raíz
- **Antes:** todo salía "perdida" y el "competidor" era tu propio precio.
- **Ahora:** consulta por SKU (getListingOffers), detecta bien tu oferta; si eres único vendedor, la Buy Box es tuya y no hay competidor. **Se refresca solo cada hora.**
- **Verificar:** menú *Buy Box y competencia* → casi todo en verde "✓ tuya / único vendedor".

### 2. Detector de sobrecostes — por país de DESTINO
- Además del total, desglosa **a qué mercado le pierdes dinero** sirviéndolo desde fuera (dónde te falta stock local).
- **Verificar:** *Detector sobrecobros FBA* → resumen "Sobrecoste por país de destino".

### 3. Reembolsos a clientes (no solo devoluciones físicas)
- Capta el dinero devuelto por entrega fallida, A-to-z, garantía… (el email que te manda Amazon). Fuente settlement + Finanzas.
- El nº de pedido **enlaza a Seller Central**.
- **Verificar:** *Devoluciones* → sección "Reembolsos a clientes".

### 4. Pedir reseña (permitido)
- Usa la **Solicitations API oficial** de Amazon (una por pedido, en ventana, sin tocar datos del cliente). Puede ser automático.
- **Verificar:** menú *Pedir reseña* → estado y registro.

### 5. Listings por país (activar/desactivar)
- Matriz producto × país (ES/FR/IT/DE/BE): **activo / inactivo (con el motivo real de Amazon, en español) / no publicado.**
- Como admin, pulsas una celda para **cerrar o reabrir** un listing en un país.
- **Verificar:** menú *Listings por país*.

### 6. Puja sugerida por keyword
- Trae el rendimiento por palabra (clics/gasto/ventas) y sugiere la puja para tu **ACoS objetivo**; botón "usar" para aplicarla.
- **Verificar:** *PPC · Keywords* → columnas ACoS/Sugerida + botón "usar".

### 7. Auditor Rufus & COSMO
- Audita un listing contra los **15 atributos COSMO**, los **penalizadores de Rufus** (claims sin dato, stuffing, rating <4) y los 7 tipos de pregunta.
- **Verificar:** menú *Rufus · Atributos IA* → pega un listing → puntúa 0/15.

### 8. Generador de listing IA (COSMO + Rufus) — NUEVO
- Rellenas datos + pegas keywords de **Helium 10** (lee volumen/competencia y las coloca por peso) → la IA compone título ×3, 5 viñetas con roles, descripción, briefs de 7 imágenes, A+/Q&A y backend, cubriendo los 15 atributos COSMO.
- **Verificar:** menú *Generador de listing IA*. (Requiere la clave de IA puesta en el Worker.)

### 9. Comodidad y seguridad
- **Tu login ya es admin** (no hay que pegar la clave maestra en cada acción).
- **Buy Box, listings y reembolsos** se refrescan solos (cron horario/diario).

---

## C) Cómo comprobar que "todo funciona" en 5 minutos

1. **Cabecera** → "Datos: hace X min" y "Conectado" en verde.
2. **Buy Box y competencia** → productos en verde (no todo "perdida").
3. **Listings por país** → matriz con ✓/✕ y, en "Inactivos y su motivo", textos **en español**.
4. **PPC · Keywords** → columnas de rendimiento + puja **Sugerida** + botón "usar".
5. **Detector sobrecobros** → "Sobrecoste por país de destino".
6. **Devoluciones** → "Reembolsos a clientes" con enlaces a los pedidos.
7. **Rufus · Atributos IA** → pega un listing y mira el 0/15 COSMO.
8. **Generador de listing IA** → genera uno de prueba.

Si algo sale vacío, casi siempre es que falta **ejecutar un SQL** o **una variable en Cloudflare** (ver `docs/DESPLIEGUE.md`).

---

## D) Lo que queda pendiente (para hablarlo)

- **SQP**: Amazon a veces devuelve "FATAL" en ese informe; está en beta. Falta validar con una respuesta real.
- **Sponsored Brands / Display**: hoy solo Sponsored Products. Ampliable.
- **Comparativa interanual**: pendiente.
- **Generador IA**: pulir prompts por categoría y añadir "regenerar hasta 15/15 COSMO".
- **Roles de Amazon** (pueden faltar y la app avisa sin romper): Listings, Finanzas (reembolsos al momento), Solicitations (reseñas). Ojo: pedir un rol nuevo puede reabrir la revisión de la app.
