import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const geometries=[[[128,90],[130,90],[132,90],[134,90]],[[128,90],[130,93],[132,93],[134,90]]];

function app(customize=()=>{}, actual=false) {
  const meta={records:[{g:0,e:'AAA',x:'LAST',m:1,t:0,r:0,c:0},{g:0,e:'AAA',x:'LAST',m:1,t:0,r:1,c:1},{g:1,e:'AAA',x:'LAST',m:1,t:0,r:0,c:0}],
    itineraries:['AAA DCT MID V21 END UT300 LAST','AAA DCT MID UT300 END UT300 LAST'],times:['H24'],conditions:[{airports:'ARR LFBO'},{airports:'ARR LFPO'}],points:[],airports:['LFBO','LFPO'].map(code=>[code,code,134/256*360-180,180/Math.PI*Math.atan(Math.sinh(Math.PI-2*Math.PI*90/256))])};
  const trajectories={g:JSON.parse(JSON.stringify(geometries)),z:{LFRTEST:[0]}};
  customize(meta,trajectories);
  const code=actual?source:source.split('\n').map(line=>{
    if(line.includes('const FRA_METADATA ='))return `const FRA_METADATA=${JSON.stringify(meta)};`;
    if(line.includes('const TRAJECTORY_DATA ='))return `const TRAJECTORY_DATA=${JSON.stringify(trajectories)};`;
    if(line.includes('const AIRWAY_DATA ='))return 'const AIRWAY_DATA={lower:{routes:[]},upper:{routes:[]},points:[]};';
    if(line.includes('const ATC_DATA ='))return 'const ATC_DATA={controllers:[]};';
    return line;
  }).join('\n');
  const context=vm.createContext({atob,document:{getElementById:()=>null},window:{devicePixelRatio:1}});
  vm.runInContext(code.slice(0,code.lastIndexOf('\n      bindEvents();'))+'\nglobalThis.api={state,FRA_METADATA,TRAJECTORY_DATA,fraSegmentProfile,fraRecordConflictsForZone,fraRoutesForPeriod,routeAnalysis,reverseSearchResults,impactedAirports,unprojectMercator,drawTrajectoryCanvas,routeGroupKey,selectHighlightedRoute,routeLabelPoints,routeListItemHtml};})();',context);
  return context.api;
}

function zone(api,x,y,bottom=18000,top=19200,id=1) {
  return {id,name:'LF R TEST',minimumAlt:bottom,maximumAlt:top,regionMap:[[x-.1,y-.1],[x+.1,y-.1],[x+.1,y+.1],[x-.1,y+.1]].map(([x,y])=>api.unprojectMercator({x,y},0))};
}

test('FRA V21 caps at FL190; DCT and UT300 can climb/descend below their FL350 cruise cap',()=>{
  const api=app(), record=api.FRA_METADATA.records[0];
  assert.deepEqual([...api.fraSegmentProfile(record)],['upper','lower','upper']);
  api.state.airspace='lower';
  const a=zone(api,131,90);
  assert.equal(api.fraRecordConflictsForZone(record,a),true);
  for(const [bottom,top] of [[0,18999],[19001,19500],[20000,30000]]) {
    a.minimumAlt=bottom;a.maximumAlt=top;
    assert.equal(api.fraRecordConflictsForZone(record,a),false);
  }
  for(const [bottom,top] of [[18000,19000],[19000,19500]]) {
    a.minimumAlt=bottom;a.maximumAlt=top;
    assert.equal(api.fraRecordConflictsForZone(record,a),true,'FL190 boundary contact is included');
  }
  assert.equal(api.fraRecordConflictsForZone(record,zone(api,129,90)),false,'DCT not lower');
  assert.equal(api.fraRecordConflictsForZone(record,zone(api,133,90)),true,'arrival descent on UT300 crosses FL190');
  api.state.airspace='upper';
  assert.equal(api.fraRecordConflictsForZone(record,zone(api,131,90,25000,40000)),false,'published JS association must not override segment altitude');
  assert.equal(api.fraRecordConflictsForZone(record,zone(api,129,90,25000,40000)),true);
  assert.equal(api.fraRecordConflictsForZone(record,zone(api,133,90,25000,40000)),false,'aircraft is already descending below this upper zone');
});

