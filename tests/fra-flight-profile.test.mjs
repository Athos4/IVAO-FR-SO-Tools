import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const lng=nm=>nm*1852/6371008.8*180/Math.PI;
const project=nm=>[(lng(nm)+180)/360*256,128];
const climb=1852*.09/.3048,descent=1852*.05/.3048;
function app({positions=[10,290],connectors,airports=[['LFPG','Departure',lng(0),0],['LFBO','Arrival',lng(300),0]],conditions='DEP LFPG with ARR LFBO',customize=()=>{}}={}) {
  const names=positions.map((_,i)=>`P${i}`);
  const meta={records:[{g:0,e:names[0],x:names.at(-1),m:1,t:0,r:0,c:0}],itineraries:[names.map((name,i)=>i?`${connectors?.[i-1]||'DCT'} ${name}`:name).join(' ')],times:['H24'],conditions:[{airports:conditions}],airports,points:names.map((name,i)=>[name,lng(positions[i]),0])};
  const data={g:[positions.map(project)],z:{}};customize(meta,data);
  const code=source.split('\n').map(line=>{
    if(line.includes('const FRA_METADATA ='))return `const FRA_METADATA=${JSON.stringify(meta)};`;
    if(line.includes('const TRAJECTORY_DATA ='))return `const TRAJECTORY_DATA=${JSON.stringify(data)};`;
    if(line.includes('const AIRWAY_DATA ='))return 'const AIRWAY_DATA={lower:{routes:[]},upper:{routes:[]},points:[]};';
    if(line.includes('const ATC_DATA ='))return 'const ATC_DATA={controllers:[]};';
    return line;
  }).join('\n');
  const ctx=vm.createContext({atob,document:{getElementById:()=>null},window:{}});
  vm.runInContext(code.slice(0,code.lastIndexOf('\n      bindEvents();'))+'\nglobalThis.api={state,FRA_METADATA,TRAJECTORY_DATA,FLIGHT_PROFILE,flightDistance,fraAltitudeProfile,fraAltitudeRanges,fraRecordConflictsForZone,fraRoutesForPeriod,routeAnalysis,reverseSearchResults,impactedAirports,airportConnections};})();',ctx);
  return ctx.api;
}
function at(api,nm,index=0,ignore=false){
  const points=api.TRAJECTORY_DATA.g[0],x=project(nm)[0],t=(x-points[index][0])/(points[index+1][0]-points[index][0]);
  return api.fraAltitudeRanges(api.fraAltitudeProfile(api.FRA_METADATA.records[0],ignore),index,t,t);
}
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<.02,`${actual} vs ${expected} ft`);
function zone(nm,min,max,id=nm,width=.001){return{id,name:`ZONE ${id}`,minimumAlt:min,maximumAlt:max,regionMap:[{lng:lng(nm-width),lat:-.001},{lng:lng(nm+width),lat:-.001},{lng:lng(nm+width),lat:.001},{lng:lng(nm-width),lat:.001}]};}
const conflict=(api,z,ignore=false)=>api.fraRecordConflictsForZone(api.FRA_METADATA.records[0],z,ignore);

test('airport reference is 0 ft; 9% climb, FL350 cruise and 5% descent use along-route metres converted to feet',()=>{
  const api=app();
  near(at(api,10)[0].minimum,10*climb);
  near(at(api,50)[0].minimum,50*climb);
  near(at(api,100)[0].minimum,35000);
  near(at(api,250)[0].minimum,50*descent);
  near(at(api,290)[0].minimum,10*descent);
  assert.equal(api.FLIGHT_PROFILE.airport,0);
  api.state.airspace='lower';near(at(api,100)[0].maximum,35000,'changing view cannot teleport a flight to another altitude');
});

test('lower segments cruise at FL190 and slopes begin/end at airports including connection distances',()=>{
  const api=app({connectors:['V21']});api.state.airspace='lower';
  near(at(api,10)[0].minimum,10*climb);
  near(at(api,100)[0].minimum,19000);
  near(at(api,290)[0].minimum,10*descent);
  assert.equal(conflict(api,zone(100,18999,19001)),true);
  assert.equal(conflict(api,zone(100,19001,19500)),false);
});

test('mixed upper/lower segments obey continuous descent and climb envelopes at FL190 transitions',()=>{
  const api=app({positions:[10,120,150,290],connectors:['DCT','V21','UT300']});
  near(at(api,120,0)[0].minimum,19000);
  near(at(api,120,1)[0].minimum,19000);
  near(at(api,100,0)[0].minimum,19000+20*descent);
  near(at(api,150,1)[0].minimum,19000);
  near(at(api,150,2)[0].minimum,19000);
  near(at(api,160,2)[0].minimum,19000+10*climb);
  near(at(api,180,2)[0].minimum,35000);
});

test('short flights form a triangular profile; the interior peak is not lost when endpoint heights are zero',()=>{
  const api=app({positions:[0,40],airports:[['LFPG','Departure',lng(0),0],['LFBO','Arrival',lng(40),0]]});
  const profile=api.fraAltitudeProfile(api.FRA_METADATA.records[0]),range=api.fraAltitudeRanges(profile,0)[0];
  const peakDistance=40*.05/(.09+.05),peak=peakDistance*climb;
  near(range.minimum,0);near(range.maximum,peak);
  near(at(api,peakDistance)[0].maximum,peak);
  api.state.airspace='lower';assert.equal(conflict(api,zone(peakDistance,peak-.1,peak+.1)),true);
  api.state.airspace='upper';assert.equal(conflict(api,zone(peakDistance,20000,40000)),false);
  assert.equal(api.routeAnalysis([zone(peakDistance,20000,40000)]).conflicts.length,0);
});

