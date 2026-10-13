/*
 * Excel export of ITO results with ExcelJS (loaded as global `ExcelJS`).
 * One sheet per ITO with a title block, styled header, number formats,
 * autofilter, frozen header and a totals row with live SUM formulas.
 * Optionally an element sheet per ITO with the underlying elements.
 */
(function (root) {
  'use strict';

  const INK = 'FF1F2A30';
  const HEAD = 'FF22474D';
  const BAND = 'FFF1F5F4';
  const TOTAL = 'FFE3ECEA';

  function sheetName(name, used) {
    let base = String(name || 'ITO').replace(/[\[\]:*?/\\]/g, ' ').trim().substring(0, 31) || 'ITO';
    let n = base;
    let i = 2;
    while (used.has(n.toLowerCase())) {
      const suffix = ' (' + i++ + ')';
      n = base.substring(0, 31 - suffix.length) + suffix;
    }
    used.add(n.toLowerCase());
    return n;
  }

  function numFmt(decimals) {
    const d = Math.max(0, Math.min(6, decimals == null ? 2 : +decimals));
    return d === 0 ? '#,##0' : '#,##0.' + '0'.repeat(d);
  }

  function cellValue(v, col) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      return Math.round(v * 1e9) / 1e9; // strip floating point noise, keep precision

    }
    if (typeof v === 'boolean') return v ? 'Waar' : 'Onwaar';
    return String(v);
  }

  function colLetter(n) {
    let s = '';
    n++;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  // results: [{ito, columns, rows, totals, elementCount}] ; opts: {model, includeElements, elementFields}
  async function buildWorkbook(results, opts) {
    if (typeof ExcelJS === 'undefined') throw new Error('De Excel-bibliotheek (ExcelJS) is niet geladen. Controleer de internetverbinding en probeer opnieuw.');
    opts = opts || {};
    const model = opts.model;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'IFC ITO';
    wb.created = new Date();
    const used = new Set();
    const stamp = new Date().toLocaleString('nl-NL');

    // ----- overview sheet
    const ov = wb.addWorksheet(sheetName('Overzicht', used), { views: [{ showGridLines: false }] });
    ov.columns = [{ width: 38 }, { width: 18 }, { width: 18 }, { width: 50 }];
    ov.addRow(['Hoeveelhedenoverzicht (ITO)']).font = { bold: true, size: 16, color: { argb: INK } };
    ov.addRow([]);
    const meta = [
      ['Model', model ? model.fileName : ''],
      ['Project', model && model.project ? model.project.name : ''],
      ['IFC-schema', model ? model.schema : ''],
      ['Aantal elementen in model', model ? model.elements.length : ''],
      ['Geëxporteerd op', stamp]
    ];
    meta.forEach((m) => {
      const r = ov.addRow(m);
      r.getCell(1).font = { color: { argb: 'FF5B6B70' } };
    });
    ov.addRow([]);
    const hr = ov.addRow(['ITO', 'Regels', 'Elementen', 'Werkblad']);
    styleHeader(hr, 4);

    const sheets = [];
    results.forEach((res) => {
      const name = sheetName(res.ito.name, used);
      sheets.push(name);
      const r = ov.addRow([res.ito.name, res.rows.length, res.elementCount, name]);
      r.getCell(4).value = { text: name, hyperlink: "#'" + name.replace(/'/g, "''") + "'!A1" };
      r.getCell(4).font = { color: { argb: 'FF1F6F78' }, underline: true };
    });

    // ----- one sheet per ITO
    results.forEach((res, ri) => {
      const cols = res.columns;
      const ws = wb.addWorksheet(sheets[ri], { views: [{ state: 'frozen', ySplit: 4 }] });
      ws.addRow([res.ito.name]).font = { bold: true, size: 14, color: { argb: INK } };
      const scope = [];
      if (res.scopeLabel) scope.push(res.scopeLabel);
      scope.push(res.ito.mode === 'detail' ? 'Per element' : 'Gegroepeerd');
      scope.push(res.elementCount + ' elementen');
      ws.addRow([scope.join('  ·  ') + '  ·  ' + (model ? model.fileName : '') + '  ·  ' + stamp]).font = { size: 9, color: { argb: 'FF5B6B70' } };
      ws.addRow([]);
      const header = ws.addRow(cols.map((c) => c.label));
      styleHeader(header, cols.length);

      const numeric = cols.map((c, i) => res.rows.some((r) => typeof r.values[i] === 'number') || ['sum', 'count', 'avg', 'min', 'max'].includes(c.agg));
      const firstData = ws.rowCount + 1;
      res.rows.forEach((row, k) => {
        const r = ws.addRow(row.values.map((v, i) => cellValue(v, cols[i])));
        cols.forEach((c, i) => {
          const cell = r.getCell(i + 1);
          if (typeof cell.value === 'number') cell.numFmt = c.agg === 'count' ? '#,##0' : numFmt(c.decimals);
        });
        if (k % 2 === 1) {
          for (let i = 1; i <= cols.length; i++) r.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
        }
      });
      const lastData = ws.rowCount;

      // totals row with formulas
      if (res.rows.length) {
        const tr = ws.addRow(cols.map(() => null));
        let labelPlaced = false;
        cols.forEach((c, i) => {
          const cell = tr.getCell(i + 1);
          if (res.totals[i] != null && numeric[i]) {
            const L = colLetter(i);
            cell.value = { formula: 'SUBTOTAL(9,' + L + firstData + ':' + L + lastData + ')', result: res.totals[i] };
            cell.numFmt = c.agg === 'count' ? '#,##0' : numFmt(c.decimals);
          } else if (!labelPlaced && i === 0) {
            cell.value = 'Totaal';
            labelPlaced = true;
          }
          cell.font = { bold: true };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL } };
          cell.border = { top: { style: 'thin', color: { argb: 'FF22474D' } } };
        });
        if (!labelPlaced && res.totals[0] == null) tr.getCell(1).value = 'Totaal';
      }

      ws.autoFilter = { from: { row: header.number, column: 1 }, to: { row: Math.max(header.number, lastData), column: cols.length } };
      cols.forEach((c, i) => {
        let w = String(c.label || '').length;
        res.rows.slice(0, 500).forEach((r) => {
          const v = r.values[i];
          const s = typeof v === 'number' ? v.toFixed(c.decimals || 0) : (v == null ? '' : String(v));
          w = Math.max(w, s.length);
        });
        ws.getColumn(i + 1).width = Math.min(60, Math.max(10, w + 3));
        if (numeric[i]) ws.getColumn(i + 1).alignment = { horizontal: 'right' };
      });
      header.eachCell((cell) => { cell.alignment = { vertical: 'middle', wrapText: true }; });

      // optional element sheet
      if (opts.includeElements && model) {
        const ename = sheetName(res.ito.name + ' – elementen', used);
        const es = wb.addWorksheet(ename, { views: [{ state: 'frozen', ySplit: 1 }] });
        const fields = opts.elementFields || ['Attribuut::GlobalId', 'Attribuut::Entiteit', 'Attribuut::Naam', 'Type::Typenaam', 'Locatie::Bouwlaag', 'Materiaal::Materiaal'];
        const groupCols = cols.filter((c) => c.agg === 'group' || res.ito.mode === 'detail');
        const heads = ['Regel'].concat(fields.map((f) => f.split('::')[1]));
        const h = es.addRow(heads);
        styleHeader(h, heads.length);
        res.rows.forEach((row, k) => {
          const rowLabel = groupCols.length ? groupCols.map((c) => { const i = cols.indexOf(c); const v = row.values[i]; return v == null ? '' : String(v); }).filter(Boolean).join(' / ') : String(k + 1);
          row.ids.forEach((id) => {
            const el = model.byId.get(id);
            if (!el) return;
            es.addRow([rowLabel].concat(fields.map((f) => cellValue(el.props[f]))));
          });
        });
        es.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, es.rowCount), column: heads.length } };
        heads.forEach((hh, i) => { es.getColumn(i + 1).width = i === 0 ? 34 : Math.max(12, Math.min(40, hh.length + 8)); });
      }
    });

    return wb;
  }

  function styleHeader(row, n) {
    for (let i = 1; i <= n; i++) {
      const c = row.getCell(i);
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD } };
      c.border = { bottom: { style: 'thin', color: { argb: INK } } };
    }
    row.height = 22;
  }

  async function exportToBlob(results, opts) {
    const wb = await buildWorkbook(results, opts);
    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  root.ITO = root.ITO || {};
  root.ITO.excel = { buildWorkbook, exportToBlob, sheetName };
})(typeof window !== 'undefined' ? window : globalThis);
