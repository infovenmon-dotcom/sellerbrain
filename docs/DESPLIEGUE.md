# Despliegue — qué subir para dejar todo lo nuevo activo

> Checklist vivo. Marca con [x] lo que vayas dejando hecho.
> La carpeta `sql/` tiene 40+ archivos, pero la mayoría son **históricos** (ya
> ejecutados en su día). Aquí solo están los **de las últimas mejoras**, que son
> los que faltan por aplicar.

Worker actual: **v98-listings-diag** (verifícalo en `…workers.dev/version`).

---

## 1) Supabase → SQL Editor (ejecutar una vez cada uno)

- [ ] `sql/buybox.sql` — **recrea** la tabla Buy Box por SKU (antes era por ASIN)
- [ ] `sql/fugas-destino.sql` — sobrecoste por país de **destino**
- [ ] `sql/reembolsos-cliente.sql` — reembolsos a clientes (settlement + Finanzas)
- [ ] `sql/resenas.sql` — registro de solicitudes de reseña
- [ ] `sql/listings-pais.sql` — **estado de listings por país** ← el de "no sale nada"
- [ ] `sql/listings-acciones.sql` — registro de cerrar/reabrir listing
- [ ] `sql/ppc-keywords-perf.sql` — rendimiento por keyword (para la puja sugerida)
- [ ] `sql/ppc-keywords-dia.sql` — **rendimiento DIARIO por keyword + filtro por fechas** (CVR/CTR/CPC/ACoS/ROAS por rango). Tras correrlo, re-carga keywords (🔌 Conexión → «Cargar keywords») para poblar el histórico.

## 2) Cloudflare → pegar el Worker

- [ ] Subir `worker/worker.js` (versión **v98-listings-diag**)

## 3) Cloudflare → Variables and Secrets

| Variable | Valor | Para qué | ¿Obligatoria? |
|---|---|---|---|
| `ADMIN_EMAILS` | tu email de login | Que tu login sea admin (no pegar la clave cada vez) | Recomendada |
| `SPAPI_SELLER_ID` | tu **Merchant Token** | **Listings por país** | Sí (para esa vista) |
| `ADS_WRITE` | `1` | Pausar campañas, cambiar puja/presupuesto | Ya puesta |
| `LISTINGS_WRITE` | `1` | Cerrar/reabrir listings por país | Solo si lo usas |
| `RESENAS_AUTO` | `1` | Pedir reseñas automáticamente cada día | Opcional |

**Merchant Token:** Seller Central → Ajustes (⚙️) → **Información de la cuenta** →
*Merchant Token* (tipo `A2XXXXXXXX`).

## 4) Netlify

- Nada. El frontend se despliega solo desde `main` al hacer push.

---

## Después de subir: encender cada cosa

- **Buy Box** → se refresca **sola cada hora**. No hay que tocar nada.
- **Listings por país** → 🔌 Conexión → «🌍 Comprobar listings». Ahora te hace una
  **prueba en directo** y te dice la causa exacta si algo falla
  (falta token / falta rol / falta la tabla / catálogo vacío).
- **Reembolsos** → se ven solos (settlement). Para tiempo real, rol "Finance and
  Accounting" + botón «💸 Cargar reembolsos».
- **Reseñas** → automático si `RESENAS_AUTO=1`; si no, botón «⭐ Pedir reseñas».
- **Puja sugerida** → 🔌 Conexión → «Cargar keywords» (trae el rendimiento).

## Roles de Amazon que pueden faltar (la app avisa sin romper)

- **Listings** (gestión de inventario) → para «Listings por país».
- **Finance and Accounting** → para reembolsos en tiempo real.
- **Solicitations / Orders** → para pedir reseñas.

Si un botón dice "falta el rol", se solicita en Seller Central → tu app. Ojo: pedir
un rol nuevo puede **reabrir la revisión** de la app (como con el rol fiscal).
