/*
 * IFC (STEP Physical File, ISO 10303-21) parser.
 *
 * Reads the alphanumeric part of an IFC file (IFC2X3 / IFC4 / IFC4X3) without
 * any external dependency and turns it into a flat list of elements with their
 * attributes, property sets, quantity sets, type, materials, classifications
 * and spatial location (building storey). Geometry is not interpreted here;
 * the optional 3D viewer handles that through web-ifc.
 *
 * Entities are indexed in one pass and their arguments are only parsed when
 * needed, so large files with lots of geometry stay fast.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // STEP value model
  // ---------------------------------------------------------------------------
  function Ref(id) { this.r = id; }
  function Enum(v) { this.e = v; }
  function Typed(t, v) { this.t = t; this.v = v; }

  // Decodes the escape sequences of ISO 10303-21 strings.
  function decodeStepString(s) {
    if (s.indexOf('\\') === -1) return s;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '\\') { out += c; continue; }
      if (s.startsWith('\\X2\\', i)) {
        const end = s.indexOf('\\X0\\', i + 4);
        const hex = s.substring(i + 4, end);
        for (let k = 0; k + 4 <= hex.length; k += 4) out += String.fromCharCode(parseInt(hex.substr(k, 4), 16));
        i = end + 3;
      } else if (s.startsWith('\\X4\\', i)) {
        const end = s.indexOf('\\X0\\', i + 4);
        const hex = s.substring(i + 4, end);
        for (let k = 0; k + 8 <= hex.length; k += 8) out += String.fromCodePoint(parseInt(hex.substr(k, 8), 16));
        i = end + 3;
      } else if (s.startsWith('\\X\\', i)) {
        out += String.fromCharCode(parseInt(s.substr(i + 3, 2), 16));
        i += 4;
      } else if (s.startsWith('\\S\\', i)) {
        out += String.fromCharCode(s.charCodeAt(i + 3) + 128);
        i += 3;
      } else if (s[i + 1] === 'P' && s[i + 3] === '\\') {
        i += 3; // code page directive, ignored
      } else if (s[i + 1] === '\\') {
        out += '\\';
        i += 1;
      } else {
        out += c;
      }
    }
    return out;
  }

  // Parses the argument list of one entity instance: text between the outer
  // parentheses, e.g. "'abc',#12,$,(1.,2.),.T.,IFCLABEL('x')".
  function parseArgs(text) {
    let i = 0;
    const n = text.length;

    function skipWs() {
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) i++;
        else break;
      }
    }

    function value() {
      skipWs();
      const c = text[i];
      if (c === '$') { i++; return null; }
      if (c === '*') { i++; return null; }
      if (c === '#') {
        let j = i + 1;
        while (j < n && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++;
        const id = +text.substring(i + 1, j);
        i = j;
        return new Ref(id);
      }
      if (c === "'") {
        let j = i + 1;
        let s = '';
        for (;;) {
          const k = text.indexOf("'", j);
          if (k === -1) { s += text.substring(j); i = n; break; }
          if (text[k + 1] === "'") { s += text.substring(j, k + 1); j = k + 2; continue; }
          s += text.substring(j, k);
          i = k + 1;
          break;
        }
        return decodeStepString(s);
      }
      if (c === '"') {
        const k = text.indexOf('"', i + 1);
        const s = text.substring(i + 1, k);
        i = k + 1;
        return s;
      }
      if (c === '.') {
        const k = text.indexOf('.', i + 1);
        const s = text.substring(i + 1, k);
        i = k + 1;
        if (s === 'T') return true;
        if (s === 'F') return false;
        if (s === 'U') return null;
        return new Enum(s);
      }
      if (c === '(') {
        i++;
        return list();
      }
      if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
        let j = i;
        while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
        const t = text.substring(i, j).toUpperCase();
        i = j;
        skipWs();
        if (text[i] === '(') {
          i++;
          const inner = list();
          return new Typed(t, inner.length === 1 ? inner[0] : inner);
        }
        return new Enum(t);
      }
      // number
      let j = i;
      while (j < n && /[0-9eE+\-.]/.test(text[j])) j++;
      const num = parseFloat(text.substring(i, j));
      i = j;
      return num;
    }

    function list() {
      const arr = [];
      skipWs();
      if (text[i] === ')') { i++; return arr; }
      for (;;) {
        arr.push(value());
        skipWs();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ')') { i++; break; }
        if (i >= n) break;
        i++; // tolerate garbage
      }
      return arr;
    }

    const res = [];
    skipWs();
    while (i < n) {
      res.push(value());
      skipWs();
      if (text[i] === ',') i++;
      else break;
    }
    return res;
  }

  // ---------------------------------------------------------------------------
  // STEP file index
  // ---------------------------------------------------------------------------
  function StepFile(text) {
    this.text = text;
    this.index = new Map(); // id -> [typeUpper, argStart, argEnd]
    this.byType = new Map(); // typeUpper -> [ids]
    this.cache = new Map();
    this.header = {};
    this._scan();
  }

  StepFile.prototype._scan = function () {
    const text = this.text;
    const n = text.length;
    const hs = text.indexOf('HEADER;');
    const ds = text.indexOf('DATA;');
    if (ds === -1) throw new Error('Geen geldig IFC-bestand: DATA-sectie ontbreekt.');
    if (hs !== -1) {
      const head = text.substring(hs, ds);
      const m = head.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
      if (m) this.header.schema = m[1].toUpperCase();
      const fn = head.match(/FILE_NAME\s*\(\s*'([^']*)'\s*,\s*'([^']*)'/i);
      if (fn) { this.header.name = decodeStepString(fn[1]); this.header.timestamp = fn[2]; }
      const fd = head.match(/FILE_DESCRIPTION\s*\(\s*\(([^)]*)\)/i);
      if (fd) this.header.description = fd[1];
      const app = head.match(/FILE_NAME\s*\((?:[^']*'(?:[^']|'')*'){5}[^']*'((?:[^']|'')*)'/i);
      if (app) this.header.application = decodeStepString(app[1]);
    }
    let i = ds + 5;
    while (i < n) {
      const hash = text.indexOf('#', i);
      if (hash === -1) break;
      // Find "=" after id
      let j = hash + 1;
      while (j < n && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++;
      const id = +text.substring(hash + 1, j);
      while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r' || text[j] === '\n')) j++;
      if (text[j] !== '=') { i = j + 1; continue; }
      j++;
      while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r' || text[j] === '\n')) j++;
      const ts = j;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
      const type = text.substring(ts, j).toUpperCase();
      const open = text.indexOf('(', j);
      // Scan to the terminating ';' outside of strings.
      let k = open + 1;
      let inStr = false;
      for (; k < n; k++) {
        const c = text.charCodeAt(k);
        if (inStr) {
          if (c === 39) { if (text.charCodeAt(k + 1) === 39) k++; else inStr = false; }
        } else if (c === 39) inStr = true;
        else if (c === 59) break; // ;
      }
      // argument text is between open+1 and the last ')' before k
      let close = k - 1;
      while (close > open && text[close] !== ')') close--;
      this.index.set(id, [type, open + 1, close]);
      let arr = this.byType.get(type);
      if (!arr) { arr = []; this.byType.set(type, arr); }
      arr.push(id);
      i = k + 1;
      if (text.startsWith('ENDSEC', i) || text.startsWith('\nENDSEC', i) || text.startsWith('\r\nENDSEC', i)) break;
    }
  };

  StepFile.prototype.type = function (id) {
    const e = this.index.get(id);
    return e ? e[0] : null;
  };

  StepFile.prototype.args = function (id) {
    let a = this.cache.get(id);
    if (a) return a;
    const e = this.index.get(id);
    if (!e) return null;
    a = parseArgs(this.text.substring(e[1], e[2]));
    this.cache.set(id, a);
    return a;
  };

  StepFile.prototype.ids = function (type) {
    return this.byType.get(type) || [];
  };

  // ---------------------------------------------------------------------------
  // IFC knowledge
  // ---------------------------------------------------------------------------
  const ELEMENT_TYPES = [
    'IfcWall', 'IfcWallStandardCase', 'IfcWallElementedCase', 'IfcSlab', 'IfcSlabStandardCase',
    'IfcSlabElementedCase', 'IfcBeam', 'IfcBeamStandardCase', 'IfcColumn', 'IfcColumnStandardCase',
    'IfcDoor', 'IfcDoorStandardCase', 'IfcWindow', 'IfcWindowStandardCase', 'IfcRoof', 'IfcStair',
    'IfcStairFlight', 'IfcRamp', 'IfcRampFlight', 'IfcRailing', 'IfcCovering', 'IfcCurtainWall',
    'IfcPlate', 'IfcPlateStandardCase', 'IfcMember', 'IfcMemberStandardCase', 'IfcFooting', 'IfcPile',
    'IfcBuildingElementProxy', 'IfcBuildingElementPart', 'IfcBuildingElementComponent', 'IfcChimney',
    'IfcShadingDevice', 'IfcFurnishingElement', 'IfcFurniture', 'IfcSystemFurnitureElement',
    'IfcFlowTerminal', 'IfcFlowSegment', 'IfcFlowFitting', 'IfcFlowController', 'IfcFlowMovingDevice',
    'IfcFlowStorageDevice', 'IfcFlowTreatmentDevice', 'IfcEnergyConversionDevice',
    'IfcDistributionControlElement', 'IfcDistributionElement', 'IfcDistributionFlowElement',
    'IfcDistributionChamberElement', 'IfcReinforcingBar', 'IfcReinforcingMesh', 'IfcTendon',
    'IfcTendonAnchor', 'IfcDiscreteAccessory', 'IfcMechanicalFastener', 'IfcFastener',
    'IfcElementAssembly', 'IfcTransportElement', 'IfcGeographicElement', 'IfcCivilElement',
    'IfcEarthworksFill', 'IfcEarthworksCut', 'IfcCourse', 'IfcPavement', 'IfcKerb', 'IfcSpace',
    'IfcPipeSegment', 'IfcPipeFitting', 'IfcDuctSegment', 'IfcDuctFitting', 'IfcDuctSilencer',
    'IfcAirTerminal', 'IfcAirTerminalBox', 'IfcSanitaryTerminal', 'IfcLightFixture', 'IfcLamp',
    'IfcValve', 'IfcPump', 'IfcCableSegment', 'IfcCableFitting', 'IfcCableCarrierSegment',
    'IfcCableCarrierFitting', 'IfcOutlet', 'IfcSwitchingDevice', 'IfcSpaceHeater', 'IfcBoiler',
    'IfcTank', 'IfcFireSuppressionTerminal', 'IfcElectricAppliance', 'IfcSensor', 'IfcAlarm',
    'IfcDamper', 'IfcFan', 'IfcUnitaryEquipment', 'IfcChiller', 'IfcCoil', 'IfcHeatExchanger',
    'IfcFilter', 'IfcFlowMeter', 'IfcJunctionBox', 'IfcProtectiveDevice', 'IfcStackTerminal',
    'IfcWasteTerminal', 'IfcCommunicationsAppliance', 'IfcAudioVisualAppliance', 'IfcMedicalDevice',
    'IfcElectricDistributionBoard', 'IfcElectricGenerator', 'IfcElectricMotor', 'IfcTransformer',
    'IfcController', 'IfcActuator', 'IfcUnitaryControlElement', 'IfcBurner', 'IfcCompressor',
    'IfcCondenser', 'IfcCooledBeam', 'IfcCoolingTower', 'IfcEvaporativeCooler', 'IfcEvaporator',
    'IfcHumidifier', 'IfcInterceptor', 'IfcSolarDevice', 'IfcTubeBundle', 'IfcBearing',
    'IfcDeepFoundation', 'IfcCaissonFoundation', 'IfcSurfaceFeature', 'IfcSign', 'IfcSignal',
    'IfcRail', 'IfcTrackElement', 'IfcMooringDevice', 'IfcNavigationElement', 'IfcVibrationIsolator',
    'IfcVibrationDamper', 'IfcImpactProtectionDevice', 'IfcReinforcedSoil'
  ];
  const SPATIAL_TYPES = ['IfcProject', 'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcSpace',
    'IfcFacility', 'IfcFacilityPart', 'IfcBridge', 'IfcRoad', 'IfcRailway', 'IfcMarineFacility',
    'IfcBridgePart', 'IfcRoadPart', 'IfcRailwayPart', 'IfcExternalSpatialElement', 'IfcSpatialZone'];
  const NOT_ELEMENTS = new Set(['IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE', 'IFCVIRTUALELEMENT',
    'IFCANNOTATION', 'IFCGRID', 'IFCVOIDINGFEATURE', 'IFCPORT', 'IFCDISTRIBUTIONPORT',
    'IFCALIGNMENT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCPROJECT']);

  const CAMEL = new Map();
  ELEMENT_TYPES.concat(SPATIAL_TYPES, ['IfcOpeningElement', 'IfcVirtualElement', 'IfcAnnotation',
    'IfcGrid']).forEach((t) => CAMEL.set(t.toUpperCase(), t));
  ELEMENT_TYPES.forEach((t) => CAMEL.set(t.toUpperCase() + 'TYPE', t + 'Type'));
  ['IfcSpaceType', 'IfcWallType', 'IfcDoorStyle', 'IfcWindowStyle'].forEach((t) => CAMEL.set(t.toUpperCase(), t));
  function prettyType(upper) {
    return CAMEL.get(upper) || ('Ifc' + upper.substring(3, 4) + upper.substring(4).toLowerCase());
  }

  const ELEMENT_SET = new Set(ELEMENT_TYPES.map((t) => t.toUpperCase()));

  function nominal(v) {
    if (v == null) return null;
    if (v instanceof Typed) return nominal(v.v);
    if (v instanceof Enum) return v.e;
    if (Array.isArray(v)) return v.map(nominal).filter((x) => x != null).join('; ');
    if (v instanceof Ref) return null;
    return v;
  }

  // ---------------------------------------------------------------------------
  // Model extraction
  // ---------------------------------------------------------------------------
  function parseIfc(text, opts) {
    opts = opts || {};
    const t0 = Date.now();
    const f = new StepFile(text);
    const schema = f.header.schema || 'ONBEKEND';
    const ifc4 = !/IFC2X3/.test(schema);

    // ----- units
    const units = {};
    f.ids('IFCUNITASSIGNMENT').forEach((ua) => {
      (f.args(ua)[0] || []).forEach((r) => {
        if (!(r instanceof Ref)) return;
        const t = f.type(r.r);
        const a = f.args(r.r);
        if (t === 'IFCSIUNIT') {
          const ut = a[1] && a[1].e;
          const prefix = a[2] && a[2].e;
          const name = a[3] && a[3].e;
          units[ut] = siLabel(prefix, name);
        } else if (t === 'IFCCONVERSIONBASEDUNIT') {
          const ut = a[1] && a[1].e;
          units[ut] = a[2];
        }
      });
    });

    // ----- project
    let project = null;
    const pid = f.ids('IFCPROJECT')[0];
    if (pid) {
      const a = f.args(pid);
      project = { name: a[2] || a[5] || 'Project', longName: a[5] || '', description: a[3] || '', phase: a[6] || '' };
    }

    // ----- spatial structure
    const spatial = new Map(); // id -> {id,type,name,longName,elevation,parent}
    SPATIAL_TYPES.forEach((T) => {
      f.ids(T.toUpperCase()).forEach((id) => {
        const a = f.args(id);
        const node = { id, type: T, name: a[2] || '', longName: a[7] || '', parent: null };
        if (T === 'IfcBuildingStorey') node.elevation = typeof a[9] === 'number' ? a[9] : null;
        spatial.set(id, node);
      });
    });

    const aggParent = new Map(); // child -> parent (decomposition)
    f.ids('IFCRELAGGREGATES').forEach((rid) => {
      const a = f.args(rid);
      const parent = a[4] && a[4].r;
      (a[5] || []).forEach((c) => { if (c instanceof Ref) aggParent.set(c.r, parent); });
    });
    f.ids('IFCRELNESTS').forEach((rid) => {
      const a = f.args(rid);
      const parent = a[4] && a[4].r;
      (a[5] || []).forEach((c) => { if (c instanceof Ref && !aggParent.has(c.r)) aggParent.set(c.r, parent); });
    });
    spatial.forEach((node) => { node.parent = aggParent.get(node.id) || null; });

    const container = new Map(); // element -> spatial id
    f.ids('IFCRELCONTAINEDINSPATIALSTRUCTURE').forEach((rid) => {
      const a = f.args(rid);
      const s = a[5] && a[5].r;
      (a[4] || []).forEach((c) => { if (c instanceof Ref) container.set(c.r, s); });
    });

    // ----- element candidates
    const elementIds = new Set();
    f.byType.forEach((ids, type) => {
      if (ELEMENT_SET.has(type)) ids.forEach((id) => elementIds.add(id));
    });
    container.forEach((s, id) => {
      const t = f.type(id);
      if (t && !NOT_ELEMENTS.has(t) && !spatial.has(id)) elementIds.add(id);
    });
    // Spaces are spatial elements but also relevant for take-offs (areas).
    f.ids('IFCSPACE').forEach((id) => elementIds.add(id));

    // ----- properties
    const psetCache = new Map();
    function readPropertySet(id) {
      if (psetCache.has(id)) return psetCache.get(id);
      const t = f.type(id);
      const a = f.args(id);
      let res = null;
      if (t === 'IFCPROPERTYSET') {
        const props = {};
        (a[4] || []).forEach((r) => readProperty(r.r, props, ''));
        res = { name: a[2] || 'Pset', props, kind: 'pset' };
      } else if (t === 'IFCELEMENTQUANTITY') {
        const props = {};
        (a[5] || []).forEach((r) => readQuantity(r.r, props, ''));
        res = { name: a[2] || 'Qto', props, kind: 'qto' };
      }
      psetCache.set(id, res);
      return res;
    }

    function readProperty(id, props, prefix) {
      const t = f.type(id);
      const a = f.args(id);
      if (!a) return;
      const name = prefix + (a[0] || '?');
      switch (t) {
        case 'IFCPROPERTYSINGLEVALUE': props[name] = nominal(a[2]); break;
        case 'IFCPROPERTYENUMERATEDVALUE': props[name] = nominal(a[2]); break;
        case 'IFCPROPERTYLISTVALUE': props[name] = nominal(a[2]); break;
        case 'IFCPROPERTYBOUNDEDVALUE': {
          const lo = nominal(a[3]); const hi = nominal(a[2]);
          props[name] = lo != null && hi != null ? lo + ' – ' + hi : (lo != null ? lo : hi);
          break;
        }
        case 'IFCPROPERTYTABLEVALUE': props[name] = '(tabel)'; break;
        case 'IFCPROPERTYREFERENCEVALUE': props[name] = a[2] ? '(referentie)' : null; break;
        case 'IFCCOMPLEXPROPERTY':
          (a[3] || []).forEach((r) => readProperty(r.r, props, name + '.'));
          break;
        default: break;
      }
    }

    function readQuantity(id, props, prefix) {
      const t = f.type(id);
      const a = f.args(id);
      if (!a) return;
      const name = prefix + (a[0] || '?');
      if (t === 'IFCPHYSICALCOMPLEXQUANTITY') {
        (a[2] || []).forEach((r) => readQuantity(r.r, props, name + '.'));
        return;
      }
      if (/^IFCQUANTITY/.test(t)) props[name] = nominal(a[3]);
    }

    const elPsets = new Map(); // element -> [pset]
    f.ids('IFCRELDEFINESBYPROPERTIES').forEach((rid) => {
      const a = f.args(rid);
      const def = a[5] && a[5].r;
      if (!def) return;
      const ps = readPropertySet(def);
      if (!ps) return;
      const rel = a[4];
      (Array.isArray(rel) ? rel : [rel]).forEach((o) => {
        if (!(o instanceof Ref)) return;
        let arr = elPsets.get(o.r);
        if (!arr) { arr = []; elPsets.set(o.r, arr); }
        arr.push(ps);
      });
    });

    // ----- types
    const elType = new Map(); // element -> type object id
    f.ids('IFCRELDEFINESBYTYPE').forEach((rid) => {
      const a = f.args(rid);
      const typeId = a[5] && a[5].r;
      (a[4] || []).forEach((o) => { if (o instanceof Ref) elType.set(o.r, typeId); });
    });
    const typeInfo = new Map();
    function readType(id) {
      if (typeInfo.has(id)) return typeInfo.get(id);
      const a = f.args(id);
      const info = { id, entity: prettyType(f.type(id)), name: a[2] || '', psets: [] };
      (a[5] || []).forEach((r) => {
        if (!(r instanceof Ref)) return;
        const ps = readPropertySet(r.r);
        if (ps) info.psets.push(ps);
      });
      typeInfo.set(id, info);
      return info;
    }

    // ----- materials
    const elMaterial = new Map();
    const matCache = new Map();
    f.ids('IFCRELASSOCIATESMATERIAL').forEach((rid) => {
      const a = f.args(rid);
      const m = a[5] && a[5].r;
      if (!m) return;
      const desc = readMaterial(m);
      (a[4] || []).forEach((o) => { if (o instanceof Ref) elMaterial.set(o.r, desc); });
    });
    function readMaterial(id) {
      if (matCache.has(id)) return matCache.get(id);
      const t = f.type(id);
      const a = f.args(id) || [];
      let res = { names: [], layers: [], setName: '' };
      const nameOf = (r) => (r instanceof Ref ? (f.args(r.r) || [])[0] || '' : '');
      switch (t) {
        case 'IFCMATERIAL': res.names = [a[0] || '']; break;
        case 'IFCMATERIALLIST': res.names = (a[0] || []).map(nameOf); break;
        case 'IFCMATERIALLAYERSETUSAGE': res = readMaterial(a[0].r); break;
        case 'IFCMATERIALLAYERSET':
          res.setName = a[1] || '';
          (a[0] || []).forEach((l) => {
            const la = f.args(l.r);
            const nm = nameOf(la[0]);
            res.layers.push({ name: nm, thickness: la[1] });
            res.names.push(nm);
          });
          break;
        case 'IFCMATERIALLAYER': res.names = [nameOf(a[0])]; res.layers = [{ name: nameOf(a[0]), thickness: a[1] }]; break;
        case 'IFCMATERIALPROFILESETUSAGE': res = readMaterial(a[0].r); break;
        case 'IFCMATERIALPROFILESET':
          res.setName = a[0] || '';
          (a[2] || []).forEach((p) => { res.names.push(nameOf((f.args(p.r) || [])[2])); });
          break;
        case 'IFCMATERIALPROFILE': res.names = [nameOf(a[2])]; break;
        case 'IFCMATERIALCONSTITUENTSET':
          res.setName = a[0] || '';
          (a[2] || []).forEach((p) => { res.names.push(nameOf((f.args(p.r) || [])[2])); });
          break;
        case 'IFCMATERIALCONSTITUENT': res.names = [nameOf(a[2])]; break;
        default: break;
      }
      res.names = res.names.filter(Boolean);
      matCache.set(id, res);
      return res;
    }

    // ----- classifications
    const elClass = new Map(); // element -> [{system, code, name}]
    f.ids('IFCRELASSOCIATESCLASSIFICATION').forEach((rid) => {
      const a = f.args(rid);
      const c = a[5] && a[5].r;
      if (!c) return;
      const ref = readClassRef(c);
      if (!ref) return;
      (a[4] || []).forEach((o) => {
        if (!(o instanceof Ref)) return;
        let arr = elClass.get(o.r);
        if (!arr) { arr = []; elClass.set(o.r, arr); }
        arr.push(ref);
      });
    });
    function readClassRef(id) {
      const t = f.type(id);
      const a = f.args(id) || [];
      if (t === 'IFCCLASSIFICATIONREFERENCE') {
        let system = '';
        let src = a[3];
        // walk up to the IfcClassification
        let guard = 0;
        while (src instanceof Ref && guard++ < 10) {
          const st = f.type(src.r);
          const sa = f.args(src.r);
          if (st === 'IFCCLASSIFICATION') { system = ifc4 ? sa[3] : sa[3]; break; }
          src = sa[3];
        }
        return { system: system || 'Classificatie', code: a[1] || '', name: a[2] || '' };
      }
      if (t === 'IFCCLASSIFICATION') return { system: a[3] || 'Classificatie', code: '', name: a[3] || '' };
      return null;
    }

    // ----- storeys / buildings for elements
    function spatialChain(id) {
      const chain = [];
      let cur = id;
      let guard = 0;
      while (cur && guard++ < 50) {
        const s = spatial.get(cur);
        if (s) chain.push(s);
        cur = (s && s.parent) || container.get(cur) || aggParent.get(cur);
      }
      return chain;
    }

    // ----- build elements
    const elements = [];
    const byId = new Map();
    elementIds.forEach((id) => {
      const upper = f.type(id);
      const a = f.args(id);
      if (!a || typeof a[0] !== 'string') return;
      const entity = prettyType(upper);
      const el = {
        id,
        entity,
        globalId: a[0],
        name: a[2] || '',
        description: a[3] || '',
        objectType: a[4] || '',
        tag: '',
        predefinedType: '',
        props: {} // "Group::Name" -> value
      };
      if (upper !== 'IFCSPACE') el.tag = typeof a[7] === 'string' ? a[7] : '';
      else el.longName = a[7] || '';
      for (let k = a.length - 1; k >= 8; k--) {
        if (a[k] instanceof Enum) { el.predefinedType = a[k].e; break; }
      }
      // spatial
      let chainStart = container.get(id);
      if (!chainStart) {
        // inherit from aggregate parent (e.g. stair flight -> stair -> storey)
        let p = aggParent.get(id);
        let guard = 0;
        while (p && !spatial.has(p) && guard++ < 10) { chainStart = container.get(p); if (chainStart) break; p = aggParent.get(p); }
        if (!chainStart && p && spatial.has(p)) chainStart = p;
      }
      const chain = upper === 'IFCSPACE' ? spatialChain(aggParent.get(id)) : spatialChain(chainStart);
      const storey = chain.find((s) => s.type === 'IfcBuildingStorey');
      const building = chain.find((s) => s.type === 'IfcBuilding');
      const space = upper === 'IFCSPACE' ? null : chain.find((s) => s.type === 'IfcSpace');
      el.storey = storey ? storey.name : '';
      el.storeyElevation = storey ? storey.elevation : null;
      el.building = building ? building.name : '';
      el.space = space ? (space.name + (space.longName ? ' ' + space.longName : '')) : '';
      const parent = aggParent.get(id);
      el.parentId = parent && !spatial.has(parent) ? parent : null;

      // type
      const tid = elType.get(id);
      const tinfo = tid ? readType(tid) : null;
      el.typeName = tinfo ? tinfo.name : '';
      el.typeEntity = tinfo ? tinfo.entity : '';

      // materials (occurrence first, then type)
      const mat = elMaterial.get(id) || (tid && elMaterial.get(tid)) || null;
      el.materials = mat ? mat.names : [];
      el.materialLayers = mat ? mat.layers : [];
      el.materialSet = mat ? mat.setName : '';

      // classifications (occurrence first, then type)
      el.classifications = (elClass.get(id) || []).concat((tid && elClass.get(tid)) || []);

      // attribute fields
      const P = el.props;
      P['Attribuut::Entiteit'] = entity;
      P['Attribuut::Naam'] = el.name;
      P['Attribuut::GlobalId'] = el.globalId;
      P['Attribuut::Beschrijving'] = el.description;
      P['Attribuut::ObjectType'] = el.objectType;
      P['Attribuut::Tag'] = el.tag;
      P['Attribuut::PredefinedType'] = el.predefinedType;
      if (el.longName != null) P['Attribuut::LongName'] = el.longName;
      if (/^IFC(WINDOW|DOOR)/.test(upper)) {
        if (typeof a[8] === 'number') P['Attribuut::OverallHeight'] = a[8];
        if (typeof a[9] === 'number') P['Attribuut::OverallWidth'] = a[9];
      }
      P['Locatie::Bouwlaag'] = el.storey;
      if (el.storeyElevation != null) P['Locatie::Bouwlaag peil'] = el.storeyElevation;
      P['Locatie::Gebouw'] = el.building;
      if (el.space) P['Locatie::Ruimte'] = el.space;
      P['Type::Typenaam'] = el.typeName;
      P['Type::Type-entiteit'] = el.typeEntity;
      P['Materiaal::Materiaal'] = el.materials.join(' / ');
      P['Materiaal::Materiaalset'] = el.materialSet;
      if (el.materialLayers.length) {
        P['Materiaal::Aantal lagen'] = el.materialLayers.length;
        P['Materiaal::Totale laagdikte'] = el.materialLayers.reduce((s, l) => s + (+l.thickness || 0), 0);
        el.materialLayers.forEach((l, i) => {
          P['Materiaal::Laag ' + (i + 1)] = l.name;
          P['Materiaal::Laag ' + (i + 1) + ' dikte'] = l.thickness;
        });
      }
      el.classifications.forEach((c) => {
        const key = 'Classificatie::' + c.system;
        if (P[key] == null) { P[key] = c.code; P[key + ' omschrijving'] = c.name; }
      });

      // type property sets first, occurrence overrides
      if (tinfo) {
        tinfo.psets.forEach((ps) => {
          Object.keys(ps.props).forEach((k) => { P[ps.name + '::' + k] = ps.props[k]; });
        });
      }
      (elPsets.get(id) || []).forEach((ps) => {
        Object.keys(ps.props).forEach((k) => { P[ps.name + '::' + k] = ps.props[k]; });
      });
      const qtoNames = new Set();
      (elPsets.get(id) || []).forEach((ps) => { if (ps.kind === 'qto') qtoNames.add(ps.name); });
      if (tinfo) tinfo.psets.forEach((ps) => { if (ps.kind === 'qto') qtoNames.add(ps.name); });
      el.qtoGroups = Array.from(qtoNames);

      elements.push(el);
      byId.set(id, el);
    });

    elements.forEach((el) => {
      if (el.parentId && byId.has(el.parentId)) {
        const p = byId.get(el.parentId);
        el.props['Locatie::Onderdeel van'] = p.name || p.entity;
      }
    });

    elements.sort((a, b) => (a.storeyElevation || 0) - (b.storeyElevation || 0) || a.entity.localeCompare(b.entity) || a.name.localeCompare(b.name));

    const storeys = Array.from(spatial.values())
      .filter((s) => s.type === 'IfcBuildingStorey')
      .sort((a, b) => (a.elevation || 0) - (b.elevation || 0))
      .map((s) => ({ name: s.name, elevation: s.elevation }));

    return {
      fileName: opts.fileName || f.header.name || 'model.ifc',
      schema,
      application: f.header.application || '',
      project,
      units,
      storeys,
      elements,
      byId,
      entityCount: f.index.size,
      parseMs: Date.now() - t0
    };
  }

  function siLabel(prefix, name) {
    const p = { MILLI: 'm', CENTI: 'c', DECI: 'd', KILO: 'k' }[prefix] || '';
    switch (name) {
      case 'METRE': return p + 'm';
      case 'SQUARE_METRE': return p + 'm²';
      case 'CUBIC_METRE': return p + 'm³';
      case 'GRAM': return p + 'g';
      case 'SECOND': return 's';
      case 'RADIAN': return 'rad';
      default: return (p ? prefix.toLowerCase() : '') + (name || '').toLowerCase();
    }
  }

  const api = { parseIfc, parseArgs, decodeStepString, StepFile, prettyType };
  root.ITO = root.ITO || {};
  root.ITO.parser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
