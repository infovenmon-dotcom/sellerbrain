# PPC · por qué un día aparece un "pico" grande (facturación mensual)

**Amazon factura la publicidad UNA vez al mes** y descuenta el importe del saldo
del vendedor **de golpe el día de facturación** (normalmente el **día 2**), cubriendo
el ciclo del 2 al 2 del mes anterior.

Por eso, en el gráfico diario / en el settlement, puede verse un **pico de PPC ese
día** que **NO es el gasto de ese día**, sino el **recibo del ciclo entero**.

## Ejemplo real (2 de julio de 2026)

Cargo del 2-jul en el settlement ≈ visto en el dashboard: ~690€.
Lo que realmente facturó Amazon Ads ese día (facturas del vendedor):

| Factura | País | Periodo | Total |
|---|---|---|---|
| 849745MUPA26 | ES | 02-06 → 02-07 | 373,15€ (IVA incl.) |
| 894498MTPA26 | IT | 02-06 → 02-07 | 13,83€ (IVA 0% reverse charge) |
| **Total 2-jul** | | | **386,98€** |

(La factura 740307MTPA26 —IT, 5,63€— tiene fecha 02-06-2026, es de **junio**.)

## Nota de modelo (pendiente de decisión)

El dashboard saca hoy el PPC mezclando dos fuentes: el **gasto diario** de la Ads
API (`ppc_dia`) y el **recibo** del settlement (cargo mensual). Como el recibo se
concentra en la fecha de cobro, distorsiona el día 2 y puede inflar el total del mes.

Arreglo propuesto (no aplicado, a la espera de OK): usar **solo `ppc_dia`** (gasto
diario real) en P&L, tarjetas y gráfico, y **backfill** del histórico diario que
falte. Así el PPC se reparte por días y cuadra con lo realmente gastado en el mes
natural (las facturas van del 2 al 2, no cuadran con el mes natural por sí solas).
