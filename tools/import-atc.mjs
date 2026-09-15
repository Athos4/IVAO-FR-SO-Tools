import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// X-Plane ATCFILE 1000: geographic POINT values are latitude then longitude;
// polygon limits are feet AMSL. Source data is parsed, never executed.
export function parseAtc(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!['A', 'I'].includes(lines[0]) || lines[1] !== '1000' || lines[2] !== 'ATCFILE') throw new Error('Unsupported ATC header');
  const controllers = [];
  let current = null, volume = null, polygonCount = 0, pointCount = 0;
  for (const [index, line] of lines.slice(3).entries()) {
    const [command, ...fields] = line.split(/\s+/);
    const fail = message => { throw new Error(`${message} at ATC line ${index + 4}`); };
    if (command === '99') { if (current) fail('Unclosed controller'); break; }
    if (command === 'CONTROLLER') {
      if (current) fail('Nested controller');
      current = { name: '', facility: '', icao: '', role: '', volumes: [] };
    } else if (command === 'CONTROLLER_END') {
      if (!current || volume || !current.facility || !current.role) fail('Incomplete controller');
      controllers.push(current); current = null;
    } else if (!current) fail('Data outside controller');
    else if (['NAME', 'FACILITY_ID', 'ICAO', 'ROLE'].includes(command)) {
      const key = { NAME: 'name', FACILITY_ID: 'facility', ICAO: 'icao', ROLE: 'role' }[command];
      current[key] = fields.join(' ');
    } else if (command === 'AIRSPACE_POLYGON_BEGIN') {
      if (volume || fields.length !== 2) fail('Invalid polygon start');
      const [minimumAlt, maximumAlt] = fields.map(Number);
      if (!Number.isFinite(minimumAlt) || !Number.isFinite(maximumAlt) || maximumAlt <= minimumAlt) fail('Invalid vertical limits');
      volume = { minimumAlt, maximumAlt, points: [] };
    } else if (command === 'POINT') {
      const [lat, lng] = fields.map(Number);
      if (!volume || fields.length !== 2 || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail('Invalid point');
      volume.points.push([lng, lat]); pointCount++;
    } else if (command === 'AIRSPACE_POLYGON_END') {
      if (!volume || new Set(volume.points.map(point => point.join(','))).size < 3) fail('Invalid polygon');
      current.volumes.push(volume); volume = null; polygonCount++;
    } else if (!['FREQ', 'CHAN', 'CLASS', 'ALT_REPORT', 'TRANSITION_ALT', 'VOICE_DEF', 'SQUAWK', 'PRESSURE_UNITS', 'FREQUENCY_STYLE', 'TRANSITION_LAYER_MIN'].includes(command)) fail(`Unsupported directive ${command}`);
  }
  if (current || volume) throw new Error('Truncated ATC data');
  return { controllers, polygonCount, pointCount };
}

export function filterAtcForFrance(data) {
  const firIds = new Set(['LFFF', 'LFEE', 'LFBB', 'LFRR', 'LFMM']);
  const controllers = data.controllers.filter(controller => /^(LF|NT|TF|FM)/.test(controller.facility) && !firIds.has(controller.facility));
  return { controllers, polygonCount: controllers.reduce((sum, controller) => sum + controller.volumes.length, 0),
    pointCount: controllers.reduce((sum, controller) => sum + controller.volumes.reduce((count, volume) => count + volume.points.length, 0), 0) };
}

export function encodeAtcPoints(points) {
  const bytes = [];
  let previous = [0, 0];
  for (const point of points) point.forEach((coordinate, axis) => {
    const value = Math.round(coordinate * 1e6);
    const delta = value - previous[axis];
    previous[axis] = value;
    let encoded = delta < 0 ? -delta * 2 - 1 : delta * 2;
    while (encoded >= 128) { bytes.push((encoded % 128) | 128); encoded = Math.floor(encoded / 128); }
    bytes.push(encoded);
  });
  return Buffer.from(bytes).toString('base64');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sourcePath, htmlPath] = process.argv.slice(2);
  if (!sourcePath || !htmlPath) throw new Error('Usage: node tools/import-atc.mjs atc.dat index.html [--write]');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const data = { ...filterAtcForFrance(parseAtc(source)), source: 'atc.dat', sha256: createHash('sha256').update(source).digest('hex') };
  // Lossless at the source's six-decimal precision; no polygon simplification.
  data.encoding = 'delta-varint-1e6';
  data.controllers.forEach(controller => controller.volumes.forEach(volume => { volume.points = encodeAtcPoints(volume.points); }));
  const html = fs.readFileSync(htmlPath, 'utf8');
  const oldLine = html.split(/\r?\n/).find(line => line.includes('const ATC_DATA = /* ATC_DATA */'));
  if (!oldLine) throw new Error('ATC_DATA marker missing');
  // Optional temporary placeholder lets editors handle the large autonomous file;
  // run again without --placeholder to restore the complete generated dataset.
  const replacement = `      const ATC_DATA = /* ATC_DATA */ ${JSON.stringify(process.argv.includes('--placeholder') ? { controllers: [] } : data)};`;
  if (process.argv.includes('--write')) {
    // Mechanical regeneration of the embedded dataset only.
    fs.writeFileSync(htmlPath, html.replace(oldLine, replacement), 'utf8');
    console.log(JSON.stringify({ controllers: data.controllers.length, polygons: data.polygonCount, points: data.pointCount }));
  } else process.stdout.write(`*** Begin Patch\n*** Update File: ${htmlPath}\n@@\n-${oldLine}\n+${replacement}\n*** End Patch`);
}
