import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { fraPeriodMask, extractFraMetadata } from '../tools/import-fra-metadata.mjs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const g = [
  [[128, 90], [138, 90]],
  [[128, 90], [128, 93], [138, 93], [138, 90]],
  [[128, 90], [128, 87], [138, 87], [138, 90]],
  [[128, 91], [138, 91]],
  [[138, 90], [138, 93], [128, 93], [128, 90]]
];

function loadFixture(customize = () => {}, documentStub = {}) {
  const meta = { times: ['H24', '22:00..05:00'], itineraries: ['AAA DCT MID UA1 LAST DCT BBB'], records: [
    { g: 0, e: 'AAA', x: 'BBB', m: 1, t: 0, r: 0 },
    { g: 1, e: 'AAA', x: 'BBB', m: 1, t: 0 },
    { g: 2, e: 'AAA', x: 'BBB', m: 2, t: 1 },
    { g: 3, e: 'CCC', x: 'DDD', m: 1, t: 0 },
    { g: 4, e: 'BBB', x: 'AAA', m: 1, t: 0 }
  ] };
  customize(meta);
  const stubbed = source.split('\n').map(line => {
    if (line.includes('const TRAJECTORY_DATA =')) return `const TRAJECTORY_DATA = ${JSON.stringify({ airac: 'test', g, z: {} })};`;
    if (line.includes('const FRA_METADATA =')) return `const FRA_METADATA = ${JSON.stringify(meta)};`;
    if (line.includes('const AIRWAY_DATA =')) return 'const AIRWAY_DATA = { lower: { routes: [] }, upper: { routes: [] } };';
    if (line.includes('const ATC_DATA =')) return 'const ATC_DATA = { controllers: [] };';
    return line;
  }).join('\n');
  const context = vm.createContext({ document: { getElementById: () => null, ...documentStub }, window: { devicePixelRatio: 1 } });
  vm.runInContext(stubbed.slice(0, stubbed.lastIndexOf('\n      bindEvents();')) + '\nglobalThis.api = { state, AIRWAY_DATA, routeAnalysis, unprojectMercator, fraRoutesForPeriod, drawTrajectoryCanvas, airwayReportHtml, isRtbaZone, planningZones, zoneTypeClass, zoneMapColor, selectHighlightedRoute, highlightedRouteForAnalysis, routeListItemHtml, routeGroupKey, changeRouteAirport, routeLabelPoints, routePointLabelsSvg, reverseSearchResults, impactedAirports, selectedMapZones, toggleReverseSearch, selectedAirportCodes, routeEntryKey, routePairGroups, toggleRoutePairDetails, selectedRouteEntries, selectRoutePair }; })();', context);
  return context.api;
}

function zone(api, x, y, id = 1) {
  return { id, name: `Zone ${id}`, minimumAlt: 7000, maximumAlt: 40000, regionMap: [[x - .2, y - .2], [x + .2, y - .2], [x + .2, y + .2], [x - .2, y + .2]].map(([px, py]) => api.unprojectMercator({ x: px, y: py }, 0)) };
}

function detourFixture(customize = () => {}) {
  const api = loadFixture(meta => { meta.records = []; });
  api.state.airspace = 'lower';
  const routes = [
    { name: 'A0', vertices: [[128,90],[130,90],[138,90]], pointNames: ['START','VIA','END'] },
    { name: 'A1', vertices: [[130,90],[130,93],[134,93]], pointNames: ['VIA','MID1','MID2'] },
    // Reversed source order: graph directions are explicitly assumed bidirectional.
    { name: 'A2', vertices: [[138,90],[134,93]], pointNames: ['END','MID2'] },
    { name: 'A3', vertices: [[130,90],[130,98],[138,98],[138,90]], pointNames: ['VIA','FAR1','FAR2','END'] }
  ];
  customize(routes);
  api.AIRWAY_DATA.lower.routes = routes.map(({ vertices, ...route }) => ({ ...route, points: vertices.map(([x,y]) => { const p = api.unprojectMercator({x,y},0); return [p.lng,p.lat]; }) }));
  return api;
}

test('AWY fallback finds shortest connected detour using safe parts of conflicted airways with identical endpoints', () => {
  const api = detourFixture(), a = zone(api,133,90);
  const result = api.routeAnalysis([a]);
  assert.equal(result.generatedAlternatives.length,1);
  const group = result.groups.find(group => group.conflict.id === 0);
  const path = group.alternatives[0];
  assert.equal(path.kind,'airway-path');
  assert.equal(path.itinerary,'START A0 VIA A1 MID1 A1 MID2 A2 END');
  const project = point => api.unprojectMercator({x:point[0],y:point[1]},0);
  assert.deepEqual(project(path.points[0]),project([128,90]));
  assert.ok(Math.abs(project(path.points.at(-1)).lng-project([138,90]).lng)<1e-10);
  assert.equal(path.keys[0], group.conflict.keys[0]);
  assert.equal(path.conflict,false);
  assert.equal(api.routeAnalysis([a]),result,'unchanged selection reuses graph search results');
  const b = zone(api,132,93,2);
  const changed = api.routeAnalysis([a,b]);
  assert.match(changed.groups.find(group=>group.conflict.id===0).alternatives[0].itinerary,/A3 FAR1 A3 FAR2/,'detour must avoid all selected zones');
  b.regionMap=zone(api,132,98).regionMap;
  assert.match(api.routeAnalysis([a,b]).groups.find(group=>group.conflict.id===0).alternatives[0].itinerary,/A1 MID1/,'geometry changes invalidate paths');
  assert.equal(api.routeAnalysis([]).generatedAlternatives.length,0);
});

test('AWY fallback respects disconnected BREAK parts and never connects mere crossings', () => {
  const api = detourFixture(routes => routes.splice(1,3,
    {name:'A1',vertices:[[130,90],[130,93]],pointNames:['VIA','LEFT']},
    {name:'A1',vertices:[[131,93],[138,90]],pointNames:['RIGHT','END']},
    {name:'CROSS',vertices:[[129,92],[138,90]],pointNames:['CROSS','END']}
  ));
  const result=api.routeAnalysis([zone(api,133,90)]);
  assert.equal(result.airwayConflicts.size,1);
  assert.equal(result.generatedAlternatives.length,0);
  assert.equal(result.groups[0].alternatives.length,0);
});

test('AWY fallback fails closed for blocked endpoints, blocked detours and missing geometry', () => {
  for (const extra of ['start','end','both','missing']) {
    const api=detourFixture(), a=zone(api,133,90);
    const zones=[a];
    if(extra==='start') zones.push(zone(api,128,90,2));
    if(extra==='end') zones.push(zone(api,138,90,2));
    if(extra==='both') zones.push(zone(api,132,93,2),zone(api,132,98,3));
    if(extra==='missing') zones.push({id:2,name:'Unknown',minimumAlt:7000,maximumAlt:30000});
    assert.equal(api.routeAnalysis(zones).groups.find(group=>group.conflict.id===0).alternatives.length,0,extra);
  }
});

