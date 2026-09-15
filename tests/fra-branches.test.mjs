import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const geo=([x,y])=>[x/256*360-180,180/Math.PI*Math.atan(Math.sinh(Math.PI-2*Math.PI*y/256))];
function app(customize=()=>{},actual=false){
  const meta={records:[{g:0,e:'AAA',x:'GAI',r:0,c:0,t:0,m:1}],itineraries:['AAA DCT GAI G39 KORAB/ G39 AFRIC'],times:['H24'],
    conditions:[{airports:'overflight or DEP [LFPG, LFPO] with ARR [LFBO, LFMP]'}],
    points:[['AAA',...geo([128,90])],['GAI',...geo([130,90])],['KORAB',...geo([132,88])],['AFRIC',...geo([132,92])]],
    airports:[['LFPG','Paris',...geo([126,90])],['LFPO','Orly',...geo([126,92])],['LFBO','Toulouse',...geo([134,88])],['LFMP','Perpignan',...geo([134,92])]]};
  const data={g:[[[128,90],[130,90],[132,92]]],z:{LFRTEST:[0]}};
  customize(meta,data);
  const code=actual?source:source.split('\n').map(line=>{
    if(line.includes('const FRA_METADATA ='))return `const FRA_METADATA=${JSON.stringify(meta)};`;
    if(line.includes('const TRAJECTORY_DATA ='))return `const TRAJECTORY_DATA=${JSON.stringify(data)};`;
    if(line.includes('const AIRWAY_DATA ='))return 'const AIRWAY_DATA={lower:{routes:[]},upper:{routes:[]},points:[]};';
    if(line.includes('const ATC_DATA ='))return 'const ATC_DATA={controllers:[]};';
    return line;
  }).join('\n');
  const ctx=vm.createContext({atob,document:{getElementById:()=>null},window:{devicePixelRatio:1}});
  vm.runInContext(code.slice(0,code.lastIndexOf('\n      bindEvents();'))+'\nglobalThis.api={state,FRA_METADATA,TRAJECTORY_DATA,splitFraItinerary,fraSegmentProfile,airportConnections,routeAnalysis,drawTrajectoryCanvas,routeListItemHtml,airwayReportHtml,airportMapData,reverseSearchResults,routeGroupKey,selectHighlightedRoute};})();',ctx);
  return ctx.api;
}
function zone(x,y,bottom=18000,top=19500,id=1){return{id,name:'LF R TEST',minimumAlt:bottom,maximumAlt:top,regionMap:[[x-.1,y-.1],[x+.1,y-.1],[x+.1,y+.1],[x-.1,y+.1]].map(p=>{const[lng,lat]=geo(p);return{lng,lat};})};}

test('slash splits common-prefix branches without converting level/speed suffixes',()=>{
  const api=app();
  assert.deepEqual([...api.splitFraItinerary('GAI G39 KORAB / G39 AFRIC')],['GAI G39 KORAB','GAI G39 AFRIC']);
  assert.deepEqual([...api.splitFraItinerary('AAA DCT GAI G39 KORAB/ G39 AFRIC')],['AAA DCT GAI G39 KORAB','AAA DCT GAI G39 AFRIC']);
  assert.deepEqual([...api.splitFraItinerary('GAI G39 KORAB / G39 AFRIC / G39 OTHER')],['GAI G39 KORAB','GAI G39 AFRIC','GAI G39 OTHER']);
  for(const text of ['GAI G39 KORAB/F190 G39 AFRIC','GAI G39 KORAB/N0450F190 G39 AFRIC']) assert.deepEqual([...api.splitFraItinerary(text)],[text]);
});

test('both branch geometries are rendered and conflict checks never join the two endpoints',()=>{
  const api=app(),records=api.FRA_METADATA.records;
  assert.equal(records.length,2);
  assert.deepEqual([...records].map(r=>r.branchPointNames.at(-1)),['KORAB','AFRIC']);
  records.forEach(record=>assert.deepEqual([...api.fraSegmentProfile(record)],['upper','lower']));
  api.state.airspace='lower';
  const zones=[zone(131,89)],analysis=api.routeAnalysis(zones);
  assert.equal(analysis.conflicts.length,1);
  assert.equal(analysis.conflicts[0].record.branchPointNames.at(-1),'KORAB');
  assert.equal(analysis.groups[0].alternatives[0].record.branchPointNames.at(-1),'AFRIC');
  const paths=[],ctx={scale(){},beginPath(){},moveTo(x,y){this.previous=[x,y];},lineTo(x,y){paths.push([this.previous,[x,y]]);this.previous=[x,y];},stroke(){}};
  api.drawTrajectoryCanvas({getContext:()=>ctx},{x:0,y:0},0,256,256,true,zones);
  assert.ok(paths.some(([,b])=>Math.abs(b[1]-88)<1e-8));
  assert.ok(paths.some(([,b])=>Math.abs(b[1]-92)<1e-8));
  assert.ok(paths.every(([a])=>[128,130].some(x=>Math.abs(a[0]-x)<1e-8)&&Math.abs(a[1]-90)<1e-8),'visible branches may include the descent toward GAI, never a connection between branch endpoints');
  const branchOnly=app(meta=>{meta.conditions[0].airports='';});
  branchOnly.state.airspace='lower';
  assert.equal(branchOnly.routeAnalysis([zone(132,90)]).conflicts.length,0,'no false connector KORAB to AFRIC');
});

