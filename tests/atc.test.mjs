import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parseAtc, encodeAtcPoints, filterAtcForFrance } from '../tools/import-atc.mjs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const project = ([lng, lat]) => [(lng + 180) / 360 * 256, (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) * 128];
const polygon = [[0,44],[2,44],[2,46],[0,46]];
const controllers = [{ name: 'TOULOUSE <test>', facility: 'LFBO', icao: 'LFBO', role: 'tracon', volumes: [
  { minimumAlt: 1000, maximumAlt: 3000, points: polygon },
  { minimumAlt: 20000, maximumAlt: 30000, points: polygon }
] }];

function loadApp(customControllers = controllers, actual = false) {
  const modified = actual ? source : source.split('\n').map(line => {
    if (line.includes('const ATC_DATA =')) return `const ATC_DATA = ${JSON.stringify({controllers:customControllers})};`;
    if (line.includes('const AIRWAY_DATA =')) return 'const AIRWAY_DATA = {lower:{routes:[]},upper:{routes:[]}};';
    if (line.includes('const TRAJECTORY_DATA =')) return `const TRAJECTORY_DATA = ${JSON.stringify({g:[[[10,45],[12,45]].map(project)],z:{}})};`;
    if (line.includes('const FRA_METADATA =')) return 'const FRA_METADATA={records:[{g:0,e:"AAA",x:"BBB",m:1,c:0,t:0}],times:["H24"],conditions:[{airports:"ARR LFBO"}]};';
    return line;
  }).join('\n');
  const context = vm.createContext({ atob, document:{getElementById:()=>null},window:{devicePixelRatio:1} });
  vm.runInContext(modified.slice(0, modified.lastIndexOf('\n      bindEvents();')) + '\nglobalThis.api={state,ATC_DATA,decodeAtcPoints,atcVolumes,polygonsIntersect,atcVerticalOverlap,atcConflictsForZone,impactedAtcSvg,reverseSearchResults,impactedAirports,atcImpactReportHtml};})();',context);
  return context.api;
}

function zone(id, x = 1, y = 45, bottom = 25000, top = 26000) {
  return {id,name:`Zone ${id}`,minimumAlt:bottom,maximumAlt:top,regionMap:[[x-.1,y-.1],[x+.1,y-.1],[x+.1,y+.1],[x-.1,y+.1]].map(([lng,lat])=>({lng,lat}))};
}

test('ATC parser preserves independent volume limits, lat/lon order and controller identifiers', () => {
  const body = 'CONTROLLER\nNAME SAMPLE\nFACILITY_ID LFBO\nROLE tracon\nICAO LFBO\nAIRSPACE_POLYGON_BEGIN 1000 3000\nPOINT 44 0\nPOINT 44 2\nPOINT 46 2\nAIRSPACE_POLYGON_END\nAIRSPACE_POLYGON_BEGIN 20000 30000\nPOINT 44 0\nPOINT 44 2\nPOINT 46 2\nAIRSPACE_POLYGON_END\nCONTROLLER_END\n99';
  const result = parseAtc(`A\n1000\nATCFILE\n${body}`);
  assert.equal(result.polygonCount,2);
  assert.equal(result.pointCount,6);
  assert.deepEqual(result.controllers[0].volumes[0].points,[[0,44],[2,44],[2,46]]);
  assert.equal(result.controllers[0].icao,'LFBO');
  assert.throws(()=>parseAtc(`A\n1000\nATCFILE\n${body.replace('1000 3000','3000 1000')}`));
  assert.throws(()=>parseAtc(`A\n1000\nATCFILE\n${body.replace('POINT 44 0','POINT 99 0')}`));
  assert.throws(()=>parseAtc('A\n1000\nATCFILE\nCONTROLLER\nNAME Unclosed'));
});

