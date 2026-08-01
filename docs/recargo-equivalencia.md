# Informe: Implicaciones fiscales del Recargo de Equivalencia para vendedores Amazon

> Spec de la FASE siguiente (Motor Fiscal RE). Documento de referencia — NO implementado
> todavía. Guardado en el checkpoint `checkpoint-2026-08-pre-recargo`.

## Resumen ejecutivo
El **régimen de recargo de equivalencia (RE)** es un régimen especial obligatorio de IVA
para comerciantes minoristas (personas físicas o entidades en atribución de rentas) que
venden bienes tal como los adquieren. En la práctica, **quien vende al por menor no
presenta liquidaciones periódicas de IVA por sus ventas**: el IVA y el recargo (p. ej.
21%+5,2%) los cobra el proveedor en las compras. A cambio, el minorista **no deduce el IVA
soportado en sus gastos y compras** (art. 154 LIVA).

Para un vendedor en Amazon, esto significa que **los costes de producto y servicios con IVA
incrementan su coste real**, reduciendo el margen final. Ej.: comprar un artículo a 2,00 €
+21% +5,2% RE cuesta 2,524 € para el autónomo en RE, frente a 2,00 € netos para una empresa
en régimen general (que recupera el IVA soportado).

**Conclusión operativa:** SellerBrain necesita **dos motores fiscales**: régimen general (IVA
deducible) y recargo de equivalencia (IVA no deducible). Cada transacción (venta, compra,
servicio) se clasifica por tipo (bien/servicio, país proveedor/mercado destino) para decidir
si el IVA soportado es deducible, no deducible o de autoliquidación especial (309, 349, OSS).
Así se calcula el **margen económico real** tras el impacto fiscal del IVA.

## 1. Marco legal (Ley 37/1992, AEAT)
- **Sujetos:** RE es **obligatorio** para minoristas persona física / entidad en atribución.
  Minorista = vende bienes muebles sin transformar y >80% de ventas a consumidor final.
  Sociedades mercantiles excluidas. Hay productos excluidos (vehículos, joyas, maquinaria…).
- **Repercusión/recaudación:** art. 154 LIVA — el IVA de ventas se cobra al cliente pero el
  minorista **no presenta liquidación periódica** ni ingresa ese IVA. El proveedor repercute
  IVA **+ recargo** al minorista e ingresa ambos. Tipos: 21%→5,2%, 10%→1,4%, 4%→0,5%
  (0%→0%; especiales 7,5%→1%, 2%→0,26%).
- **Deducciones/obligaciones:** en RE **no se deduce** el IVA soportado. No hay 303 periódico
  por la venta minorista. Excepción: **sí** liquida IVA en adquisiciones intracomunitarias,
  importaciones o inversión del sujeto pasivo → **modelo 309** (y 349 para intracom). Sigue
  sin poder deducir.
- **Normativa:** Ley 37/1992 arts. 148-163; Reglamento IVA RD 1624/92 arts. 59-61.

## 2. Tratamiento fiscal por tipo de operación Amazon
- **Compras de mercancía:**
  - Nacional: factura con IVA+RE. RE paga todo (2,00 +0,42 +0,104 = 2,524 €), no deduce.
  - Intracomunitaria (UE): **autoliquida** IVA+RE (modelo 309) + informa 349. No deduce.
  - Importación (fuera UE): IVA+RE en aduana. No deduce. (Desde jul-2021 todo import >0€ lleva IVA.)
- **Servicios (fees, FBA, Ads, software, asesorías):**
  - Amazon España factura con IVA 21% → RE lo paga y **no deduce** (coste extra).
  - Amazon EU (Lux) sin IVA → **inversión del sujeto pasivo** (309), no deduce.
  - Proveedor UE / fuera UE → inversión (309), no deduce.
  - (Nota práctica: desde ~ago-2024 muchos RE reportan que Amazon España les repercute IVA en
    comisiones/FBA en vez de inversión. El motor debe soportar ambos escenarios.)
- **Ventas:**
  - B2C nacional: cobra IVA (parte del precio) pero **no declara ni ingresa**.
  - UE B2C (OSS): recauda IVA del país destino vía OSS. **El RE no exime del OSS.** El recargo
    grava compras, NO ventas → en OSS no hay "recargo repercutido".
  - B2B UE: entrega intracom exenta (0%) si Amazon la calcula como B2B (raro).
- **Especiales:** dropshipping (RE en la primera entrega), Amazon Retail como proveedor
  (IVA+RE), warehousing (servicio, sin recargo), reembolsos (ajustan tarifas/IVA original).

### Tabla comparativa
| Operación | Régimen General | Autónomo en RE |
|---|---|---|
| Compra nacional mercancía | 21% IVA (deducible) | 21% IVA + 5,2% RE (no deducible) |
| Compra UE (IIC) | Autoliquida 21% (deducible) | Autoliquida 21% + 5,2% RE (no ded.) |
| Importación | IVA 21% (deducible) | IVA 21% + 5,2% RE (no deducible) |
| Venta nacional B2C | Cobra 21% (declara 303) | Cobra 21% (no declara ni paga) |
| Venta UE B2C (OSS) | IVA destino (OSS) | IVA destino (OSS; sin RE) |
| Servicio Amazon España | IVA 21% (deducible) | IVA 21% (no deducible) |
| Servicio Amazon UE | Inversión (303/349) | Inversión (309; no ded.) |
| Publicidad internacional | Inversión (303) | Inversión (309; no ded.) |
| Servicios locales (agencia) | IVA 21% (deducible) | IVA 21% (no deducible) |