test('overflight-or-DEP-with-ARR connects departures and arrivals to each branch in source direction',()=>{
  const api=app();
  for(const record of api.FRA_METADATA.records){
    const connections=api.airportConnections(record).connections;
    assert.deepEqual([...connections].map(c=>`${c.role} ${c.code}`),['DEP LFPG','DEP LFPO','ARR LFBO','ARR LFMP']);
    const geometry=api.TRAJECTORY_DATA.g[record.g];
    for(const c of connections) assert.equal(c.role==='DEP'?c.points[1]:c.points[0],c.role==='DEP'?geometry[0]:geometry.at(-1));
  }
  api.state.airspace='lower';
  const data=api.airportMapData([zone(130,90)]);
  assert.equal(data.airports.length,4);
  assert.equal(data.links.length,6,'departure links share one common prefix; arrivals attach to each branch');
  api.state.routeAirport='LFBO';api.state.reverseSearch=true;api.state.filtered=[zone(127,90,0,1000)];
  assert.equal(api.reverseSearchResults().zones.length,0,'departure connector does not create conflicts');
  api.state.filtered=[zone(130,90)];
  assert.equal(api.reverseSearchResults().zones.length,1,'both lower FRA branches still impact the selected arrival');
  assert.equal(api.reverseSearchResults().counts.get(1),2);
});

test('branch cards preserve availability and identify missing siblings without inventing coordinates',()=>{
  const api=app(meta=>{meta.points=meta.points.filter(p=>p[0]!=='KORAB');});
  const record=api.FRA_METADATA.records[0];
  assert.equal(api.FRA_METADATA.records.length,1);
  assert.equal(record.branchPointNames.at(-1),'AFRIC');
  assert.ok(record.branchMissing.includes('KORAB'));
  api.state.airspace='lower';
  const entry=api.routeAnalysis([zone(131,91)]).conflicts[0];
  const card=api.routeListItemHtml(entry,false);
  assert.match(card,/Branche 2\/2/);assert.match(card,/KORAB/);assert.match(card,/Contrôle incomplet/);
  assert.match(api.airwayReportHtml([]),/Branches FRA : contrôle incomplet/);
});

test('source-only points can be recovered from a source trace with matching known anchors',()=>{
  const api=app((meta,data)=>{
    meta.points=meta.points.filter(p=>p[0]!=='KORAB');
    data.g.push([[128,90],[132,88],[132,92]]);
    meta.itineraries.push('AAA G39 KORAB G39 AFRIC');
    meta.records.push({g:1,e:'AAA',x:'AFRIC',r:1,c:0,t:0,m:1});
  });
  assert.equal(api.FRA_METADATA.records.filter(r=>r.branchCount).length,2);
});

test('branches retain military/night filters and published potential conflicts when a zone has no polygon',()=>{
  const api=app(meta=>{meta.records[0].m=2;meta.records[0].military=true;});
  api.state.airspace='lower';const a={name:'LF R TEST',minimumAlt:18000,maximumAlt:19500};
  assert.equal(api.routeAnalysis([a]).conflicts.length,0);
  api.state.showMilitaryRoutes=true;
  assert.equal(api.routeAnalysis([a]).conflicts.length,0);
  api.state.fraPeriod='night';
  const result=api.routeAnalysis([a]);
  assert.equal(result.conflicts.length,2);
  assert.equal(result.unverified,true);
  assert.equal(result.alternatives.length,0);
});

test('real SOPIL split has both KORAB/AFRIC branches and overflight DEP/ARR connections',()=>{
  const api=app(undefined,true);
  const records=api.FRA_METADATA.records.filter(r=>r.sourceItinerary==='SOPIL DCT BALAN DCT EVPOK DCT NARAK DCT GAI G39 MEDAP G39 AMOLO G39 KORAB/ G39 AFRIC');
  assert.equal(records.length,2);
  assert.deepEqual([...records].map(r=>r.branchPointNames.at(-1)),['KORAB','AFRIC']);
  for(const record of records){
    const connections=api.airportConnections(record).connections;
    for(const code of ['LFOC','LFOQ','LFOR','LFOT']) assert.ok(connections.some(c=>c.role==='DEP'&&c.code===code));
    for(const code of ['LFHO','LFMT','LFMU']) assert.ok(connections.some(c=>c.role==='ARR'&&c.code===code));
  }
});
