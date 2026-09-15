import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { extractFraMetadata } from '../tools/import-fra-metadata.mjs';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const unproject=([x,y])=>[x/256*360-180,180/Math.PI*Math.atan(Math.sinh(Math.PI-2*Math.PI*y/256))];
function app(customize=()=>{}, actual=false) {
  const meta={records:[{g:0,e:'START',x:'END',m:1,t:0,r:0,c:0},{g:1,e:'START',x:'END',m:1,t:0,r:0,c:0}],
    itineraries:['START DCT END'],times:['H24'],conditions:[{airports:'DEP LFPG; ARR LFBO, ARR LFPO'}],
    airports:[['LFPG','Paris <CDG>',...unproject([128,90])],['LFBO','Toulouse',...unproject([138,90])],['LFPO','Orly',...unproject([134,96])]],points:[]};
  const data={g:[[[130,90],[134,90]],[[130,90],[132,92],[134,90]]],z:{}};
  const atc={controllers:[]};
  customize(meta,data,atc);
  const code=actual?source:source.split('\n').map(line=>{
    if(line.includes('const FRA_METADATA ='))return `const FRA_METADATA=${JSON.stringify(meta)};`;
    if(line.includes('const TRAJECTORY_DATA ='))return `const TRAJECTORY_DATA=${JSON.stringify(data)};`;
    if(line.includes('const ATC_DATA ='))return `const ATC_DATA=${JSON.stringify(atc)};`;
    if(line.includes('const AIRWAY_DATA ='))return 'const AIRWAY_DATA={lower:{routes:[]},upper:{routes:[]},points:[]};';
    return line;
  }).join('\n');
  const ctx=vm.createContext({atob,document:{getElementById:()=>null,querySelectorAll:()=>[]},window:{devicePixelRatio:1}});
  vm.runInContext(code.slice(0,code.lastIndexOf('\n      bindEvents();'))+'\nglobalThis.api={state,FRA_METADATA,AIRWAY_DATA,airportConnections,airportMapData,airportMapSvg,airportMapFitPoints,airportImpactReportHtml,routeAnalysis,fraRecordConflictsForZone,reverseSearchResults,selectHighlightedRoute,routeGroupKey,fraRoutesForPeriod,toggleAirportConnections,connectionsButtonHtml,expandAirportCodes,airportAssociations,drawTrajectoryCanvas,routeListItemHtml,routePairGroups,selectRoutePair};})();',ctx);
  return ctx.api;
}
function zone(x,y,bottom=0,top=2000,id=1) {
  return {id,name:'TEST',minimumAlt:bottom,maximumAlt:top,regionMap:[[x-.1,y-.1],[x+.1,y-.1],[x+.1,y+.1],[x-.1,y+.1]].map(point=>{const [lng,lat]=unproject(point);return{lng,lat};})};
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('positive DEP and ARR link the airport to the first and last trace points respectively',()=>{
  const api=app(),connections=api.airportConnections(api.FRA_METADATA.records[0]).connections;
  assert.equal(connections.length,3);
  for(const connection of connections) {
    const endpoint=connection.role==='DEP'?connection.points[1]:connection.points[0];
    assert.deepEqual(plain(endpoint),connection.role==='DEP'?[130,90]:[134,90]);
    const airportPoint=connection.role==='DEP'?connection.points[0]:connection.points[1];
    assert.deepEqual(plain(airportPoint),plain(connection.airportPoint));
  }
});

test('airport connections never create conflicts at any altitude or in either slice',()=>{
  const api=app(),record=api.FRA_METADATA.records[0],a=zone(129,90);
  api.state.airspace='lower';
  assert.equal(api.fraRecordConflictsForZone(record,a),false,'departure link only, outside FRA trace');
  assert.equal(api.routeAnalysis([a]).conflicts.length,0);
  for(const [bottom,top] of [[0,500],[6000,6100],[18000,18500],[19499,20000],[19500,30000],[0,0]]) {
    a.minimumAlt=bottom;a.maximumAlt=top;
    assert.equal(api.fraRecordConflictsForZone(record,a),false);
  }
  a.minimumAlt=0;a.maximumAlt=2000;
  a.regionMap=zone(120,85).regionMap;
  assert.equal(api.fraRecordConflictsForZone(record,a),false,'geometry changes invalidate connection tests');
  api.state.airspace='upper';
  assert.equal(api.fraRecordConflictsForZone(record,zone(129,90,25000,40000)),false);
  assert.equal(api.fraRecordConflictsForZone(record,zone(132,90,25000,40000)),true,'core FRA conflicts remain checked');
});

test('inverse search ignores all arrival and departure connections',()=>{
  const api=app();api.state.airspace='lower';api.state.reverseSearch=true;api.state.routeAirport='LFBO';
  api.state.filtered=[zone(136,90,500,1000,1),zone(134,94,500,1000,2),zone(129,90,500,1000,3)];
  assert.equal(api.reverseSearchResults().zones.length,0);
  api.state.routeAirport='LFPO';
  assert.equal(api.reverseSearchResults().zones.length,0);
  api.state.routeAirport='LFBO, LFPO';
  assert.equal(api.reverseSearchResults().zones.length,0);
  api.state.airspace='upper';
  assert.equal(api.reverseSearchResults().zones.length,0);
});

test('airport markers replace the list; directed links deduplicate and frame both airports and trace ends',()=>{
  const api=app();const zones=[zone(132,90,25000,40000)];
  const data=api.airportMapData(zones);
  assert.equal(data.airports.length,3);
  assert.equal(data.links.length,3,'two identical itinerary endpoints share one displayed connection');
  assert.equal(api.airportMapData(zones),data,'panning reuses the analysis overlay cache');
  const svg=api.airportMapSvg(zones,{x:0,y:0},0,256,256);
  assert.equal((svg.match(/class="airport-map-marker"/g)||[]).length,3);
  assert.equal((svg.match(/class="airport-connection"/g)||[]).length,3);
  assert.match(svg,/Paris &lt;CDG&gt;/);
  assert.match(svg,/stroke-dasharray="5 4"/);
  assert.match(svg,/stroke-width="0.8"/);
  assert.doesNotMatch(api.airportImpactReportHtml(zones),/airport-impact-list/);
  assert.match(api.airportImpactReportHtml(zones),/3 aérodromes sur la carte/);
  assert.equal(api.airportMapData([]).airports.length,0);
  assert.ok(api.airportMapFitPoints(zones).some(p=>Math.abs(p.lng-unproject([138,90])[0])<1e-8));
  assert.doesNotMatch(api.airportMapSvg(zones,{x:0,y:0},0,10,10),/class="airport-map-marker"|class="airport-connection"/);
  assert.ok(html.includes('${airportLayer}')&&html.includes('airportMapFitPoints([zone])'));
});

test('isolated route boxes preserve red conflicts and green alternative airport links, including upper context',()=>{
  const api=app();const zones=[zone(132,90,25000,40000)];
  const analysis=api.routeAnalysis(zones),group=analysis.groups[0];
  assert.equal(group.alternatives.length,1);
  api.selectHighlightedRoute('fra',0,zones,api.routeGroupKey(group));
  const data=api.airportMapData(zones);
  assert.ok(data.airports.length>0,'upper conflicts still show lower airport connections as context');
  assert.ok(data.links.every(link=>link.color==='#ff5263'),'shared links keep red priority');
  api.state.airspace='lower';
  assert.equal(api.airportMapData(zones).airports.length,0,'upper-only conflict does not survive slice change');
});

test('individual variants refresh airport overlays even when switching within the same box',()=>{
  const api=app(),zones=[zone(132,90,25000,40000)];
  const group=api.routeAnalysis(zones).groups[0],key=api.routeGroupKey(group),alternative=group.alternatives[0];
  api.selectHighlightedRoute('fra',group.conflict.id,zones,key,api.routeGroupKey({conflict:group.conflict}));
  const conflictMap=api.airportMapData(zones);
  assert.ok(conflictMap.links.every(link=>link.color==='#ff5263'));
  api.selectHighlightedRoute('fra',alternative.id,zones,key,api.routeGroupKey({conflict:alternative}));
  const alternativeMap=api.airportMapData(zones);
  assert.notEqual(alternativeMap,conflictMap,'cache distinguishes individual entries within the same comparison box');
  assert.equal(alternativeMap.links.length,3);
  assert.ok(alternativeMap.links.every(link=>link.color==='#39d98a'));
  api.selectHighlightedRoute('fra',group.conflict.id,zones,key);
  assert.ok(api.airportMapData(zones).links.every(link=>link.color==='#ff5263'),'group comparison restores red priority on shared links');
});

test('pair selection includes airports from all its variants and refreshes the overlay on individual selection',()=>{
  const api=app(meta=>{
    meta.conditions=[{airports:'ARR LFBO'},{airports:'ARR LFPO'}];
    meta.records[1].c=1;
  });
  const zones=[zone(132,90,25000,40000),zone(132,92,25000,40000,2)];
  const pair=api.routePairGroups(api.routeAnalysis(zones))[0];
  assert.equal(pair.groups.length,2);
  api.selectRoutePair(pair.key,zones);
  const combined=api.airportMapData(zones);
  assert.deepEqual([...combined.airports].map(a=>a.code).sort(),['LFBO','LFPO']);
  assert.equal(combined.links.length,2);
  const group=pair.groups[0];
  api.selectHighlightedRoute('fra',group.conflict.id,zones,api.routeGroupKey(group),api.routeGroupKey(group));
  const individual=api.airportMapData(zones);
  assert.notEqual(individual,combined);
  assert.equal(individual.airports.length,1);
  api.selectRoutePair(pair.key,zones);
  assert.equal(api.airportMapData(zones).airports.length,2);
});

test('restrictions, FIRs, ambiguous roles and absent coordinates never invent airport connections',()=>{
  const api=app(meta=>{
    meta.conditions[0].airports='NOT AVAILABLE FOR ARR LFPO; ARR LFMMFIR; ARR LFPG_GROUP; ARR LEGE; LFBO; DEP LFPG';
  });
  const result=api.airportConnections(api.FRA_METADATA.records[0]);
  assert.deepEqual([...result.connections].map(c=>c.code),['LFPG']);
  assert.deepEqual([...result.missing],['LEGE']);
  assert.ok(result.unresolved.includes('LFBO'));
  const data=api.airportMapData([zone(132,90,25000,40000)]);
  assert.equal(data.airports.length,1);
  assert.ok(data.missing.has('LEGE'));
  assert.match(api.airportImpactReportHtml([zone(132,90,25000,40000)]),/sans coordonnées/);
});

test('lower alternatives ignore connector intersections and still render their links green',()=>{
  const api=app((meta,data)=>{
    meta.conditions[0].airports='ARR LFBO';
    meta.itineraries=['START V21 END','START V21 MID V21 END'];
    meta.records[1].r=1;
    data.g[1]=[[130,90],[132,92],[134,92]];
  });
  api.state.airspace='lower';
  const a=zone(132,90,18000,19500),b=zone(136,91,0,2000,2);
  const analysis=api.routeAnalysis([a]);
  assert.equal(analysis.conflicts.length,1);
  assert.equal(analysis.groups[0].alternatives.length,1);
  const links=api.airportMapData([a]).links;
  assert.ok(links.some(link=>link.color==='#39d98a'));
  assert.ok(links.some(link=>link.color==='#ff5263'));
  assert.equal(api.routeAnalysis([a,b]).alternatives.length,1,'connector collision does not exclude otherwise-safe FRA alternatives');
});

test('missing airport coordinates leave potential conflicts but prevent verified slope-based alternatives',()=>{
  const api=app(meta=>{
    meta.airports=[];
    meta.itineraries=['START V21 END','START V21 MID V21 END'];
    meta.records[1].r=1;
  });
  api.state.airspace='lower';
  const result=api.routeAnalysis([zone(132,90,18000,19500)]);
  assert.equal(result.conflicts.length,1);
  assert.equal(result.alternatives.length,0);
  assert.equal(result.conflicts[0].verticalUnverified,true);
});

test('alternatives preserve every specified airport role, not just the FRA entry and exit',()=>{
  for(const [original,candidate,expected] of [
    ['DEP LFPG','DEP LFPG',1],['DEP LFPG','DEP LFPO',0],['DEP LFPG','ARR LFPG',0],
    ['ARR LFBO','ARR LFBO, LFPO',1],['ARR LFBO','',0],['ARR LFBO','NOT AVAILABLE FOR ARR LFBO',0],
    ['DEP LFPG with ARR LFBO','DEP LFPG with ARR LFPO',0],
    ['DEP LFPG with ARR LFBO','DEP LFPO with ARR LFBO',0],
    ['DEP LFPG with ARR LFBO','overflight or DEP LFPG with ARR LFBO',1],
    ['ARR LFOA/LN','ARR LFLN',1],['','DEP LFPO',1]
  ]) {
    const api=app(meta=>{
      meta.conditions=[{airports:original},{airports:candidate}];meta.records[1].c=1;
      meta.airports.push(['LFOA','Avord',...unproject([128,90])],['LFLN','Saint-Yan',...unproject([128,90])]);
    });
    const result=api.routeAnalysis([zone(132,90,25000,40000)]);
    assert.equal(result.groups[0].alternatives.length,expected,`${original} => ${candidate}`);
    assert.equal(result.alternatives.length,expected,'global green alternatives agree with boxes');
    assert.equal(result.fraAlternatives.size,expected);
  }
});

test('alternatives are airport-compatible with their own box even when different conflicts share endpoints',()=>{
  const api=app(meta=>{
    meta.conditions=[{airports:'DEP LFPG'},{airports:'DEP LFPO'}];
    meta.records.push({...meta.records[0],c:1});
  });
  const result=api.routeAnalysis([zone(132,90,25000,40000)]);
  assert.equal(result.groups.length,2);
  assert.equal(result.groups.find(g=>g.conflict.conditionId===0).alternatives.length,1);
  assert.equal(result.groups.find(g=>g.conflict.conditionId===1).alternatives.length,0);
});

test('airport filtering cannot substitute another arrival merely because the departure still matches',()=>{
  const api=app(meta=>{
    meta.conditions=[{airports:'DEP LFPG with ARR LFBO, LFPO'},{airports:'DEP LFPG with ARR LFPO'}];
    meta.records[1].c=1;
  });
  const zones=[zone(132,90,25000,40000)];
  assert.equal(api.routeAnalysis(zones).alternatives.length,1);
  api.state.routeAirport='LFPG, LFBO';
  assert.equal(api.fraRoutesForPeriod().records.length,2,'both routes still match the broad airport filter');
  assert.equal(api.routeAnalysis(zones).alternatives.length,0,'alternative must preserve the selected arrival');
  api.state.routeAirport='LFPG, LFPO';
  assert.equal(api.routeAnalysis(zones).alternatives.length,1);
});

test('unassociated AWY cannot replace FRA with an explicit airport requirement',()=>{
  const api=app();
  api.AIRWAY_DATA.upper.routes=[{name:'UT300',points:[[130,90],[132,93],[134,90]].map(unproject)}];
  const result=api.routeAnalysis([zone(132,90,25000,40000)]);
  assert.ok(result.groups[0].alternatives.every(entry=>entry.kind==='fra'));
  assert.equal(result.airwayAlternatives.size,0);
});

function differentEndpoints(original,candidate,customize=()=>{}) {
  return app((meta,data)=>{
    meta.airports.push(['LFOA','Avord',...unproject([128,90])],['LFLN','Saint-Yan',...unproject([128,90])]);
    meta.conditions=[{airports:original},{airports:candidate}];
    meta.itineraries.push('OTHER DCT MID DCT LAST');
    Object.assign(meta.records[1],{e:'OTHER',x:'LAST',r:1,c:1});
    data.g[1]=[[129,92],[132,93],[135,92]];
    customize(meta,data);
  });
}

test('different FRA entries and exits are allowed only for the same explicit departure AND arrival',()=>{
  for(const [original,candidate,expected] of [
    ['DEP LFPG with ARR LFBO','DEP LFPG with ARR LFBO',1],
    ['DEP LFPG, LFPO with ARR LFBO','DEP LFPO with ARR LFBO',1],
    ['DEP LFOA/LN with ARR LFBO','DEP LFLN with ARR LFBO',1],
    ['DEP LFPG with ARR LFBO','DEP LFPO with ARR LFBO',0],
    ['DEP LFPG with ARR LFBO','DEP LFPG with ARR LFPO',0],
    ['DEP LFPG with ARR LFBO','DEP LFBO with ARR LFPG',0],
    ['DEP LFPG with ARR LFBO','ARR LFBO',0],
    ['ARR LFBO','ARR LFBO',0],['DEP LFPG','DEP LFPG',0],['','',0],
    ['DEP LFPG with ARR LFBO','DEP LFPG; NOT AVAILABLE FOR ARR LFBO',0]
  ]) {
    const api=differentEndpoints(original,candidate);
    const result=api.routeAnalysis([zone(132,90,25000,40000)]);
    assert.equal(result.conflicts.length,1);
    assert.equal(result.groups[0].alternatives.length,expected,`${original} => ${candidate}`);
    assert.equal(result.fraAlternatives.size,expected);
    assert.equal(result.alternatives.length,expected);
    if(expected) assert.equal(result.groups[0].alternatives[0].label,'OTHER → LAST');
  }
});

test('airport-pair alternatives still avoid every zone and obey airport, military and period filters',()=>{
  const api=differentEndpoints('DEP LFPG with ARR LFBO, LFPO','DEP LFPG with ARR LFPO');
  const a=zone(132,90,25000,40000),b=zone(132,93,25000,40000,2);
  assert.equal(api.routeAnalysis([a]).alternatives.length,1);
  api.state.routeAirport='LFPG, LFBO';
  assert.equal(api.routeAnalysis([a]).alternatives.length,0);
  api.state.routeAirport='LFPG, LFPO';
  assert.equal(api.routeAnalysis([a]).alternatives.length,1);
  assert.equal(api.routeAnalysis([a,b]).alternatives.length,0,'airport match cannot override a geometric conflict');
  const filtered=differentEndpoints('DEP LFPG with ARR LFBO','DEP LFPG with ARR LFBO',meta=>{
    meta.records[1].military=true;meta.records[1].m=2;
  });
  assert.equal(filtered.routeAnalysis([a]).alternatives.length,0);
  filtered.state.showMilitaryRoutes=true;
  assert.equal(filtered.routeAnalysis([a]).alternatives.length,0);
  filtered.state.fraPeriod='night';
  assert.equal(filtered.routeAnalysis([a]).alternatives.length,1);
});

test('different-endpoint alternatives stay in the correct box and retain their own airport connections',()=>{
  const api=differentEndpoints('DEP LFPG with ARR LFBO','DEP LFPG with ARR LFBO',meta=>{
    meta.conditions.push({airports:'DEP LFPO with ARR LFBO'});
    meta.records.push({...meta.records[0],c:2});
  });
  const zones=[zone(132,90,25000,40000)],result=api.routeAnalysis(zones);
  const group=result.groups.find(g=>g.conflict.conditionId===0);
  assert.equal(group.alternatives.length,1);
  assert.equal(result.groups.find(g=>g.conflict.conditionId===2).alternatives.length,0);
  api.selectHighlightedRoute('fra',1,zones,api.routeGroupKey(group));
  const data=api.airportMapData(zones);
  assert.deepEqual([...data.airports].map(a=>a.code).sort(),['LFBO','LFPG']);
  assert.ok(data.links.some(link=>link.color==='#39d98a'&&link.points.some(p=>p[0]===129&&p[1]===92)),'green alternative connects its own first point');
  assert.ok(data.links.some(link=>link.color==='#ff5263'));
});

test('period and military filters also hide airport connections and their conflicts',()=>{
  const api=app(meta=>{meta.records[0].military=true;meta.records[1].m=2;});
  const zones=[zone(130,90,25000,40000)];
  assert.equal(api.routeAnalysis(zones).conflicts.length,0);
  assert.equal(api.airportMapData(zones).airports.length,0);
  api.state.showMilitaryRoutes=true;
  assert.equal(api.routeAnalysis(zones).conflicts.length,1);
  api.state.showMilitaryRoutes=false;api.state.fraPeriod='night';
  assert.equal(api.routeAnalysis(zones).conflicts.length,1);
  assert.ok(api.airportMapData(zones).links.length>0);
});

test('airport-only ATC impacts get a marker but no fabricated route connection',()=>{
  const api=app((meta,data,atc)=>{
    atc.controllers=[{name:'Toulouse',icao:'LFBO',facility:'LFBO',role:'twr',volumes:[{minimumAlt:0,maximumAlt:3000,points:[[119,84],[121,84],[121,86],[119,86]].map(unproject)}]}];
  });
  api.state.airspace='lower';
  const data=api.airportMapData([zone(120,85)]);
  assert.deepEqual([...data.airports].map(a=>a.code),['LFBO']);
  assert.equal(data.links.length,0);
});

test('airport coordinate import is explicit and the embedded LFBO position is retained',()=>{
  const source='route_all = '+JSON.stringify({features:[]})+';\nairport = '+JSON.stringify({features:[{geometry:{type:'Point',coordinates:[1.3,43.6]},properties:{oaci:'LFBO',nom:'Toulouse'}}]})+';';
  assert.deepEqual(extractFraMetadata(source).airports,[['LFBO','Toulouse',1.3,43.6]]);
  const api=app(undefined,true),airport=api.FRA_METADATA.airports.find(a=>a[0]==='LFBO');
  assert.equal(airport[2],1.3677777777777778);assert.equal(airport[3],43.635);
});

test('connections toggle hides only segments while retaining airport markers and conflict results',()=>{
  const api=app();const zones=[zone(132,90,25000,40000)];
  const analysis=api.routeAnalysis(zones);
  assert.equal(api.state.showAirportConnections,true);
  assert.match(api.connectionsButtonHtml(),/Connexions : ON/);
  assert.match(api.airportMapSvg(zones,{x:0,y:0},0,256,256),/class="airport-connection"/);
  api.toggleAirportConnections();
  const svg=api.airportMapSvg(zones,{x:0,y:0},0,256,256);
  assert.doesNotMatch(svg,/class="airport-connection"/);
  assert.match(svg,/class="airport-map-marker"/);
  assert.equal(api.routeAnalysis(zones),analysis,'display toggle does not invalidate or disable conflict calculations');
  assert.match(api.connectionsButtonHtml(),/aria-pressed="false"/);
  assert.match(api.connectionsButtonHtml(),/Connexions : OFF/);
  api.state.routeAirport='LFBO';api.state.reverseSearch=true;api.state.filtered=zones;
  assert.equal(api.reverseSearchResults().zones.length,1);
  api.toggleAirportConnections();
  assert.match(api.airportMapSvg(zones,{x:0,y:0},0,256,256),/class="airport-connection"/);
  assert.equal((html.match(/connectionsButtonHtml\(\)/g)||[]).length,4,'button is included in both maps and refreshed drawer controls');
  assert.equal((html.match(/closest\("\[data-airport-connections\]"\)/g)||[]).length,2,'both map event handlers are wired');
});

test('lower AWY remain visible with airport and inverse filters, but isolated boxes still hide unrelated AWY',()=>{
  const api=app((meta,data,atc)=>{
    meta.itineraries=['START V21 END'];
    atc.controllers=[{icao:'LFBO',role:'tracon',volumes:[{minimumAlt:0,maximumAlt:19500,points:[[120,89],[122,89],[122,91],[120,91]].map(unproject)}]}];
  });api.state.airspace='lower';
  api.AIRWAY_DATA.lower.routes=[{name:'V21',points:[[120,90],[122,90]].map(unproject)},{name:'G39',points:[[120,94],[122,94]].map(unproject)}];
  const zones=[zone(121,90,7000,9000)],strokes=[];
  const ctx={scale(){},beginPath(){this.lines=[];},moveTo(x,y){this.lines.push([x,y]);},lineTo(x,y){this.lines.push([x,y]);},stroke(){if(this.lines.length)strokes.push({color:this.strokeStyle,width:this.lineWidth,lines:this.lines});}};
  const draw=(selection)=>{strokes.length=0;api.drawTrajectoryCanvas({getContext:()=>ctx},{x:0,y:0},0,256,256,true,selection);};
  for(const reverse of [false,true]) {
    api.state.routeAirport='LFBO';api.state.reverseSearch=reverse;draw(zones);
    assert.ok(strokes.some(s=>s.width===1&&s.color==='rgba(65, 75, 91, .3)'),'safe background AWY remains visible');
    assert.ok(strokes.some(s=>s.width===1&&s.color==='#ff5263'),'AWY conflicts stay red');
    assert.ok(api.routeAnalysis(zones).groups.every(group=>group.conflict.kind==='fra'),'unassociated AWY do not pollute airport-filtered cards');
  }
  api.state.filtered=zones;
  assert.equal(api.reverseSearchResults().zones.length,1,'the selected airport ATC footprint is still included in inverse searches');
  const fraZones=[zone(132,90,18000,19500)],group=api.routeAnalysis(fraZones).groups[0];
  api.selectHighlightedRoute('fra',group.conflict.id,fraZones,api.routeGroupKey(group));draw(fraZones);
  assert.ok(!strokes.some(s=>s.width===1),'selected route box still isolates its own routes');
});

test('airport suffix shorthand expands without touching branches, levels, FIRs or ordinary prose',()=>{
  const api=app();
  for(const [input,output] of [
    ['LFOA/LN','LFOA, LFLN'],['arr lfoa / ln / bo','arr LFOA, LFLN, LFBO'],['LFOA/LFLN','LFOA, LFLN'],
    ['LFOA/NTAA/BB','LFOA, NTAA, NTBB'],['LFOA/LN_GROUP','LFOA/LN_GROUP'],
    ['GAI G39 KORAB / G39 AFRIC','GAI G39 KORAB / G39 AFRIC'],['KORAB/F190','KORAB/F190'],['ONLY/IF','ONLY/IF']
  ]) assert.equal(api.expandAirportCodes(input),output);
  assert.deepEqual([...api.airportAssociations('overflight or DEP LFOA/LN with ARR LFBO').values()].map(a=>a.role+' '+a.code),['DEP LFOA','DEP LFLN','ARR LFBO']);
  assert.equal(api.airportAssociations('NOT AVAILABLE FOR ARR LFOA/LN').size,0);
});

test('LFOA/LN affects filtering, airport connections, inverse searches and displayed FRA conditions',()=>{
  const api=app(meta=>{
    meta.conditions[0].airports='ARR LFOA/LN';
    meta.airports.push(['LFOA','Avord',...unproject([138,90])],['LFLN','Saint-Yan',...unproject([134,96])]);
  });
  const record=api.FRA_METADATA.records[0];
  assert.deepEqual([...api.airportConnections(record).connections].map(c=>c.code),['LFOA','LFLN']);
  api.state.routeAirport='LFLN';api.state.reverseSearch=true;
  api.state.filtered=[zone(132,90,25000,40000)];
  assert.equal(api.reverseSearchResults().zones.length,1);
  const result=api.routeAnalysis(api.state.filtered);
  assert.ok(result.conflicts.length>0);
  assert.match(api.routeListItemHtml(result.conflicts[0],false),/ARR LFOA, LFLN/);
  assert.deepEqual([...api.airportMapData(api.state.filtered).airports].map(a=>a.code),['LFLN']);
  api.state.routeAirport='LFOA';
  assert.equal(api.reverseSearchResults().zones.length,1,'both airport suffixes match their shared FRA route');
  api.state.airspace='lower';api.state.filtered=[zone(134,94)];
  assert.equal(api.reverseSearchResults().zones.length,0,'airport connections alone cannot create reverse matches');
});