test('packed ATC points round-trip without losing six-decimal coordinates', () => {
  const api=loadApp();
  const points=[[-179.999999,-85.123456],[179.123456,85.999999],[0,0],[-1.001001,42.000001]];
  assert.deepEqual(JSON.parse(JSON.stringify(api.decodeAtcPoints(encodeAtcPoints(points)))),points);
  assert.throws(()=>api.decodeAtcPoints('gA=='),/tronquées/);
});

test('polygon conflicts detect containment, crossing and boundary contact but exclude disjoint polygons', () => {
  const api=loadApp();
  const a=[[0,0],[3,0],[3,3],[0,3]], inside=[[1,1],[2,1],[2,2],[1,2]];
  assert.equal(api.polygonsIntersect(a,inside),true);
  assert.equal(api.polygonsIntersect(inside,a),true);
  assert.equal(api.polygonsIntersect(a,[[3,1],[4,1],[4,2],[3,2]]),true);
  assert.equal(api.polygonsIntersect(a,[[-1,1],[4,1],[4,2],[-1,2]]),true);
  assert.equal(api.polygonsIntersect(a,[[4,4],[5,4],[5,5],[4,5]]),false);
});

test('ATC conflicts require vertical overlap within the chosen slice and are independent of the AWY FL65 floor', () => {
  const api=loadApp(), a=zone(1);
  assert.deepEqual([...api.atcConflictsForZone(a)],[1]);
  a.minimumAlt=30000; a.maximumAlt=31000;
  assert.equal(api.atcConflictsForZone(a).size,0,'touching altitude boundaries have no shared volume');
  a.minimumAlt=1500; a.maximumAlt=2500;
  api.state.airspace='lower';
  assert.deepEqual([...api.atcConflictsForZone(a)],[0]);
  a.regionMap=zone(2,20,45).regionMap;
  assert.equal(api.atcConflictsForZone(a).size,0,'cache invalidates when geometry changes');
  assert.equal(api.atcVerticalOverlap(zone(3,1,45,18000,19500),{minimumAlt:0,maximumAlt:40000},'upper'),false);
  assert.equal(api.atcVerticalOverlap(zone(3,1,45,19500,66000),{minimumAlt:0,maximumAlt:40000},'lower'),false);
});

test('dateline ATC polygons do not spuriously cover Europe and retain Pacific conflicts', () => {
  const api=loadApp([{name:'Pacific',facility:'TEST',icao:'TEST',role:'ctr',volumes:[{minimumAlt:0,maximumAlt:60000,points:[[179,-1],[-179,-1],[-179,1],[179,1]]}]}]);
  assert.equal(api.atcConflictsForZone(zone(1,0,0)).size,0);
  assert.equal(api.atcConflictsForZone(zone(2,-179.5,0)).size,1);
  assert.equal(api.atcConflictsForZone(zone(3,179.5,0)).size,1);
});

test('reverse ICAO search returns the union of FRA-only and ATC-only conflicts, including lower airspace', () => {
  const api=loadApp();
  api.state.reverseSearch=true; api.state.routeAirport='LFBO';
  api.state.filtered=[zone(1),zone(2,11,45),zone(3,1,45,1500,2500)];
  let result=api.reverseSearchResults();
  assert.deepEqual([...result.zones].map(z=>z.id),[1,2]);
  assert.equal(result.counts.get(1),0);
  assert.equal(result.airspaceCounts.get(1),1);
  assert.equal(result.counts.get(2),1);
  assert.equal(result.airspaceCounts.get(2),0);
  api.state.airspace='lower';
  result=api.reverseSearchResults();
  assert.deepEqual([...result.zones].map(z=>z.id),[3]);
  assert.equal(result.routeCount,1,'missing airport coordinates retain a possible lower profile without inventing a position');
  api.state.routeAirport='LFXX';
  assert.equal(api.reverseSearchResults().zones.length,0);
  api.state.routeAirport='LFXX, LFBO';
  assert.equal(api.reverseSearchResults().zones.length,1);
});

