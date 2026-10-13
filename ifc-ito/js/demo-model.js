/*
 * Generates a small but realistic IFC4 demo model (two storeys of a small
 * office/house) with geometry, types, materials, property sets, quantity sets
 * and NL-SfB classification references. Used for the "Demo-model" button so
 * the application can be explored without an IFC file at hand.
 */
(function (root) {
  'use strict';

  function generateDemoIfc() {
    let next = 1;
    const lines = [];
    let seed = 20261013;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
    function guid() {
      let s = CH[Math.floor(rnd() * 4)];
      for (let i = 0; i < 21; i++) s += CH[Math.floor(rnd() * 64)];
      return s;
    }
    function str(v) {
      if (v == null) return '$';
      // encode non-ASCII as \X2\
      let out = '';
      for (const ch of String(v)) {
        const c = ch.charCodeAt(0);
        if (c > 126) out += '\\X2\\' + c.toString(16).toUpperCase().padStart(4, '0') + '\\X0\\';
        else if (ch === "'") out += "''";
        else out += ch;
      }
      return "'" + out + "'";
    }
    function num(v) { const s = String(+v.toFixed(6)); return s.indexOf('.') === -1 && s.indexOf('e') === -1 ? s + '.' : s; }
    function add(body) { const id = next++; lines.push('#' + id + '=' + body + ';'); return id; }
    function ref(ids) { return '(' + ids.map((i) => '#' + i).join(',') + ')'; }

    // ----- context & units
    const origin = add('IFCCARTESIANPOINT((0.,0.,0.))');
    const dirZ = add('IFCDIRECTION((0.,0.,1.))');
    const dirX = add('IFCDIRECTION((1.,0.,0.))');
    const wcs = add('IFCAXIS2PLACEMENT3D(#' + origin + ',#' + dirZ + ',#' + dirX + ')');
    const ctx = add("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#" + wcs + ',$)');
    const body = add("IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#" + ctx + ',$,.MODEL_VIEW.,$)');
    const uL = add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
    const uA = add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)');
    const uV = add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)');
    const uM = add('IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.)');
    const units = add('IFCUNITASSIGNMENT(' + ref([uL, uA, uV, uM]) + ')');
    const project = add('IFCPROJECT(' + str(guid()) + ",$,'Demo Kantoor De Linde',$,$,'Kantoorgebouw De Linde','VO'," + ref([ctx]) + ',#' + units + ')');

    // ----- spatial
    const plSite = add('IFCLOCALPLACEMENT($,#' + wcs + ')');
    const site = add('IFCSITE(' + str(guid()) + ",$,'Kavel 12',$,$,#" + plSite + ',$,$,.ELEMENT.,$,$,$,$,$)');
    const plBld = add('IFCLOCALPLACEMENT(#' + plSite + ',#' + wcs + ')');
    const bld = add('IFCBUILDING(' + str(guid()) + ",$,'Gebouw A',$,$,#" + plBld + ',$,$,.ELEMENT.,$,$,$)');
    add('IFCRELAGGREGATES(' + str(guid()) + ',$,$,$,#' + project + ',(#' + site + '))');
    add('IFCRELAGGREGATES(' + str(guid()) + ',$,$,$,#' + site + ',(#' + bld + '))');

    const H = 3000; // storey height mm
    const storeyDefs = [{ name: '00 Begane grond', elev: 0 }, { name: '01 Eerste verdieping', elev: H }];
    const storeys = storeyDefs.map((s) => {
      const p = add('IFCCARTESIANPOINT((0.,0.,' + num(s.elev) + '))');
      const ax = add('IFCAXIS2PLACEMENT3D(#' + p + ',$,$)');
      const pl = add('IFCLOCALPLACEMENT(#' + plBld + ',#' + ax + ')');
      const id = add('IFCBUILDINGSTOREY(' + str(guid()) + ',$,' + str(s.name) + ',$,$,#' + pl + ',$,$,.ELEMENT.,' + num(s.elev) + ')');
      return { id, pl, elev: s.elev, elements: [] };
    });
    add('IFCRELAGGREGATES(' + str(guid()) + ',$,$,$,#' + bld + ',' + ref(storeys.map((s) => s.id)) + ')');

    // ----- styles & materials
    const styles = {};
    function style(name, r, g, b, transp) {
      if (styles[name]) return styles[name];
      const c = add('IFCCOLOURRGB($,' + num(r) + ',' + num(g) + ',' + num(b) + ')');
      const sh = add('IFCSURFACESTYLESHADING(#' + c + ',' + num(transp || 0) + ')');
      styles[name] = add('IFCSURFACESTYLE(' + str(name) + ',.BOTH.,(#' + sh + '))');
      return styles[name];
    }
    const materials = {};
    function material(name, category) {
      if (!materials[name]) materials[name] = add('IFCMATERIAL(' + str(name) + ',$,' + str(category || null) + ')');
      return materials[name];
    }

    // ----- classification (NL-SfB)
    const nlsfb = add("IFCCLASSIFICATION('BIM Loket','2005',$,'NL-SfB',$,$,$)");
    const classRefs = {};
    function classify(code, name, objIds) {
      if (!objIds.length) return;
      if (!classRefs[code]) classRefs[code] = add('IFCCLASSIFICATIONREFERENCE($,' + str(code) + ',' + str(name) + ',#' + nlsfb + ',$,$)');
      add('IFCRELASSOCIATESCLASSIFICATION(' + str(guid()) + ',$,$,$,' + ref(objIds) + ',#' + classRefs[code] + ')');
    }

    // ----- helpers for geometry
    function box(storey, x, y, z, rotDeg, lx, ly, lz, styleId, offsetX) {
      // local placement at (x,y,z) relative to storey, rotated around Z
      const a = rotDeg * Math.PI / 180;
      const p = add('IFCCARTESIANPOINT((' + num(x) + ',' + num(y) + ',' + num(z) + '))');
      const rd = add('IFCDIRECTION((' + num(Math.cos(a)) + ',' + num(Math.sin(a)) + ',0.))');
      const ax = add('IFCAXIS2PLACEMENT3D(#' + p + ',#' + dirZ + ',#' + rd + ')');
      const pl = add('IFCLOCALPLACEMENT(#' + storey.pl + ',#' + ax + ')');
      const pc = add('IFCCARTESIANPOINT((' + num(offsetX == null ? lx / 2 : offsetX) + ',0.))');
      const a2 = add('IFCAXIS2PLACEMENT2D(#' + pc + ',$)');
      const prof = add('IFCRECTANGLEPROFILEDEF(.AREA.,$,#' + a2 + ',' + num(lx) + ',' + num(ly) + ')');
      const solid = add('IFCEXTRUDEDAREASOLID(#' + prof + ',#' + wcs + ',#' + dirZ + ',' + num(lz) + ')');
      if (styleId) add('IFCSTYLEDITEM(#' + solid + ',(#' + styleId + '),$)');
      const rep = add("IFCSHAPEREPRESENTATION(#" + body + ",'Body','SweptSolid',(#" + solid + '))');
      const shape = add('IFCPRODUCTDEFINITIONSHAPE($,$,(#' + rep + '))');
      return { pl, shape };
    }
    function val(type, v) {
      if (type === 'IFCBOOLEAN') return 'IFCBOOLEAN(' + (v ? '.T.' : '.F.') + ')';
      if (type === 'IFCLABEL' || type === 'IFCIDENTIFIER' || type === 'IFCTEXT') return type + '(' + str(v) + ')';
      return type + '(' + num(v) + ')';
    }
    function pset(name, objIds, props) {
      const ps = Object.keys(props).map((k) => {
        const [t, v] = props[k];
        return add('IFCPROPERTYSINGLEVALUE(' + str(k) + ',$,' + val(t, v) + ',$)');
      });
      const id = add('IFCPROPERTYSET(' + str(guid()) + ',$,' + str(name) + ',$,' + ref(ps) + ')');
      add('IFCRELDEFINESBYPROPERTIES(' + str(guid()) + ',$,$,$,' + ref(objIds) + ',#' + id + ')');
    }
    const QT = { L: ['IFCQUANTITYLENGTH', 'IFCLENGTHMEASURE'], A: ['IFCQUANTITYAREA'], V: ['IFCQUANTITYVOLUME'], W: ['IFCQUANTITYWEIGHT'], C: ['IFCQUANTITYCOUNT'] };
    function qto(name, objIds, q) {
      const qs = Object.keys(q).map((k) => {
        const [t, v] = q[k];
        return add(QT[t][0] + '(' + str(k) + ',$,$,' + num(v) + ',$)');
      });
      const id = add('IFCELEMENTQUANTITY(' + str(guid()) + ",$," + str(name) + ",$,'BaseQuantities'," + ref(qs) + ')');
      add('IFCRELDEFINESBYPROPERTIES(' + str(guid()) + ',$,$,$,' + ref(objIds) + ',#' + id + ')');
    }
    const types = {};
    function typeObj(entity, name, predefined, typePsets) {
      if (types[name]) return types[name];
      let psIds = '$';
      if (typePsets) {
        const ids = Object.keys(typePsets).map((psName) => {
          const props = typePsets[psName];
          const ps = Object.keys(props).map((k) => add('IFCPROPERTYSINGLEVALUE(' + str(k) + ',$,' + val(props[k][0], props[k][1]) + ',$)'));
          return add('IFCPROPERTYSET(' + str(guid()) + ',$,' + str(psName) + ',$,' + ref(ps) + ')');
        });
        psIds = ref(ids);
      }
      let tail;
      if (entity === 'IFCWINDOWTYPE') tail = '.' + predefined + '.,.NOTDEFINED.,$,$)';
      else if (entity === 'IFCDOORTYPE') tail = '.' + predefined + '.,.NOTDEFINED.,$,$)';
      else tail = '.' + predefined + '.)';
      const id = add(entity + '(' + str(guid()) + ',$,' + str(name) + ',$,$,' + psIds + ',$,$,$,' + tail);
      types[name] = { id, objects: [] };
      return types[name];
    }
    const layerSets = {};
    function layerSet(name, layers) {
      if (layerSets[name]) return layerSets[name];
      const ls = layers.map(([m, t, cat]) => add('IFCMATERIALLAYER(#' + material(m, cat) + ',' + num(t) + ',$,$,$,$,$)'));
      const set = add('IFCMATERIALLAYERSET(' + ref(ls) + ',' + str(name) + ',$)');
      layerSets[name] = { set, usages: [] };
      return layerSets[name];
    }
    const matAssoc = new Map(); // material/usage id -> [objects]
    function assocMat(matId, obj) {
      if (!matAssoc.has(matId)) matAssoc.set(matId, []);
      matAssoc.get(matId).push(obj);
    }

    const sConcrete = style('Beton', 0.72, 0.72, 0.70);
    const sBrick = style('Metselwerk', 0.66, 0.36, 0.26);
    const sKzs = style('Kalkzandsteen', 0.90, 0.88, 0.82);
    const sSteel = style('Staal', 0.30, 0.38, 0.48);
    const sGlass = style('Glas', 0.55, 0.75, 0.88, 0.55);
    const sWood = style('Hout', 0.62, 0.45, 0.28);
    const sGypsum = style('Gips', 0.95, 0.95, 0.95);

    const W = 14400; const D = 9600; // footprint mm
    const classTodo = {}; // code -> {name, ids}
    function todo(code, name, id) {
      if (!classTodo[code]) classTodo[code] = { name, ids: [] };
      classTodo[code].ids.push(id);
    }

    function wall(storey, x1, y1, x2, y2, kind, opts) {
      opts = opts || {};
      const len = Math.hypot(x2 - x1, y2 - y1);
      const rot = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      const ext = kind === 'ext';
      const t = ext ? 434 : (kind === 'stab' ? 214 : 100);
      const g = box(storey, x1, y1, 0, rot, len, t, H, ext ? sBrick : (kind === 'stab' ? sKzs : sGypsum));
      const typeName = ext ? 'WA_Buitenwand_KZS214_ISO120_MW100' : (kind === 'stab' ? 'WA_Binnenwand_KZS214' : 'WA_Scheidingswand_MS100');
      const nm = ext ? 'Buitenwand' : (kind === 'stab' ? 'Dragende binnenwand' : 'Metal stud wand');
      const id = add('IFCWALL(' + str(guid()) + ',$,' + str(nm) + ',$,' + str(typeName) + ',#' + g.pl + ',#' + g.shape + ',' + str(opts.tag || null) + ',.' + (ext || kind === 'stab' ? 'SOLIDWALL' : 'PARTITIONING') + '.)');
      storey.elements.push(id);
      const ty = typeObj('IFCWALLTYPE', typeName, ext || kind === 'stab' ? 'SOLIDWALL' : 'PARTITIONING',
        { Pset_WallCommon: { Reference: ['IFCIDENTIFIER', typeName.split('_')[1]], AcousticRating: ['IFCLABEL', ext ? 'Rw 52 dB' : 'Rw 45 dB'] } });
      ty.objects.push(id);
      const ls = ext ? layerSet('Buitenwand spouw', [['Kalkzandsteen CS12', 214, 'Steenachtig'], ['Minerale wol', 120, 'Isolatie'], ['Baksteen waalformaat', 100, 'Steenachtig']])
        : kind === 'stab' ? layerSet('Kalkzandsteen 214', [['Kalkzandsteen CS12', 214, 'Steenachtig']])
          : layerSet('Metal stud', [['Gipsplaat', 12.5, 'Afbouw'], ['Minerale wol', 75, 'Isolatie'], ['Gipsplaat', 12.5, 'Afbouw']]);
      const usage = add('IFCMATERIALLAYERSETUSAGE(#' + ls.set + ',.AXIS2.,.POSITIVE.,' + num(-t / 2) + ',$)');
      assocMat(usage, id);
      const openingArea = opts.openings || 0;
      pset('Pset_WallCommon', [id], {
        IsExternal: ['IFCBOOLEAN', ext], LoadBearing: ['IFCBOOLEAN', ext || kind === 'stab'],
        FireRating: ['IFCLABEL', ext ? '60 min' : (kind === 'stab' ? '60 min' : '30 min')],
        ThermalTransmittance: ['IFCREAL', ext ? 0.21 : 1.8]
      });
      qto('Qto_WallBaseQuantities', [id], {
        Length: ['L', len], Height: ['L', H], Width: ['L', t],
        GrossSideArea: ['A', len * H / 1e6], NetSideArea: ['A', len * H / 1e6 - openingArea],
        GrossVolume: ['V', len * H * t / 1e9], NetVolume: ['V', (len * H / 1e6 - openingArea) * t / 1000]
      });
      if (opts.classify !== false) todo(ext ? '21.1' : '22.1', ext ? 'buitenwanden; niet constructief' : 'binnenwanden; niet constructief', id);
      return id;
    }

    function slab(storey, z, thick, kind) {
      const roof = kind === 'roof';
      const g = box(storey, 0, D / 2, z - thick, 0, W, D, thick, sConcrete, W / 2);
      const typeName = roof ? 'DA_Kanaalplaat_200' : 'VL_Kanaalplaat_260';
      const id = add('IFCSLAB(' + str(guid()) + ',$,' + str(roof ? 'Dakvloer' : 'Verdiepingsvloer') + ',$,' + str(typeName) + ',#' + g.pl + ',#' + g.shape + ',$,.' + (roof ? 'ROOF' : 'FLOOR') + '.)');
      storey.elements.push(id);
      typeObj('IFCSLABTYPE', typeName, roof ? 'ROOF' : 'FLOOR').objects.push(id);
      assocMat(material('Beton C35/45', 'Beton'), id);
      pset('Pset_SlabCommon', [id], { IsExternal: ['IFCBOOLEAN', roof], LoadBearing: ['IFCBOOLEAN', true], FireRating: ['IFCLABEL', '90 min'] });
      qto('Qto_SlabBaseQuantities', [id], {
        Width: ['L', thick], Perimeter: ['L', 2 * (W + D)], GrossArea: ['A', W * D / 1e6], NetArea: ['A', W * D / 1e6 - (roof ? 0 : 4.32)],
        GrossVolume: ['V', W * D * thick / 1e9], NetVolume: ['V', (W * D / 1e6 - (roof ? 0 : 4.32)) * thick / 1000],
        GrossWeight: ['W', W * D * thick / 1e9 * 2400 * 0.55]
      });
      // roof slabs are left unclassified on purpose: the rule-based classification picks them up
      if (!roof) todo('23.1', 'vloeren; constructief', id);
      return id;
    }

    function column(storey, x, y) {
      const g = box(storey, x - 100, y, 0, 0, 200, 200, H, sSteel, 100);
      const id = add('IFCCOLUMN(' + str(guid()) + ",$,'Kolom HEA200',$,'KO_Staal_HEA200',#" + g.pl + ',#' + g.shape + ',$,.COLUMN.)');
      storey.elements.push(id);
      typeObj('IFCCOLUMNTYPE', 'KO_Staal_HEA200', 'COLUMN', { Pset_ColumnCommon: { Reference: ['IFCIDENTIFIER', 'HEA200'] } }).objects.push(id);
      assocMat(material('Staal S235', 'Staal'), id);
      pset('Pset_ColumnCommon', [id], { IsExternal: ['IFCBOOLEAN', false], LoadBearing: ['IFCBOOLEAN', true], FireRating: ['IFCLABEL', '60 min'] });
      qto('Qto_ColumnBaseQuantities', [id], { Length: ['L', H], CrossSectionArea: ['A', 0.00538], GrossVolume: ['V', 0.00538 * H / 1000], GrossWeight: ['W', 42.3 * H / 1000] });
      todo('28.1', 'kolommen', id);
      return id;
    }

    function beam(storey, x1, y1, x2, y2) {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const rot = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      const g = box(storey, x1, y1, H - 260 - 300, rot, len, 200, 300, sSteel);
      const id = add('IFCBEAM(' + str(guid()) + ",$,'Ligger HEB300',$,'BA_Staal_HEB300',#" + g.pl + ',#' + g.shape + ',$,.BEAM.)');
      storey.elements.push(id);
      typeObj('IFCBEAMTYPE', 'BA_Staal_HEB300', 'BEAM').objects.push(id);
      assocMat(material('Staal S235', 'Staal'), id);
      pset('Pset_BeamCommon', [id], { LoadBearing: ['IFCBOOLEAN', true], FireRating: ['IFCLABEL', '60 min'], Span: ['IFCPOSITIVELENGTHMEASURE', len] });
      qto('Qto_BeamBaseQuantities', [id], { Length: ['L', len], CrossSectionArea: ['A', 0.0149], NetVolume: ['V', 0.0149 * len / 1000], NetWeight: ['W', 117 * len / 1000] });
      todo('28.2', 'balken', id);
      return id;
    }

    function windowEl(storey, x, y, rot, w, h, sill, typeName) {
      const g = box(storey, x, y, sill, rot, w, 120, h, sGlass);
      const id = add('IFCWINDOW(' + str(guid()) + ',$,' + str('Raam ' + (w / 1000).toFixed(1) + 'x' + (h / 1000).toFixed(1)) + ',$,' + str(typeName) + ',#' + g.pl + ',#' + g.shape + ',$,' + num(h) + ',' + num(w) + ',.WINDOW.,.SINGLE_PANEL.,$)');
      storey.elements.push(id);
      typeObj('IFCWINDOWTYPE', typeName, 'WINDOW', { Pset_WindowCommon: { ThermalTransmittance: ['IFCREAL', 1.1], GlazingAreaFraction: ['IFCREAL', 0.78] } }).objects.push(id);
      assocMat(material('Aluminium', 'Metaal'), id);
      pset('Pset_WindowCommon', [id], { IsExternal: ['IFCBOOLEAN', true], FireRating: ['IFCLABEL', '-'], Infiltration: ['IFCREAL', 0.2] });
      qto('Qto_WindowBaseQuantities', [id], { Width: ['L', w], Height: ['L', h], Area: ['A', w * h / 1e6], Perimeter: ['L', 2 * (w + h)] });
      todo('31.2', 'ramen', id);
      return id;
    }

    function door(storey, x, y, rot, w, h, typeName, external) {
      const g = box(storey, x, y, 0, rot, w, external ? 120 : 60, h, sWood);
      const id = add('IFCDOOR(' + str(guid()) + ',$,' + str(external ? 'Voordeur' : 'Binnendeur') + ',$,' + str(typeName) + ',#' + g.pl + ',#' + g.shape + ',$,' + num(h) + ',' + num(w) + ',.DOOR.,.SINGLE_SWING_LEFT.,$)');
      storey.elements.push(id);
      typeObj('IFCDOORTYPE', typeName, 'DOOR', { Pset_DoorCommon: { FireRating: ['IFCLABEL', external ? '-' : '30 min'] } }).objects.push(id);
      assocMat(material(external ? 'Hardhout Meranti' : 'Plaatmateriaal HPL', 'Hout'), id);
      pset('Pset_DoorCommon', [id], { IsExternal: ['IFCBOOLEAN', !!external], FireRating: ['IFCLABEL', external ? '-' : '30 min'], HandicapAccessible: ['IFCBOOLEAN', true] });
      qto('Qto_DoorBaseQuantities', [id], { Width: ['L', w], Height: ['L', h], Area: ['A', w * h / 1e6] });
      // inner doors deliberately left unclassified
      if (external) todo('32.1', 'buitendeuren', id);
      return id;
    }

    function space(storey, name, longName, x, y, w, d) {
      const g = box(storey, x, y + d / 2, 0, 0, w, d, H - 300, null, w / 2);
      const id = add('IFCSPACE(' + str(guid()) + ',$,' + str(name) + ',$,$,#' + g.pl + ',#' + g.shape + ',' + str(longName) + ',.ELEMENT.,.INTERNAL.,$)');
      pset('Pset_SpaceCommon', [id], { IsExternal: ['IFCBOOLEAN', false], Reference: ['IFCIDENTIFIER', name], NetPlannedArea: ['IFCAREAMEASURE', w * d / 1e6] });
      qto('Qto_SpaceBaseQuantities', [id], { NetFloorArea: ['A', w * d / 1e6], GrossFloorArea: ['A', w * d / 1e6], NetPerimeter: ['L', 2 * (w + d)], Height: ['L', H - 300], NetVolume: ['V', w * d * (H - 300) / 1e9] });
      return id;
    }

    const spacesPerStorey = new Map();
    storeys.forEach((s, si) => {
      const isTop = si === storeys.length - 1;
      // external walls (window area per facade subtracted from NetSideArea)
      wall(s, 0, 0, W, 0, 'ext', { openings: si === 0 ? 3 * 1.8 * 1.5 + 2.3 : 3 * 1.8 * 1.5, tag: 'W-' + si + '01' });
      wall(s, W, 0, W, D, 'ext', { openings: 1.8 * 1.5, tag: 'W-' + si + '02' });
      wall(s, W, D, 0, D, 'ext', { openings: 3 * 1.8 * 1.5, tag: 'W-' + si + '03' });
      wall(s, 0, D, 0, 0, 'ext', { openings: 0, tag: 'W-' + si + '04', classify: si === 0 });
      // internal
      wall(s, 4800, 175, 4800, D - 175, 'stab', { tag: 'W-' + si + '10' });
      wall(s, 4975, 4800, W - 175, 4800, 'part', { tag: 'W-' + si + '11' });
      wall(s, 9600, 175, 9600, 4750, 'part', { tag: 'W-' + si + '12', classify: false });
      // floor slab (ground floor) and roof/upper floor on top
      if (si === 0) slab(s, 0, 260, 'floor');
      slab(s, H, isTop ? 200 : 260, isTop ? 'roof' : 'floor');
      // columns + beams
      [2400, 7200, 12000].forEach((x) => column(s, x, D / 2));
      beam(s, 2400, D / 2, 12000, D / 2);
      // windows
      [1200, 6000, 10800].forEach((x) => windowEl(s, x, 0, 0, 1800, 1500, 900, 'KZ_Draairaam_1800x1500'));
      windowEl(s, W, 3000, 90, 1800, 1500, 900, 'KZ_Draairaam_1800x1500');
      [2000, 7200, 11000].forEach((x) => windowEl(s, x, D, 180, 1800, 1500, 900, 'KZ_Draairaam_1800x1500'));
      // doors
      if (si === 0) door(s, 3900, 0, 0, 1000, 2300, 'DR_Buitendeur_1000x2300', true);
      door(s, 4800, 1200, 90, 930, 2315, 'DR_Binnendeur_930x2315');
      door(s, 7000, 4800, 0, 930, 2315, 'DR_Binnendeur_930x2315');
      door(s, 11500, 4800, 0, 930, 2315, 'DR_Binnendeur_930x2315');
      // spaces
      const sp = [
        space(s, si + '.01', si === 0 ? 'Entree / ontvangst' : 'Vergaderruimte', 175, 175, 4625 - 50, D - 350),
        space(s, si + '.02', 'Kantoor', 4850, 175, 4750 - 50, 4625 - 50),
        space(s, si + '.03', si === 0 ? 'Pantry' : 'Kantoor', 9650, 175, W - 175 - 9650, 4625 - 50),
        space(s, si + '.04', 'Open werkplek', 4850, 4850, W - 175 - 4850, D - 175 - 4850)
      ];
      spacesPerStorey.set(s.id, sp);
    });

    // relations
    storeys.forEach((s) => {
      add('IFCRELCONTAINEDINSPATIALSTRUCTURE(' + str(guid()) + ',$,$,$,' + ref(s.elements) + ',#' + s.id + ')');
      add('IFCRELAGGREGATES(' + str(guid()) + ',$,$,$,#' + s.id + ',' + ref(spacesPerStorey.get(s.id)) + ')');
    });
    Object.keys(types).forEach((n) => {
      const t = types[n];
      if (t.objects.length) add('IFCRELDEFINESBYTYPE(' + str(guid()) + ',$,$,$,' + ref(t.objects) + ',#' + t.id + ')');
    });
    matAssoc.forEach((objs, m) => add('IFCRELASSOCIATESMATERIAL(' + str(guid()) + ',$,$,$,' + ref(objs) + ',#' + m + ')'));
    Object.keys(classTodo).forEach((code) => classify(code, classTodo[code].name, classTodo[code].ids));

    const header = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
      "FILE_NAME('Demo_Kantoor_De_Linde.ifc','2026-10-13T12:00:00',('IFC ITO'),('IFC ITO demo'),'IFC ITO','IFC ITO demo-generator','');",
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;',
      'DATA;'
    ];
    return header.concat(lines, ['ENDSEC;', 'END-ISO-10303-21;']).join('\n');
  }

  root.ITO = root.ITO || {};
  root.ITO.generateDemoIfc = generateDemoIfc;
  if (typeof module !== 'undefined' && module.exports) module.exports = { generateDemoIfc };
})(typeof window !== 'undefined' ? window : globalThis);