test('existing alternatives take priority; computed AWY routes respect slice, FL65 and airport filters', () => {
  const api=detourFixture(routes=>routes.push({name:'EXISTING',vertices:g[2],pointNames:['START','NORTH1','NORTH2','END']}));
  const a=zone(api,133,90);
  const result=api.routeAnalysis([a]);
  assert.equal(result.generatedAlternatives.length,0);
  assert.equal(result.groups[0].alternatives[0].kind,'airway');
  const other=detourFixture(), low=zone(other,133,90);
  low.minimumAlt=0;low.maximumAlt=6500;
  assert.equal(other.routeAnalysis([low]).generatedAlternatives.length,0);
  low.maximumAlt=6600;
  assert.equal(other.routeAnalysis([low]).generatedAlternatives.length,1);
  other.state.airspace='upper';
  assert.equal(other.routeAnalysis([low]).generatedAlternatives.length,0);
  other.state.airspace='lower';other.state.routeAirport='LFBO';
  assert.equal(other.routeAnalysis([low]).generatedAlternatives.length,0);
});

test('computed detours keep normal width and green color; selecting their box isolates all its points and routes', () => {
  const api=detourFixture(), zones=[zone(api,133,90)];
  const analysis=api.routeAnalysis(zones), group=analysis.groups[0], path=group.alternatives[0];
  assert.equal(api.routeLabelPoints(zones).length,0);
  assert.equal(api.selectHighlightedRoute(path.kind,path.id,zones,api.routeGroupKey(group)),true);
  const labels=api.routeLabelPoints(zones);
  assert.ok(labels.some(item=>item.label==='MID1'&&item.color==='#39d98a'));
  assert.ok(labels.some(item=>item.label==='START'&&item.color==='#ff5263'));
  assert.ok(!labels.some(item=>item.label==='FAR1'));
  assert.match(api.routeListItemHtml(path,true,api.routeGroupKey(group)),/sens, niveaux et disponibilités non validés/);
  const strokes=[];
  const ctx={scale(){},beginPath(){this.lines=[];},moveTo(x,y){this.lines.push([x,y]);},lineTo(x,y){this.lines.push([x,y]);},stroke(){if(this.lines.length)strokes.push({color:this.strokeStyle,width:this.lineWidth,lines:this.lines});}};
  const canvas={getContext:()=>ctx};
  api.drawTrajectoryCanvas(canvas,{x:0,y:0},0,256,256,false,zones);
  assert.deepEqual(strokes.map(s=>[s.color,s.width]),[['#39d98a',1],['#ff5263',1]]);
  assert.equal(strokes[0].lines.length,path.points.length);
  assert.ok(!strokes.some(s=>s.lines.some(([,y])=>Math.abs(y-98)<.01)),'unrelated AWY hidden');
  api.selectHighlightedRoute(path.kind,path.id,zones,api.routeGroupKey(group));
  strokes.length=0;
  api.drawTrajectoryCanvas(canvas,{x:0,y:0},0,256,256,false,zones);
  assert.ok(strokes.some(s=>s.color==='rgba(65, 75, 91, .3)'));
  assert.ok(strokes.some(s=>s.color==='#39d98a'&&s.width===1));
});

test('upper AWY fallback uses only the upper network and strict FL195 overlap', () => {
  const api = detourFixture();
  api.AIRWAY_DATA.upper.routes = api.AIRWAY_DATA.lower.routes;
  api.AIRWAY_DATA.lower.routes = [];
  api.state.airspace = 'upper';
  const a = zone(api,133,90);
  assert.equal(api.routeAnalysis([a]).generatedAlternatives.length,1);
  a.maximumAlt=19500;
  assert.equal(api.routeAnalysis([a]).generatedAlternatives.length,0);
  a.minimumAlt=19500;a.maximumAlt=19600;
  assert.equal(api.routeAnalysis([a]).generatedAlternatives.length,1);
  api.state.airspace='lower';
  assert.equal(api.routeAnalysis([a]).generatedAlternatives.length,0);
});

test('route cards collapse consecutive identical airways without changing geometry or transition points', () => {
  const api = loadFixture();
  for (const [input, expected] of [
    ['GAI V21 TOBVO V21 TAKAT', 'GAI V21 TAKAT'],
    ['GAI V21 TOBVO V21 TAKAT V21 LAST', 'GAI V21 LAST'],
    ['GAI V21 TOBVO V21 TAKAT A1 OTHER A1 LAST V21 END', 'GAI V21 TAKAT A1 LAST V21 END'],
    ['GAI DCT TOBVO DCT TAKAT', 'GAI DCT TOBVO DCT TAKAT'],
    ['GAI V21 TOBVO DCT TAKAT V21 LAST', 'GAI V21 TOBVO DCT TAKAT V21 LAST'],
    ['GAI V21 TOBVO/N0450F250 V21 TAKAT', 'GAI V21 TOBVO/N0450F250 V21 TAKAT'],
    ['GAI V21 TOBVO V21', 'GAI V21 TOBVO V21']
  ]) {
    for (const kind of ['fra','airway-path']) {
      const entry = {kind,id:0,label:'Test',itinerary:input};
      const card = api.routeListItemHtml(entry,false);
      assert.equal(card.match(/class="route-itinerary">([^<]*)<\/span>/)[1], expected);
      assert.equal(entry.itinerary,input,'source itinerary remains unchanged');
    }
  }
  const detourApi=detourFixture(), zones=[zone(detourApi,133,90)];
  const group=detourApi.routeAnalysis(zones).groups[0], path=group.alternatives[0];
  assert.match(detourApi.routeListItemHtml(path,true), />START A0 VIA A1 MID2 A2 END<\/span>/);
  assert.ok(path.pointNames.includes('MID1'));
  detourApi.selectHighlightedRoute(path.kind,path.id,zones,detourApi.routeGroupKey(group));
  assert.ok(detourApi.routeLabelPoints(zones).some(item=>item.label==='MID1'),'intermediate points remain visible on selected map routes');
});

test('availability uses explicit H24 and night ranges, not arbitrary restrictions', () => {
  assert.equal(fraPeriodMask({ time_availability: 'H24 unless interfering with a military area' }), 1);
  assert.equal(fraPeriodMask({ time_availability: '22:00..05:00 (23:00..04:00)' }), 2);
  assert.equal(fraPeriodMask({ time_availability: '00:00..03:30' }), 2);
  assert.equal(fraPeriodMask({ time_availability: 'Night, Week-End, French public holidays' }), 2);
  assert.equal(fraPeriodMask({ time_availability: 'H24 22:00..05:00' }), 3);
  assert.equal(fraPeriodMask({ time_availability: 'FRI 10:00..16:00' }), 0);
  assert.equal(fraPeriodMask({ time_availability: 'When a military area is active' }), 0);
});

test('FRA same directed endpoints turn green only if all selected zones are avoided', () => {
  const api = loadFixture();
  const a = zone(api, 133, 90), b = zone(api, 133, 93, 2);
  let result = api.routeAnalysis([a]);
  assert.deepEqual([...result.fraConflicts], [0]);
  assert.deepEqual([...result.fraAlternatives], [1]);
  assert.ok(!result.fraAlternatives.has(3), 'different endpoints are not alternatives');
  assert.ok(!result.fraAlternatives.has(4), 'reverse direction is not an alternative');
  result = api.routeAnalysis([a, b]);
  assert.ok(result.fraConflicts.has(1));
  assert.equal(result.fraAlternatives.size, 0);
  api.state.fraPeriod = 'night';
  result = api.routeAnalysis([a, b]);
  assert.deepEqual([...result.fraAlternatives], [2]);
  assert.ok(api.fraRoutesForPeriod().ids.has(1), 'night mode retains H24 routes');
  assert.equal(api.routeAnalysis([]).fraAlternatives.size, 0);
});

