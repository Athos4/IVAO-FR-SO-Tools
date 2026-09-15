import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parseAirways, parseCoordinate, parseNavigationPoints } from '../tools/import-airways.mjs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// Load the actual inline functions without startup/network/DOM rendering.
const boot = source.lastIndexOf('\n      bindEvents();');
assert.ok(boot > 0);
const context = vm.createContext({ document: { getElementById: () => null }, window: { devicePixelRatio: 1 } });
vm.runInContext(source.slice(0, boot) + '\nglobalThis.api = { state, AIRWAY_DATA, parse: null, zoneInAirspace, segmentIntersectsRing, airwayNetwork, airwayConflictsForZones, conflictingTrajectoryIdsForZones, unprojectMercator, drawTrajectoryCanvas }; })();', context);
const api = context.api;
const square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

test('DMS includes milliseconds and hemisphere; invalid values are rejected', () => {
  assert.equal(parseCoordinate('S048.30.00.000', 'lat'), -48.5);
  assert.ok(Math.abs(parseCoordinate('W003.17.41.200', 'lng') + (3 + 17 / 60 + 41.2 / 3600)) < 1e-12);
  assert.throws(() => parseCoordinate('N091.00.00.000', 'lat'));
  assert.throws(() => parseCoordinate('E003.60.00.000', 'lng'));
  assert.throws(() => parseCoordinate('N003.00.00.000', 'lng'));
});

test('BREAK and name changes split polylines without artificial connectors', () => {
  const parsed = parseAirways('T;A3;N045.00.00.000;E001.00.00.000;\nT;A3;N046.00.00.000;E001.00.00.000;\nT;BREAK;FIX;FIX;\nT;A3;N050.00.00.000;E005.00.00.000;\nT;A3;N051.00.00.000;E005.00.00.000;\nT;B1;N040.00.00.000;E000.00.00.000;\nT;B1;N041.00.00.000;E000.00.00.000;');
  assert.equal(parsed.breaks, 1);
  assert.equal(parsed.routes.length, 3);
  assert.deepEqual(parsed.routes.map(route => route.points.length), [2, 2, 2]);
  assert.throws(() => parseAirways('T;A1;not-a-coordinate;E001.00.00.000;'));
});

test('FIX, VOR and NDB databases resolve named AWY points alongside raw coordinates', () => {
  const points = [
    ...parseNavigationPoints('AAA;N045.00.00.000;E001.00.00.000;1;0;', 'fix'),
    ...parseNavigationPoints('BB;110.60;N046.00.00.000;W001.00.00.000;', 'vor'),
    ...parseNavigationPoints('CC;321.0;N047.00.00.000;E002.00.00.000;', 'ndb')
  ];
  assert.deepEqual(points, [['AAA', 1, 45, 'fix'], ['BB', -1, 46, 'vor'], ['CC', 2, 47, 'ndb']]);
  const parsed = parseAirways('T;A1;AAA;AAA;\nT;A1;BB;BB;\nT;BREAK;FIX;FIX;\nT;A1;CC;CC;\nT;A1;N048.00.00.000;E003.00.00.000;', points);
  assert.equal(parsed.routes.length, 2);
  assert.deepEqual(parsed.routes[0].pointNames, ['AAA', 'BB']);
  assert.deepEqual(parsed.routes[1].pointNames, ['CC', null]);
  assert.deepEqual(parsed.routes[1].points, [[2, 47], [3, 48]]);
  assert.throws(() => parseAirways('T;A1;MISSING;MISSING;', points), /Unknown point/);
  assert.throws(() => parseAirways('T;A1;AAA;BB;', points), /Mismatched/);
  assert.throws(() => parseAirways('T;A1;AAA;AAA;', [...points, ['AAA', 3, 50]]), /Ambiguous/);
  assert.throws(() => parseNavigationPoints('AAA;N099.00.00.000;E001.00.00.000;', 'fix'));
});

test('embedded networks retain all segments and BREAK counts', () => {
  assert.equal(api.AIRWAY_DATA.points.length, 3830);
  assert.equal(api.AIRWAY_DATA.pointSources.length, 3);
  assert.equal(api.AIRWAY_DATA.lower.routes[0].pointNames[0], 'BRY');
  assert.equal(api.AIRWAY_DATA.upper.routes[0].pointNames[0], 'AMORO');
  for (const level of ['lower', 'upper']) for (const route of api.AIRWAY_DATA[level].routes) assert.equal(route.pointNames.length, route.points.length);
  assert.equal(api.AIRWAY_DATA.lower.breaks, 3);
  assert.equal(api.AIRWAY_DATA.upper.breaks, 24);
  assert.equal(api.airwayNetwork('lower').length, 1050);
  assert.equal(api.airwayNetwork('upper').length, 567);
  assert.equal(new Set(api.AIRWAY_DATA.lower.routes.map(route => route.name)).size, 278);
  assert.equal(new Set(api.AIRWAY_DATA.upper.routes.map(route => route.name)).size, 204);
});

