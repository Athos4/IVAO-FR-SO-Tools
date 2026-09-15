import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function fraPeriodMask(properties) {
  const availability = String(properties.time_availability || '');
  const explicitNight = /\bNIGHT\b/i.test(availability + ' ' + properties.traj_type) || /Survols_N_/i.test(properties.calque_carto || '');
  const clocks = [...availability.matchAll(/(\d{2}):(\d{2})/g)].map(match => Number(match[1]) * 60 + Number(match[2]));
  // Include overnight intervals, including intervals starting after midnight.
  const nightClock = clocks.some((clock, index) => index + 1 < clocks.length && (clock >= 18 * 60 || clock < 6 * 60) && clocks[index + 1] <= 9 * 60 && clock !== clocks[index + 1]);
  return (/\bH24\b/i.test(availability) ? 1 : 0) | (explicitNight || nightClock ? 2 : 0);
}

export function extractFraMetadata(text) {
  const line = text.split(/\r?\n/).find(line => /^route_all\s*=/.test(line));
  if (!line) throw new Error('route_all not found');
  const data = JSON.parse(line.slice(line.indexOf('=') + 1).trim().replace(/;$/, ''));
  const geometryIds = new Map();
  const times = [], timeIds = new Map(), records = [], itineraries = [], itineraryIds = new Map();
  const conditions = [], conditionIds = new Map();
  for (const feature of data.features) {
    const key = JSON.stringify(feature.geometry.coordinates);
    if (!geometryIds.has(key)) geometryIds.set(key, geometryIds.size);
    const p = feature.properties;
    const time = String(p.time_availability || '').trim();
    if (!timeIds.has(time)) { timeIds.set(time, times.length); times.push(time); }
    const itinerary = String(p.route_complete || p.fpl_route || p.route_interne_str || `${p.E} → ${p.X}`).trim();
    if (!itineraryIds.has(itinerary)) { itineraryIds.set(itinerary, itineraries.length); itineraries.push(itinerary); }
    const condition = {
      airports: String(p['ADEP or ADES'] || '').trim(),
      utilisation: String(p.utilisation || '').trim(),
      vertical: String(p.vertical_constraint || '').trim()
    };
    const conditionKey = JSON.stringify(condition);
    if (!conditionIds.has(conditionKey)) { conditionIds.set(conditionKey, conditions.length); conditions.push(condition); }
    if (!/^[A-Z0-9]{2,8}$/.test(p.E) || !/^[A-Z0-9]{2,8}$/.test(p.X)) throw new Error('Missing or ambiguous FRA endpoints');
    records.push({ g: geometryIds.get(key), e: p.E, x: p.X, m: fraPeriodMask(p), t: timeIds.get(time), r: itineraryIds.get(itinerary), c: conditionIds.get(conditionKey), military: /\b(?:flt|flight)[\s-]*type\s*\(?\s*(?:[A-Z]\s*,\s*)*M\b/i.test(condition.utilisation) });
  }
  const points = [], airports = [];
  for (const [dataset, nameKey] of [['point_all', 'PT'], ['airport', 'oaci']]) {
    const pointLine = text.split(/\r?\n/).find(line => line.startsWith(`${dataset} =`));
    if (!pointLine) continue;
    const collection = JSON.parse(pointLine.slice(pointLine.indexOf('=') + 1).trim().replace(/;$/, ''));
    for (const feature of collection.features) {
      const name = String(feature.properties[nameKey] || '').trim();
      const coords = feature.geometry?.coordinates;
      if (name && feature.geometry.type === 'Point' && coords?.length >= 2 && coords.every(Number.isFinite)) points.push([name, coords[0], coords[1]]);
      if (dataset === 'airport' && name) airports.push([name, String(feature.properties.nom || ''), ...(feature.geometry.type === 'Point' && coords?.length >= 2 && coords.every(Number.isFinite) ? coords.slice(0, 2) : [])]);
    }
  }
  return { records, times, itineraries, conditions, points, airports, geometryCount: geometryIds.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sourcePath, htmlPath] = process.argv.slice(2);
  const meta = extractFraMetadata(fs.readFileSync(sourcePath, 'utf8'));
  const html = fs.readFileSync(htmlPath, 'utf8');
  const oldLine = html.split(/\r?\n/).find(line => line.includes('const FRA_METADATA = /* FRA_METADATA */'));
  if (!oldLine) throw new Error('FRA_METADATA marker missing');
  const geometryLine = html.split(/\r?\n/).find(line => line.includes('const TRAJECTORY_DATA ='));
  const geometryData = JSON.parse(geometryLine.slice(geometryLine.indexOf('*/') + 2).trim().replace(/;$/, ''));
  if (meta.geometryCount !== geometryData.g.length) throw new Error('FRA geometry IDs do not match embedded data');
  const replacement = `      const FRA_METADATA = /* FRA_METADATA */ ${JSON.stringify(meta)};`;
  if (process.argv.includes('--write')) {
    // Mechanical regeneration of the embedded dataset only; no application code edits.
    fs.writeFileSync(htmlPath, html.replace(oldLine, replacement), 'utf8');
    console.log(`Embedded ${meta.records.length} FRA records and ${meta.itineraries.length} full itineraries`);
  } else {
    process.stdout.write(`*** Begin Patch\n*** Update File: ${htmlPath}\n@@\n-${oldLine}\n+${replacement}\n*** End Patch`);
  }
}
