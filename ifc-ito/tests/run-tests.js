/* Run with: node ifc-ito/tests/run-tests.js */
'use strict';
const assert = require('assert');
const path = require('path');
const P = require(path.join(__dirname, '../js/ifc-parser.js'));
const E = require(path.join(__dirname, '../js/engine.js'));
const { generateDemoIfc } = require(path.join(__dirname, '../js/demo-model.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  ', name); } catch (e) { console.error('FAIL', name, '\n     ', e.message); process.exitCode = 1; }
}

test('STEP strings are decoded', () => {
  assert.strictEqual(P.decodeStepString('Ge\\X2\\00EB\\X0\\xporteerd'), 'Geëxporteerd');
  assert.strictEqual(P.decodeStepString('\\X\\E9t\\X\\E9'), 'été');
  const a = P.parseArgs("'it''s',#12,$,.T.,(1.,2.5),IFCLABEL('x'),.ELEMENT.");
  assert.strictEqual(a[0], "it's");
  assert.strictEqual(a[1].r, 12);
  assert.strictEqual(a[2], null);
  assert.strictEqual(a[3], true);
  assert.deepStrictEqual(a[4], [1, 2.5]);
  assert.strictEqual(a[5].v, 'x');
  assert.strictEqual(a[6].e, 'ELEMENT');
});

const model = P.parseIfc(generateDemoIfc());

test('demo model is parsed with storeys, types, materials and quantities', () => {
  assert.strictEqual(model.schema, 'IFC4');
  assert.strictEqual(model.storeys.length, 2);
  assert.strictEqual(model.units.LENGTHUNIT, 'mm');
  const wall = model.elements.find((e) => e.entity === 'IfcWall' && e.tag === 'W-001');
  assert.ok(wall);
  assert.strictEqual(wall.props['Locatie::Bouwlaag'], '00 Begane grond');
  assert.strictEqual(wall.props['Pset_WallCommon::IsExternal'], true);
  assert.strictEqual(wall.props['Qto_WallBaseQuantities::Length'], 14400);
  assert.strictEqual(wall.props['Classificatie::NL-SfB'], '21.1');
  assert.strictEqual(wall.props['Materiaal::Aantal lagen'], 3);
  assert.ok(wall.props['Pset_WallCommon::AcousticRating'], 'type property sets are inherited');
});

test('filters with wildcards, lists, numbers and nested filters', () => {
  const cfg = E.defaultConfig();
  const count = (rule) => E.applyFilter(model.elements, rule, cfg).length;
  assert.strictEqual(count({ logic: 'and', conditions: [{ field: 'Attribuut::Entiteit', op: 'eq', value: 'IfcWall*' }] }), 14);
  assert.strictEqual(count({ logic: 'and', conditions: [{ field: 'Attribuut::Entiteit', op: 'in', value: 'IfcColumn; IfcBeam' }] }), 8);
  assert.strictEqual(count({ logic: 'and', conditions: [{ field: 'Qto_WallBaseQuantities::Length', op: 'gt', value: '10000' }] }), 4);
  assert.strictEqual(count({ logic: 'and', conditions: [{ op: 'filter', value: 'f-buitenwanden' }] }), 8);
  assert.strictEqual(count({ logic: 'or', conditions: [] }), model.elements.length);
});

test('rule-based classification and manual overrides', () => {
  const cfg = E.defaultConfig();
  let res = E.classifyAll(model.elements, cfg);
  assert.strictEqual(res['s-elementcodering'].size, model.elements.length);
  const roof = model.elements.find((e) => e.predefinedType === 'ROOF');
  assert.strictEqual(roof.props['ITO-classificatie::Elementcodering'], '27');
  cfg.classifications[0].overrides[roof.globalId] = 'c-23';
  res = E.classifyAll(model.elements, cfg);
  assert.strictEqual(roof.props['ITO-classificatie::Elementcodering'], '23');
  assert.strictEqual(roof.props['ITO-classificatie::Elementcodering (handmatig)'], true);
});

test('ITO grouping, totals and formula columns', () => {
  const cfg = E.defaultConfig();
  const cr = E.classifyAll(model.elements, cfg);
  const walls = E.computeIto(model, cfg.itos.find((i) => i.id === 'ito-wanden'), cfg, cr);
  assert.strictEqual(walls.elementCount, 14);
  assert.strictEqual(walls.rows.length, 6);
  const countCol = walls.columns.findIndex((c) => c.agg === 'count');
  assert.strictEqual(walls.totals[countCol], 14);
  const lenCol = walls.columns.findIndex((c) => c.label === 'Lengte (m)');
  assert.ok(Math.abs(walls.totals[lenCol] - 142.15) < 1e-6, 'factor converts mm to m');
  const concrete = E.computeIto(model, cfg.itos.find((i) => i.id === 'ito-beton'), cfg, cr);
  const vol = concrete.columns.findIndex((c) => c.label === 'Volume (m³)');
  const reb = concrete.columns.findIndex((c) => c.source === 'formula');
  assert.ok(Math.abs(concrete.totals[reb] - concrete.totals[vol] * 95) < 1e-6);
  assert.deepStrictEqual(Object.keys(concrete.errors), []);
});

test('formula parser', () => {
  const f = E.compileFormula('round(2 * {a} + [x::y] / 3; 2)');
  assert.strictEqual(f({ col: () => 2, field: () => 3 }), 5);
  assert.strictEqual(E.compileFormula('if({a} > 1; 10; 20)')({ col: () => 2 }), 10);
  assert.throws(() => E.compileFormula('2 +'));
  assert.throws(() => E.compileFormula('foo(1)'));
});

console.log('\n' + passed + ' tests geslaagd');