test('conflict altitude is checked at the zone intersection, not against a whole segment height range',()=>{
  const api=app();
  assert.equal(conflict(api,zone(12,30000,40000)),false,'the segment reaches FL350 elsewhere, but not inside this zone');
  assert.equal(conflict(api,zone(100,35001,40000)),false);
  assert.equal(conflict(api,zone(100,34000,36000)),true);
  api.state.airspace='lower';
  assert.equal(conflict(api,zone(12,12*climb-1,12*climb+1)),true);
  assert.equal(conflict(api,zone(12,12000,15000)),false);
  assert.equal(conflict(api,zone(290,10*descent-1,10*descent+1)),true,'descent conflicts below the standalone AWY FL65 floor are valid FRA conflicts');
});

test('point-airport links contribute distance but never create conflicts',()=>{
  const api=app();api.state.airspace='lower';
  assert.equal(api.airportConnections(api.FRA_METADATA.records[0]).connections.length,2);
  assert.equal(conflict(api,zone(5,0,19500)),false);
  assert.equal(conflict(api,zone(295,0,19500)),false);
  near(at(api,10)[0].minimum,10*climb);
  api.state.showAirportConnections=false;
  near(at(api,10)[0].minimum,10*climb);
});

test('all-traffic overflights retain cruise levels without invented airport anchors',()=>{
  const upper=app({conditions:'',airports:[]});
  near(at(upper,10)[0].minimum,35000);near(at(upper,290)[0].minimum,35000);
  assert.equal(upper.fraAltitudeProfile(upper.FRA_METADATA.records[0]).uncertain,false);
  const lower=app({conditions:'',airports:[],connectors:['G39']});
  near(at(lower,10)[0].minimum,19000);
});

test('overflight-or-DEP conditions retain the cruise scenario unless that departure is explicitly selected',()=>{
  const api=app({conditions:'[overflights or DEP LFPG] with ARR LFBO'}),a=zone(12,34000,36000);
  assert.equal(conflict(api,a),true,'overflight is already at cruise altitude');
  api.state.routeAirport='LFPG';assert.equal(conflict(api,a),false,'selected departure is still climbing');
  api.state.routeAirport='LFBO';assert.equal(conflict(api,a),true,'arrival can originate from an overflight');
});

test('multi-airport profiles remain discrete and filtered ICAO choices invalidate profile and reverse results',()=>{
  const api=app({conditions:'DEP LFPG, LFPO with ARR LFBO',airports:[['LFPG','Far departure',lng(0),0],['LFPO','Near departure',lng(9.5),0],['LFBO','Arrival',lng(300),0]]});
  api.state.airspace='lower';
  const far=zone(10.01,10.01*climb-1,10.01*climb+1),between=zone(10.01,1000,2000);
  assert.equal(conflict(api,far),true);
  assert.equal(conflict(api,between),false,'do not merge distinct possible heights into a fictitious continuous band');
  api.state.routeAirport='LFPO';assert.equal(conflict(api,far),false);
  assert.equal(conflict(api,far,true),true,'all-airport impact queries ignore the active filter');
  assert.deepEqual([...api.impactedAirports([far])].map(a=>a.code),['LFBO','LFPG'],'only the airport scenarios that actually conflict are reported');
  api.state.reverseSearch=true;api.state.filtered=[far];
  assert.equal(api.reverseSearchResults().zones.length,0);
  api.state.routeAirport='LFPG';assert.equal(api.reverseSearchResults().zones.length,1);
  api.state.routeAirport='LFPG, LFPO';assert.equal(api.reverseSearchResults().zones.length,1);
});

test('missing airport positions remain uncertain, never default to an invented coordinate or a verified alternative',()=>{
  const api=app({airports:[],customize(meta,data){data.g.push([project(10),[project(150)[0],129],project(290)]);meta.itineraries.push('P0 DCT MID DCT P1');meta.records.push({...meta.records[0],g:1,r:1});}});
  const profile=api.fraAltitudeProfile(api.FRA_METADATA.records[0]);
  assert.equal(profile.uncertain,true);
  const range=at(api,100)[0];near(range.minimum,0);near(range.maximum,35000);
  const analysis=api.routeAnalysis([zone(100,25000,30000)]);
  assert.equal(analysis.conflicts.length,1);
  assert.equal(analysis.conflicts[0].verticalUnverified,true);
  assert.equal(analysis.alternatives.length,0);
  assert.equal(conflict(api,zone(100,35001,40000)),false,'known cruise ceiling still bounds an uncertain profile');
});

test('unresolved airport groups do not become verified overflight profiles',()=>{
  const api=app({conditions:'DEP PARIS_GROUP with ARR LFBO'});
  assert.equal(api.fraAltitudeProfile(api.FRA_METADATA.records[0]).uncertain,true);
  assert.equal(at(api,12)[0].minimum,0);
});

test('bent itineraries use flown distance along each leg instead of direct airport-to-zone distance',()=>{
  const api=app({positions:[10,150,290],conditions:'DEP LFPG',customize(meta,data){data.g[0][1][1]-=1;}});
  const profile=api.fraAltitudeProfile(api.FRA_METADATA.records[0]);
  assert.ok(profile.lengths[0]>140*1852);
  const range=api.fraAltitudeRanges(profile,0,.1,.1)[0];
  near(range.minimum,Math.min(35000,10*climb+profile.lengths[0]*.1*.09/.3048));
});