test('shared FRA geometry retains per-itinerary vertical conflicts, airport impacts and inverse results',()=>{
  const api=app(), upper=zone(api,131,90,25000,40000), lower=zone(api,131,90,18000,19200,2);
  let result=api.routeAnalysis([upper]);
  assert.equal(result.conflicts.length,1);
  assert.equal(result.conflicts[0].conditionId,1,'only upper variant conflicts');
  assert.deepEqual([...api.impactedAirports([upper])].map(a=>a.code),['LFPO']);
  api.state.filtered=[upper,lower];api.state.reverseSearch=true;api.state.routeAirport='LFBO';
  assert.equal(api.reverseSearchResults().zones.length,0);
  api.state.airspace='lower';
  assert.deepEqual([...api.reverseSearchResults().zones].map(z=>z.id),[2]);
  assert.equal(api.reverseSearchResults().counts.get(2),1);
  result=api.routeAnalysis([lower]);
  assert.equal(result.conflicts.length,1);
  assert.equal(result.conflicts[0].conditionId,0);
  assert.equal(result.groups[0].alternatives.length,1,'lower detour is a verified alternative');
  assert.deepEqual([...api.impactedAirports([lower])].map(a=>a.code),['LFBO']);
  lower.maximumAlt=18999;
  assert.equal(api.reverseSearchResults().zones.length,0,'altitude edit invalidates reverse results');
});

test('lower FRA drawing and selected labels include segments crossing the lower slice during transitions',()=>{
  const api=app();api.state.airspace='lower';
  const zones=[zone(api,131,90)],group=api.routeAnalysis(zones).groups[0];
  api.selectHighlightedRoute('fra',0,zones,api.routeGroupKey(group));
  const strokes=[],ctx={scale(){},beginPath(){this.lines=[];},moveTo(x,y){this.lines.push([x,y]);},lineTo(x,y){this.lines.push([x,y]);},stroke(){if(this.lines.length)strokes.push({color:this.strokeStyle,lines:this.lines,width:this.lineWidth});}};
  api.drawTrajectoryCanvas({getContext:()=>ctx},{x:0,y:0},0,256,256,true,zones);
  assert.deepEqual(strokes,[{color:'#39d98a',lines:geometries[1],width:.8},{color:'#ff5263',lines:geometries[0],width:.8}]);
  assert.equal(api.routeLabelPoints(zones).length,6);
  assert.match(api.routeListItemHtml(group.conflict,false),/FL190/);
});

test('extra geometry vertices align by named anchors without dropping the lower airway span',()=>{
  const unproject=([x,y])=>[(x/256)*360-180,180/Math.PI*Math.atan(Math.sinh(Math.PI-2*Math.PI*y/256))];
  const api=app((meta,data)=>{
    data.g[0]=[[128,90],[130,90],[131,90],[132,90],[134,90]];
    meta.points=['AAA','MID','END','LAST'].map((name,i)=>[name,...unproject(geometries[0][i])]);
  });
  assert.deepEqual([...api.fraSegmentProfile(api.FRA_METADATA.records[0])],['upper','lower','lower','upper']);
});

test('routes starting before their FRA entry render fully in both slices without changing conflict altitudes',()=>{
  const api=app(meta=>{meta.records.forEach(record=>{record.e='MID';});});
  const record=api.FRA_METADATA.records[0];
  for(const level of ['upper','lower']) {
    api.state.airspace=level;
    const zones=[level==='upper'?zone(api,129,90,25000,40000):zone(api,131,90)];
    const paths=[],ctx={scale(){},beginPath(){},moveTo(x,y){this.previous=[x,y];},lineTo(x,y){paths.push([this.previous,[x,y]]);this.previous=[x,y];},stroke(){}};
    api.drawTrajectoryCanvas({getContext:()=>ctx},{x:0,y:0},0,256,256,true,zones);
    for(let i=1;i<geometries[0].length;i++) assert.ok(paths.some(path=>JSON.stringify(path)===JSON.stringify([geometries[0][i-1],geometries[0][i]])),`${level}: segment ${i} is visible`);
    assert.equal(api.routeLabelPoints(zones).length,0,'points remain hidden without box selection');
    const group=api.routeAnalysis(zones).groups.find(g=>g.conflict.record===record);
    api.selectHighlightedRoute('fra',record.g,zones,api.routeGroupKey(group));
    const labels=api.routeLabelPoints(zones);
    for(const point of geometries[0]) assert.ok(labels.some(label=>JSON.stringify(label.point)===JSON.stringify(point)),'every full-route point is labelled in selection');
    api.state.highlightedRoute=null;
  }
  api.state.airspace='upper';
  assert.equal(api.fraRecordConflictsForZone(record,zone(api,131,90,25000,40000)),false,'visible lower context is not an upper conflict');
  api.state.airspace='lower';
  assert.equal(api.fraRecordConflictsForZone(record,zone(api,129,90)),false,'visible DCT context is not a lower conflict');
});