## 3. Elegibilidad para RE (validación)
- Persona física o entidad en atribución (sociedades fuera).
- Actividad minorista: bienes sin transformar, >80% ventas a consumidor final.
- Productos admitidos (no en lista de excluidos).
- Alta IAE correspondiente + notificación a proveedores/aduanas.
Si falla algún requisito → **régimen general**. SellerBrain debe hacer este chequeo y asignar
perfil automáticamente.

## 4. Árbol de decisión y ejemplo numérico
Por transacción: **Tipo IVA** (aplicado/invertido), **Recargo** (sí compras/IIC/import; no
ventas), **Deducibilidad** (NO en RE, SÍ en general), **Obligación** (309/349/OSS).

**Ejemplo (venta B2C ES, IVA 21% incl.):** PVP 20,00 € (base 16,528 / IVA 3,472); coste
proveedor 2,00 €; comisión 3,00 €+IVA=3,63 €; FBA+Ads 4,50 €+IVA=5,445 €.
- **RE:** proveedor 2,524 € + servicios 9,075 € → margen = 20,00 − 11,599 = **8,401 €**.
- **General:** proveedor 2,00 € + servicios 7,50 € → margen = 16,528 − 9,50 = **7,028 €**.
- (El RE tiene margen económico menor por el IVA no deducible: ~1,37 €/ud de coste fiscal.)

| Concepto | RE | General |
|---|--:|--:|
| Coste mercancía | 2,524 € | 2,00 € |
| Coste Amazon | 3,630 € | 3,00 € |
| Coste FBA+Ads | 5,445 € | 4,50 € |
| IVA no deducible | 1,575 € | 0 € |
| **Total costes** | **11,599 €** | **9,50 €** |
| Ingreso | 20,000 € | 20,000 € (neto 16,528) |
| Margen | 8,401 € | 7,028 € |

## 5. Casos especiales y riesgos
- **Pan-EU / stock transfer:** trasiego entre países = entrega/adquisición intracom; puede
  exigir registro en otros países (349/309/303 locales). Área de incertidumbre → marcar y
  sugerir asesoría.
- **OSS:** obligatorio pasado el umbral; RE no exime. Recargo no aplica a la venta OSS.
- **Inversión del sujeto pasivo con Amazon:** soportar que Amazon facture con o sin IVA.
- **Facturación Amazon multi-país:** decidir inversión/IVA según país del proveedor (API).
- **Modelos informativos:** RE no presenta 303 periódico, pero sí 349/309 cuando corresponde
  → avisar al usuario.
- **Riesgos de exclusión:** operaciones exentas de RE (art.157) o incumplir requisitos → posible
  cambio a régimen general. Avisar en casos dudosos. Donde la norma no sea clara → "no
  especificado" + recomendar consulta vinculante.

## 6. Recomendaciones técnicas (Motor Fiscal)
1. **Perfil del contribuyente:** forma jurídica, régimen IVA (general/RE), ámbito de ventas
   (país, marketplaces, OSS), logística (FBA/Pan-EU/FBM). Impugnar SL+RE.
2. **Fuente de datos:** SP-API (órdenes, fees, reembolsos) con TransactionType, montos, país,
   IVA, proveedor. Compras de mercancía normalmente entran a mano (fuera de SP-API).
3. **Normalización:** clasificar cada entrada (Venta B2C, Compra bienes, Amazon Fees/Servicios,
   Servicios terceros).
4. **Tabla maestra de operaciones:** combinaciones (tipo + país proveedor + régimen) → IVA
   soportado (S/N), deducción, autoliquidación.
5. **Motor de decisión:** ¿IVA deducible? (solo general + IVA local). ¿Inversión sujeto pasivo?
   (servicio UE/intl B2B → sí, 309). ¿Recargo? (compras/IIC/import de bienes). Banderas 309/349/OSS/303.
6. **Versionado de reglas:** tabla de configuración con "vigencia desde" para cambios de tipos.
7. **Output por transacción (JSON):**
   ```json
   {
     "gross_amount": 3.63,
     "vat_amount": 0.63,
     "vat_recoverable": 0,
     "vat_non_recoverable": 0.63,
     "economic_cost": 3.63,
     "special_obligation": false
   }
   ```
   Este output alimenta el Profit Engine (coste real).

El módulo fiscal debe ser **transversal y automático**: configurado el perfil, procesa cada
transacción y genera alertas (309/OSS) y métricas (coste fiscal RE vs general).

## 7. Encaje con lo YA construido (agosto 2026)
Buena parte de la fontanería necesaria **ya existe** y encaja con este motor:
- **País de salida/destino por pedido** (`envios_fc`) y **régimen fiscal por transacción**
  (informe de IVA / módulo Ventanilla Única) → base para clasificar operaciones y OSS.
- **Settlement con tarifas reales** (comisión/FBA/Ads) → los servicios cuyo IVA sería no
  deducible en RE.
- **Calculadora de margen** (portal.html) ya tiene un modo con "IVA+RE no deducibles (+26,2%)"
  y "tarifas Amazon +21% IVA no deducible (mod. 309)" → punto de partida del motor RE.

**Pendiente antes de implementar:** confirmar con el gestor del usuario el detalle exacto
(qué está facturando Amazon con/sin IVA hoy, umbrales OSS, registros de IVA por país) para no
codificar supuestos incorrectos.

## 8. Fuentes
Ley 37/1992 (arts. 148-163); Reglamento IVA RD 1624/92 (arts. 59-61); guías AEAT del RE;
consultas vinculantes DGT; Seller Central y foros de vendedores. Revisar BOE/AEAT para valores
actualizados; en ambigüedades (p.ej. Pan-EU FBA) → consulta vinculante / asesoría.
