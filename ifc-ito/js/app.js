/*
 * IFC ITO Studio — user interface.
 * Plain DOM, no framework. State lives in `S`; the configuration (filters,
 * classifications, ITO definitions) is autosaved to localStorage and can be
 * exported/imported as JSON.
 */
(function () {
  'use strict';

  const E = ITO.engine;
  const STORE_KEY = 'ifc-ito-studio-config-v1';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const S = {
    model: null,
    bytes: null,
    config: loadStoredConfig() || E.defaultConfig(),
    classResult: {},
    fields: [],
    leftTab: 'model',
    centerTab: 'viewer',
    selFilter: null,
    selScheme: null,
    selClass: null,
    selIto: null,
    activeSet: null, // {label, ids:[]}
    selected: new Set(),
    lastSelected: null,
    colorBy: 'none', // 'none' | 'scheme'
    ghost: true,
    itoResult: null,
    itoSelRow: null,
    elemSort: null,
    search: ''
  };
  S.selFilter = (S.config.filters[0] || {}).id || null;
  S.selScheme = (S.config.classifications[0] || {}).id || null;
  S.selIto = (S.config.itos[0] || {}).id || null;

  let viewer = null;
  let viewerState = 'idle'; // idle | loading | ready | unavailable | error
  let viewerMsg = '';

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on')) el.addEventListener(k.substring(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach((x) => append(el, x)); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  const $ = (id) => document.getElementById(id);
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  function fmt(v, decimals) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') {
      if (!isFinite(v)) return '';
      const d = decimals == null ? (Number.isInteger(v) ? 0 : 3) : decimals;
      return v.toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d });
    }
    if (v === true) return 'Waar';
    if (v === false) return 'Onwaar';
    return String(v);
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    let t = document.querySelector('.toast');
    if (!t) { t = h('div', { class: 'toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 3200);
  }

  function progress(p) { $('progress').style.width = p == null ? '0' : Math.round(p * 100) + '%'; }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------
  function loadStoredConfig() {
    try {
      const s = localStorage.getItem(STORE_KEY);
      if (!s) return null;
      const c = JSON.parse(s);
      return c && c.filters && c.itos && c.classifications ? c : null;
    } catch (e) { return null; }
  }
  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(S.config)); } catch (e) { /* storage unavailable */ }
    }, 300);
  }

  function saveFile(blob, filename) {
    if (window.ITO_SAVE_FILE) return window.ITO_SAVE_FILE(blob, filename);
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Model loading
  // ---------------------------------------------------------------------------
  async function loadIfcText(text, fileName, bytes) {
    progress(0.15);
    await new Promise((r) => setTimeout(r, 20));
    let model;
    try {
      model = ITO.parser.parseIfc(text, { fileName });
    } catch (e) {
      progress(null);
      toast('Kan het IFC-bestand niet lezen: ' + e.message, true);
      return;
    }
    S.model = model;
    S.bytes = bytes;
    S.selected.clear();
    S.activeSet = null;
    S.itoSelRow = null;
    recompute(true);
    progress(0.5);
    renderAll();
    toast(model.elements.length + ' elementen ingelezen uit ' + fileName + ' (' + model.parseMs + ' ms)');
    load3D();
  }

  async function load3D() {
    if (!S.bytes) return;
    if (!ITO.Viewer.available()) {
      viewerState = 'unavailable';
      viewerMsg = 'De 3D-bibliotheken (three.js en web-ifc) zijn niet geladen. Classificeren, filteren en exporteren werkt wel.';
      progress(null);
      if (S.centerTab === 'viewer') renderCenter();
      return;
    }
    viewerState = 'loading';
    if (S.centerTab === 'viewer') renderCenter();
    try {
      if (!viewer) {
        viewer = new ITO.Viewer(h('div'), { onPick: (id, add) => { if (id != null) selectElements([id], add); else selectElements([], false); } });
      }
      if (S.centerTab === 'viewer') mountViewer();
      else viewer.init();
      const q = await viewer.load(S.bytes, (n) => progress(0.5 + Math.min(0.45, n / 20000)));
      // add computed geometric quantities to the elements
      const G = 'Geometrie (berekend)::';
      S.model.elements.forEach((el) => {
        const g = q.get(el.id);
        if (!g) return;
        el.props[G + 'Volume (m³)'] = round(g.volume, 4);
        el.props[G + 'Oppervlakte totaal (m²)'] = round(g.area, 3);
        el.props[G + 'Bovenaanzicht (m²)'] = round(g.topArea, 3);
        el.props[G + 'Lengte bbox (m)'] = round(Math.max(g.dx, g.dy), 3);
        el.props[G + 'Breedte bbox (m)'] = round(Math.min(g.dx, g.dy), 3);
        el.props[G + 'Hoogte bbox (m)'] = round(g.dz, 3);
      });
      viewerState = 'ready';
      recompute(false);
      renderAll();
    } catch (e) {
      console.error(e);
      viewerState = 'error';
      viewerMsg = '3D kon niet worden geladen (' + (e && e.message ? e.message : e) + '). Classificeren, filteren en exporteren werkt wel.';
      renderCenter();
    }
    progress(null);
  }
  function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

  function openFile(file) {
    if (!file) return;
    const reader = new FileReader();
    progress(0.05);
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      const text = new TextDecoder('latin1').decode(bytes);
      loadIfcText(text, file.name, bytes);
    };
    reader.onerror = () => { progress(null); toast('Het bestand kon niet worden gelezen.', true); };
    reader.readAsArrayBuffer(file);
  }

  function loadDemo() {
    const text = ITO.generateDemoIfc();
    loadIfcText(text, 'Demo_Kantoor_De_Linde.ifc', new TextEncoder().encode(text));
  }

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------
  function recompute(fieldsToo) {
    if (!S.model) return;
    S.classResult = E.classifyAll(S.model.elements, S.config);
    if (fieldsToo !== false || !S.fields.length) {
      S.fields = E.fieldCatalog(S.model.elements);
      const dl = clear($('dl-fields'));
      S.fields.forEach((f) => dl.appendChild(h('option', { value: f.key, label: f.count + '×' })));
    }
    const ito = currentIto();
    S.itoResult = ito ? E.computeIto(S.model, ito, S.config, S.classResult) : null;
  }

  // Debounced recompute + refresh of everything except the editor being typed in.
  let refreshTimer = null;
  function changed(opts) {
    persist();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      recompute(false);
      refreshCounts();
      renderCenter();
      if (opts && opts.inspector) renderInspector();
    }, 120);
  }

  function currentFilter() { return S.config.filters.find((f) => f.id === S.selFilter) || null; }
  function currentScheme() { return S.config.classifications.find((s) => s.id === S.selScheme) || null; }
  function currentIto() { return S.config.itos.find((i) => i.id === S.selIto) || null; }

  function filterIds(rule) {
    if (!S.model) return [];
    const ctx = E.makeContext(S.config);
    return S.model.elements.filter((el) => E.evalRule(el, rule, ctx, 0)).map((el) => el.id);
  }

  function classColors(scheme) {
    const colors = new Map();
    if (!scheme) return colors;
    const map = S.classResult[scheme.id];
    const byId = new Map(scheme.classes.map((c) => [c.id, c]));
    if (map) map.forEach((cid, eid) => { const c = byId.get(cid); if (c && c.color) colors.set(eid, c.color); });
    return colors;
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------
  function selectElements(ids, add) {
    if (!add) S.selected.clear();
    ids.forEach((id) => {
      if (add && S.selected.has(id) && ids.length === 1) S.selected.delete(id);
      else S.selected.add(id);
    });
    S.lastSelected = ids.length ? ids[ids.length - 1] : null;
    renderInspector();
    updateViewer();
    markTableSelection();
  }

  function showSet(label, ids, opts) {
    S.activeSet = { label, ids };
    if (!opts || opts.tab !== false) S.centerTab = opts && opts.tab ? opts.tab : (S.centerTab === 'ito' ? 'elements' : S.centerTab);
    renderCenterTabs();
    renderCenter();
    if (viewer && viewerState === 'ready' && ids.length) viewer.fit(ids);
  }

  function updateViewer() {
    if (!viewer || viewerState !== 'ready') return;
    const scheme = S.colorBy === 'scheme' ? currentScheme() : null;
    let visible = null;
    if (S.centerTab === 'viewer' && S.activeSet) visible = new Set(S.activeSet.ids);
    viewer.apply({ colors: scheme ? classColors(scheme) : null, visible, ghost: S.ghost, selected: S.selected });
  }

  // ---------------------------------------------------------------------------
  // Rendering — top
  // ---------------------------------------------------------------------------
  function renderAll() {
    renderModelInfo();
    renderLeftTabs();
    renderLeft();
    renderCenterTabs();
    renderCenter();
    renderInspector();
  }

  function renderModelInfo() {
    const el = clear($('model-info'));
    if (!S.model) { el.textContent = 'Geen model geladen — open een IFC-bestand of probeer het demo-model'; return; }
    const m = S.model;
    append(el, [h('strong', { text: m.fileName }), '  ·  ' + m.schema + '  ·  ' + m.elements.length + ' elementen  ·  ' + m.storeys.length + ' bouwlagen' + (m.project ? '  ·  ' + m.project.name : '')]);
    el.title = el.textContent;
  }

  const LEFT_TABS = [
    { id: 'model', label: 'Model' },
    { id: 'filters', label: 'Filters', n: () => S.config.filters.length },
    { id: 'class', label: 'Classificatie', n: () => S.config.classifications.length },
    { id: 'ito', label: "ITO's", n: () => S.config.itos.length }
  ];
  function renderLeftTabs() {
    const nav = clear($('left-tabs'));
    LEFT_TABS.forEach((t) => {
      nav.appendChild(h('button', {
        class: 'tab', role: 'tab', type: 'button', 'aria-selected': S.leftTab === t.id ? 'true' : 'false',
        onclick: () => {
          S.leftTab = t.id;
          if (t.id === 'ito') S.centerTab = 'ito';
          renderLeftTabs(); renderLeft(); renderCenterTabs(); renderCenter();
        }
      }, t.label, t.n ? h('span', { class: 'n', text: String(t.n()) }) : null));
    });
  }

  function renderLeft() {
    const body = clear($('left-body'));
    if (S.leftTab === 'model') body.appendChild(renderModelPanel());
    else if (S.leftTab === 'filters') body.appendChild(renderFiltersPanel());
    else if (S.leftTab === 'class') body.appendChild(renderClassPanel());
    else body.appendChild(renderItoPanel());
  }

  // ---------------------------------------------------------------------------
  // Left: model tree
  // ---------------------------------------------------------------------------
  function renderModelPanel() {
    const wrap = h('div');
    if (!S.model) {
      wrap.appendChild(h('div', { class: 'empty' },
        h('h3', { text: 'Begin met een model' }),
        h('p', { text: 'Open een IFC-bestand (IFC2x3, IFC4 of IFC4.3). Het bestand blijft op je eigen computer; er wordt niets geüpload.' }),
        h('div', { class: 'row', style: 'justify-content:center' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => $('file-ifc').click() }, 'IFC openen'),
          h('button', { class: 'btn', type: 'button', onclick: loadDemo }, 'Demo-model laden'))));
      return wrap;
    }
    const m = S.model;
    const sec = h('div', { class: 'section' });
    sec.appendChild(h('div', { class: 'eyebrow' }, 'Zoeken'));
    const search = h('input', { class: 'input', id: 'model-search', type: 'search', placeholder: 'Naam, GlobalId, type of tag…', value: S.search });
    search.addEventListener('input', () => {
      S.search = search.value;
      clearTimeout(search._t);
      search._t = setTimeout(() => {
        const q = S.search.trim().toLowerCase();
        if (!q) return;
        const ids = m.elements.filter((el) => [el.name, el.globalId, el.typeName, el.tag, el.entity, el.objectType].some((v) => v && String(v).toLowerCase().indexOf(q) !== -1)).map((el) => el.id);
        showSet('Zoekresultaat "' + S.search + '"', ids, { tab: 'elements' });
      }, 250);
    });
    sec.appendChild(search);
    wrap.appendChild(sec);

    const tree = h('div', { class: 'section tree' });
    tree.appendChild(h('div', { class: 'eyebrow' }, 'Ruimtelijke structuur', h('span', { class: 'count', text: m.elements.length + '' })));
    tree.appendChild(leaf('Alle elementen', m.elements.map((e) => e.id), 0));
    const byStorey = new Map();
    m.elements.forEach((el) => {
      const k = el.storey || '(geen bouwlaag)';
      if (!byStorey.has(k)) byStorey.set(k, []);
      byStorey.get(k).push(el);
    });
    const order = m.storeys.map((s) => s.name);
    Array.from(byStorey.keys()).sort((a, b) => {
      const ia = order.indexOf(a); const ib = order.indexOf(b);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.localeCompare(b);
    }).forEach((storey) => {
      const els = byStorey.get(storey);
      const det = h('details', { open: byStorey.size <= 4 ? true : null });
      det.appendChild(h('summary', { onclick: (e) => { if (e.target.closest('.name')) { e.preventDefault(); showSet('Bouwlaag ' + storey, els.map((x) => x.id)); } } },
        h('span', { class: 'name', text: storey }), h('span', { class: 'count', text: els.length + '' })));
      const sub = h('div', { class: 'sub' });
      const byEnt = new Map();
      els.forEach((el) => { if (!byEnt.has(el.entity)) byEnt.set(el.entity, []); byEnt.get(el.entity).push(el.id); });
      Array.from(byEnt.keys()).sort().forEach((ent) => sub.appendChild(leaf(ent, byEnt.get(ent), 1, storey + ' · ' + ent)));
      det.appendChild(sub);
      tree.appendChild(det);
    });
    wrap.appendChild(tree);

    const ent = h('div', { class: 'section tree' });
    ent.appendChild(h('div', { class: 'eyebrow' }, 'Per entiteit'));
    const byEnt = new Map();
    m.elements.forEach((el) => { if (!byEnt.has(el.entity)) byEnt.set(el.entity, []); byEnt.get(el.entity).push(el.id); });
    Array.from(byEnt.keys()).sort().forEach((k) => ent.appendChild(leaf(k, byEnt.get(k), 0)));
    wrap.appendChild(ent);

    const info = h('div', { class: 'section' });
    info.appendChild(h('div', { class: 'eyebrow' }, 'Bestand'));
    const dl = h('div', { class: 'hint' });
    [['Schema', m.schema], ['Applicatie', m.application], ['Eenheden', Object.keys(m.units).map((k) => m.units[k]).join(', ')], ['STEP-entiteiten', m.entityCount.toLocaleString('nl-NL')], ['Inleestijd', m.parseMs + ' ms']]
      .forEach(([k, v]) => { if (v) dl.appendChild(h('div', null, k + ': ', h('span', { style: 'font-family:var(--font-data)', text: String(v) }))); });
    info.appendChild(dl);
    wrap.appendChild(info);
    return wrap;

    function leaf(label, ids, depth, fullLabel) {
      const cur = S.activeSet && S.activeSet.label === (fullLabel || label);
      return h('button', { class: 'leaf', type: 'button', 'aria-current': cur ? 'true' : null, style: depth ? '' : 'padding-left:6px', onclick: () => { showSet(fullLabel || label, ids); renderLeft(); } },
        h('span', { class: 'name', text: label }), h('span', { class: 'count', text: ids.length + '' }));
    }
  }

  // ---------------------------------------------------------------------------
  // Left: condition editor (shared by filters and classes)
  // ---------------------------------------------------------------------------
  function ruleEditor(rule, onChange, ownFilterId) {
    const wrap = h('div', { class: 'conds' });
    function render() {
      clear(wrap);
      const seg = h('div', { class: 'row' },
        h('span', { class: 'hint', text: 'Element voldoet aan' }),
        h('div', { class: 'seg', role: 'group' },
          h('button', { type: 'button', 'aria-pressed': rule.logic !== 'or' ? 'true' : 'false', onclick: () => { rule.logic = 'and'; render(); onChange(); } }, 'alle'),
          h('button', { type: 'button', 'aria-pressed': rule.logic === 'or' ? 'true' : 'false', onclick: () => { rule.logic = 'or'; render(); onChange(); } }, 'één van')),
        h('span', { class: 'hint', text: 'voorwaarden' }));
      wrap.appendChild(seg);
      rule.conditions.forEach((c, i) => {
        if (i > 0) wrap.appendChild(h('div', { class: 'logic-word', text: rule.logic === 'or' ? 'of' : 'en' }));
        wrap.appendChild(condRow(c, i));
      });
      wrap.appendChild(h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => { rule.conditions.push({ field: 'Attribuut::Entiteit', op: 'eq', value: '' }); render(); onChange(); } }, '+ Voorwaarde'),
        S.config.filters.length > (ownFilterId ? 1 : 0) ? h('button', { class: 'btn small', type: 'button', onclick: () => {
          const other = S.config.filters.find((f) => f.id !== ownFilterId);
          rule.conditions.push({ field: '', op: 'filter', value: other ? other.id : '' }); render(); onChange();
        } }, '+ Bestaand filter') : null));
    }
    function condRow(c, i) {
      const isFilterRef = c.op === 'filter' || c.op === 'nfilter';
      const row = h('div', { class: 'cond' });
      const ops = h('select', { class: 'select', 'aria-label': 'Operator', onchange: () => {
        const wasRef = isFilterRef;
        c.op = ops.value;
        const nowRef = c.op === 'filter' || c.op === 'nfilter';
        if (nowRef !== wasRef) { c.value = nowRef ? ((S.config.filters.find((f) => f.id !== ownFilterId) || {}).id || '') : ''; if (!nowRef && !c.field) c.field = 'Attribuut::Entiteit'; render(); }
        else render();
        onChange();
      } }, E.OPERATORS.map((o) => h('option', { value: o.id, selected: o.id === c.op ? true : null, text: o.label })));
      if (isFilterRef) {
        const sel = h('select', { class: 'select', 'aria-label': 'Filter', onchange: () => { c.value = sel.value; onChange(); } },
          S.config.filters.filter((f) => f.id !== ownFilterId).map((f) => h('option', { value: f.id, selected: f.id === c.value ? true : null, text: f.name })));
        row.appendChild(h('span', { class: 'hint', text: 'Filter' }));
        row.appendChild(ops);
        row.appendChild(sel);
      } else {
        const field = h('input', { class: 'input mono', list: 'dl-fields', value: c.field || '', placeholder: 'Pset::Eigenschap', 'aria-label': 'Eigenschap', title: c.field || '' });
        field.addEventListener('input', () => { c.field = field.value.trim(); field.title = c.field; onChange(); });
        row.appendChild(field);
        row.appendChild(ops);
        const op = E.OPERATORS.find((o) => o.id === c.op);
        const val = h('input', { class: 'input', list: 'dl-values', value: c.value == null ? '' : c.value, placeholder: c.op === 'in' ? 'a; b; c' : 'waarde (* ? toegestaan)', 'aria-label': 'Waarde', disabled: op && !op.needsValue ? true : null });
        val.addEventListener('focus', () => fillValues(c.field));
        val.addEventListener('input', () => { c.value = val.value; onChange(); });
        row.appendChild(val);
      }
      row.appendChild(h('button', { class: 'btn ghost small danger', type: 'button', title: 'Voorwaarde verwijderen', 'aria-label': 'Voorwaarde verwijderen', onclick: () => { rule.conditions.splice(i, 1); render(); onChange(); } }, '✕'));
      return row;
    }
    render();
    return wrap;
  }

  function fillValues(field) {
    const dl = clear($('dl-values'));
    const f = S.fields.find((x) => x.key === field);
    if (!f) return;
    Array.from(f.values).sort(E.naturalCompare).slice(0, 300).forEach((v) => dl.appendChild(h('option', { value: v })));
  }

  // ---------------------------------------------------------------------------
  // Left: filters
  // ---------------------------------------------------------------------------
  function renderFiltersPanel() {
    const wrap = h('div');
    const sec = h('div', { class: 'section' });
    sec.appendChild(h('div', { class: 'eyebrow' }, 'Filters',
      h('button', { class: 'btn small', type: 'button', onclick: () => {
        const f = { id: E.uid('f'), name: 'Nieuw filter', logic: 'and', conditions: [{ field: 'Attribuut::Entiteit', op: 'eq', value: '' }] };
        S.config.filters.push(f); S.selFilter = f.id; changed(); renderLeftTabs(); renderLeft();
      } }, '+ Nieuw')));
    sec.appendChild(h('p', { class: 'hint', style: 'margin:0', text: 'Een filter selecteert elementen op basis van IFC-informatie: attributen, property sets, quantity sets, type, materiaal, bouwlaag of classificatie. Filters zijn te combineren en te gebruiken als scope van een ITO.' }));
    const list = h('div', { class: 'list' });
    S.config.filters.forEach((f) => {
      list.appendChild(h('button', { class: 'item', type: 'button', 'aria-current': f.id === S.selFilter ? 'true' : null, onclick: () => { S.selFilter = f.id; renderLeft(); showSet('Filter: ' + f.name, filterIds(f)); } },
        h('span', { class: 'name', text: f.name }), h('span', { class: 'pill', 'data-count-filter': f.id, text: '–' })));
    });
    sec.appendChild(list);
    wrap.appendChild(sec);

    const f = currentFilter();
    if (f) {
      const ed = h('div', { class: 'section' });
      const name = h('input', { class: 'input title', value: f.name, 'aria-label': 'Naam filter' });
      name.addEventListener('input', () => { f.name = name.value; const it = list.querySelector('[aria-current="true"] .name'); if (it) it.textContent = f.name; changed(); });
      ed.appendChild(name);
      ed.appendChild(ruleEditor(f, () => changed(), f.id));
      ed.appendChild(h('div', { class: 'row' },
        h('button', { class: 'btn primary small', type: 'button', onclick: () => showSet('Filter: ' + f.name, filterIds(f)) }, 'Toon elementen'),
        h('button', { class: 'btn small', type: 'button', onclick: () => {
          const c = JSON.parse(JSON.stringify(f)); c.id = E.uid('f'); c.name = f.name + ' (kopie)';
          S.config.filters.push(c); S.selFilter = c.id; changed(); renderLeftTabs(); renderLeft();
        } }, 'Dupliceren'),
        h('button', { class: 'btn small', type: 'button', onclick: () => {
          const ito = { id: E.uid('ito'), name: 'ITO ' + f.name, mode: 'group', scope: { filterId: f.id }, columns: [
            { id: E.uid('k'), label: 'Typenaam', source: 'field', field: 'Type::Typenaam', agg: 'group', decimals: 0, factor: 1 },
            { id: E.uid('k'), label: 'Aantal', source: 'field', field: '', agg: 'count', decimals: 0, factor: 1 }] };
          S.config.itos.push(ito); S.selIto = ito.id; S.leftTab = 'ito'; S.centerTab = 'ito'; changed(); renderAll();
        } }, 'Maak ITO'),
        h('span', { style: 'flex:1' }),
        h('button', { class: 'btn small danger', type: 'button', onclick: () => {
          S.config.filters = S.config.filters.filter((x) => x.id !== f.id);
          S.selFilter = (S.config.filters[0] || {}).id || null; changed(); renderLeftTabs(); renderLeft();
        } }, 'Verwijderen')));
      wrap.appendChild(ed);
    }
    setTimeout(refreshCounts, 0);
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Left: classification
  // ---------------------------------------------------------------------------
  function renderClassPanel() {
    const wrap = h('div');
    const sec = h('div', { class: 'section' });
    const scheme = currentScheme();
    sec.appendChild(h('div', { class: 'eyebrow' }, 'Classificatieschema',
      h('button', { class: 'btn small', type: 'button', onclick: () => {
        const s = { id: E.uid('s'), name: 'Nieuw schema', overrides: {}, classes: [] };
        S.config.classifications.push(s); S.selScheme = s.id; changed(); renderLeftTabs(); renderLeft();
      } }, '+ Nieuw schema')));
    sec.appendChild(h('p', { class: 'hint', style: 'margin:0', text: 'Klassen worden van boven naar beneden getoetst; de eerste klasse waarvan de regels kloppen wint. Handmatige toewijzingen in het eigenschappenpaneel gaan altijd voor.' }));
    if (S.config.classifications.length > 1) {
      sec.appendChild(h('select', { class: 'select', 'aria-label': 'Schema', onchange: (e) => { S.selScheme = e.target.value; S.selClass = null; renderLeft(); updateViewer(); } },
        S.config.classifications.map((s) => h('option', { value: s.id, selected: s.id === S.selScheme ? true : null, text: s.name }))));
    }
    if (!scheme) { wrap.appendChild(sec); return wrap; }
    const nm = h('input', { class: 'input title', value: scheme.name, 'aria-label': 'Naam schema' });
    nm.addEventListener('change', () => {
      const old = 'ITO-classificatie::' + scheme.name;
      const nw = 'ITO-classificatie::' + nm.value;
      S.config.itos.forEach((ito) => ito.columns.forEach((c) => { if (c.field && c.field.startsWith(old)) c.field = nw + c.field.substring(old.length); }));
      scheme.name = nm.value; changed();
    });
    sec.appendChild(nm);
    sec.appendChild(h('div', { class: 'row' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.colorBy === 'scheme', onchange: (e) => { S.colorBy = e.target.checked ? 'scheme' : 'none'; S.centerTab = 'viewer'; renderCenterTabs(); renderCenter(); } }), 'Kleur 3D-model op klasse'),
      h('span', { style: 'flex:1' }),
      h('button', { class: 'btn small danger', type: 'button', onclick: () => {
        S.config.classifications = S.config.classifications.filter((x) => x.id !== scheme.id);
        S.selScheme = (S.config.classifications[0] || {}).id || null; changed(); renderLeftTabs(); renderLeft();
      } }, 'Schema verwijderen')));
    wrap.appendChild(sec);

    // classes
    const cs = h('div', { class: 'section' });
    cs.appendChild(h('div', { class: 'eyebrow' }, 'Klassen',
      h('button', { class: 'btn small', type: 'button', onclick: () => {
        const c = { id: E.uid('c'), code: String(scheme.classes.length + 1), name: 'Nieuwe klasse', color: E.PALETTE[scheme.classes.length % E.PALETTE.length], rule: { logic: 'and', conditions: [{ field: 'Attribuut::Entiteit', op: 'eq', value: '' }] } };
        scheme.classes.push(c); S.selClass = c.id; changed(); renderLeft();
      } }, '+ Klasse')));
    const list = h('div', { class: 'list' });
    scheme.classes.forEach((c, i) => {
      const open = S.selClass === c.id;
      const item = h('div', { class: 'item', 'aria-current': open ? 'true' : null, style: 'cursor:default' });
      const color = h('input', { type: 'color', class: 'swatch', value: c.color || '#888888', 'aria-label': 'Kleur', title: 'Kleur in 3D' });
      color.addEventListener('input', () => { c.color = color.value; persist(); updateViewer(); });
      const code = h('input', { class: 'input mono', value: c.code, style: 'width:64px', 'aria-label': 'Code' });
      code.addEventListener('input', () => { c.code = code.value; changed(); });
      const name = h('input', { class: 'input', value: c.name, style: 'flex:1', 'aria-label': 'Omschrijving' });
      name.addEventListener('input', () => { c.name = name.value; changed(); });
      append(item, [color, code, name,
        h('button', { class: 'pill', type: 'button', 'data-count-class': c.id, title: 'Toon elementen', style: 'cursor:pointer', onclick: () => showClass(scheme, c) }, '–'),
        h('button', { class: 'btn ghost small', type: 'button', title: 'Regels bewerken', 'aria-expanded': open ? 'true' : 'false', onclick: () => { S.selClass = open ? null : c.id; renderLeft(); } }, open ? '▾' : '▸')]);
      list.appendChild(item);
      if (open) {
        const ed = h('div', { style: 'padding:8px 10px;border-bottom:1px solid var(--line);background:var(--panel-2);display:flex;flex-direction:column;gap:8px' });
        ed.appendChild(ruleEditor(c.rule, () => changed()));
        ed.appendChild(h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', disabled: i === 0 ? true : null, onclick: () => { scheme.classes.splice(i - 1, 0, scheme.classes.splice(i, 1)[0]); changed(); renderLeft(); } }, '↑ Hoger'),
          h('button', { class: 'btn small', type: 'button', disabled: i === scheme.classes.length - 1 ? true : null, onclick: () => { scheme.classes.splice(i + 1, 0, scheme.classes.splice(i, 1)[0]); changed(); renderLeft(); } }, '↓ Lager'),
          h('span', { style: 'flex:1' }),
          h('button', { class: 'btn small danger', type: 'button', onclick: () => { scheme.classes.splice(i, 1); S.selClass = null; changed(); renderLeft(); } }, 'Verwijderen')));
        list.appendChild(ed);
      }
    });
    cs.appendChild(list);
    cs.appendChild(h('button', { class: 'item', type: 'button', style: 'border:1px dashed var(--line-strong);border-radius:var(--r)', onclick: () => {
      const map = S.classResult[scheme.id] || new Map();
      showSet('Niet geclassificeerd (' + scheme.name + ')', S.model ? S.model.elements.filter((e) => !map.has(e.id)).map((e) => e.id) : []);
    } }, h('span', { class: 'name', text: 'Niet geclassificeerd' }), h('span', { class: 'pill', 'data-count-class': '__none', text: '–' })));
    wrap.appendChild(cs);

    // generate
    const gen = h('div', { class: 'section' });
    gen.appendChild(h('div', { class: 'eyebrow' }, 'Klassen genereren'));
    gen.appendChild(h('p', { class: 'hint', style: 'margin:0', text: 'Maak automatisch één klasse per unieke waarde van een eigenschap, bijvoorbeeld Type::Typenaam of Classificatie::NL-SfB.' }));
    const gf = h('input', { class: 'input mono grow', list: 'dl-fields', placeholder: 'Type::Typenaam', value: 'Type::Typenaam', 'aria-label': 'Eigenschap' });
    gen.appendChild(h('div', { class: 'row' }, gf, h('button', { class: 'btn small', type: 'button', onclick: () => {
      if (!S.model) { toast('Laad eerst een model.', true); return; }
      const cls = E.classesFromField(S.model.elements, gf.value.trim());
      if (!cls.length) { toast('Geen waarden gevonden voor ' + gf.value, true); return; }
      const existing = new Set(scheme.classes.map((c) => c.code));
      cls.forEach((c) => { if (!existing.has(c.code)) scheme.classes.push(c); });
      changed(); renderLeft(); toast(cls.length + ' klassen toegevoegd');
    } }, 'Genereer')));
    wrap.appendChild(gen);
    setTimeout(refreshCounts, 0);
    return wrap;
  }

  function showClass(scheme, c) {
    const map = S.classResult[scheme.id] || new Map();
    const ids = [];
    map.forEach((cid, eid) => { if (cid === c.id) ids.push(eid); });
    showSet(scheme.name + ': ' + c.code + ' ' + c.name, ids);
  }

  // ---------------------------------------------------------------------------
  // Left: ITO editor
  // ---------------------------------------------------------------------------
  function renderItoPanel() {
    const wrap = h('div');
    const sec = h('div', { class: 'section' });
    sec.appendChild(h('div', { class: 'eyebrow' }, "ITO's (hoeveelhedenstaten)",
      h('button', { class: 'btn small', type: 'button', onclick: () => {
        const ito = { id: E.uid('ito'), name: 'Nieuwe ITO', mode: 'group', scope: { filterId: '' }, columns: [
          { id: E.uid('k'), label: 'Entiteit', source: 'field', field: 'Attribuut::Entiteit', agg: 'group', decimals: 0, factor: 1 },
          { id: E.uid('k'), label: 'Aantal', source: 'field', field: '', agg: 'count', decimals: 0, factor: 1 }] };
        S.config.itos.push(ito); S.selIto = ito.id; changed(); renderLeftTabs(); renderLeft(); renderCenter();
      } }, '+ Nieuw')));
    const list = h('div', { class: 'list' });
    S.config.itos.forEach((ito) => {
      list.appendChild(h('button', { class: 'item', type: 'button', 'aria-current': ito.id === S.selIto ? 'true' : null, onclick: () => {
        S.selIto = ito.id; S.itoSelRow = null; S.centerTab = 'ito'; recompute(false); renderLeft(); renderCenterTabs(); renderCenter();
      } }, h('span', { class: 'name', text: ito.name }), h('span', { class: 'hint', text: ito.mode === 'detail' ? 'per element' : 'gegroepeerd' })));
    });
    sec.appendChild(list);
    wrap.appendChild(sec);

    const ito = currentIto();
    if (!ito) return wrap;
    const ed = h('div', { class: 'section' });
    const name = h('input', { class: 'input title', value: ito.name, 'aria-label': 'Naam ITO' });
    name.addEventListener('input', () => { ito.name = name.value; const it = list.querySelector('[aria-current="true"] .name'); if (it) it.textContent = ito.name; changed(); });
    ed.appendChild(name);
    ito.scope = ito.scope || {};
    const scopeSel = h('select', { class: 'select grow', 'aria-label': 'Scope', onchange: () => { ito.scope.filterId = scopeSel.value; changed(); } },
      h('option', { value: '', text: 'Alle elementen' }),
      S.config.filters.map((f) => h('option', { value: f.id, selected: f.id === ito.scope.filterId ? true : null, text: 'Filter: ' + f.name })));
    ed.appendChild(h('div', { class: 'row' }, h('span', { class: 'hint', style: 'width:72px', text: 'Elementen' }), scopeSel));
    const schemeSel = h('select', { class: 'select grow', 'aria-label': 'Classificatie', onchange: () => { ito.scope.schemeId = schemeSel.value; ito.scope.onlyClassified = !!schemeSel.value; renderLeft(); changed(); } },
      h('option', { value: '', text: '—' }),
      S.config.classifications.map((s) => h('option', { value: s.id, selected: s.id === ito.scope.schemeId ? true : null, text: 'Alleen geclassificeerd in ' + s.name })));
    ed.appendChild(h('div', { class: 'row' }, h('span', { class: 'hint', style: 'width:72px', text: 'Classificatie' }), schemeSel));
    ed.appendChild(h('div', { class: 'row' }, h('span', { class: 'hint', style: 'width:72px', text: 'Regels' }),
      h('div', { class: 'seg', role: 'group' },
        h('button', { type: 'button', 'aria-pressed': ito.mode !== 'detail' ? 'true' : 'false', onclick: () => { ito.mode = 'group'; renderLeft(); changed(); } }, 'Gegroepeerd'),
        h('button', { type: 'button', 'aria-pressed': ito.mode === 'detail' ? 'true' : 'false', onclick: () => { ito.mode = 'detail'; renderLeft(); changed(); } }, 'Per element'))));
    wrap.appendChild(ed);

    // columns
    const cs = h('div', { class: 'section' });
    cs.appendChild(h('div', { class: 'eyebrow' }, 'Kolommen'));
    cs.appendChild(h('p', { class: 'hint', style: 'margin:0', text: ito.mode === 'detail'
      ? 'Per element één regel. Som- en aantal-kolommen krijgen een totaal.'
      : 'Kolommen met "Groeperen" bepalen de regels; de overige kolommen worden per groep samengevat (som, aantal, gemiddelde…).' }));
    const cols = h('div', { class: 'cols' });
    ito.columns.forEach((c, i) => cols.appendChild(columnRow(ito, c, i)));
    cs.appendChild(cols);
    cs.appendChild(h('div', { class: 'row' },
      h('button', { class: 'btn small', type: 'button', onclick: () => { ito.columns.push({ id: E.uid('k'), label: 'Kolom ' + (ito.columns.length + 1), source: 'field', field: '', agg: ito.mode === 'detail' ? 'first' : 'sum', decimals: 2, factor: 1 }); renderLeft(); changed(); } }, '+ Kolom'),
      h('button', { class: 'btn small', type: 'button', onclick: () => { ito.columns.push({ id: E.uid('k'), label: 'Berekening', source: 'formula', formula: '{' + ((ito.columns.find((c) => c.agg === 'sum') || ito.columns[0] || {}).label || 'Kolom') + '} * 1', agg: 'sum', decimals: 2, factor: 1 }); renderLeft(); changed(); } }, '+ Formule'),
      h('button', { class: 'btn small', type: 'button', onclick: () => { ito.columns.push({ id: E.uid('k'), label: 'Aantal', source: 'field', field: '', agg: 'count', decimals: 0, factor: 1 }); renderLeft(); changed(); } }, '+ Aantal')));
    cs.appendChild(h('p', { class: 'hint', style: 'margin:0', text: 'Formules: verwijs naar kolommen met {Kolomnaam} of naar IFC-velden met [Pset::Eigenschap]. Functies: round(x; n), ceil, floor, min, max, abs, if(voorwaarde; a; b).' }));
    wrap.appendChild(cs);

    const act = h('div', { class: 'section' });
    act.appendChild(h('div', { class: 'row' },
      h('button', { class: 'btn primary small', type: 'button', onclick: () => exportExcel([ito.id]) }, 'Exporteer deze ITO'),
      h('button', { class: 'btn small', type: 'button', onclick: () => {
        const c = JSON.parse(JSON.stringify(ito)); c.id = E.uid('ito'); c.name = ito.name + ' (kopie)'; c.columns.forEach((k) => { k.id = E.uid('k'); });
        S.config.itos.push(c); S.selIto = c.id; changed(); renderLeftTabs(); renderLeft();
      } }, 'Dupliceren'),
      h('span', { style: 'flex:1' }),
      h('button', { class: 'btn small danger', type: 'button', onclick: () => {
        S.config.itos = S.config.itos.filter((x) => x.id !== ito.id);
        S.selIto = (S.config.itos[0] || {}).id || null; changed(); renderLeftTabs(); renderLeft();
      } }, 'Verwijderen')));
    wrap.appendChild(act);
    return wrap;
  }

  function columnRow(ito, c, i) {
    const row = h('div', { class: 'colrow' });
    const label = h('input', { class: 'input grow', value: c.label, 'aria-label': 'Kolomnaam', style: 'flex:1;font-weight:600' });
    label.addEventListener('input', () => { c.label = label.value; changed(); });
    const agg = h('select', { class: 'select', 'aria-label': 'Samenvatting', onchange: () => { c.agg = agg.value; changed(); } },
      E.AGGREGATES.filter((a) => ito.mode !== 'detail' || a.id !== 'group' || true).map((a) => h('option', { value: a.id, selected: a.id === c.agg ? true : null, text: ito.mode === 'detail' && a.id === 'group' ? 'Waarde' : a.label })));
    const line1 = h('div', { class: 'line' }, label, agg);
    let src;
    if (c.source === 'formula') {
      src = h('input', { class: 'input mono', value: c.formula || '', placeholder: '{Volume} * 2400', 'aria-label': 'Formule', style: 'flex:1' });
      src.addEventListener('input', () => {
        c.formula = src.value; changed();
        try { E.compileFormula(src.value || '0'); src.classList.remove('err'); src.title = ''; } catch (e) { src.classList.add('err'); src.title = e.message; }
      });
    } else {
      src = h('input', { class: 'input mono', list: 'dl-fields', value: c.field || '', placeholder: c.agg === 'count' ? '(telt elementen)' : 'Qto_…::NetVolume', 'aria-label': 'Eigenschap', style: 'flex:1', title: c.field || '' });
      src.addEventListener('input', () => {
        c.field = src.value.trim(); src.title = c.field; changed();
        if (/^Eigen kolom|^Kolom \d+$/.test(c.label) && c.field) { c.label = c.field.split('::')[1]; label.value = c.label; }
      });
    }
    const kind = h('button', { class: 'btn small ghost', type: 'button', title: c.source === 'formula' ? 'Formulekolom' : 'IFC-veld', onclick: () => { c.source = c.source === 'formula' ? 'field' : 'formula'; renderLeft(); changed(); } }, c.source === 'formula' ? 'ƒx' : '◫');
    const dec = h('input', { class: 'input num', type: 'number', min: '0', max: '6', value: c.decimals == null ? 2 : c.decimals, 'aria-label': 'Decimalen', title: 'Decimalen' });
    dec.addEventListener('input', () => { c.decimals = Math.max(0, Math.min(6, +dec.value || 0)); changed(); });
    const factor = h('input', { class: 'input num', type: 'number', step: 'any', value: c.factor == null ? 1 : c.factor, 'aria-label': 'Factor', title: 'Vermenigvuldigingsfactor, bv. 0,001 voor mm → m' });
    factor.addEventListener('input', () => { c.factor = factor.value === '' ? 1 : +factor.value; changed(); });
    const line2 = h('div', { class: 'line' }, kind, src);
    const line3 = h('div', { class: 'line' }, h('span', { class: 'hint', text: 'Factor' }), factor, h('span', { class: 'hint', text: 'Decimalen' }), dec);
    const tools = h('div', { class: 'tools' },
      h('button', { class: 'btn ghost small', type: 'button', title: 'Omhoog', 'aria-label': 'Omhoog', disabled: i === 0 ? true : null, onclick: () => { ito.columns.splice(i - 1, 0, ito.columns.splice(i, 1)[0]); renderLeft(); changed(); } }, '↑'),
      h('button', { class: 'btn ghost small', type: 'button', title: 'Omlaag', 'aria-label': 'Omlaag', disabled: i === ito.columns.length - 1 ? true : null, onclick: () => { ito.columns.splice(i + 1, 0, ito.columns.splice(i, 1)[0]); renderLeft(); changed(); } }, '↓'),
      h('button', { class: 'btn ghost small danger', type: 'button', title: 'Verwijderen', 'aria-label': 'Kolom verwijderen', onclick: () => { ito.columns.splice(i, 1); renderLeft(); changed(); } }, '✕'));
    append(row, [h('div', { style: 'display:flex;flex-direction:column;gap:4px;min-width:0' }, line1, line2, line3), tools]);
    return row;
  }

  // ---------------------------------------------------------------------------
  // Counts (updated in place while typing)
  // ---------------------------------------------------------------------------
  function refreshCounts() {
    if (!S.model) return;
    const ctx = E.makeContext(S.config);
    document.querySelectorAll('[data-count-filter]').forEach((el) => {
      const f = S.config.filters.find((x) => x.id === el.getAttribute('data-count-filter'));
      if (!f) return;
      let n = 0;
      S.model.elements.forEach((e) => { if (E.evalRule(e, f, ctx, 0)) n++; });
      el.textContent = String(n);
      el.classList.toggle('zero', n === 0);
    });
    const scheme = currentScheme();
    if (scheme) {
      const map = S.classResult[scheme.id] || new Map();
      const counts = new Map();
      map.forEach((cid) => counts.set(cid, (counts.get(cid) || 0) + 1));
      document.querySelectorAll('[data-count-class]').forEach((el) => {
        const id = el.getAttribute('data-count-class');
        const n = id === '__none' ? S.model.elements.length - map.size : (counts.get(id) || 0);
        el.textContent = String(n);
        el.classList.toggle('zero', n === 0 && id !== '__none');
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Centre
  // ---------------------------------------------------------------------------
  const CENTER_TABS = [
    { id: 'viewer', label: '3D' },
    { id: 'elements', label: 'Elementen' },
    { id: 'ito', label: 'ITO-resultaat' }
  ];
  function renderCenterTabs() {
    const nav = clear($('center-tabs'));
    CENTER_TABS.forEach((t) => {
      let n = null;
      if (t.id === 'elements' && S.activeSet) n = S.activeSet.ids.length;
      if (t.id === 'ito' && S.itoResult) n = S.itoResult.rows.length;
      nav.appendChild(h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': S.centerTab === t.id ? 'true' : 'false', onclick: () => { S.centerTab = t.id; renderCenterTabs(); renderCenter(); } },
        t.label, n != null ? h('span', { class: 'n', text: String(n) }) : null));
    });
  }

  function renderCenter() {
    renderCenterTabs();
    const body = $('center-body');
    if (S.centerTab === 'viewer') renderViewerTab(body);
    else if (S.centerTab === 'elements') renderElementsTab(clear(body));
    else renderItoTab(clear(body));
    updateViewer();
  }

  let viewportEl = null;
  function mountViewer() {
    if (!viewer || !viewportEl) return;
    viewer.container = viewportEl;
    if (!viewer.renderer) viewer.init();
    else viewportEl.insertBefore(viewer.renderer.domElement, viewportEl.firstChild);
    if (typeof ResizeObserver !== 'undefined') {
      if (viewer._ro) viewer._ro.disconnect();
      viewer._ro = new ResizeObserver(viewer._resize);
      viewer._ro.observe(viewportEl);
    }
    viewer._resize();
  }

  function renderViewerTab(body) {
    clear(body);
    const tb = h('div', { class: 'toolbar' },
      h('button', { class: 'btn small', type: 'button', onclick: () => viewer && viewer.fit(S.activeSet ? S.activeSet.ids : null) }, 'Passend maken'),
      h('button', { class: 'btn small', type: 'button', disabled: S.selected.size ? null : true, onclick: () => viewer && viewer.fit(Array.from(S.selected)) }, 'Zoom naar selectie'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.ghost, onchange: (e) => { S.ghost = e.target.checked; updateViewer(); } }), 'Overige elementen transparant'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.colorBy === 'scheme', onchange: (e) => { S.colorBy = e.target.checked ? 'scheme' : 'none'; renderCenter(); } }), 'Kleur op classificatie'),
      h('span', { class: 'spacer' }),
      S.activeSet ? h('span', { class: 'pill', title: S.activeSet.label }, S.activeSet.label.substring(0, 48) + ' · ' + S.activeSet.ids.length) : null,
      S.activeSet ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => { S.activeSet = null; renderCenter(); if (viewer) viewer.fit(); } }, 'Alles tonen') : null);
    body.appendChild(tb);
    viewportEl = h('div', { class: 'viewport' });
    body.appendChild(viewportEl);
    let overlay = null;
    if (!S.model) overlay = h('div', null, h('h3', { style: 'font:600 18px var(--font-display);margin:0 0 6px;color:var(--ink)', text: 'Nog geen model' }), h('p', { text: 'Open een IFC-bestand of laad het demo-model om te beginnen.' }),
      h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'btn primary', type: 'button', onclick: () => $('file-ifc').click() }, 'IFC openen'), h('button', { class: 'btn', type: 'button', onclick: loadDemo }, 'Demo-model laden')));
    else if (viewerState === 'loading') overlay = h('div', null, h('p', { text: 'Geometrie wordt opgebouwd…' }));
    else if (viewerState === 'unavailable' || viewerState === 'error') overlay = h('div', null, h('p', { text: viewerMsg }));
    if (overlay) viewportEl.appendChild(h('div', { class: 'overlay' }, overlay));
    if (viewer && (viewerState === 'ready' || viewerState === 'loading')) mountViewer();
    if (S.colorBy === 'scheme' && viewerState === 'ready') {
      const scheme = currentScheme();
      if (scheme) {
        const lg = h('div', { class: 'legend' }, h('strong', { style: 'font:600 11px var(--font-display);text-transform:uppercase;letter-spacing:.06em', text: scheme.name }));
        scheme.classes.forEach((c) => lg.appendChild(h('div', null, h('span', { class: 'swatch', style: 'background:' + c.color }), (c.code ? c.code + ' ' : '') + c.name)));
        viewportEl.appendChild(lg);
      }
    }
  }

  function elementColumns() {
    const cols = [
      { key: 'Attribuut::Entiteit', label: 'Entiteit' },
      { key: 'Attribuut::Naam', label: 'Naam' },
      { key: 'Type::Typenaam', label: 'Typenaam' },
      { key: 'Locatie::Bouwlaag', label: 'Bouwlaag' },
      { key: 'Materiaal::Materiaal', label: 'Materiaal' }
    ];
    S.config.classifications.forEach((s) => cols.push({ key: 'ITO-classificatie::' + s.name, label: s.name }));
    if (S.fields.some((f) => f.key === 'Classificatie::NL-SfB')) cols.push({ key: 'Classificatie::NL-SfB', label: 'NL-SfB (IFC)' });
    cols.push({ key: 'Attribuut::GlobalId', label: 'GlobalId' });
    return cols;
  }

  function renderElementsTab(body) {
    if (!S.model) { body.appendChild(h('div', { class: 'empty' }, h('h3', { text: 'Geen elementen' }), h('p', { text: 'Laad een model om elementen te zien.' }))); return; }
    const set = S.activeSet || { label: 'Alle elementen', ids: S.model.elements.map((e) => e.id) };
    const tb = h('div', { class: 'toolbar' },
      h('strong', { style: 'font:600 13px var(--font-display)', text: set.label }),
      h('span', { class: 'pill', text: set.ids.length + ' elementen' }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', type: 'button', onclick: () => selectElements(set.ids, false) }, 'Selecteer alle'),
      h('button', { class: 'btn small', type: 'button', onclick: () => { S.centerTab = 'viewer'; renderCenter(); if (viewer && viewerState === 'ready') viewer.fit(set.ids); } }, 'Toon in 3D'));
    body.appendChild(tb);
    const cols = elementColumns();
    let els = set.ids.map((id) => S.model.byId.get(id)).filter(Boolean);
    if (S.elemSort) {
      const k = S.elemSort.key; const d = S.elemSort.dir;
      els = els.slice().sort((a, b) => d * E.naturalCompare(E.toText(a.props[k]), E.toText(b.props[k])));
    }
    const MAX = 3000;
    const wrap = h('div', { class: 'table-wrap' });
    const table = h('table', { class: 'grid', id: 'elements-table' });
    table.appendChild(h('thead', null, h('tr', null, cols.map((c) => h('th', { onclick: () => {
      S.elemSort = S.elemSort && S.elemSort.key === c.key ? { key: c.key, dir: -S.elemSort.dir } : { key: c.key, dir: 1 }; renderCenter();
    } }, c.label + (S.elemSort && S.elemSort.key === c.key ? (S.elemSort.dir > 0 ? ' ▲' : ' ▼') : ''))))));
    const tbody = h('tbody');
    els.slice(0, MAX).forEach((el) => {
      tbody.appendChild(h('tr', { 'data-id': el.id, class: S.selected.has(el.id) ? 'sel' : null, onclick: (e) => selectElements([el.id], e.ctrlKey || e.metaKey || e.shiftKey) },
        cols.map((c) => h('td', { text: fmt(el.props[c.key]), title: fmt(el.props[c.key]) }))));
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    if (els.length > MAX) wrap.appendChild(h('p', { class: 'hint', style: 'padding:8px 12px', text: 'Eerste ' + MAX + ' van ' + els.length + ' elementen getoond.' }));
    body.appendChild(wrap);
  }

  function markTableSelection() {
    document.querySelectorAll('#elements-table tbody tr').forEach((tr) => tr.classList.toggle('sel', S.selected.has(+tr.getAttribute('data-id'))));
  }

  function renderItoTab(body) {
    const ito = currentIto();
    if (!ito) { body.appendChild(h('div', { class: 'empty' }, h('h3', { text: 'Geen ITO geselecteerd' }), h('p', { text: 'Maak of kies een ITO in het tabblad ITO\'s.' }))); return; }
    const res = S.itoResult;
    const tb = h('div', { class: 'toolbar' },
      h('strong', { style: 'font:600 13px var(--font-display)', text: ito.name }),
      res ? h('span', { class: 'pill', text: res.rows.length + ' regels · ' + res.elementCount + ' elementen' }) : null,
      h('span', { class: 'spacer' }),
      S.leftTab !== 'ito' ? h('button', { class: 'btn small', type: 'button', onclick: () => { S.leftTab = 'ito'; renderLeftTabs(); renderLeft(); } }, 'Bewerken') : null,
      h('button', { class: 'btn small primary', type: 'button', disabled: res ? null : true, onclick: () => exportExcel([ito.id]) }, 'Exporteer naar Excel'));
    body.appendChild(tb);
    if (!S.model || !res) { body.appendChild(h('div', { class: 'empty' }, h('h3', { text: 'Nog geen resultaat' }), h('p', { text: 'Laad een model; de hoeveelheden worden direct berekend terwijl je de ITO samenstelt.' }))); return; }
    const errs = Object.keys(res.errors);
    if (errs.length) body.appendChild(h('div', { class: 'toolbar err-text' }, 'Formulefout: ' + errs.map((id) => { const c = res.columns.find((x) => x.id === id); return (c ? c.label : id) + ' – ' + res.errors[id]; }).join('; ')));
    const wrap = h('div', { class: 'table-wrap' });
    const table = h('table', { class: 'grid' });
    const numeric = res.columns.map((c, i) => res.rows.some((r) => typeof r.values[i] === 'number'));
    table.appendChild(h('thead', null, h('tr', null, res.columns.map((c, i) => h('th', {
      class: numeric[i] ? 'num' : null,
      title: c.source === 'formula' ? 'ƒx ' + c.formula : (c.field || ''),
      onclick: () => { ito.sort = ito.sort && ito.sort.col === c.id ? { col: c.id, dir: ito.sort.dir === 'asc' ? 'desc' : 'asc' } : { col: c.id, dir: 'asc' }; changed(); }
    }, c.label + (ito.sort && ito.sort.col === c.id ? (ito.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''))), h('th', { class: 'num', text: 'n' }))));
    const tbody = h('tbody');
    res.rows.forEach((r, ri) => {
      tbody.appendChild(h('tr', { class: S.itoSelRow === ri ? 'sel' : null, title: 'Klik om de ' + r.ids.length + ' elementen te selecteren', onclick: () => {
        S.itoSelRow = ri;
        tbody.querySelectorAll('tr').forEach((tr, k) => tr.classList.toggle('sel', k === ri));
        selectElements(r.ids, false);
        if (viewer && viewerState === 'ready') viewer.fit(r.ids);
      } }, r.values.map((v, i) => h('td', { class: numeric[i] ? 'num' : null, text: fmt(v, numeric[i] ? (res.columns[i].agg === 'count' ? 0 : res.columns[i].decimals) : null) })), h('td', { class: 'num hint', text: String(r.ids.length) })));
    });
    table.appendChild(tbody);
    if (res.rows.length) {
      table.appendChild(h('tfoot', null, h('tr', null, res.totals.map((t, i) => h('td', { class: numeric[i] ? 'num' : null, text: i === 0 && t == null ? 'Totaal' : fmt(t, res.columns[i].agg === 'count' ? 0 : res.columns[i].decimals) })), h('td', { class: 'num', text: String(res.elementCount) }))));
    } else {
      wrap.appendChild(h('div', { class: 'empty' }, h('p', { text: 'Geen elementen binnen de scope van deze ITO. Controleer het filter of de classificatie.' })));
    }
    wrap.insertBefore(table, wrap.firstChild);
    body.appendChild(wrap);
  }

  // ---------------------------------------------------------------------------
  // Inspector
  // ---------------------------------------------------------------------------
  function renderInspector() {
    const box = clear($('inspector'));
    if (!S.model) { box.appendChild(h('div', { class: 'empty' }, h('p', { text: 'Selecteer een element in 3D, in een tabel of via een ITO-regel om de IFC-eigenschappen te zien.' }))); return; }
    if (!S.selected.size) { box.appendChild(h('div', { class: 'empty' }, h('p', { text: 'Klik op een element in 3D of in een tabel. Ctrl/Shift-klik voegt toe aan de selectie.' }))); return; }
    const ids = Array.from(S.selected);
    const el = S.model.byId.get(S.lastSelected != null && S.selected.has(S.lastSelected) ? S.lastSelected : ids[0]);
    if (!el) return;
    const head = h('div', { class: 'inspector-head' },
      h('span', { class: 'ent', text: el.entity + (el.predefinedType ? ' · ' + el.predefinedType : '') }),
      h('h2', { text: el.name || '(naamloos)' }),
      ids.length > 1 ? h('span', { class: 'pill', style: 'align-self:flex-start', text: ids.length + ' elementen geselecteerd' }) : null);
    box.appendChild(head);

    // manual classification
    if (S.config.classifications.length) {
      const sec = h('div', { class: 'section' });
      sec.appendChild(h('div', { class: 'eyebrow', text: 'Classificatie' + (ids.length > 1 ? ' (' + ids.length + ' elementen)' : '') }));
      S.config.classifications.forEach((scheme) => {
        const map = S.classResult[scheme.id] || new Map();
        const cur = map.get(el.id) || '';
        const manual = scheme.overrides && scheme.overrides[el.globalId];
        const sel = h('select', { class: 'select grow', 'aria-label': scheme.name, onchange: () => {
          scheme.overrides = scheme.overrides || {};
          ids.forEach((id) => {
            const e = S.model.byId.get(id);
            if (!e) return;
            if (sel.value === '__auto') delete scheme.overrides[e.globalId];
            else scheme.overrides[e.globalId] = sel.value;
          });
          recompute(false); persist(); refreshCounts(); renderCenter(); renderInspector();
          toast(sel.value === '__auto' ? 'Handmatige classificatie verwijderd' : ids.length + ' element(en) handmatig geclassificeerd');
        } },
        h('option', { value: '__auto', text: manual ? 'Automatisch (regels)' : (cur ? 'Automatisch: ' + labelOf(scheme, cur) : 'Automatisch: niet geclassificeerd'), selected: manual ? null : true }),
        scheme.classes.map((c) => h('option', { value: c.id, selected: manual === c.id ? true : null, text: 'Handmatig: ' + (c.code ? c.code + ' ' : '') + c.name })));
        sec.appendChild(h('div', { class: 'row' }, h('span', { class: 'hint', style: 'width:100%', text: scheme.name }), sel));
      });
      box.appendChild(sec);
    }

    // properties grouped
    const groups = new Map();
    Object.keys(el.props).forEach((k) => {
      const i = k.indexOf('::');
      const g = k.substring(0, i);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push([k, k.substring(i + 2), el.props[k]]);
    });
    const props = h('div', { class: 'props' });
    const ORDER = ['Attribuut', 'Locatie', 'Type', 'Materiaal', 'Classificatie', 'ITO-classificatie', 'Geometrie (berekend)'];
    const keys = Array.from(groups.keys()).sort((a, b) => {
      const ia = ORDER.indexOf(a); const ib = ORDER.indexOf(b);
      const ra = ia >= 0 ? ia : (/^Qto_|Quantities/i.test(a) ? 20 : 30); const rb = ib >= 0 ? ib : (/^Qto_|Quantities/i.test(b) ? 20 : 30);
      return ra - rb || a.localeCompare(b);
    });
    keys.forEach((g) => {
      const items = groups.get(g).filter((x) => !E.isEmpty(x[2]));
      if (!items.length) return;
      const det = h('details', { open: g === 'Attribuut' || /^Qto_|Quantities|Geometrie/i.test(g) ? true : null });
      det.appendChild(h('summary', null, h('span', { text: g }), h('span', { class: 'count', text: String(items.length) })));
      const dl = h('dl');
      items.forEach(([key, name, v]) => {
        dl.appendChild(h('dt', { text: name, title: key }));
        dl.appendChild(h('dd', { text: fmt(v, typeof v === 'number' && !Number.isInteger(v) ? 3 : null) }));
        dl.appendChild(h('button', { class: 'mini', type: 'button', title: 'Gebruik in filter of ITO', 'aria-label': 'Gebruik ' + name, onclick: (e) => quickMenu(e, key, v) }, '＋'));
      });
      det.appendChild(dl);
      props.appendChild(det);
    });
    box.appendChild(props);
  }

  function labelOf(scheme, classId) {
    const c = scheme.classes.find((x) => x.id === classId);
    return c ? (c.code ? c.code + ' ' : '') + c.name : '';
  }

  // Small menu next to a property: add it to a filter or to the current ITO.
  function quickMenu(ev, key, value) {
    closeModal();
    const f = currentFilter();
    const ito = currentIto();
    const isNum = typeof value === 'number';
    const actions = [
      ['Nieuw filter: ' + key.split('::')[1] + ' = ' + fmt(value), () => {
        const nf = { id: E.uid('f'), name: key.split('::')[1] + ' = ' + fmt(value), logic: 'and', conditions: [{ field: key, op: 'eq', value: E.toText(value) }] };
        S.config.filters.push(nf); S.selFilter = nf.id; S.leftTab = 'filters'; changed(); renderLeftTabs(); renderLeft();
        showSet('Filter: ' + nf.name, filterIds(nf));
      }],
      f ? ['Voeg voorwaarde toe aan filter "' + f.name + '"', () => {
        f.conditions.push({ field: key, op: 'eq', value: E.toText(value) }); S.leftTab = 'filters'; changed(); renderLeftTabs(); renderLeft();
      }] : null,
      ito ? ['Kolom toevoegen aan ITO "' + ito.name + '"' + (isNum ? ' (som)' : ' (groeperen)'), () => {
        ito.columns.push({ id: E.uid('k'), label: key.split('::')[1], source: 'field', field: key, agg: isNum ? 'sum' : (ito.mode === 'detail' ? 'first' : 'group'), decimals: isNum ? 2 : 0, factor: 1 });
        S.leftTab = 'ito'; S.centerTab = 'ito'; changed(); renderAll();
      }] : null
    ].filter(Boolean);
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) closeModal(); } });
    const m = h('div', { class: 'modal', role: 'dialog', 'aria-label': 'Eigenschap gebruiken' },
      h('h2', { text: key.split('::')[1] }),
      h('p', { class: 'hint', style: 'margin:0;font-family:var(--font-data)', text: key + ' = ' + fmt(value) }),
      h('div', { class: 'list' }, actions.map(([label, fn]) => h('button', { class: 'item', type: 'button', onclick: () => { closeModal(); fn(); } }, h('span', { class: 'name', text: label })))),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Annuleren')));
    back.appendChild(m);
    document.body.appendChild(back);
  }
  function closeModal() { document.querySelectorAll('.modal-back').forEach((m) => m.remove()); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // ---------------------------------------------------------------------------
  // Excel export
  // ---------------------------------------------------------------------------
  function exportExcel(preselect) {
    if (!S.model) { toast('Laad eerst een model.', true); return; }
    closeModal();
    const chosen = new Set(preselect || S.config.itos.map((i) => i.id));
    let withElements = false;
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) closeModal(); } });
    const list = h('div', { class: 'list' });
    S.config.itos.forEach((ito) => {
      const res = E.computeIto(S.model, ito, S.config, S.classResult);
      list.appendChild(h('label', { class: 'item' },
        h('input', { type: 'checkbox', checked: chosen.has(ito.id), onchange: (e) => { if (e.target.checked) chosen.add(ito.id); else chosen.delete(ito.id); } }),
        h('span', { class: 'name', text: ito.name }), h('span', { class: 'count', text: res.rows.length + ' regels' })));
    });
    const status = h('p', { class: 'hint', style: 'margin:0' });
    const go = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      if (!chosen.size) { status.textContent = 'Kies minimaal één ITO.'; return; }
      go.disabled = true; status.textContent = 'Werkmap wordt opgebouwd…';
      try {
        const results = S.config.itos.filter((i) => chosen.has(i.id)).map((ito) => {
          const r = E.computeIto(S.model, ito, S.config, S.classResult);
          const f = ito.scope && ito.scope.filterId ? S.config.filters.find((x) => x.id === ito.scope.filterId) : null;
          r.scopeLabel = f ? 'Filter: ' + f.name : 'Alle elementen';
          return r;
        });
        const blob = await ITO.excel.exportToBlob(results, { model: S.model, includeElements: withElements, elementFields: ['Attribuut::GlobalId', 'Attribuut::Entiteit', 'Attribuut::Naam', 'Type::Typenaam', 'Locatie::Bouwlaag', 'Materiaal::Materiaal'] });
        const base = S.model.fileName.replace(/\.ifc$/i, '');
        const fname = 'ITO_' + base + '_' + new Date().toISOString().slice(0, 10) + '.xlsx';
        await saveFile(blob, fname);
        closeModal();
        toast('Excel-bestand gemaakt: ' + fname);
      } catch (e) {
        console.error(e);
        status.textContent = e.message || String(e);
        status.className = 'err-text';
        go.disabled = false;
      }
    } }, 'Download .xlsx');
    const m = h('div', { class: 'modal', role: 'dialog', 'aria-label': 'Exporteer naar Excel' },
      h('h2', { text: 'Exporteer naar Excel' }),
      h('p', { class: 'hint', style: 'margin:0', text: 'Elke ITO wordt een werkblad met totalen (SUBTOTAAL-formules, dus ook kloppend na filteren in Excel). Het eerste werkblad is een overzicht.' }),
      list,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { withElements = e.target.checked; } }), 'Ook een werkblad met de onderliggende elementen per ITO (GlobalId, type, bouwlaag…)'),
      status,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Annuleren'), go));
    back.appendChild(m);
    document.body.appendChild(back);
  }

  // ---------------------------------------------------------------------------
  // Config import/export
  // ---------------------------------------------------------------------------
  function saveConfig() {
    const blob = new Blob([JSON.stringify(S.config, null, 2)], { type: 'application/json' });
    saveFile(blob, 'ito-configuratie.json').then(() => toast('Configuratie opgeslagen'));
  }
  function loadConfigFile(file) {
    if (!file) return;
    file.text().then((t) => {
      const c = JSON.parse(t);
      if (!c.filters || !c.itos || !c.classifications) throw new Error('Dit is geen ITO-configuratie.');
      S.config = c;
      S.selFilter = (c.filters[0] || {}).id || null;
      S.selScheme = (c.classifications[0] || {}).id || null;
      S.selIto = (c.itos[0] || {}).id || null;
      persist(); recompute(false); renderAll();
      toast('Configuratie geladen: ' + c.filters.length + ' filters, ' + c.classifications.length + ' schema\'s, ' + c.itos.length + " ITO's");
    }).catch((e) => toast('Kan configuratie niet laden: ' + e.message, true));
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  $('btn-open').addEventListener('click', () => $('file-ifc').click());
  $('file-ifc').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
  $('btn-demo').addEventListener('click', loadDemo);
  $('btn-export').addEventListener('click', () => exportExcel());
  $('btn-config-save').addEventListener('click', saveConfig);
  $('btn-config-load').addEventListener('click', () => $('file-config').click());
  $('file-config').addEventListener('change', (e) => { loadConfigFile(e.target.files[0]); e.target.value = ''; });
  // drag & drop of IFC or JSON files anywhere
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (!f) return;
    if (/\.json$/i.test(f.name)) loadConfigFile(f); else openFile(f);
  });

  window.ITO.app = { state: S, loadDemo, exportExcel, restoreDefaults: () => { S.config = E.defaultConfig(); persist(); recompute(false); renderAll(); } };

  renderAll();
  if (window.ITO_AUTOLOAD_DEMO !== false) loadDemo();
})();
