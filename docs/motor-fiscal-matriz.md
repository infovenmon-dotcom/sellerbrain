# Motor Fiscal · Matriz de reglas (multi-perfil) — cubre TODAS las casuísticas

> Base para el "Motor Fiscal" de SellerBrain. Cubre **régimen general** y **recargo de
> equivalencia (RE)**, y todos los tipos de operación. Anclado en facturas reales de Amazon
> (jun-2026, vendedor establecido en ES). Lo que la norma no deje claro → **"consultar gestor"**,
> nunca un número silenciosamente mal. Pendiente de validar por asesor fiscal.

## 0. Hecho confirmado por las facturas (vendedor establecido en ES)
- **Comisiones de venta y Logística/FBA** → *Amazon EU S.à r.l., Sucursal en España* · **21% IVA ES**.
- **Publicidad (Ads)** → *Amazon Online Spain, S.L.U.* · **VAT 21% SPAIN** (+ "Regulatory Advertising
  Fees" = tasa digital, por jurisdicción).
- **Incluso los marketplaces FR/IT/BE** se facturan con **IVA español** ("servicio recibido en ES").
- ⇒ **NO hay inversión del sujeto pasivo** en los servicios de Amazon para un vendedor ES →
  **NO hay modelo 309** por esas facturas. (El 309 queda solo para compras de mercancía intracom/import.)
- ⚠️ Esto es cierto para vendedor **establecido en ES**. Para un vendedor establecido en otro país,
  o si Amazon cambia a inversión, el motor debe soportar el otro escenario (campo de perfil).

## 1. Perfil fiscal del usuario (lo define UNA vez)
- **Forma jurídica:** persona física / autónomo · Sociedad (SL, SA…). → SL/SA ⇒ **siempre general**.
- **Régimen IVA:** general · recargo de equivalencia. (RE solo válido si persona física + minorista + >80% B2C.)
- **País de establecimiento** (ES por defecto).
- **Países con registro de IVA** + **OSS** (ej.: ES, FR, IT con OSS activo).
- **Tipo de IVA de producto** por defecto (21% / 10% / 4%) — editable por SKU.
- **Escenario de facturación Amazon:** con IVA local (por defecto, confirmado) / inversión.

## 2. Matriz por operación — tratamiento del IVA soportado
| Operación | General (SL/empresa) | Recargo de Equivalencia (autónomo) |
|---|---|---|
| **Comisión / FBA / Ads Amazon** (factura ES 21%) | IVA **deducible** → coste = **base** | IVA **no deducible** → coste = **base+21%**. Sin 309. |
| **Compra mercancía nacional** (proveedor ES) | IVA deducible → coste = base | IVA no deducible **+ recargo** (21%→+5,2%; 10%→+1,4%; 4%→+0,5%) → coste = base+IVA+recargo. Sin 309. |
| **Compra intracom** (proveedor UE, sin IVA) | Autoliquida (deducible, neutro) → coste = base | Autoliquida IVA+recargo vía **309** (no deducible) → coste = base+IVA+recargo. + **349**. |
| **Importación** (fuera UE) | IVA deducible → coste = base (+aranceles) | IVA+recargo no deducible → coste = base+IVA+recargo. |
| **Servicio Amazon en inversión** (si aplicara) | Inversión, deducible (neutro) | Inversión vía **309**, no deducible → coste = base+IVA. |
| **Servicios terceros** (software, agencia) | IVA deducible (ES) / inversión (UE) | No deducible; UE/intl → 309. |

## 3. Matriz por operación — lado del INGRESO (venta)
| Venta | General | Recargo de Equivalencia |
|---|---|---|
| **B2C nacional (ES)** | Repercute 21%, lo **ingresa** (303). Ingreso a efectos de margen = **base (sin IVA)**. | Repercute 21% pero **NO lo declara ni ingresa** → se lo **queda**. Ingreso de margen = **precio (IVA incl.)**. |
| **B2C UE distancia (OSS)** | Repercute IVA destino, lo ingresa vía **OSS**. Ingreso = base. | Repercute IVA destino y lo ingresa vía **OSS** (RE **no exime**). Ingreso = base. **Sin recargo en venta.** |
| **B2B intracom** | Entrega exenta (0%). | Igual (raro vía Amazon). |

> **Clave del RE (y por qué a veces gana y a veces no):** en venta **nacional** el RE **se queda el
> IVA repercutido** (compensa el IVA no deducible de sus costes). Pero en venta **OSS** ese IVA se
> remite al país destino → NO se lo queda. Por eso el motor debe distinguir nacional vs OSS.

## 4. Salida del motor (por línea)
```json
{ "gross_amount": 388.96, "base": 321.45, "vat": 67.51,
  "vat_recoverable": 67.51,      // general: deducible ; RE: 0
  "vat_non_recoverable": 0,      // general: 0 ; RE: 67.51
  "recargo": 0,                  // solo compras de bienes en RE
  "economic_cost": 321.45,       // general: base ; RE: base+vat(+recargo)
  "obligacion": null }           // "309" | "349" | "OSS" | null
```
Alimenta el Profit Engine: **Margen operativo** (sin IVA) vs **Margen real** (con IVA no recuperable) +
**"IVA no recuperable €"** + **avisos** (309/349/OSS con importes).

## 5. Casos que se MARCAN (no se calculan a ciegas)
- **Pan-EU / trasiego de stock entre países** → posible registro de IVA en otro país (349/303 local).
  Marcar "no especificado · consultar gestor".
- Cambio de escenario de facturación Amazon (con IVA ↔ inversión).
- Posible exclusión del RE (transformación de producto, <80% B2C, productos excluidos).

## 6. Fases de implementación
- **Fase 0:** perfil fiscal (1 pantalla, guardado). SL→general automático.
- **Fase 1:** motor "IVA deducible/no deducible" aplicado a Beneficio por producto y P&L (usa el
  IVA real del settlement). Margen operativo vs real. — el 80% del valor.
- **Fase 2:** recargo en compras de mercancía (por tipo de IVA + origen).
- **Fase 3:** avisos de autoliquidación (309/349/OSS con importes) — reusa Ventanilla Única.
- **Fase 4:** comparador "coste fiscal del RE vs general".