test('AWY conflicts use red, alternatives use green, and FL65 excludes low zones', () => {
  const api = loadFixture();
  api.state.airspace = 'lower';
  api.AIRWAY_DATA.lower.routes = g.slice(0, 4).map((points, id) => ({ name: `A${id}`, points: points.map(([x, y]) => { const p = api.unprojectMercator({ x, y }, 0); return [p.lng, p.lat]; }) }));
  const a = zone(api, 133, 90), b = zone(api, 133, 93, 2);
  const result = api.routeAnalysis([a, b]);
  assert.deepEqual([...result.airwayConflicts].sort(), [0, 1]);
  assert.deepEqual([...result.airwayAlternatives], [2]);
  assert.equal(result.groups.length, 2);
  for (const group of result.groups) assert.deepEqual([...group.alternatives].map(entry => entry.id), [2], 'shared alternative belongs to each matching conflict');
  const strokes = [];
  const context = { scale() {}, beginPath() { this.lines = []; }, moveTo(x, y) { this.lines.push([x, y]); }, lineTo(x, y) { this.lines.push([x, y]); }, stroke() { strokes.push({ color: this.strokeStyle, lines: this.lines }); } };
  api.drawTrajectoryCanvas({ getContext: () => context }, { x: 0, y: 0 }, 0, 256, 256, false, [a, b]);
  assert.ok(strokes.find(s => s.color === '#39d98a').lines.length > 0);
  assert.ok(strokes.at(-1).color === '#ff5263' && strokes.at(-1).lines.length > 0);
  a.maximumAlt = 6500;
  a.minimumAlt = 0;
  assert.equal(api.routeAnalysis([a]).airwayConflicts.size, 0);
  assert.equal(api.routeAnalysis([a]).airwayAlternatives.size, 0);
});

test('missing zone geometry prevents unverified green alternatives', () => {
  const api = loadFixture();
  const a = zone(api, 133, 90);
  const result = api.routeAnalysis([a, { name: 'Unmapped', minimumAlt: 0, maximumAlt: 40000 }]);
  assert.ok(result.unverified);
  assert.equal(result.fraAlternatives.size, 0);
});

test('RTBA descriptions are normalized, distinctively colored and hidden only from planning by default', () => {
  const api = loadFixture();
  const rtba = { id: 1, type: 'R', description: 'Test: LOW\u00a0FLYING  high speed training  area' };
  const normal = { id: 2, type: 'R', description: 'Other activity' };
  api.state.filtered = [rtba, normal];
  assert.equal(api.isRtbaZone(rtba), true);
  assert.equal(api.isRtbaZone({}), false);
  assert.equal(api.state.showRtba, false);
  assert.deepEqual([...api.planningZones()], [normal]);
  assert.equal(api.state.filtered.length, 2, 'map source remains unfiltered');
  assert.equal(api.zoneTypeClass(rtba), 'type-rtba');
  assert.equal(api.zoneMapColor(rtba), '#2dd4bf');
  assert.notEqual(api.zoneMapColor(rtba), api.zoneMapColor(normal));
  api.state.showRtba = true;
  assert.deepEqual([...api.planningZones()], [rtba, normal]);
});

test('R 589 through R 593 and their named subdivisions are RTBA without requiring a training description',()=>{
  const api=loadFixture();
  const rtba=['R 589','LF R 590','LFR591','LF-R-592','LF R 593','LF R 589 A','LF R 590A1','LF R 593 *'].map((name,id)=>({id,name,type:'R',description:''}));
  const other=['R 588','R 594','R 5890','LF D 589','EG R 589'].map((name,id)=>({id:id+20,name,type:'R'}));
  for(const item of rtba) {
    assert.equal(api.isRtbaZone(item),true,item.name);
    assert.equal(api.zoneTypeClass(item),'type-rtba');
    assert.equal(api.zoneMapColor(item),'#2dd4bf');
  }
  for(const item of other) assert.equal(api.isRtbaZone(item),false,item.name);
  api.state.filtered=[...rtba,...other];
  assert.deepEqual([...api.planningZones()],other);
  api.state.showRtba=true;
  assert.equal(api.planningZones().length,rtba.length+other.length);
});

test('not-available-for-traffic ARR/DEP clauses exclude the route only for the prohibited ICAO search',()=>{
  const api=loadFixture(meta=>{
    meta.conditions=[{airports:'DEP LFPG with ARR LFBO',utilisation:'Not available for traffic ARR LFBO'}];
    meta.records.forEach(record=>{record.c=0;});
  });
  assert.ok(api.fraRoutesForPeriod().records.length>0,'not globally deleted for other traffic');
  api.state.routeAirport='LFBO';
  assert.equal(api.fraRoutesForPeriod().records.length,0);
  const zones=[zone(api,133,90)];
  assert.equal(api.routeAnalysis(zones).conflicts.length,0);
  assert.equal(api.routeAnalysis(zones).alternatives.length,0);
  api.state.reverseSearch=true;api.state.filtered=zones;
  assert.equal(api.reverseSearchResults().zones.length,0);
  api.state.routeAirport='LFPG';
  assert.ok(api.fraRoutesForPeriod().records.length>0,'permitted departure still matches');
  assert.equal(api.reverseSearchResults().zones.length,1);
  assert.ok(api.impactedAirports(zones).every(airport=>airport.code!=='LFBO'),'negative mentions cannot create airport impacts');
  api.state.routeAirport='LFPG, LFBO';
  assert.equal(api.fraRoutesForPeriod().records.length,0,'explicit selected restriction takes precedence over another matching airport');
});

test('traffic restriction parsing handles numbered lists, case, whitespace, shorthand and explicit exceptions',()=>{
  for(const [value,code,blocked] of [
    ['not\u00a0available FOR TRAFFIC\n1.ARR LFBO\n2. DEP LFPG','LFBO',true],
    ['Not available for traffic\n1. DEP (az:PARIS_GROUP, ad:LFOB, LFQQ)','LFOB',true],
    ['Not available for traffic\n1. DEP (az:PARIS_GROUP, ad:LFOB, LFQQ)','LFQQ',true],
    ['Not available for traffic ARR LFOA/LN','LFLN',true],
    ['Not available for traffic ARR LFBO, LFPO Except ARR LFBO','LFBO',false],
    ['Not available for traffic ARR LFBO, LFPO Except ARR LFBO','LFPO',true],
    ['Not available for traffic ARR LFBO Available for traffic DEP LFPG','LFPG',false],
    ['Not available for traffic crossing LFFFIR; ARR LFBO_GROUP','LFBO',false],
    ['Available for traffic ARR LFBO','LFBO',false]
  ]) {
    const api=loadFixture(meta=>{
      meta.conditions=[{airports:`ARR ${code}`,utilisation:value}];
      meta.records.forEach(record=>{record.c=0;});
    });
    api.state.routeAirport=code;
    assert.equal(api.fraRoutesForPeriod().records.length===0,blocked,value+' / '+code);
  }
});

test('traffic restrictions are checked across every condition field and do not contaminate shared-geometry variants',()=>{
  for(const field of ['airports','utilisation','vertical']) {
    const api=loadFixture(meta=>{
      meta.conditions=[{airports:'ARR LFBO',[field]:'Not available for traffic ARR LFBO'},{airports:'ARR LFBO'}];
      meta.records=[{...meta.records[0],c:0},{...meta.records[0],c:1}];
    });
    api.state.routeAirport='LFBO';
    assert.equal(api.fraRoutesForPeriod().records.length,1,field);
    assert.equal(api.fraRoutesForPeriod().records[0].c,1);
    const result=api.routeAnalysis([zone(api,133,90)]);
    assert.equal(result.conflicts.length,1);
    assert.equal(result.conflicts[0].conditionId,1);
  }
});

