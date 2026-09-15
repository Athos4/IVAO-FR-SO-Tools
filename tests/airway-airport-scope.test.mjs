import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const square=(x,y,r=.05)=>[[x-r,y-r],[x+r,y-r],[x+r,y+r],[x-r,y+r]];
function app(customize=()=>{}) {
  const data={controllers:[
    {icao:'LFBO',facility:'LFBO',role:'tracon',volumes:[{minimumAlt:0,maximumAlt:3000,points:square(0,45)}]},
    {icao:'LFPG',facility:'LFPG',role:'tracon',volumes:[{minimumAlt:0,maximumAlt:19500,points:square(5,45)}]},
    {icao:'',facility:'LFZZ',role:'ctr',volumes:[{minimumAlt:0,maximumAlt:19500,points:square(3,45)}]}
  ],routes:[{name:'V21',points:[[-2,45],[7,45]]}]};
  customize(data);
  const code=source.split('\n').map(line=>{
    if(line.includes('const ATC_DATA ='))return `const ATC_DATA=${JSON.stringify({controllers:data.controllers})};`;
    if(line.includes('const AIRWAY_DATA ='))return `const AIRWAY_DATA=${JSON.stringify({lower:{routes:data.routes},upper:{routes:data.routes},points:[]})};`;
    if(line.includes('const FRA_METADATA ='))return 'const FRA_METADATA={records:[],points:[],airports:[]};';
    if(line.includes('const TRAJECTORY_DATA ='))return 'const TRAJECTORY_DATA={g:[],z:{}};';
    return line;
  }).join('\n');
  const ctx=vm.createContext({atob,document:{getElementById:()=>null},window:{}});
  vm.runInContext(code.slice(0,code.lastIndexOf('\n      bindEvents();'))+'\nglobalThis.api={state,airwayConflictsForZones,projectMercator,segmentPartsInRing,pointToArcDistance,sphereVector,lowerAirwayScope,segmentInAirportScope};})();',ctx);
  ctx.api.state.airspace='lower';ctx.api.state.routeAirport='LFBO';
  return ctx.api;
}
const zone=(x,y=45,bottom=7000,top=9000)=>({id:x,name:`ZONE ${x}`,minimumAlt:bottom,maximumAlt:top,regionMap:square(x,y,.005).map(([lng,lat])=>({lng,lat}))});
const count=(api,z)=>api.airwayConflictsForZones([z]).ids.size;

test('lower AWY conflict must be inside the chosen ICAO footprint or its 50 NM extension',()=>{
  const api=app();
  assert.equal(count(api,zone(0)),1,'inside original footprint, even if ATC ceiling is below AWY floor');
  assert.equal(count(api,zone(.9)),1,'inside 50 NM of the boundary');
  assert.equal(count(api,zone(1.5)),0,'outside the buffer');
  assert.equal(count(api,zone(5)),0,'another airport is not in scope');
  assert.equal(count(api,zone(3)),0,'facility without ICAO is not in scope');
  assert.equal(count(api,zone(0,45,0,6500)),0,'AWY floor is unchanged');
  assert.equal(count(api,zone(0,45,19000,21000)),1);
  assert.equal(count(api,zone(0,45,19500,21000)),0);
});

test('scope caches follow ICAO changes, unions and filter clearing; upper AWY are unchanged',()=>{
  const api=app(),a=zone(0),b=zone(5);
  assert.equal(count(api,a),1);assert.equal(count(api,b),0);
  api.state.routeAirport='LFPG';
  assert.equal(count(api,a),0);assert.equal(count(api,b),1);
  api.state.routeAirport='LFBO, LFPG';
  assert.equal(count(api,a),1);assert.equal(count(api,b),1);
  api.state.routeAirport='LFZZ';
  assert.equal(count(api,zone(3)),0,'no fallback to a facility identifier without ICAO');
  api.state.routeAirport='LFLN';
  assert.equal(count(api,a),0,'missing ATC data does not silently enable nationwide conflicts');
  api.state.routeAirport='';
  assert.equal(count(api,zone(3)),1,'unfiltered general checking remains available');
  api.state.routeAirport='LFBO';api.state.airspace='upper';
  assert.equal(count(api,zone(5,45,25000,30000)),1);
});

test('the zone intersection itself must be in scope, not a distant part of the same airway segment',()=>{
  const api=app();
  assert.equal(count(api,zone(4)),0,'long segment crosses both ATC footprint and distant zone: not a local conflict');
  const large=zone(4);large.regionMap=[{lng:4,lat:44.99},{lng:4.1,lat:44.99},{lng:4.1,lat:44},{lng:0,lat:44},{lng:0,lat:44.1},{lng:4,lat:44.1}];
  assert.equal(count(api,large),0,'a zone approaching ATC away from the airway cannot create a shared intersection');
});

test('50 NM uses distance from polygon edges, with latitude scaling and longitude wrapping',()=>{
  for(const [lng,lat] of [[0,45],[0,70],[179.95,-17]]) {
    const api=app(data=>{data.controllers=[{icao:'LFBO',role:'tracon',volumes:[{minimumAlt:0,maximumAlt:19500,points:square(lng,lat)}]}];});
    const scope=api.lowerAirwayScope();
    const p=(x,y)=>{const v=api.projectMercator({lng:x,lat:y},0);return[v.x,v.y];};
    const degreesPerNM=1852/6371008.8*180/Math.PI;
    for(const [nm,expected] of [[49,true],[51,false]]) {
      const point=p(lng,lat+.05+nm*degreesPerNM);
      assert.equal(api.segmentInAirportScope(point,point,scope),expected,`${lat}°: ${nm} NM north of boundary`);
    }
    assert.equal(api.segmentInAirportScope(p(lng,lat),p(lng+.1,lat),scope),true);
  }
});

test('clip preserves contained segments, crossings, concavity and tangencies',()=>{
  const api=app(),ring=[[0,0],[3,0],[3,1],[1,1],[1,3],[0,3]];
  const parts=api.segmentPartsInRing([-1,2],[4,2],ring);
  assert.ok(parts.some(([a,b])=>a[0]===0&&b[0]===1));
  assert.ok(parts.every(([a,b])=>a[0]>=0&&b[0]<=1));
  assert.ok(api.segmentPartsInRing([-1,-1],[0,0],ring).length,'corner contact retained');
  assert.ok(api.segmentPartsInRing([-.5,0],[.5,0],ring).length,'collinear contact retained');
  assert.equal(api.segmentPartsInRing([2,2],[3,3],ring).length,0);
});