test('impacted ATC fill is pink at 0.1, outline at 0.5, with ICAO-only and vertical labels', () => {
  const api=loadApp(), a=zone(1);
  const svg=api.impactedAtcSvg([a,a],{x:0,y:0},0,256,256);
  assert.equal((svg.match(/class="atc-impacted-path"/g)||[]).length,1,'shared impacted volumes are drawn once');
  assert.match(svg,/fill="#ff69cf" fill-opacity="0.1" stroke="#ff69cf" stroke-opacity="0.5"/);
  assert.match(svg, /class="map-airspace-name" x="0" y="-17">LFBO<\/tspan>/);
  assert.doesNotMatch(svg, /TRACON|APP LFBO/);
  assert.match(api.atcImpactReportHtml([a]), /LFBO/);
  assert.doesNotMatch(api.atcImpactReportHtml([a]), /TRACON|APP LFBO/);
  assert.match(svg, /class="atc-altitude-tag"/);
  assert.match(svg, /y="-3">FL300<\/tspan><tspan class="map-altitude-min" x="0" y="9">FL200/);
  assert.ok(svg.includes('&lt;test&gt;'));
  assert.equal(api.impactedAtcSvg([],{x:0,y:0},0,256,256),'');
  const impact=api.impactedAirports([a]);
  assert.equal(impact[0].code,'LFBO');
  assert.equal(impact[0].count,0);
  assert.equal(impact[0].airspaceCount,1);
  assert.match(api.atcImpactReportHtml([{...a,regionMap:[]}]),/contrôle incomplet/);
});

test('ATC labels omit every type and fall back to facility when ICAO is absent', () => {
  for (const [role,icao,expected] of [['twr','LFBO','LFBO'],['ctr','','NTTT']]) {
    const api = loadApp([{...controllers[0],role,icao,facility:'NTTT'}]);
    const svg = api.impactedAtcSvg([zone(1)],{x:0,y:0},0,256,256);
    assert.ok(svg.includes(`y="-17">${expected}</tspan>`));
  }
});

test('inverse mode shows only selected ICAO spaces, labels and report counts without changing conflict calculations',()=>{
  const api=loadApp([
    {...controllers[0],name:'Toulouse'},
    {...controllers[0],icao:'LFPG',facility:'LFPG',name:'Paris'},
    {...controllers[0],icao:'LFBO',facility:'LFBO_TWR',role:'twr',name:'Toulouse tower'}
  ]);
  const a=zone(1),svg=()=>api.impactedAtcSvg([a],{x:0,y:0},0,256,256);
  const count=()=> (svg().match(/class="atc-impacted-path"/g)||[]).length;
  assert.equal(api.atcConflictsForZone(a).size,3);
  api.state.routeAirport='LFBO';
  assert.equal(count(),3,'ordinary airport filtering alone does not restrict ATC display');
  api.state.reverseSearch=true;
  assert.equal(count(),2,'all matching ICAO volumes are retained, including a different facility name');
  assert.doesNotMatch(svg(),/LFPG|Paris/);
  assert.match(api.atcImpactReportHtml([a]),/2 volumes/);
  assert.doesNotMatch(api.atcImpactReportHtml([a]),/LFPG|Paris/);
  assert.equal(api.atcConflictsForZone(a).size,3,'display filtering does not alter cached physical intersections');
  api.state.routeAirport='LFPG';
  assert.equal(count(),1);assert.doesNotMatch(svg(),/LFBO|Toulouse/);
  api.state.routeAirport='LFBO, LFPG';
  assert.equal(count(),3,'multiple ICAO codes display the union without duplicates');
  api.state.routeAirport='';assert.equal(count(),0);
  api.state.routeAirport='LFXX';assert.equal(count(),0);
  api.state.reverseSearch=false;assert.equal(count(),3,'leaving inverse mode restores all impacted volumes');
  api.state.reverseSearch=true;api.state.routeAirport='LFPG';api.state.airspace='lower';
  const lower=api.impactedAtcSvg([zone(2,1,45,1500,2500)],{x:0,y:0},0,256,256);
  assert.match(lower,/LFPG/);assert.doesNotMatch(lower,/LFBO/);
});