test('full published FRA itineraries survive import and are rendered without truncation', () => {
  const itinerary = 'AAA DCT MID UA1 LAST DCT BBB';
  const feature = { geometry: { coordinates: [[1, 48], [2, 49]] }, properties: { E: 'AAA', X: 'BBB', route_complete: itinerary, fpl_route: 'SHORT', time_availability: 'H24' } };
  const meta = extractFraMetadata(`route_all = ${JSON.stringify({ features: [feature] })};`);
  assert.equal(meta.itineraries[meta.records[0].r], itinerary);
  const api = loadFixture();
  assert.ok(api.airwayReportHtml([zone(api, 133, 90)]).includes(itinerary));
  assert.ok(api.routeListItemHtml({ kind: 'fra', id: 0, label: 'AAA', itinerary: '<unsafe>', time: '' }, false).includes('&lt;unsafe&gt;'));
});

for (const kind of ['fra', 'airway']) {
  test(`${kind} selection isolates its box and preserves red conflicts and green alternatives`, () => {
    const api = loadFixture();
    if (kind === 'airway') {
      api.state.airspace = 'lower';
      api.AIRWAY_DATA.lower.routes = [g[0], g[1], g[3]].map((points, id) => ({ name: `A${id}`, points: points.map(([x, y]) => { const p = api.unprojectMercator({ x, y }, 0); return [p.lng, p.lat]; }) }));
    }
    const a = zone(api, 133, 90);
    const strokes = [];
    const context = { scale() {}, beginPath() { this.paths = 0; }, moveTo() { this.paths++; }, lineTo() {}, stroke() { strokes.push({ color: this.strokeStyle, width: this.lineWidth, paths: this.paths }); } };
    const groupKey = api.routeGroupKey(api.routeAnalysis([a]).groups[0]);
    for (const id of [0, 1]) {
      strokes.length = 0;
      assert.equal(api.selectHighlightedRoute(kind, id, [a], groupKey), true);
      api.drawTrajectoryCanvas({ getContext: () => context }, { x: 0, y: 0 }, 0, 256, 256, true, [a]);
      assert.deepEqual(strokes, [{ color: '#39d98a', width: kind === 'fra' ? .8 : 1, paths: kind === 'fra' ? 1 : 3 }, { color: '#ff5263', width: kind === 'fra' ? .8 : 1, paths: 1 }], 'only the conflict and its alternative are drawn, preserving colors');
      assert.equal((api.airwayReportHtml([a]).match(/class="route-item[^>]+aria-pressed="true"/g) || []).length, 2);
      assert.equal(api.highlightedRouteForAnalysis(api.routeAnalysis([])), null);
      assert.equal(api.selectHighlightedRoute(kind, 1 - id, [a], groupKey), true);
      assert.equal(api.state.highlightedRoute, null, 'second click clears selection');
      strokes.length = 0;
      api.drawTrajectoryCanvas({ getContext: () => context }, { x: 0, y: 0 }, 0, 256, 256, true, [a]);
      assert.ok(strokes.some(stroke => stroke.color === '#ff5263'));
      assert.ok(strokes.every(stroke => stroke.color !== '#ff69cf'));
    }
    assert.equal(api.selectHighlightedRoute(kind, 999, [a], groupKey), false);
    assert.equal(api.state.highlightedRoute, null);
  });
}

test('a shared alternative selects the clicked box, not every box containing that route', () => {
  const api = loadFixture();
  api.state.fraPeriod = 'night';
  const zones = [zone(api, 133, 90), zone(api, 133, 93, 2)];
  const analysis = api.routeAnalysis(zones);
  const sharedGroups = analysis.groups.filter(group => group.alternatives.some(entry => entry.id === 2));
  assert.equal(sharedGroups.length, 2);
  for (const group of sharedGroups) {
    assert.equal(api.selectHighlightedRoute('fra', 2, zones, api.routeGroupKey(group)), true);
    assert.equal(api.highlightedRouteForAnalysis(analysis).conflict.id, group.conflict.id);
    assert.equal((api.airwayReportHtml(zones).match(/class="route-item[^>]+aria-pressed="true"/g) || []).length, 2);
  }
  assert.equal(api.selectHighlightedRoute('fra', 2, zones, 'missing-box'), false);
});

test('a mixed FRA/AWY box isolates both route types and suppresses unrelated routes', () => {
  const api = loadFixture();
  api.AIRWAY_DATA.upper.routes = [g[1], g[3]].map((points, id) => ({ name: `A${id}`, points: points.map(([x, y]) => { const p = api.unprojectMercator({ x, y }, 0); return [p.lng, p.lat]; }) }));
  const zones = [zone(api, 133, 90)];
  const group = api.routeAnalysis(zones).groups[0];
  assert.equal(api.selectHighlightedRoute('airway', 0, zones, api.routeGroupKey(group)), true);
  const strokes = [];
  const context = { scale() {}, beginPath() { this.paths = 0; }, moveTo() { this.paths++; }, lineTo() {}, stroke() { strokes.push([this.strokeStyle, this.lineWidth, this.paths]); } };
  api.drawTrajectoryCanvas({ getContext: () => context }, { x: 0, y: 0 }, 0, 256, 256, true, zones);
  assert.deepEqual(strokes, [['#39d98a', 1, 3], ['#39d98a', .8, 1], ['#ff5263', .8, 1]]);
});

test('same directed entry/exit conflicts are grouped under collapsed details without merging condition variants',()=>{
  const api=loadFixture(meta=>{
    meta.conditions=[{airports:'DEP LFPG'},{airports:'DEP LFPO'}];
    meta.records=[{...meta.records[0],c:0},{...meta.records[0],c:1},meta.records[3]];
  });
  const zones=[zone(api,133,90),zone(api,133,91,2)];
  const analysis=api.routeAnalysis(zones),pairs=api.routePairGroups(analysis);
  assert.equal(pairs.length,2);
  assert.equal(pairs.find(pair=>pair.label==='AAA → BBB').groups.length,2);
  assert.equal(analysis.conflicts.length,3,'variants remain distinct for calculations');
  const report=api.airwayReportHtml(zones);
  assert.equal((report.match(/class="route-pair-group"/g)||[]).length,2);
  assert.equal((report.match(/class="route-pair-content" hidden/g)||[]).length,2);
  assert.equal((report.match(/aria-expanded="false"/g)||[]).length,2);
  assert.equal((report.match(/class="route-conflict-group"/g)||[]).length,3);
  assert.match(report,/Afficher les détails/);
  assert.match(report,/DEP LFPG/);assert.match(report,/DEP LFPO/);
  assert.match(report,/data-route-entry=/);
  assert.match(report,/Voir conflit \+ alternatives/);
});

test('details buttons expand and collapse without selecting routes and retain state across report refreshes',()=>{
  const buttons=[];
  const api=loadFixture(()=>{}, {querySelectorAll:()=>buttons});
  const zones=[zone(api,133,90)],pair=api.routePairGroups(api.routeAnalysis(zones))[0];
  for(let i=0;i<2;i++) {
    const content={hidden:true},label={textContent:''};
    buttons.push({dataset:{routePairToggle:pair.key},attributes:{},content,label,
      setAttribute(k,v){this.attributes[k]=v;},querySelector:()=>label,closest:()=>({querySelector:()=>content})});
  }
  api.toggleRoutePairDetails(buttons[0]);
  for(const button of buttons){assert.equal(button.attributes['aria-expanded'],'true');assert.equal(button.content.hidden,false);assert.match(button.label.textContent,/Masquer/);}
  assert.match(api.airwayReportHtml(zones),/aria-expanded="true"/);
  assert.doesNotMatch(api.airwayReportHtml(zones),/class="route-pair-content" hidden/);
  assert.equal(api.state.highlightedRoute,null);
  api.toggleRoutePairDetails(buttons[1]);
  assert.ok(buttons.every(button=>button.content.hidden));
  assert.match(api.airwayReportHtml(zones),/class="route-pair-content" hidden/);
});

for(const kind of ['fra','airway']) test(`${kind} pair selection shows all group conflicts and deduplicated alternatives only`,()=>{
  const api=loadFixture(meta=>{if(kind==='airway')meta.records=[];});
  api.state.fraPeriod='night';
  if(kind==='airway'){
    api.state.airspace='lower';
    api.AIRWAY_DATA.lower.routes=g.slice(0,4).map((points,id)=>({name:`V${id}`,pointNames:points.map((_,i)=>i===0?(id===3?'OTHER':'AAA'):i===points.length-1?(id===3?'LAST':'BBB'):`MID${id}${i}`),points:points.map(([x,y])=>{const p=api.unprojectMercator({x,y},0);return[p.lng,p.lat];})}));
  }
  const zones=[zone(api,133,90),zone(api,133,93,2),zone(api,133,91,3)];
  const analysis=api.routeAnalysis(zones),pair=api.routePairGroups(analysis).find(pair=>pair.label==='AAA → BBB');
  assert.equal(pair.groups.length,2);
  assert.equal(api.selectRoutePair(pair.key,zones),true);
  const selected=api.highlightedRouteForAnalysis(analysis),entries=api.selectedRouteEntries(selected);
  assert.equal(entries.filter(entry=>entry.conflict).length,2);
  assert.equal(entries.filter(entry=>!entry.conflict).length,1,'shared alternative displayed once');
  assert.deepEqual([...entries].map(entry=>entry.id).sort(),[0,1,2]);
  const strokes=[],ctx={scale(){},beginPath(){this.paths=0;},moveTo(){this.paths++;},lineTo(){},stroke(){if(this.paths)strokes.push([this.strokeStyle,this.lineWidth,this.paths]);}};
  api.drawTrajectoryCanvas({getContext:()=>ctx},{x:0,y:0},0,256,256,true,zones);
  assert.deepEqual(strokes,kind==='fra'?[['#39d98a',.8,1],['#ff5263',.8,2]]:[['#39d98a',1,3],['#ff5263',1,4]]);
  assert.ok(api.routeLabelPoints(zones).every(label=>label.point[1]!==91),'unrelated route points are hidden');
  const report=api.airwayReportHtml(zones);
  assert.match(report,/class="route-pair-select selected"/);
  assert.match(report,/Groupe affiché/);
  assert.match(report,/class="route-pair-content" hidden/,'group selection does not force details open');
  assert.equal(api.highlightedRouteForAnalysis(api.routeAnalysis([])),null,'disappearing groups cannot retain stale route geometry');
  assert.equal(api.selectRoutePair('missing',zones),false);
  assert.equal(api.selectRoutePair(pair.key,zones),true);
  assert.equal(api.state.highlightedRoute,null,'second group click restores the full map');
});

test('pair, comparison-box and individual selections can replace one another without losing variants',()=>{
  const api=loadFixture();api.state.fraPeriod='night';
  const zones=[zone(api,133,90),zone(api,133,93,2)],analysis=api.routeAnalysis(zones);
  const pair=api.routePairGroups(analysis).find(pair=>pair.label==='AAA → BBB'),group=pair.groups[0];
  api.selectRoutePair(pair.key,zones);
  assert.equal(api.selectedRouteEntries(api.highlightedRouteForAnalysis(analysis)).length,3);
  api.selectHighlightedRoute('fra',group.conflict.id,zones,api.routeGroupKey(group),api.routeEntryKey(group.conflict));
  assert.equal(api.selectedRouteEntries(api.highlightedRouteForAnalysis(analysis)).length,1);
  assert.doesNotMatch(api.airwayReportHtml(zones),/class="route-pair-select selected"/);
  api.selectRoutePair(pair.key,zones);
  assert.equal(api.selectedRouteEntries(api.highlightedRouteForAnalysis(analysis)).length,3);
  api.selectHighlightedRoute('fra',group.conflict.id,zones,api.routeGroupKey(group));
  assert.equal(api.selectedRouteEntries(api.highlightedRouteForAnalysis(analysis)).length,2);
});

for(const kind of ['fra','airway']) test(`${kind} variants select individually and retain normal red/green widths`,()=>{
  const api=loadFixture();
  if(kind==='airway') {
    api.state.airspace='lower';
    api.AIRWAY_DATA.lower.routes=[g[0],g[1],g[3]].map((points,id)=>({name:`A${id}`,points:points.map(([x,y])=>{const p=api.unprojectMercator({x,y},0);return[p.lng,p.lat];})}));
  }
  const zones=[zone(api,133,90)],analysis=api.routeAnalysis(zones);
  const group=analysis.groups.find(group=>group.conflict.kind===kind),groupKey=api.routeGroupKey(group);
  const alternative=group.alternatives.find(entry=>entry.kind===kind);
  const strokes=[],ctx={scale(){},beginPath(){this.paths=0;},moveTo(){this.paths++;},lineTo(){},stroke(){if(this.paths)strokes.push({color:this.strokeStyle,width:this.lineWidth});}};
  for(const entry of [alternative,group.conflict]) {
    assert.equal(api.selectHighlightedRoute(kind,entry.id,zones,groupKey,api.routeEntryKey(entry)),true);
    assert.deepEqual([...api.selectedRouteEntries(group)],[entry]);
    strokes.length=0;api.drawTrajectoryCanvas({getContext:()=>ctx},{x:0,y:0},0,256,256,true,zones);
    assert.deepEqual(strokes,[{color:entry.conflict?'#ff5263':'#39d98a',width:kind==='fra'?.8:1}]);
    assert.equal((api.airwayReportHtml(zones).match(/class="route-item[^>]+aria-pressed="true"/g)||[]).length,1);
  }
  assert.equal(api.selectHighlightedRoute(kind,group.conflict.id,zones,groupKey,api.routeEntryKey(group.conflict)),true);
  assert.equal(api.state.highlightedRoute,null,'second click on the same variant clears selection');
  api.selectHighlightedRoute(kind,group.conflict.id,zones,groupKey);
  assert.ok(api.selectedRouteEntries(group).length>1,'explicit group selection remains available');
});

test('individual selection distinguishes variants with identical geometry but different conditions',()=>{
  const api=loadFixture(meta=>{
    meta.conditions=[{airports:'ARR LFBO'},{airports:'ARR LFPO'}];
    meta.records=[{...meta.records[0],c:0},{...meta.records[0],c:1}];
  });
  const zones=[zone(api,133,90)],groups=api.routeAnalysis(zones).groups;
  assert.notEqual(api.routeEntryKey(groups[0].conflict),api.routeEntryKey(groups[1].conflict));
  assert.equal(api.selectHighlightedRoute('fra',0,zones,api.routeGroupKey(groups[0]),api.routeEntryKey(groups[1].conflict)),false,'another condition cannot be selected via the wrong box');
  for(const group of groups){
    api.selectHighlightedRoute('fra',0,zones,api.routeGroupKey(group),api.routeEntryKey(group.conflict));
    assert.equal(api.selectedRouteEntries(group)[0].conditionId,group.conflict.conditionId);
    assert.equal((api.airwayReportHtml(zones).match(/class="route-item[^>]+aria-pressed="true"/g)||[]).length,1);
  }
});

test('a generated airway detour can be displayed alone without its red conflict',()=>{
  const api=detourFixture(),zones=[zone(api,133,90)],group=api.routeAnalysis(zones).groups[0];
  const detour=group.alternatives.find(entry=>entry.kind==='airway-path');
  assert.ok(detour);
  api.selectHighlightedRoute(detour.kind,detour.id,zones,api.routeGroupKey(group),api.routeEntryKey(detour));
  const strokes=[],ctx={scale(){},beginPath(){this.paths=0;},moveTo(){this.paths++;},lineTo(){},stroke(){if(this.paths)strokes.push([this.strokeStyle,this.lineWidth]);}};
  api.drawTrajectoryCanvas({getContext:()=>ctx},{x:0,y:0},0,256,256,true,zones);
  assert.deepEqual(strokes,[['#39d98a',1]]);
  assert.equal(api.routeLabelPoints(zones).length,detour.points.length);
});

test('route panel is inside map shell, separate from the zone list', () => {
  const template = source.slice(source.indexOf('function renderMapMode('), source.indexOf('function renderCurrentView('));
  assert.match(template, /class="map-zone-list">\$\{zoneList\}<\/div>\s*<\/aside>\s*<div class="overview-map-shell">\s*<aside class="airway-report map-route-panel"/);
  assert.match(template, /class="overview-map-viewport"/);
});

test('each conflict box includes only its own alternatives, with an explicit empty state', () => {
  const api = loadFixture();
  const zones = [zone(api, 133, 90), zone(api, 133, 91, 2)];
  const analysis = api.routeAnalysis(zones);
  assert.equal(analysis.groups.length, 2);
  assert.deepEqual([...analysis.groups[0].alternatives].map(entry => entry.id), [1], 'matching both pair keys does not duplicate the route');
  assert.equal(analysis.groups[1].conflict.id, 3);
  assert.equal(analysis.groups[1].alternatives.length, 0, 'unrelated endpoints do not inherit alternatives');
  const report = api.airwayReportHtml(zones);
  const boxes = [...report.matchAll(/<section class="route-conflict-group"[^>]*>([\s\S]*?)<\/section>/g)].map(match => match[1]);
  assert.equal(boxes.length, 2);
  assert.match(boxes[0], /data-route-id="0"[\s\S]*Alternatives · 1[\s\S]*data-route-id="1"/);
  assert.match(boxes[1], /data-route-id="3"[\s\S]*Aucune alternative correspondante/);
  assert.doesNotMatch(boxes[1], /data-route-id="1"/);
  const missingReport = api.airwayReportHtml([...zones, { name: 'Missing', minimumAlt: 0, maximumAlt: 40000 }]);
  assert.match(missingReport, /Alternatives non vérifiables/);
  assert.doesNotMatch(api.airwayReportHtml([]), /class="route-conflict-group"/);
});

test('import preserves ARR/DEP restrictions and recognizes explicit military flight types', () => {
  const uses = ['with flt-type(M)', 'FLT-TYPE (M, X)', 'FLT-TYPE M,X', 'flight type M', 'FLT-TYPE(X)', 'ARR LFMN'];
  const features = uses.map(utilisation => ({ geometry: { coordinates: [[1, 48], [2, 49]] }, properties: {
    E: 'AAA', X: 'BBB', time_availability: 'H24', utilisation,
    'ADEP or ADES': 'DEP LFPG\nNot available for ARR LFML', vertical_constraint: 'FL285max with ARR LFPO'
  } }));
  const meta = extractFraMetadata(`route_all = ${JSON.stringify({ features })};`);
  assert.deepEqual(meta.records.map(record => record.military), [true, true, true, true, false, false]);
  for (const record of meta.records) {
    assert.equal(meta.conditions[record.c].airports, 'DEP LFPG\nNot available for ARR LFML');
    assert.equal(meta.conditions[record.c].vertical, 'FL285max with ARR LFPO');
  }
});

test('route cards preserve distinct ARR/DEP conditions for the same itinerary', () => {
  const api = loadFixture(meta => {
    meta.conditions = [{ airports: 'ARR LFPG', utilisation: 'FLT-TYPE(M)', vertical: 'FL285max' }, { airports: 'DEP LFPO <condition>' }];
    meta.records[0].c = 0;
    meta.records[0].military = true;
    meta.records.push({ ...meta.records[0], c: 1, military: false });
  });
  api.state.showMilitaryRoutes = true;
  const zones = [zone(api, 133, 90)];
  const analysis = api.routeAnalysis(zones);
  assert.equal(analysis.groups.length, 2);
  assert.notEqual(api.routeGroupKey(analysis.groups[0]), api.routeGroupKey(analysis.groups[1]));
  const report = api.airwayReportHtml(zones);
  for (const text of ['ARR LFPG', 'DEP LFPO &lt;condition&gt;', 'FLT-TYPE(M)', 'FL285max', 'Flight type M']) assert.ok(report.includes(text));
});

test('military FRA are green normally and red on conflict including their selected box', () => {
  const api = loadFixture(meta => { meta.records[0].military = true; });
  api.state.showMilitaryRoutes = true;
  const strokes = [];
  const context = { scale() {}, beginPath() { this.paths = 0; }, moveTo() { this.paths++; }, lineTo() {}, stroke() { if (this.paths) strokes.push({ color: this.strokeStyle, width: this.lineWidth }); } };
  const draw = zones => { strokes.length = 0; api.drawTrajectoryCanvas({ getContext: () => context }, { x: 0, y: 0 }, 0, 256, 256, true, zones); };
  draw([]);
  assert.deepEqual(strokes.at(-1), { color: '#238653', width: .8 });
  const zones = [zone(api, 133, 90)];
  draw(zones);
  assert.equal(strokes.at(-1).color, '#ff5263');
  api.selectHighlightedRoute('fra', 0, zones, api.routeGroupKey(api.routeAnalysis(zones).groups[0]));
  draw(zones);
  assert.deepEqual(strokes, [{ color: '#39d98a', width: .8 }, { color: '#ff5263', width: .8 }]);
  api.state.airspace = 'lower';
  draw([]);
  assert.equal(strokes.length, 0);
});

test('military routes are hidden by default, independently toggled, and excluded from cached conflicts and alternatives', () => {
  const api = loadFixture(meta => { meta.records[0].military = true; meta.records[2].military = true; });
  const zones = [zone(api, 133, 90)];
  assert.equal(api.state.showMilitaryRoutes, false);
  assert.equal(api.fraRoutesForPeriod().ids.has(0), false);
  assert.equal(api.routeAnalysis(zones).conflicts.length, 0);
  assert.doesNotMatch(api.airwayReportHtml(zones), /Flight type M/);
  const strokes = [];
  const context = { scale() {}, beginPath() { this.starts = []; }, moveTo(x, y) { this.starts.push([x, y]); }, lineTo() {}, stroke() { if (this.starts.length) strokes.push({ color: this.strokeStyle, paths: this.starts.length }); } };
  const draw = showAll => { strokes.length = 0; api.drawTrajectoryCanvas({ getContext: () => context }, { x: 0, y: 0 }, 0, 256, 256, showAll, []); };
  draw(true);
  assert.deepEqual(strokes, [{ color: 'rgba(65, 75, 91, .3)', paths: 3 }]);
  api.state.showMilitaryRoutes = true;
  assert.equal(api.routeAnalysis(zones).conflicts.length, 1);
  draw(false);
  assert.deepEqual(strokes, [{ color: 'rgba(65, 75, 91, .3)', paths: 4 }, { color: '#238653', paths: 1 }], 'FRA always visible; military button adds green routes');
  api.state.fraPeriod = 'night';
  draw(false);
  assert.deepEqual(strokes, [{ color: 'rgba(65, 75, 91, .3)', paths: 5 }, { color: '#238653', paths: 2 }], 'night filter applies to military routes');
  api.state.showMilitaryRoutes = false;
  assert.equal(api.routeAnalysis(zones).conflicts.length, 0);
  assert.equal(api.routeAnalysis(zones).alternatives.length, 0);
  assert.equal(api.fraRoutesForPeriod().ids.has(2), false);
});

test('airport filter updates FRA paths, conflict boxes and alternatives and restores them when cleared', () => {
  const api = loadFixture(meta => {
    meta.conditions = [{ airports: 'ARR LFPG' }, { utilisation: 'Not available for DEP LFPG' }, { airports: 'DEP LFPO' }, { airports: 'ARR LFPGROUP' }];
    meta.records.forEach((record, index) => { record.c = [0, 1, 0, 2, 3][index]; });
  });
  const zones = [zone(api, 133, 90)];
  api.routeAnalysis(zones);
  const input = { value: 'lfpg', matches: () => true, setCustomValidity() {}, reportValidity: () => true };
  api.changeRouteAirport(input);
  assert.equal(api.state.routeAirport, 'LFPG');
  assert.deepEqual([...api.fraRoutesForPeriod().ids], [0, 1], 'exact airport mentions only, and H24 filter retained');
  assert.deepEqual([...api.routeAnalysis(zones).fraAlternatives], [], 'a negative DEP mention cannot replace a required ARR airport');
  api.state.fraPeriod = 'night';
  assert.deepEqual([...api.fraRoutesForPeriod().ids], [0, 1, 2]);
  input.value = 'LFPO';
  api.changeRouteAirport(input);
  assert.deepEqual([...api.fraRoutesForPeriod().ids], [3]);
  assert.equal(api.routeAnalysis(zones).conflicts.length, 0);
  input.value = '';
  api.changeRouteAirport(input);
  assert.equal(api.fraRoutesForPeriod().ids.size, 5);
  assert.equal(api.routeAnalysis(zones).conflicts.length, 1);
  assert.equal(api.state.highlightedRoute, null);
});

test('FRA render by default in upper airspace with exactly the AWY color; airport filter hides untagged AWY', () => {
  const api = loadFixture(meta => {
    meta.conditions = [{ airports: 'ARR LFPG' }];
    meta.records[0].c = 0;
  });
  api.AIRWAY_DATA.upper.routes = [{ name: 'A1', points: g[3].map(([x, y]) => { const p = api.unprojectMercator({ x, y }, 0); return [p.lng, p.lat]; }) }];
  const strokes = [];
  const context = { scale() {}, beginPath() { this.paths = 0; }, moveTo() { this.paths++; }, lineTo() {}, stroke() { if (this.paths) strokes.push([this.strokeStyle, this.lineWidth, this.paths]); } };
  const draw = () => { strokes.length = 0; api.drawTrajectoryCanvas({ getContext: () => context }, { x: 0, y: 0 }, 0, 256, 256, false, []); };
  draw();
  assert.deepEqual(strokes, [['rgba(65, 75, 91, .3)', .8, 4], ['rgba(65, 75, 91, .3)', 1, 1]]);
  api.state.routeAirport = 'LFPG';
  draw();
  assert.deepEqual(strokes, [['rgba(65, 75, 91, .3)', .8, 1]]);
  assert.equal(api.routeAnalysis([zone(api, 133, 91)]).airwayConflicts.size, 0);
  api.state.airspace = 'lower';
  draw();
  assert.deepEqual(strokes, [['rgba(65, 75, 91, .3)', .8, 1]], 'missing ARR coordinates retain possible lower FRA context');
});

test('map labels and point symbols are absent normally and show every selected route vertex', () => {
  const api = loadFixture(meta => {
    meta.points = [['ENTRY', 128, 90], ['EXIT', 138, 90], ['MID<ONE>', 128, 93], ['MIDTWO', 138, 93]].map(([name, x, y]) => [name, x / 256 * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 256))) * 180 / Math.PI]);
  });
  const zones = [zone(api, 133, 90)];
  const normal = api.routeLabelPoints(zones);
  assert.equal(normal.length, 0);
  assert.doesNotMatch(api.routePointLabelsSvg(zones, { x: 0, y: 0 }, 0, 256, 256), /<text|<circle/);
  api.selectHighlightedRoute('fra', 1, zones, api.routeGroupKey(api.routeAnalysis(zones).groups[0]));
  const selected = api.routeLabelPoints(zones);
  assert.deepEqual([...selected].map(point => point.label).sort(), ['ENTRY', 'EXIT', 'MID<ONE>', 'MIDTWO'].sort());
  assert.equal(selected.find(point => point.label === 'ENTRY').color, '#ff5263', 'shared point keeps conflict priority');
  assert.equal(selected.find(point => point.label === 'MIDTWO').color, '#39d98a');
  const svg = api.routePointLabelsSvg(zones, { x: 0, y: 0 }, 0, 256, 256);
  assert.ok(svg.includes('MID&lt;ONE&gt;'));
  assert.equal((svg.match(/<circle /g) || []).length, 4);
  assert.doesNotMatch(api.routePointLabelsSvg(zones, { x: 1000, y: 1000 }, 0, 256, 256), /<text/);
  api.selectHighlightedRoute('fra', 0, zones, api.routeGroupKey(api.routeAnalysis(zones).groups[0]));
  assert.equal(api.routeLabelPoints(zones).length, 0);
  api.state.airspace = 'lower';
  assert.equal(api.routeLabelPoints(zones).length, 0, 'no FRA labels in lower airspace');
});

test('AWY vertices without a known fix use coordinates and respect airport filtering', () => {
  const api = loadFixture();
  api.state.airspace = 'lower';
  api.AIRWAY_DATA.lower.routes = [g[0], g[1]].map((points, id) => ({ name: `A${id}`, points: points.map(([x, y]) => { const p = api.unprojectMercator({ x, y }, 0); return [p.lng, p.lat]; }) }));
  const zones = [zone(api, 133, 90)];
  assert.equal(api.routeLabelPoints(zones).length, 0);
  api.selectHighlightedRoute('airway', 0, zones, api.routeGroupKey(api.routeAnalysis(zones).groups[0]));
  const points = api.routeLabelPoints(zones);
  assert.equal(points.length, 4);
  assert.ok(points.every(point => /°[NS] .*°[EW]/.test(point.label)));
  api.state.routeAirport = 'LFPG';
  assert.equal(api.routeLabelPoints(zones).length, 0);
});

test('metadata importer embeds named navigation points and airport coordinates', () => {
  const feature = { geometry: { coordinates: [[1, 48], [2, 49]] }, properties: { E: 'AAA', X: 'BBB' } };
  const fix = { properties: { PT: 'AAA' }, geometry: { type: 'Point', coordinates: [1, 48] } };
  const airport = { properties: { oaci: 'LFPG' }, geometry: { type: 'Point', coordinates: [2.5, 49] } };
  const text = `route_all = ${JSON.stringify({ features: [feature] })};\npoint_all = ${JSON.stringify({ features: [fix] })};\nairport = ${JSON.stringify({ features: [airport] })};`;
  assert.deepEqual(extractFraMetadata(text).points, [['AAA', 1, 48], ['LFPG', 2.5, 49]]);
});

test('selected AWY use explicit source point names in labels and itinerary cards', () => {
  const api = loadFixture();
  api.state.airspace = 'lower';
  api.AIRWAY_DATA.lower.routes = [{ name: 'A1', pointNames: ['START', 'END'], points: g[0].map(([x, y]) => { const p = api.unprojectMercator({ x, y }, 0); return [p.lng, p.lat]; }) }];
  const zones = [zone(api, 133, 90)];
  assert.match(api.airwayReportHtml(zones), /START → END/);
  api.selectHighlightedRoute('airway', 0, zones, api.routeGroupKey(api.routeAnalysis(zones).groups[0]));
  assert.deepEqual([...api.routeLabelPoints(zones)].map(point => point.label), ['START', 'END']);
});

test('multiple airport input is normalized and validated without changing state on invalid input', () => {
  const api = loadFixture();
  const input = { value: 'lfpg; LFPO lfpg', matches: () => true, setCustomValidity(message) { this.error = message; }, reportValidity() { return !this.error; } };
  api.changeRouteAirport(input);
  assert.equal(api.state.routeAirport, 'LFPG, LFPO');
  assert.deepEqual([...api.selectedAirportCodes()], ['LFPG', 'LFPO']);
  input.value = 'LFPG, BAD';
  api.changeRouteAirport(input);
  assert.ok(input.error);
  assert.equal(api.state.routeAirport, 'LFPG, LFPO');
  input.value = '';
  api.changeRouteAirport(input);
  assert.equal(api.state.routeAirport, '');
});

test('reverse search unions airports, respects altitude and filters, and preserves manual zone selection', () => {
  const api = loadFixture(meta => {
    meta.conditions = [{ airports: 'ARR LFPG' }, { airports: 'DEP LFPO' }, { airports: 'ARR LFML' }];
    meta.records.forEach((record, index) => { record.c = [0, 1, 2, 2, 2][index]; });
  });
  const a = zone(api, 133, 90), b = zone(api, 133, 93, 2), c = zone(api, 133, 87, 3);
  const low = { ...zone(api, 133, 90, 4), minimumAlt: 0, maximumAlt: 19500 };
  const missing = { id: 5, name: 'Missing', minimumAlt: 0, maximumAlt: 40000 };
  api.state.zones = api.state.filtered = [a, b, c, low, missing];
  api.state.mapSelection.add(c.id);
  api.toggleReverseSearch();
  assert.equal(api.state.reverseSearch, true);
  assert.equal(api.selectedMapZones().length, 0, 'no airport means no reverse result');
  api.state.routeAirport = 'LFPG';
  assert.deepEqual([...api.selectedMapZones()].map(zone => zone.id), [1]);
  api.state.routeAirport = 'LFPG, LFPO';
  assert.deepEqual([...api.selectedMapZones()].map(zone => zone.id), [1, 2]);
  assert.deepEqual([...api.reverseSearchResults().missing].map(zone => zone.id), [5]);
  assert.equal(api.reverseSearchResults().counts.get(1), 1);
  api.state.routeAirport = 'LFML';
  assert.equal(api.selectedMapZones().some(zone => zone.id === 3), false);
  api.state.fraPeriod = 'night';
  assert.equal(api.selectedMapZones().some(zone => zone.id === 3), true);
  api.state.filtered = [a];
  assert.equal(api.selectedMapZones().length, 0, 'global zone filters are respected');
  api.state.airspace = 'lower';
  assert.equal(api.selectedMapZones().length, 0);
  api.state.airspace = 'upper';
  api.toggleReverseSearch();
  assert.deepEqual([...api.selectedMapZones()].map(zone => zone.id), [3], 'manual selection is restored');
});

test('zone impact lists all explicit airports independently of search, with no duplicate routes or non-airport words', () => {
  const api = loadFixture(meta => {
    meta.airports = [['LFPG', 'Paris CDG'], ['LFPO', 'Paris Orly'], ['LFML', 'Marseille']];
    meta.conditions = [{ airports: 'ARR LFPG, DEP LFPO, WITH ONLY', utilisation: 'Not available for ARR LFML' }];
    meta.records[0].c = 0;
    meta.records.push({ ...meta.records[0] });
  });
  const a = zone(api, 133, 90);
  api.state.routeAirport = 'LFPG';
  const impact = api.impactedAirports([a, a]);
  assert.deepEqual([...impact].map(item => [item.code, item.count]), [['LFML', 1], ['LFPG', 1], ['LFPO', 1]]);
  assert.match(api.airwayReportHtml([a]), /aérodromes sur la carte/);
  assert.doesNotMatch(api.airwayReportHtml([a]), /airport-impact-list/);
  assert.match(api.airwayReportHtml([a]), /sans coordonnées/);
  api.state.airspace = 'lower';
  assert.equal(api.impactedAirports([a]).length, 3, 'unknown airport positions retain potential lower impacts');
  api.state.airspace = 'upper';
  a.maximumAlt = 19500;
  assert.equal(api.impactedAirports([a]).length, 0);
});

test('military and night filters also control reverse results and airport impact', () => {
  const api = loadFixture(meta => {
    meta.conditions = [{ airports: 'ARR LFPG' }];
    meta.records[0].c = 0;
    meta.records[0].military = true;
    meta.records[0].m = 2;
  });
  const a = zone(api, 133, 90);
  api.state.filtered = [a];
  api.state.routeAirport = 'LFPG';
  api.state.reverseSearch = true;
  assert.equal(api.reverseSearchResults().zones.length, 0);
  api.state.fraPeriod = 'night';
  assert.equal(api.reverseSearchResults().zones.length, 0);
  api.state.showMilitaryRoutes = true;
  assert.equal(api.reverseSearchResults().zones.length, 1);
  assert.equal(api.impactedAirports([a])[0].code, 'LFPG');
  api.state.showMilitaryRoutes = false;
  assert.equal(api.reverseSearchResults().zones.length, 0);
  assert.equal(api.impactedAirports([a]).length, 0);
});

test('explicit airports absent from the naming catalogue remain searchable and listed', () => {
  const api = loadFixture(meta => {
    meta.airports = [['LFPG', 'Paris CDG']];
    meta.conditions = [{ airports: 'ARR LEGE, DEP LERS' }];
    meta.records[0].c = 0;
  });
  const a = zone(api, 133, 90);
  api.state.filtered = [a];
  api.state.reverseSearch = true;
  api.state.routeAirport = 'LEGE';
  assert.equal(api.reverseSearchResults().zones.length, 1);
  assert.deepEqual([...api.impactedAirports([a])].map(item => item.code), ['LEGE', 'LERS']);
});
