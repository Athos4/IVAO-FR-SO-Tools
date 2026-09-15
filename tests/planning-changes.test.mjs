import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function fixture() {
  const listeners = {}, timers = new Map(), opened = [], drawers = [], cache = new Map();
  let timer = 0;
  const element = { addEventListener: (name, fn) => { listeners[name] = fn; }, classList: { add() {}, remove() {} } };
  const context = vm.createContext({
    document: { getElementById: () => element },
    window: { open: (...args) => opened.push(args) },
    localStorage: { getItem: key => cache.get(key) || null, setItem: (key, value) => cache.set(key, value) },
    setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: id => timers.delete(id),
    drawers
  });
  vm.runInContext(source.slice(0, source.lastIndexOf('\n      bindEvents();')) + `
    openDrawer = id => drawers.push(id);
    renderAll = () => {}; finishLoading = () => {}; setSourceState = () => {};
    globalThis.api = { state, normalizeZone, buildPlannerEvents, plannerEventHtml, bindPlannerInteractions, loadZones, writeCache, readCache,
      setFetch: fn => { fetchWithTimeout = fn; } };
  })();`, context);
  return { ...context.api, listeners, timers, opened, drawers, cache };
}
const slot = (startTime = '08:00', endTime = '10:00', days = { dayMon: true }) => ({ startTime, endTime, ...days });
const zone = (api, times) => api.normalizeZone({ id: 10784, name: 'LF R TEST', type: 'R', times });
const events = (api, times) => api.buildPlannerEvents(zone(api, times)).events;

test('first load is neutral; day changes keep unchanged occurrences and show removed/new slots', () => {
  const api = fixture();
  assert.equal(events(api, [slot()])[0].change, '');
  api.state.previousZones.set(10784, zone(api, [slot('08:00', '10:00', { dayMon: true, dayTue: true })]));
  const result = events(api, [slot('08:00', '10:00', { dayMon: true, dayWed: true })]);
  assert.deepEqual(Array.from(result, e => e.change), ['', 'removed', 'added']);
});

test('overlapping replacement and deleted block occupy separate lanes', () => {
  const api = fixture();
  api.state.previousZones.set(10784, zone(api, [slot()]));
  const result = events(api, [slot('09:00', '11:00')]);
  assert.equal(result.length, 2);
  assert.notEqual(result[0].lane, result[1].lane);
  assert.deepEqual(Array.from(result, e => e.change), ['removed', 'added']);
  assert.equal(events(api, [])[0].change, 'removed');
});

test('API ids, order and weekly slot grouping do not create false changes', () => {
  const api = fixture();
  api.state.previousZones.set(10784, zone(api, [{ ...slot('08:00', '10:00', { dayMon: true, dayTue: true }), id: 1 }]));
  assert.ok(events(api, [slot('08:00:00', '10:00:00', { dayTue: true }), { ...slot(), id: 2 }]).every(e => e.change === ''));
});

test('Sunday overnight deletion is visible on both ends of the week', () => {
  const api = fixture();
  api.state.previousZones.set(10784, zone(api, [slot('22:00', '02:00', { daySun: true })]));
  assert.deepEqual(Array.from(events(api, []), e => [e.start, e.end, e.change]), [[0, 120, 'removed'], [9960, 10080, 'removed']]);
});

test('deleted blocks are never active; new blocks retain their change class while active', () => {
  const api = fixture(), z = zone(api, [slot()]);
  const now = new Date(api.state.weekStart.getTime() + 540 * 60000);
  const event = { start: 480, end: 600, lane: 0, change: 'removed' };
  assert.match(api.plannerEventHtml(event, z, now), /removed-event/);
  assert.doesNotMatch(api.plannerEventHtml(event, z, now), /active-event/);
  assert.match(api.plannerEventHtml({ ...event, change: 'added' }, z, now), /active-event added-event/);
});

test('double click opens the supplied editor URL and cancels the detail drawer', () => {
  const api = fixture(); api.bindPlannerInteractions();
  const event = { target: { closest: () => ({ dataset: { zoneId: '10784' } }) }, detail: 1, preventDefault() {} };
  api.listeners.click(event);
  api.listeners.click({ ...event, detail: 2 });
  api.listeners.dblclick(event);
  assert.equal(api.timers.size, 0);
  assert.equal(api.drawers.length, 0);
  assert.equal(api.opened[0][0], 'https://data-new.ivao.aero/centers/regions/Europe/LFZZ/special-areas/10784/edit');
  assert.equal(api.opened[0][2], 'noopener,noreferrer');
  api.listeners.click(event);
  [...api.timers.values()][0]();
  assert.deepEqual(api.drawers, ['10784']);
  api.listeners.click({ ...event, detail: 0 });
  assert.equal(api.drawers.length, 2);
});

test('refresh compares against the preceding successful load and clears markers on unchanged reload', async () => {
  const api = fixture();
  const old = zone(api, [slot()]), changed = zone(api, [slot('09:00', '11:00')]);
  api.writeCache([old], []);
  api.setFetch(async () => [changed]);
  await api.loadZones({ force: true });
  assert.deepEqual(Array.from(api.buildPlannerEvents(api.state.zones[0]).events, e => e.change), ['removed', 'added']);
  await api.loadZones({ force: true });
  assert.equal(api.buildPlannerEvents(api.state.zones[0]).events[0].change, '');
});

test('failed reload preserves the last comparison', async () => {
  const api = fixture();
  api.state.zones = [zone(api, [slot('09:00', '11:00')])]; api.state.source = 'live';
  api.state.previousZones.set(10784, zone(api, [slot()]));
  api.setFetch(async () => { throw new Error('offline'); });
  await api.loadZones({ force: true });
  assert.deepEqual(Array.from(api.buildPlannerEvents(api.state.zones[0]).events, e => e.change), ['removed', 'added']);
});
