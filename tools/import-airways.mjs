import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function parseCoordinate(value, axis) {
  const match = /^([NSEW])(\d{3})\.(\d{2})\.(\d{2})\.(\d{3})$/.exec(value);
  if (!match || !(axis === 'lat' ? 'NS' : 'EW').includes(match[1])) throw new Error(`Invalid ${axis}: ${value}`);
  const [, hemisphere, degrees, minutes, seconds, milliseconds] = match;
  const absolute = +degrees + +minutes / 60 + (+seconds + +milliseconds / 1000) / 3600;
  if (+minutes >= 60 || +seconds >= 60 || absolute > (axis === 'lat' ? 90 : 180)) throw new Error(`Invalid coordinate: ${value}`);
  return absolute * ('SW'.includes(hemisphere) ? -1 : 1);
}

export function parseNavigationPoints(text, type) {
  if (!['fix', 'ndb', 'vor'].includes(type)) throw new Error(`Unsupported point type: ${type}`);
  const offset = type === 'fix' ? 1 : 2;
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const fields = line.trim().split(';').map(field => field.trim());
    if (!/^[A-Z0-9]{1,12}$/.test(fields[0])) throw new Error(`Invalid point name at ${type} line ${index + 1}`);
    return [fields[0], parseCoordinate(fields[offset + 1], 'lng'), parseCoordinate(fields[offset], 'lat'), type];
  });
}

export function parseAirways(text, navigationPoints = []) {
  const lookup = new Map();
  navigationPoints.forEach(([name, lng, lat]) => {
    if (!lookup.has(name)) lookup.set(name, []);
    if (!lookup.get(name).some(point => point[0] === lng && point[1] === lat)) lookup.get(name).push([lng, lat]);
  });
  const routes = [];
  let current = null;
  let breaks = 0;
  let points = 0;
  let singletons = 0;
  const flush = () => {
    if (current?.points.length >= 2) routes.push(current);
    else if (current) singletons += 1;
    current = null;
  };
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const [kind, name, latitude, longitude] = line.trim().split(';');
    if (kind !== 'T' || !name) throw new Error(`Unsupported line ${index + 1}`);
    if (name === 'BREAK') { flush(); breaks += 1; return; }
    let point, pointName = null;
    if (/^[NS]\d{3}\./.test(latitude)) {
      point = [parseCoordinate(longitude, 'lng'), parseCoordinate(latitude, 'lat')];
    } else {
      if (latitude !== longitude) throw new Error(`Mismatched point references at line ${index + 1}`);
      const matches = lookup.get(latitude) || [];
      if (matches.length !== 1) throw new Error(`${matches.length ? 'Ambiguous' : 'Unknown'} point ${latitude} at line ${index + 1}`);
      point = matches[0];
      pointName = latitude;
    }
    if (current?.name !== name) { flush(); current = { name, points: [], pointNames: [] }; }
    points += 1;
    const previous = current.points.at(-1);
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) {
      current.points.push(point);
      current.pointNames.push(pointName);
    } else if (pointName && !current.pointNames.at(-1)) current.pointNames[current.pointNames.length - 1] = pointName;
  });
  flush();
  return { routes, breaks, points, singletons };
}

// Produces an apply_patch document; source navdata is only read, never executed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [lowPath, highPath, htmlPath, fixPath, ndbPath, vorPath] = process.argv.slice(2).filter(arg => arg !== '--write');
  if (!lowPath || !highPath || !htmlPath) throw new Error('Usage: node tools/import-airways.mjs fr.lawy fr.hawy index.html');
  const data = {};
  data.points = [];
  data.pointSources = [];
  for (const [type, sourcePath] of [['fix', fixPath], ['ndb', ndbPath], ['vor', vorPath]]) {
    if (!sourcePath) continue;
    const text = fs.readFileSync(sourcePath, 'utf8');
    data.points.push(...parseNavigationPoints(text, type));
    data.pointSources.push({ source: `fr.${type}`, sha256: createHash('sha256').update(text).digest('hex') });
  }
  for (const [level, sourcePath] of [['lower', lowPath], ['upper', highPath]]) {
    const text = fs.readFileSync(sourcePath, 'utf8');
    data[level] = { ...parseAirways(text, data.points), source: `fr.${level === 'lower' ? 'lawy' : 'hawy'}`, sha256: createHash('sha256').update(text).digest('hex') };
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const oldLine = html.split(/\r?\n/).find(line => line.includes('const AIRWAY_DATA = /* AIRWAY_DATA */'));
  if (!oldLine) throw new Error('AIRWAY_DATA marker missing');
  const replacement = `      const AIRWAY_DATA = /* AIRWAY_DATA */ ${JSON.stringify(data)};`;
  if (process.argv.includes('--write')) {
    // Mechanical regeneration of this embedded dataset only.
    fs.writeFileSync(htmlPath, html.replace(oldLine, replacement), 'utf8');
    console.log(JSON.stringify({ navigationPoints: data.points.length, lowerRoutes: data.lower.routes.length, upperRoutes: data.upper.routes.length }));
  } else process.stdout.write(`*** Begin Patch\n*** Update File: ${htmlPath}\n@@\n-${oldLine}\n+${replacement}\n*** End Patch`);
}
