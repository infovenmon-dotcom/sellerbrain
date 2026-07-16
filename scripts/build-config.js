/* ============================================================
   Genera config.js en el deploy de Netlify a partir de
   variables de entorno. Las credenciales NO viven en el repo
   (config.js está en .gitignore); se inyectan en Netlify:
   Site settings → Environment variables.
   Variables esperadas: SB_SHEET_ID, SB_API_KEY, SB_SHEET_NAME
   ============================================================ */
const fs = require('fs');
const cfg = {
  SHEET_ID:   process.env.SB_SHEET_ID   || '',
  API_KEY:    process.env.SB_API_KEY    || '',
  SHEET_NAME: process.env.SB_SHEET_NAME || 'hoja 1'
};
fs.writeFileSync('config.js', 'window.SB_CFG=' + JSON.stringify(cfg) + ';\n');
console.log('[build-config] config.js generado — SHEET_ID:' +
  (cfg.SHEET_ID ? 'OK' : 'VACÍO') + '  API_KEY:' + (cfg.API_KEY ? 'OK' : 'VACÍO'));
