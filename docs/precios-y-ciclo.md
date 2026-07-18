# Precios y ciclo de vida — SellerBrain

> Documento de referencia para el modelo de negocio, la configuración de Stripe y el
> reparto de porcentajes con David. Última decisión: julio 2026.

## Resumen del ciclo de vida del cliente

1. **Beta (captación)** — paga **20€ una sola vez** y obtiene **3 meses** de acceso completo.
   Sin renovación automática. Solo **50 plazas**.
2. **Mes 4 (conversión)** — se le envía un correo *"¿quieres seguir con la herramienta?"*.
   Si acepta, pasa a suscripción de fundador.
3. **Fundador (recurrente)** — **20€/mes o 200€/año**, precio **bloqueado para siempre**
   por haber sido de los primeros. El pago anual lleva descuento proporcional
   (200€/año ≈ 16,67€/mes).
4. **Cohortes futuras** — a medida que crece la base y el producto, el precio base para
   clientes NUEVOS sube: ~25€/mes al llegar a ~200 usuarios, ~29€/mes a ~300, etc.
   Los fundadores **nunca** se ven afectados (grandfathering).

## Estructura en Stripe (3 productos separados = cuentas limpias con David)

| Producto | Tipo | Precio(s) | Notas |
|---|---|---|---|
| **A. Founders Beta** | Pago único | 20€ | Link limitado a **50 pagos**. Sin suscripción. Da 3 meses. |
| **B. Suscripción Founders** | Recurrente | 20€/mes · 200€/año | El link que se envía en el mes 4. Precio bloqueado para siempre. |
| **C. Cohortes futuras** | Recurrente | 25€/mes, 29€/mes… | Precios NUEVOS para clientes NUEVOS. No tocar los de A/B. |

### Grandfathering (precio para siempre)
En Stripe, al crear precios nuevos (producto C) las suscripciones existentes **no cambian**:
siguen con su precio original de forma automática. Solo hay que crear *precios nuevos* para
*clientes nuevos*; a los antiguos no se les toca nunca.

### El correo del mes 4
La Beta (A) es pago único **sin** suscripción, así que **no se cobra nada solo**. El paso a
suscripción es **opt-in**: se controla enviando el link del producto B por correo (email tool
o GHL), no con automatización de Stripe.

## Reparto con David
- Cada producto separado permite filtrar en **Stripe → Informes → ingresos por producto** y
  obtener el bruto limpio sobre el que aplicar el %.
- Anotar el % en los **metadatos** del producto (p. ej. `reparto_david = X%`) como recordatorio.
- Si en el futuro se quiere pago automático a David de su parte → **Stripe Connect**
  (más complejo); para reparto manual por %, con el informe por producto sobra.
- **IVA:** activar **Stripe Tax** para que el importe se desglose con IVA y el reparto se
  calcule sobre el neto real.

## Dónde vive esto en la web
- Botones de compra (CTA "Quiero ser fundador") en `landing.html` y `portal.html` → apuntan
  al **link del producto A (Beta 20€)**.
- Copy de precios: beta **20€ · 3 meses · 50 plazas**; tras la beta **20€/mes** (fundador).
- ⚠️ Pendiente: sustituir el link de Stripe antiguo por el nuevo del producto A cuando exista.