test('real BREMO to FJR itinerary includes all vertices before OMARD in upper map rendering',()=>{
  const api=app(undefined,true);
  const record=api.FRA_METADATA.records.find(r=>r.e==='OMARD'&&r.x==='FJR'&&api.FRA_METADATA.itineraries[r.r].startsWith('BREMO DCT BTA'));
  assert.ok(record);
  api.state.routeAirport='LFKS';
  const points=api.TRAJECTORY_DATA.g[record.g];
  assert.equal(points.length,10,'source trace already includes intermediate airway fixes');
  assert.equal(api.fraRoutesForPeriod().segments.get(record.g).size,points.length-1);
  const p=api.unprojectMercator({x:points[0][0],y:points[0][1]},0);
  assert.ok(Math.abs(p.lng-9.5769444444)<.001,'first point is BREMO, within source coordinate precision, not OMARD');
  assert.ok(api.fraSegmentProfile(record).includes('lower'),'FL190 airway portions keep their calculation profile');
});

test('upper view displays lower FRA portions even when the route starts at its FRA entry',()=>{
  const api=app(),record=api.FRA_METADATA.records[0];
  assert.equal(record.e,'AAA');
  assert.deepEqual([...api.fraRoutesForPeriod().segments.get(record.g)],[0,1,2]);
  const zones=[zone(api,129,90,25000,40000)];
  const group=api.routeAnalysis(zones).groups.find(g=>g.conflict.record===record);
  api.selectHighlightedRoute('fra',record.g,zones,api.routeGroupKey(group));
  const paths=[],ctx={scale(){},beginPath(){},moveTo(x,y){this.previous=[x,y];},lineTo(x,y){paths.push([this.previous,[x,y]]);this.previous=[x,y];},stroke(){}};
  api.drawTrajectoryCanvas({getContext:()=>ctx},{x:0,y:0},0,256,256,true,zones);
  assert.ok(paths.some(path=>JSON.stringify(path)===JSON.stringify([[130,90],[132,90]])),'FL190 segment is drawn in upper view');
  assert.equal(api.fraRecordConflictsForZone(record,zone(api,131,90,25000,40000)),false,'display context does not change altitude checks');
  for(const point of geometries[0]) assert.ok(api.routeLabelPoints(zones).some(label=>JSON.stringify(label.point)===JSON.stringify(point)));
});

test('entirely lower FRA routes also remain available as upper display context',()=>{
  const api=app(meta=>{meta.itineraries=meta.itineraries.map(()=> 'AAA V21 MID V21 END V21 LAST');});
  assert.equal(api.fraRoutesForPeriod().records.length,3);
  assert.equal(api.fraRoutesForPeriod().segments.get(0).size,3);
  assert.equal(api.routeAnalysis([zone(api,131,90,25000,40000)]).conflicts.length,0);
  api.state.airspace='lower';
  assert.equal(api.routeAnalysis([zone(api,131,90)]).conflicts.length,2);
});

test('lower-only display context does not become a verified upper alternative',()=>{
  const api=app(meta=>{
    meta.itineraries.push('AAA V21 MID V21 END V21 LAST');
    meta.records[2].r=2;
  });
  assert.equal(api.fraRoutesForPeriod().records.length,3,'lower-only route remains displayed');
  const result=api.routeAnalysis([zone(api,129,90,25000,40000)]);
  assert.ok(result.conflicts.length>0);
  assert.equal(result.alternatives.length,0,'routes outside the selected calculation slice are context only');
});

test('unmatched mixed profiles are marked uncertain and never offered as verified green alternatives',()=>{
  const api=app((meta,data)=>{data.g[1]=[[128,90],[134,90]];});
  const profile=api.fraSegmentProfile(api.FRA_METADATA.records[2]);
  assert.deepEqual([...profile],['unknown']);
  const entry={kind:'fra',id:1,label:'AAA',itinerary:'AAA V21 LAST',record:api.FRA_METADATA.records[2],verticalUnverified:true};
  assert.match(api.routeListItemHtml(entry,true),/altitude non vérifiée/);
  const result=api.routeAnalysis([zone(api,129,90,25000,40000)]);
  assert.ok(result.alternatives.every(entry=>!entry.verticalUnverified));
});

test('actual GALOF GAI G36 route has upper FRA followed by lower G36 segments',()=>{
  const api=app(undefined,true);
  const record=api.FRA_METADATA.records.find(r=>api.FRA_METADATA.itineraries[r.r]==='GALOF DCT CNA DCT SECHE DCT GAI G36 FINOT G36 MASAM G36 SALSI G36 ORBIL');
  assert.ok(record);
  assert.deepEqual([...api.fraSegmentProfile(record)],['upper','upper','upper','lower','lower','lower','lower']);
  const points=api.TRAJECTORY_DATA.g[record.g],x=(points[4][0]+points[5][0])/2,y=(points[4][1]+points[5][1])/2;
  api.state.airspace='upper';
  assert.equal(api.fraRecordConflictsForZone(record,zone(api,x,y,25000,40000)),false);
  api.state.airspace='lower';
  assert.equal(api.fraRecordConflictsForZone(record,zone(api,x,y)),true);
});
