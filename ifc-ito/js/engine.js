/*
 * Rule engine: filters, classifications and ITO (Information Take-Off)
 * computation. Pure functions on the parsed model and a configuration object,
 * so it can be tested in Node without a browser.
 *
 * Field keys have the form "Group::Name", e.g. "Qto_WallBaseQuantities::NetVolume",
 * "Pset_WallCommon::IsExternal", "Attribuut::Entiteit" or "Classificatie::NL-SfB".
 * User classifications add "ITO-classificatie::<scheme>" (code) and
 * "ITO-classificatie::<scheme> omschrijving" (name).
 */
(function (root) {
  'use strict';

  const SEP = '::';

  // ---------------------------------------------------------------------------
  // Values
  // ---------------------------------------------------------------------------
  function getValue(el, field) {
    if (!field) return null;
    const v = el.props[field];
    return v === undefined ? null : v;
  }

  function isEmpty(v) { return v == null || v === ''; }

  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') {
      const s = v.trim().replace(',', '.');
      if (/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return parseFloat(s);
    }
    return NaN;
  }

  function toText(v) {
    if (v == null) return '';
    if (v === true) return 'Waar';
    if (v === false) return 'Onwaar';
    return String(v);
  }

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------
  const OPERATORS = [
    { id: 'eq', label: 'is gelijk aan', needsValue: true },
    { id: 'ne', label: 'is niet gelijk aan', needsValue: true },
    { id: 'contains', label: 'bevat', needsValue: true },
    { id: 'ncontains', label: 'bevat niet', needsValue: true },
    { id: 'starts', label: 'begint met', needsValue: true },
    { id: 'in', label: 'is één van (a; b; c)', needsValue: true },
    { id: 'gt', label: '>', needsValue: true },
    { id: 'gte', label: '≥', needsValue: true },
    { id: 'lt', label: '<', needsValue: true },
    { id: 'lte', label: '≤', needsValue: true },
    { id: 'regex', label: 'regex', needsValue: true },
    { id: 'exists', label: 'heeft waarde', needsValue: false },
    { id: 'nexists', label: 'heeft geen waarde', needsValue: false },
    { id: 'filter', label: 'voldoet aan filter', needsValue: true, special: true },
    { id: 'nfilter', label: 'voldoet niet aan filter', needsValue: true, special: true }
  ];

  // Wildcards: * = any sequence, ? = one character. Case-insensitive.
  const wildcardCache = new Map();
  function wildcard(pattern) {
    let re = wildcardCache.get(pattern);
    if (!re) {
      re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      wildcardCache.set(pattern, re);
    }
    return re;
  }

  function equalsValue(v, expected) {
    const exp = String(expected == null ? '' : expected).trim();
    if (typeof v === 'boolean') {
      const e = exp.toLowerCase();
      const truthy = ['true', 'waar', 'ja', 'yes', '1', 't'].includes(e);
      const falsy = ['false', 'onwaar', 'nee', 'no', '0', 'f'].includes(e);
      return v ? truthy : falsy;
    }
    if (typeof v === 'number') {
      const n = toNumber(exp);
      if (!isNaN(n)) return Math.abs(v - n) <= 1e-9 * Math.max(1, Math.abs(n));
    }
    const s = toText(v);
    if (exp.indexOf('*') !== -1 || exp.indexOf('?') !== -1) return wildcard(exp).test(s);
    return s.toLowerCase() === exp.toLowerCase();
  }

  function compileRegex(src) {
    try { return new RegExp(src, 'i'); } catch (e) { return null; }
  }

  function evalCondition(el, cond, ctx, depth) {
    const op = cond.op || 'eq';
    if (op === 'filter' || op === 'nfilter') {
      const f = ctx.filtersById.get(cond.value);
      if (!f || depth > 8) return op === 'nfilter';
      const r = evalRule(el, f, ctx, depth + 1);
      return op === 'filter' ? r : !r;
    }
    const v = getValue(el, cond.field);
    switch (op) {
      case 'exists': return !isEmpty(v);
      case 'nexists': return isEmpty(v);
      case 'eq': return !isEmpty(v) && equalsValue(v, cond.value);
      case 'ne': return isEmpty(v) || !equalsValue(v, cond.value);
      case 'contains': return !isEmpty(v) && toText(v).toLowerCase().indexOf(String(cond.value || '').toLowerCase()) !== -1;
      case 'ncontains': return isEmpty(v) || toText(v).toLowerCase().indexOf(String(cond.value || '').toLowerCase()) === -1;
      case 'starts': return !isEmpty(v) && toText(v).toLowerCase().startsWith(String(cond.value || '').toLowerCase());
      case 'in': {
        if (isEmpty(v)) return false;
        return String(cond.value || '').split(/[;|\n]/).map((s) => s.trim()).filter(Boolean).some((x) => equalsValue(v, x));
      }
      case 'gt': case 'gte': case 'lt': case 'lte': {
        const a = toNumber(v); const b = toNumber(cond.value);
        if (isNaN(a) || isNaN(b)) return false;
        return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
      }
      case 'regex': {
        if (isEmpty(v)) return false;
        const re = compileRegex(cond.value || '');
        return re ? re.test(toText(v)) : false;
      }
      default: return false;
    }
  }

  // A rule is {logic: 'and'|'or', conditions: [...]}. An empty rule matches all.
  function evalRule(el, rule, ctx, depth) {
    const conds = (rule && rule.conditions) || [];
    const active = conds.filter((c) => c && (c.op === 'filter' || c.op === 'nfilter' || c.field));
    if (!active.length) return true;
    if (rule.logic === 'or') return active.some((c) => evalCondition(el, c, ctx, depth || 0));
    return active.every((c) => evalCondition(el, c, ctx, depth || 0));
  }

  function makeContext(config) {
    return { filtersById: new Map((config.filters || []).map((f) => [f.id, f])) };
  }

  function applyFilter(elements, filter, config) {
    const ctx = makeContext(config);
    return elements.filter((el) => evalRule(el, filter, ctx, 0));
  }

  // ---------------------------------------------------------------------------
  // Classification
  // ---------------------------------------------------------------------------
  // Each scheme: {id, name, classes: [{id, code, name, color, rule}], overrides: {globalId: classId}}
  // Classes are evaluated top to bottom; the first match wins. Manual overrides
  // (stored by GlobalId so they survive a model update) always win.
  function classifyAll(elements, config) {
    const ctx = makeContext(config);
    const result = {}; // schemeId -> Map(elementId -> classId)
    (config.classifications || []).forEach((scheme) => {
      const map = new Map();
      const byId = new Map(scheme.classes.map((c) => [c.id, c]));
      const fieldCode = 'ITO-classificatie' + SEP + scheme.name;
      const fieldName = fieldCode + ' omschrijving';
      elements.forEach((el) => {
        let cls = null;
        let manual = false;
        const ov = scheme.overrides && scheme.overrides[el.globalId];
        if (ov && byId.has(ov)) { cls = byId.get(ov); manual = true; }
        if (!cls) cls = scheme.classes.find((c) => hasRule(c.rule) && evalRule(el, c.rule, ctx, 0)) || null;
        if (cls) {
          map.set(el.id, cls.id);
          el.props[fieldCode] = cls.code;
          el.props[fieldName] = cls.name;
          el.props[fieldCode + ' (handmatig)'] = manual;
        } else {
          delete el.props[fieldCode];
          delete el.props[fieldName];
          delete el.props[fieldCode + ' (handmatig)'];
        }
      });
      result[scheme.id] = map;
    });
    return result;
  }

  function hasRule(rule) {
    return !!(rule && rule.conditions && rule.conditions.some((c) => c && (c.field || c.op === 'filter' || c.op === 'nfilter')));
  }

  // Creates classes from the distinct values of a field (e.g. Typenaam).
  function classesFromField(elements, field) {
    const values = new Map();
    elements.forEach((el) => {
      const v = getValue(el, field);
      if (isEmpty(v)) return;
      const k = toText(v);
      values.set(k, (values.get(k) || 0) + 1);
    });
    return Array.from(values.keys()).sort(naturalCompare).map((v, i) => ({
      id: uid('c'),
      code: v,
      name: v,
      color: PALETTE[i % PALETTE.length],
      rule: { logic: 'and', conditions: [{ field, op: 'eq', value: v.replace(/[*?]/g, '?') }] }
    }));
  }

  const PALETTE = ['#2f7f86', '#d07a2d', '#6b5fb5', '#3f8f4f', '#c0485f', '#4a78c2', '#a5862b', '#8a4f9e',
    '#2d9c9a', '#b8603a', '#5d7d2f', '#c45c9c', '#3c5f8f', '#9a7b4f', '#4f9e7a', '#a34b4b'];

  // ---------------------------------------------------------------------------
  // Formulas for computed ITO columns
  // ---------------------------------------------------------------------------
  // Grammar: expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)* ;
  // factor := ('-' factor) | number | {Column label} | [Group::Field] | func(args) | '(' expr ')'
  function compileFormula(src) {
    const tokens = [];
    const re = /\s*(?:(\d+(?:[.,]\d+)?(?:e[-+]?\d+)?)|(\{[^}]*\})|(\[[^\]]*\])|([A-Za-z_][A-Za-z0-9_]*)|(\S))/gy;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (m[0].trim() === '') break;
      if (m[1]) tokens.push({ t: 'num', v: parseFloat(m[1].replace(',', '.')) });
      else if (m[2]) tokens.push({ t: 'col', v: m[2].slice(1, -1).trim() });
      else if (m[3]) tokens.push({ t: 'field', v: m[3].slice(1, -1).trim() });
      else if (m[4]) tokens.push({ t: 'id', v: m[4].toLowerCase() });
      else tokens.push({ t: 'op', v: m[5] });
    }
    let p = 0;
    const peek = () => tokens[p];
    const eat = (v) => { const tk = tokens[p]; if (!tk || tk.v !== v) throw new Error('Verwacht "' + v + '"'); p++; };
    const FUNCS = {
      round: (a, b) => { const f = Math.pow(10, b || 0); return Math.round(a * f) / f; },
      ceil: (a, b) => { const f = Math.pow(10, b || 0); return Math.ceil(a * f) / f; },
      floor: (a, b) => { const f = Math.pow(10, b || 0); return Math.floor(a * f) / f; },
      abs: Math.abs, min: Math.min, max: Math.max, sqrt: Math.sqrt,
      if: (c, a, b) => (c ? a : b)
    };
    function expr() {
      let left = term();
      while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
        const op = tokens[p++].v; const l = left; const r = term();
        left = op === '+' ? (g) => l(g) + r(g) : (g) => l(g) - r(g);
      }
      return left;
    }
    function term() {
      let left = factor();
      while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/' || peek().v === '>' || peek().v === '<')) {
        const op = tokens[p++].v; const l = left; const r = factor();
        if (op === '*') left = (g) => l(g) * r(g);
        else if (op === '/') left = (g) => { const d = r(g); return d === 0 ? NaN : l(g) / d; };
        else if (op === '>') left = (g) => (l(g) > r(g) ? 1 : 0);
        else left = (g) => (l(g) < r(g) ? 1 : 0);
      }
      return left;
    }
    function factor() {
      const tk = tokens[p++];
      if (!tk) throw new Error('Formule onvolledig');
      if (tk.t === 'num') return () => tk.v;
      if (tk.t === 'col') return (g) => num(g.col(tk.v));
      if (tk.t === 'field') return (g) => num(g.field(tk.v));
      if (tk.t === 'op' && tk.v === '-') { const f = factor(); return (g) => -f(g); }
      if (tk.t === 'op' && tk.v === '(') { const e = expr(); eat(')'); return e; }
      if (tk.t === 'id') {
        const fn = FUNCS[tk.v];
        if (!fn) throw new Error('Onbekende functie "' + tk.v + '"');
        eat('(');
        const args = [];
        if (!(peek() && peek().v === ')')) {
          args.push(expr());
          while (peek() && (peek().v === ';' || peek().v === ',')) { p++; args.push(expr()); }
        }
        eat(')');
        return (g) => fn.apply(null, args.map((a) => a(g)));
      }
      throw new Error('Onverwacht teken "' + tk.v + '"');
    }
    function num(v) { const n = toNumber(v); return isNaN(n) ? 0 : n; }
    const fn = expr();
    if (p < tokens.length) throw new Error('Onverwacht teken "' + tokens[p].v + '"');
    return fn;
  }

  // ---------------------------------------------------------------------------
  // ITO computation
  // ---------------------------------------------------------------------------
  const AGGREGATES = [
    { id: 'group', label: 'Groeperen' },
    { id: 'sum', label: 'Som' },
    { id: 'count', label: 'Aantal' },
    { id: 'avg', label: 'Gemiddelde' },
    { id: 'min', label: 'Minimum' },
    { id: 'max', label: 'Maximum' },
    { id: 'list', label: 'Unieke waarden' },
    { id: 'first', label: 'Eerste waarde' }
  ];

  // ITO: {id, name, scope: {filterId, schemeId, onlyClassified}, mode: 'group'|'detail',
  //       columns: [{id, label, source: 'field'|'formula', field, formula, agg, decimals, factor, unit}],
  //       sort: {col, dir}}
  function computeIto(model, ito, config, classResult) {
    const ctx = makeContext(config);
    let els = model.elements;
    const scope = ito.scope || {};
    if (scope.filterId) {
      const f = ctx.filtersById.get(scope.filterId);
      if (f) els = els.filter((el) => evalRule(el, f, ctx, 0));
    }
    if (scope.schemeId && scope.onlyClassified && classResult && classResult[scope.schemeId]) {
      const map = classResult[scope.schemeId];
      els = els.filter((el) => map.has(el.id));
    }

    const cols = ito.columns || [];
    const errors = {};
    const compiled = cols.map((c) => {
      if (c.source !== 'formula') return null;
      try { return compileFormula(c.formula || '0'); } catch (e) { errors[c.id] = e.message; return () => NaN; }
    });
    const byLabel = new Map(cols.map((c, i) => [(c.label || '').toLowerCase(), i]));

    // per element values
    const rawRows = els.map((el) => {
      const vals = new Array(cols.length);
      const evaluating = new Set();
      function colValue(i) {
        if (vals[i] !== undefined) return vals[i];
        const c = cols[i];
        let v;
        if (c.source === 'formula') {
          if (evaluating.has(i)) return NaN;
          evaluating.add(i);
          v = compiled[i]({
            col: (label) => { const j = byLabel.get(label.toLowerCase()); return j == null ? null : colValue(j); },
            field: (f) => getValue(el, f)
          });
          evaluating.delete(i);
        } else if (c.agg === 'count' && !c.field) {
          v = 1;
        } else {
          v = getValue(el, c.field);
        }
        if (typeof v === 'number' && c.factor && c.factor !== 1) v = v * c.factor;
        vals[i] = v;
        return v;
      }
      for (let i = 0; i < cols.length; i++) colValue(i);
      return { el, vals };
    });

    let rows;
    if (ito.mode === 'detail') {
      rows = rawRows.map((r) => ({ values: r.vals, ids: [r.el.id] }));
    } else {
      const groupIdx = cols.map((c, i) => (c.agg === 'group' ? i : -1)).filter((i) => i >= 0);
      const groups = new Map();
      rawRows.forEach((r) => {
        const key = groupIdx.map((i) => toText(r.vals[i])).join('\u0001');
        let g = groups.get(key);
        if (!g) { g = { rows: [] }; groups.set(key, g); }
        g.rows.push(r);
      });
      rows = Array.from(groups.values()).map((g) => ({
        values: cols.map((c, i) => aggregate(c.agg, g.rows.map((r) => r.vals[i]))),
        ids: g.rows.map((r) => r.el.id)
      }));
    }

    // sort: explicit sort column, otherwise by group columns in order
    const sort = ito.sort && ito.sort.col != null ? ito.sort : null;
    const sortCols = sort ? [cols.findIndex((c) => c.id === sort.col)] : cols.map((c, i) => (c.agg === 'group' || ito.mode === 'detail' ? i : -1)).filter((i) => i >= 0);
    const dir = sort && sort.dir === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      for (const i of sortCols) {
        if (i < 0) continue;
        const r = compareValues(a.values[i], b.values[i]);
        if (r) return r * dir;
      }
      return 0;
    });

    // totals
    const totals = cols.map((c, i) => {
      if (ito.mode === 'detail') {
        if (c.agg === 'sum' || c.agg === 'count') return aggregate(c.agg === 'count' ? 'count' : 'sum', rows.map((r) => r.values[i]));
        return null;
      }
      if (c.agg === 'sum') return aggregate('sum', rows.map((r) => r.values[i]));
      if (c.agg === 'count') return aggregate('sum', rows.map((r) => r.values[i]));
      return null;
    });

    return { ito, columns: cols, rows, totals, elementCount: els.length, errors };
  }

  function aggregate(agg, values) {
    switch (agg) {
      case 'sum': {
        let s = 0; let any = false;
        values.forEach((v) => { const n = toNumber(v); if (!isNaN(n)) { s += n; any = true; } });
        return any ? s : null;
      }
      case 'count': return values.length;
      case 'avg': {
        const ns = values.map(toNumber).filter((n) => !isNaN(n));
        return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
      }
      case 'min': { const ns = values.map(toNumber).filter((n) => !isNaN(n)); return ns.length ? Math.min.apply(null, ns) : null; }
      case 'max': { const ns = values.map(toNumber).filter((n) => !isNaN(n)); return ns.length ? Math.max.apply(null, ns) : null; }
      case 'list': return Array.from(new Set(values.filter((v) => !isEmpty(v)).map(toText))).sort(naturalCompare).join(', ');
      case 'group':
      case 'first':
      default: return values.find((v) => !isEmpty(v)) ?? null;
    }
  }

  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), 'nl', { numeric: true, sensitivity: 'base' });
  }

  function compareValues(a, b) {
    if (isEmpty(a) && isEmpty(b)) return 0;
    if (isEmpty(a)) return 1;
    if (isEmpty(b)) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return naturalCompare(toText(a), toText(b));
  }

  // ---------------------------------------------------------------------------
  // Field catalogue
  // ---------------------------------------------------------------------------
  const GROUP_ORDER = ['Attribuut', 'Locatie', 'Type', 'Materiaal', 'Classificatie', 'ITO-classificatie', 'Geometrie (berekend)'];
  function fieldCatalog(elements) {
    const fields = new Map(); // key -> {key, group, name, count, numeric, values:Set}
    elements.forEach((el) => {
      Object.keys(el.props).forEach((k) => {
        const v = el.props[k];
        let f = fields.get(k);
        if (!f) {
          const i = k.indexOf(SEP);
          f = { key: k, group: k.substring(0, i), name: k.substring(i + SEP.length), count: 0, numeric: 0, values: new Set() };
          fields.set(k, f);
        }
        if (isEmpty(v)) return;
        f.count++;
        if (typeof v === 'number') f.numeric++;
        if (f.values.size < 400) f.values.add(toText(v));
      });
    });
    const groupRank = (g) => {
      const i = GROUP_ORDER.indexOf(g);
      if (i >= 0) return i;
      if (/^Qto_|BaseQuantities/i.test(g)) return 20;
      if (/^Pset_/i.test(g)) return 30;
      return 40;
    };
    return Array.from(fields.values())
      .filter((f) => f.count > 0 || f.group === 'Attribuut')
      .sort((a, b) => groupRank(a.group) - groupRank(b.group) || naturalCompare(a.group, b.group) || naturalCompare(a.name, b.name));
  }

  // ---------------------------------------------------------------------------
  // Default configuration (Dutch practice: NL-SfB, bestek-like groupings)
  // ---------------------------------------------------------------------------
  let uidCounter = 0;
  function uid(prefix) {
    uidCounter++;
    return (prefix || 'x') + Date.now().toString(36) + uidCounter.toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function cond(field, op, value) { return { field, op, value: value == null ? '' : value }; }

  function defaultConfig() {
    const fWalls = { id: 'f-wanden', name: 'Wanden', logic: 'and', conditions: [cond('Attribuut::Entiteit', 'eq', 'IfcWall*')] };
    const fExt = { id: 'f-buitenwanden', name: 'Buitenwanden', logic: 'and', conditions: [{ op: 'filter', value: 'f-wanden', field: '' }, cond('Pset_WallCommon::IsExternal', 'eq', 'Waar')] };
    const fFloors = { id: 'f-vloeren', name: 'Vloeren en daken', logic: 'and', conditions: [cond('Attribuut::Entiteit', 'in', 'IfcSlab*; IfcRoof')] };
    const fOpenings = { id: 'f-kozijnen', name: 'Ramen en deuren', logic: 'or', conditions: [cond('Attribuut::Entiteit', 'eq', 'IfcWindow*'), cond('Attribuut::Entiteit', 'eq', 'IfcDoor*')] };
    const fSteel = { id: 'f-staal', name: 'Staalconstructie', logic: 'and', conditions: [cond('Materiaal::Materiaal', 'contains', 'staal'), cond('Attribuut::Entiteit', 'in', 'IfcColumn*; IfcBeam*; IfcMember*')] };
    const fSpaces = { id: 'f-ruimten', name: 'Ruimten', logic: 'and', conditions: [cond('Attribuut::Entiteit', 'eq', 'IfcSpace')] };
    const fNoClass = { id: 'f-zonder-nlsfb', name: 'Bouwdelen zonder NL-SfB', logic: 'and', conditions: [cond('Classificatie::NL-SfB', 'nexists'), cond('Attribuut::Entiteit', 'ne', 'IfcSpace')] };

    const C = (code, name, color, logic, conditions) => ({ id: 'c-' + code.replace(/\W/g, '_'), code, name, color, rule: { logic, conditions } });
    const scheme = {
      id: 's-elementcodering',
      name: 'Elementcodering',
      overrides: {},
      classes: [
        C('21', 'Buitenwanden', '#b8603a', 'and', [cond('Attribuut::Entiteit', 'eq', 'IfcWall*'), cond('Pset_WallCommon::IsExternal', 'eq', 'Waar')]),
        C('22', 'Binnenwanden', '#d3a24a', 'and', [cond('Attribuut::Entiteit', 'eq', 'IfcWall*')]),
        C('23', 'Vloeren', '#7d8a96', 'and', [cond('Attribuut::Entiteit', 'eq', 'IfcSlab*'), cond('Attribuut::PredefinedType', 'ne', 'ROOF')]),
        C('27', 'Daken', '#5a6e7f', 'or', [cond('Attribuut::Entiteit', 'eq', 'IfcRoof'), cond('Attribuut::PredefinedType', 'eq', 'ROOF')]),
        C('28', 'Hoofddraagconstructie', '#3c5f8f', 'and', [cond('Attribuut::Entiteit', 'in', 'IfcColumn*; IfcBeam*; IfcMember*')]),
        C('31', 'Buitenwandopeningen', '#2f8f9d', 'or', [cond('Attribuut::Entiteit', 'eq', 'IfcWindow*'), cond('Pset_DoorCommon::IsExternal', 'eq', 'Waar')]),
        C('32', 'Binnenwandopeningen', '#6b5fb5', 'and', [cond('Attribuut::Entiteit', 'eq', 'IfcDoor*')]),
        C('90', 'Ruimten', '#9fb7a6', 'and', [cond('Attribuut::Entiteit', 'eq', 'IfcSpace')])
      ]
    };

    const col = (label, field, agg, decimals, extra) => Object.assign({ id: uid('k'), label, source: 'field', field, agg, decimals: decimals == null ? 2 : decimals, factor: 1 }, extra || {});
    const formula = (label, f, agg, decimals) => ({ id: uid('k'), label, source: 'formula', formula: f, agg, decimals: decimals == null ? 2 : decimals, factor: 1 });

    const itos = [
      {
        id: 'ito-elementen', name: 'Begroting per element', mode: 'group',
        scope: { filterId: '', schemeId: scheme.id, onlyClassified: true },
        columns: [
          col('Code', 'ITO-classificatie::Elementcodering', 'group', 0),
          col('Element', 'ITO-classificatie::Elementcodering omschrijving', 'group', 0),
          col('Typenaam', 'Type::Typenaam', 'group', 0),
          col('Aantal', '', 'count', 0),
          col('Netto oppervlak (m²)', 'Qto_WallBaseQuantities::NetSideArea', 'sum', 2),
          col('Vloeroppervlak (m²)', 'Qto_SlabBaseQuantities::NetArea', 'sum', 2),
          col('Netto volume (m³)', 'Qto_WallBaseQuantities::NetVolume', 'sum', 3)
        ]
      },
      {
        id: 'ito-wanden', name: 'Wanden per bouwlaag', mode: 'group', scope: { filterId: 'f-wanden' },
        columns: [
          col('Bouwlaag', 'Locatie::Bouwlaag', 'group', 0),
          col('Wandtype', 'Type::Typenaam', 'group', 0),
          col('Aantal', '', 'count', 0),
          col('Lengte (m)', 'Qto_WallBaseQuantities::Length', 'sum', 2, { factor: 0.001 }),
          col('Netto oppervlak (m²)', 'Qto_WallBaseQuantities::NetSideArea', 'sum', 2),
          col('Netto volume (m³)', 'Qto_WallBaseQuantities::NetVolume', 'sum', 3),
          col('Brandwerendheid', 'Pset_WallCommon::FireRating', 'list', 0)
        ]
      },
      {
        id: 'ito-beton', name: 'Betonvloeren en wapening', mode: 'group', scope: { filterId: 'f-vloeren' },
        columns: [
          col('Bouwlaag', 'Locatie::Bouwlaag', 'group', 0),
          col('Vloertype', 'Type::Typenaam', 'group', 0),
          col('Materiaal', 'Materiaal::Materiaal', 'group', 0),
          col('Oppervlak (m²)', 'Qto_SlabBaseQuantities::NetArea', 'sum', 2),
          col('Volume (m³)', 'Qto_SlabBaseQuantities::NetVolume', 'sum', 3),
          formula('Wapening à 95 kg/m³ (kg)', '{Volume (m³)} * 95', 'sum', 0)
        ]
      },
      {
        id: 'ito-kozijnen', name: 'Kozijnstaat', mode: 'group', scope: { filterId: 'f-kozijnen' },
        columns: [
          col('Entiteit', 'Attribuut::Entiteit', 'group', 0),
          col('Type', 'Type::Typenaam', 'group', 0),
          col('Breedte (mm)', 'Attribuut::OverallWidth', 'group', 0),
          col('Hoogte (mm)', 'Attribuut::OverallHeight', 'group', 0),
          col('Aantal', '', 'count', 0),
          col('Bouwlagen', 'Locatie::Bouwlaag', 'list', 0),
          formula('Oppervlak (m²)', '{Breedte (mm)} * {Hoogte (mm)} / 1000000', 'sum', 2)
        ]
      },
      {
        id: 'ito-staal', name: 'Staallijst', mode: 'detail', scope: { filterId: 'f-staal' },
        columns: [
          col('Bouwlaag', 'Locatie::Bouwlaag', 'group', 0),
          col('Naam', 'Attribuut::Naam', 'group', 0),
          col('GlobalId', 'Attribuut::GlobalId', 'group', 0),
          col('Lengte (mm)', 'Qto_ColumnBaseQuantities::Length', 'sum', 0),
          col('Liggerlengte (mm)', 'Qto_BeamBaseQuantities::Length', 'sum', 0),
          formula('Gewicht (kg)', 'round([Qto_ColumnBaseQuantities::GrossWeight] + [Qto_BeamBaseQuantities::NetWeight]; 1)', 'sum', 1)
        ]
      },
      {
        id: 'ito-ruimten', name: 'Ruimtestaat (NEN 2580)', mode: 'detail', scope: { filterId: 'f-ruimten' },
        columns: [
          col('Bouwlaag', 'Locatie::Bouwlaag', 'group', 0),
          col('Nummer', 'Attribuut::Naam', 'group', 0),
          col('Ruimtenaam', 'Attribuut::LongName', 'group', 0),
          col('NVO (m²)', 'Qto_SpaceBaseQuantities::NetFloorArea', 'sum', 2),
          col('Inhoud (m³)', 'Qto_SpaceBaseQuantities::NetVolume', 'sum', 2)
        ]
      }
    ];

    return {
      version: 1,
      filters: [fWalls, fExt, fFloors, fOpenings, fSteel, fSpaces, fNoClass],
      classifications: [scheme],
      itos
    };
  }

  const api = {
    SEP, OPERATORS, AGGREGATES, PALETTE,
    getValue, toNumber, toText, isEmpty, evalRule, applyFilter, makeContext,
    classifyAll, classesFromField, hasRule, compileFormula, computeIto, aggregate,
    fieldCatalog, defaultConfig, uid, naturalCompare
  };
  root.ITO = root.ITO || {};
  root.ITO.engine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