test('FL195 boundary excludes pure upper/lower zones from the opposite layer', () => {
  assert.equal(api.zoneInAirspace({ minimumAlt: 0, maximumAlt: 19500 }, 'lower'), true);
  assert.equal(api.zoneInAirspace({ minimumAlt: 0, maximumAlt: 19500 }, 'upper'), false);
  assert.equal(api.zoneInAirspace({ minimumAlt: 19500, maximumAlt: 66000 }, 'lower'), false);
  assert.equal(api.zoneInAirspace({ minimumAlt: 19500, maximumAlt: 66000 }, 'upper'), true);
  assert.equal(api.zoneInAirspace({ minimumAlt: 19000, maximumAlt: 20000 }, 'lower'), true);
  assert.equal(api.zoneInAirspace({ minimumAlt: 19000, maximumAlt: 20000 }, 'upper'), true);
});

test('intersection detects crossings, contained lines and contacts but excludes nearby lines', () => {
  assert.equal(api.segmentIntersectsRing([-1, .5], [2, .5], square), true);
  assert.equal(api.segmentIntersectsRing([.2, .2], [.8, .8], square), true);
  assert.equal(api.segmentIntersectsRing([-1, 0], [0, 0], square), true);
  assert.equal(api.segmentIntersectsRing([.2, 0], [.8, 0], square), true);
  assert.equal(api.segmentIntersectsRing([-.2, .1], [.1, -.2], square), false);
  assert.equal(api.segmentIntersectsRing([0, 1.1], [1, 1.1], square), false);
  const concave = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
  assert.equal(api.segmentIntersectsRing([1.5, 2], [2.5, 2], concave), false);
});

function zoneAround(segment, id = 1) {
  const x = (segment.points[0][0] + segment.points[1][0]) / 2;
  const y = (segment.points[0][1] + segment.points[1][1]) / 2;
  const d = .0001;
  return { id, name: 'Fixture', minimumAlt: 0, maximumAlt: 30000,
    regionMap: [[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d]].map(([px, py]) => api.unprojectMercator({ x: px, y: py }, 0)) };
}

test('real A2 geometry conflicts on crossing, unions selection, respects altitude and clears', () => {
  const zone = zoneAround(api.airwayNetwork('lower')[0]);
  let result = api.airwayConflictsForZones([zone], 'lower');
  assert.ok(result.ids.has(0));
  assert.ok(result.names.includes('A2'));
  assert.equal(api.airwayConflictsForZones([zone, zone], 'lower').ids.size, result.ids.size);
  zone.minimumAlt = 19500;
  assert.equal(api.airwayConflictsForZones([zone], 'lower').ids.size, 0);
  assert.equal(api.airwayConflictsForZones([], 'lower').ids.size, 0);
  const upper = zoneAround(api.airwayNetwork('upper')[0]);
  assert.ok(api.airwayConflictsForZones([upper], 'upper').ids.has(0));
  upper.maximumAlt = 19500;
  assert.equal(api.airwayConflictsForZones([upper], 'upper').ids.size, 0);
  assert.equal(api.airwayConflictsForZones([{ name: 'No geometry', minimumAlt: 0, maximumAlt: 30000 }], 'upper').missing.length, 1);
});

test('lower airway floor FL65 excludes zones below or at the boundary, including cached matches', () => {
  const zone = zoneAround(api.airwayNetwork('lower')[0]);
  assert.ok(api.airwayConflictsForZones([zone], 'lower').ids.has(0));
  for (const ceiling of [0, 5000, 6499, 6500]) {
    zone.maximumAlt = ceiling;
    assert.equal(api.zoneInAirspace(zone, 'lower'), true);
    const result = api.airwayConflictsForZones([zone], 'lower');
    assert.equal(result.ids.size, 0);
    assert.equal(result.names.length, 0);
  }
  zone.maximumAlt = 6501;
  assert.ok(api.airwayConflictsForZones([zone], 'lower').ids.has(0));
  assert.equal(api.airwayConflictsForZones([{ name: 'Low zone', minimumAlt: 0, maximumAlt: 6000 }], 'lower').missing.length, 0);
});

test('FRA lower portions render alongside lower AWY; missing zone altitude cannot confirm FL190 conflict', () => {
  api.state.airspace = 'lower';
  assert.equal(api.conflictingTrajectoryIdsForZones([{ name: 'LF TRA 22 A1', maximumAlt: 30000 }]).size, 0);
  const strokes = [];
  const draw = { scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { strokes.push([this.strokeStyle, this.lineWidth]); } };
  const canvas = { getContext: () => draw };
  api.drawTrajectoryCanvas(canvas, { x: 0, y: 0 }, 0, 256, 256, true, [zoneAround(api.airwayNetwork('lower')[0])]);
  assert.ok(strokes.some(([color,width])=>color==='rgba(65, 75, 91, .3)'&&width===.8),'FRA lower portions are visible');
  assert.ok(strokes.some(([color,width])=>color==='#ff5263'&&width===1));
  assert.ok(strokes.every(([,width])=>width===1||width===.8),'normal line widths are preserved');
  api.state.airspace = 'upper';
  const h24Count = api.conflictingTrajectoryIdsForZones([{ name: 'LF TRA 22 A1', minimumAlt: 20000, maximumAlt: 40000 }]).size;
  assert.ok(h24Count > 0 && h24Count <= 71);
});