test('inverse ATC display preserves explicit facility searches only when the controller has no ICAO',()=>{
  const api=loadApp([{...controllers[0],icao:'',facility:'NTTT',name:'Centre'}]);
  api.state.reverseSearch=true;api.state.routeAirport='NTTT';
  assert.match(api.impactedAtcSvg([zone(1)],{x:0,y:0},0,256,256),/NTTT/);
  api.state.routeAirport='LFBO';
  assert.doesNotMatch(api.impactedAtcSvg([zone(1)],{x:0,y:0},0,256,256),/NTTT/);
});

test('controllers without airport associations are searchable by facility but not misreported as aerodromes', () => {
  const api=loadApp([{...controllers[0],icao:'',facility:'NTTT',role:'ctr'}]);
  api.state.routeAirport='NTTT'; api.state.filtered=[zone(1)];
  assert.equal(api.reverseSearchResults().zones.length,1);
  assert.equal(api.impactedAirports([zone(1)]).length,0);
});

test('embedded ATC dataset contains only requested prefixes, no excluded FIR and retains real LFBO vertical limits', () => {
  const api=loadApp(undefined,true);
  assert.equal(api.ATC_DATA.controllers.length,128);
  assert.equal(api.ATC_DATA.polygonCount,615);
  assert.equal(api.ATC_DATA.pointCount,14141);
  assert.equal(api.atcVolumes().reduce((count,volume)=>count+volume.points.length,0),14141);
  for (const controller of api.ATC_DATA.controllers) {
    assert.match(controller.facility, /^(LF|NT|TF|FM)/);
    assert.ok(!['LFFF','LFEE','LFBB','LFRR','LFMM'].includes(controller.facility));
  }
  const tower=api.atcVolumes().find(volume=>volume.controller.icao==='LFBO'&&volume.controller.role==='twr');
  assert.equal(tower.minimumAlt,0); assert.equal(tower.maximumAlt,2000);
  const [lng,lat]=api.decodeAtcPoints(api.ATC_DATA.controllers.find(controller=>controller.icao==='LFBO'&&controller.role==='twr').volumes[0].points)[0];
  api.state.airspace='lower';
  assert.ok(api.atcConflictsForZone(zone(1,lng,lat,1000,1500)).has(tower.id));
  assert.ok(!api.atcConflictsForZone(zone(2,lng,lat,2000,3000)).has(tower.id));
});

test('ATC import filters on facility ID, recomputes counts and preserves original source objects', () => {
  const ids = ['LFBO', 'NTAA', 'TFFR', 'FMMI', 'LFFF', 'LFEE', 'LFBB', 'LFRR', 'LFMM', 'EGLL', 'NFFF', 'XXLF'];
  const data = { controllers: ids.map(facility => ({ ...controllers[0], facility })), polygonCount: 24, pointCount: 96 };
  const filtered = filterAtcForFrance(data);
  assert.deepEqual(filtered.controllers.map(c => c.facility), ids.slice(0, 4));
  assert.equal(filtered.polygonCount, 8);
  assert.equal(filtered.pointCount, 32);
  assert.equal(data.controllers.length, 12);
});

test('ATC map altitude labels use SFC, feet, flight levels and UNL and remain viewport-cullable', () => {
  const api = loadApp([{ ...controllers[0], volumes: [{ minimumAlt: 0, maximumAlt: 66000, points: polygon }, { minimumAlt: 5000, maximumAlt: 5100, points: polygon }] }]);
  api.state.airspace = 'lower';
  const svg = api.impactedAtcSvg([zone(1,1,45,0,7000)], {x:0,y:0}, 0, 256, 256);
  assert.match(svg, /y="-3">UNL/);
  assert.match(svg, /y="9">SFC/);
  assert.match(svg, /y="-3">FL051/);
  assert.match(svg, /y="9">5\D000 ft/);
  assert.equal(api.impactedAtcSvg([zone(1,1,45,0,7000)], {x:0,y:0}, 0, 10, 10), '');
});
