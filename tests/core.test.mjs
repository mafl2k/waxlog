// Run with: node --test tests/core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../pages/src/waxlog-core.mjs';

const H = 3600 * 1000;

function setup() {
    const d = C.normalize(null);
    const a = C.addChain(d, {name: 'Blue', limitKm: 300});
    const b = C.addChain(d, {name: 'Green', limitKm: 300});
    return {d, a, b};
}

// A rider state as Sauce sends it: meters, seconds, world clock in ms.
const st = (distance, time, worldTime, extra={}) =>
    ({athleteId: 1, sport: 'cycling', distance, time, worldTime, ...extra});


test('first sample of a ride credits the whole ride so far', () => {
    const {d, a} = setup();
    assert.equal(C.creditRide(d, st(15000, 1800, 10 * H)), 15000);
    assert.equal(a.sinceWaxM, 15000);
});

test('same state twice credits nothing (idempotent across windows)', () => {
    const {d, a} = setup();
    C.creditRide(d, st(1000, 100, 10 * H));
    assert.equal(C.creditRide(d, st(1000, 100, 10 * H)), 0);
    assert.equal(C.creditRide(d, st(1010, 101, 10 * H + 1000)), 10);
    assert.equal(a.sinceWaxM, 1010);
});

test('window closed mid-ride catches up on reopen', () => {
    const {d, a} = setup();
    C.creditRide(d, st(5000, 600, 10 * H));
    // 20 minutes later, 12 km further, nothing seen in between
    assert.equal(C.creditRide(d, st(17000, 1800, 10 * H + 1200e3)), 12000);
    assert.equal(a.sinceWaxM, 17000);
});

test('new ride (distance back to 0) starts from 0', () => {
    const {d, a} = setup();
    C.creditRide(d, st(30000, 3600, 10 * H));
    assert.equal(C.creditRide(d, st(200, 30, 11 * H)), 200);
    assert.equal(a.sinceWaxM, 30200);
});

test('new ride that is already longer than the last one is detected by time', () => {
    const {d, a} = setup();
    C.creditRide(d, st(30000, 3600, 10 * H));
    // Next day, window opened late: 40 km / 1.5 h in, i.e. more than yesterday on both counts.
    assert.equal(C.creditRide(d, st(40000, 5400, 34 * H)), 40000);
    assert.equal(a.sinceWaxM, 70000);
});

test('ride time going backwards means a new ride', () => {
    const {d} = setup();
    C.creditRide(d, st(30000, 3600, 10 * H));
    assert.equal(C.creditRide(d, st(31000, 100, 10 * H + 200e3)), 31000);
});

test('pause inside the same ride (under 2 h) does not double count', () => {
    const {d, a} = setup();
    C.creditRide(d, st(10000, 1200, 10 * H));
    // 1 h coffee break, ride time stood still, then 1 km more
    assert.equal(C.creditRide(d, st(11000, 1320, 11 * H + 120e3)), 1000);
    assert.equal(a.sinceWaxM, 11000);
});

test('running km are not credited but move the checkpoint', () => {
    const {d, a} = setup();
    assert.equal(C.creditRide(d, st(5000, 1500, 10 * H, {sport: 'running'})), 0);
    assert.equal(a.sinceWaxM, 0);
    // switching back to cycling = new ride from 0
    assert.equal(C.creditRide(d, st(800, 90, 10 * H + 2000e3)), 800);
});

test('different Zwift account is a new ride', () => {
    const {d} = setup();
    C.creditRide(d, st(10000, 1000, 10 * H));
    assert.equal(C.creditRide(d, st(12000, 1200, 10 * H + 200e3, {athleteId: 2})), 12000);
});

test('credit goes to the active chain only', () => {
    const {d, a, b} = setup();
    C.creditRide(d, st(1000, 100, 10 * H));
    d.activeId = b.id;
    C.creditRide(d, st(3000, 300, 10 * H + 200e3));
    assert.equal(a.sinceWaxM, 1000);
    assert.equal(b.sinceWaxM, 2000);
    assert.equal(b.totalM, 2000);
});

test('bad states are ignored', () => {
    const {d} = setup();
    assert.equal(C.creditRide(d, null), 0);
    assert.equal(C.creditRide(d, {distance: 5}), 0);
    assert.equal(d.ride, null);
});

test('levels', () => {
    const {a} = setup();
    a.sinceWaxM = 239000; assert.equal(C.level(a, 90), 0);
    a.sinceWaxM = 240000; assert.equal(C.level(a, 90), 1);
    a.sinceWaxM = 270000; assert.equal(C.level(a, 90), 2);
    a.sinceWaxM = 300000; assert.equal(C.level(a, 90), 3);
    C.markWaxed(a);
    assert.equal(a.sinceWaxM, 0);
    assert.equal(a.waxCount, 1);
});

test('normalize repairs bad data', () => {
    const n = C.normalize({
        activeId: 'gone', alertPct: 75.6, ride: {distance: 'x'},
        chains: [{id: 'x', limitKm: -5, color: 'bad', waxedAt: 'garbage'}, {id: 'x'}, null],
    });
    assert.equal(n.chains.length, 1);
    assert.equal(n.activeId, 'x');
    assert.equal(n.chains[0].limitKm, 300);
    assert.equal(n.chains[0].waxedAt, null);
    assert.equal(n.alertPct, 76);
    assert.equal(n.ride, null);
    assert.equal(C.normalize({alertPct: 200}).alertPct, 99);
});


// ---------- demo (settings window's Demo button) ----------

const M = 60 * 1000;

test('prefs: own key, separate from the km log; garbage falls back to defaults', () => {
    assert.notEqual(C.PREFS_KEY, C.DATA_KEY);
    assert.ok(!C.PREFS_KEY.startsWith('/'));
    assert.deepEqual(C.normalizePrefs(null), {demoUntil: null});
    assert.deepEqual(C.normalizePrefs('x'), {demoUntil: null});
    assert.deepEqual(C.normalizePrefs({demoUntil: 'soon', junk: 1}), {demoUntil: null});
    assert.deepEqual(C.normalizePrefs({demoUntil: 1234}), {demoUntil: 1234});
});

test('demoChange / demoOn: 10 minutes, stops by itself, stop clears it', () => {
    const now = 1e12;
    const p = C.demoChange(true, now);
    assert.equal(p.demoUntil, now + 10 * M);
    assert.equal(C.demoOn(p, now), true);
    assert.equal(C.demoOn(p, now + 10 * M - 1), true);
    assert.equal(C.demoOn(p, now + 10 * M), false);
    assert.deepEqual(C.demoChange(false, now), {demoUntil: null});
    assert.equal(C.demoOn({demoUntil: null}, now), false);
    assert.equal(C.demoOn(null, now), false);
    // An end further away than 10 min (clock set back) counts as over.
    assert.equal(C.demoOn({demoUntil: now + 11 * M}, now), false);
});

test('demoDistance: 600 m per second since the start, same in every window', () => {
    assert.equal(C.demoDistance(1000, 1000), 0);
    assert.equal(C.demoDistance(1000, 11000), 6000);
    assert.equal(C.demoDistance(1000, 500), 0);
});

test('demoView adds the demo km to a copy and never touches the real log', () => {
    const {d, a} = setup();
    a.sinceWaxM = 50000;
    a.totalM = 80000;
    d.ride = {athleteId: 1, sport: 'cycling', distance: 1000, time: 100, worldTime: 5};
    const before = JSON.stringify(d);
    const v = C.demoView(d, 20000);
    assert.equal(JSON.stringify(d), before);
    assert.equal(C.getActive(v).sinceWaxM, 70000);
    assert.equal(C.getActive(v).totalM, 100000);
    assert.equal(v.chains[1].sinceWaxM, 0);
    assert.equal(v.ride, null);
    // The copy is independent: crediting it later still leaves the real log alone.
    C.creditRide(v, st(5000, 500, 10));
    assert.equal(JSON.stringify(d), before);
});

test('demoView without chains uses a sample chain that reaches the alert during the demo', () => {
    const d = C.normalize(null);
    const v = C.demoView(d, 0);
    assert.equal(d.chains.length, 0);
    assert.equal(v.chains.length, 1);
    const chain = C.getActive(v);
    assert.ok(chain);
    assert.equal(C.level(chain, v.alertPct), 0);
    const end = C.demoView(d, C.demoDistance(0, C.DEMO_MS));
    assert.equal(C.level(C.getActive(end), end.alertPct), 3);
});


// ---------- display stages by window size ----------

test('pickSize: the largest stage whose content fits, else the smallest', () => {
    assert.deepEqual(C.SIZES, ['full', 'sub', 'bar', 'row']);
    const h = {full: 110, sub: 70, bar: 45, row: 30};
    const pick = avail => C.pickSize(s => h[s] <= avail);
    assert.equal(pick(200), 'full');
    assert.equal(pick(110), 'full');
    assert.equal(pick(109), 'sub');
    assert.equal(pick(50), 'bar');
    assert.equal(pick(30), 'row');
    assert.equal(pick(10), 'row');
});


// ---------- audit fixes (0.5.5) ----------

test('demoView on an empty log keeps the same sample chain id (alert fires once per level)', () => {
    const d = C.normalize(null);
    const a = C.getActive(C.demoView(d, 0));
    const b = C.getActive(C.demoView(d, 100000));
    assert.equal(a.id, b.id);
});

test('an older state after a newer checkpoint (other window) credits nothing', () => {
    const {d, a} = setup();
    C.creditRide(d, st(10000, 1000, 1000000));     // window A: 10 km
    C.creditRide(d, st(30000, 3000, 3000000));     // window A: 30 km
    const cp = {...d.ride};
    // window B, throttled, still sends the 20 km state from before
    assert.equal(C.creditRide(d, st(20000, 2000, 2000000)), 0);
    assert.deepEqual(d.ride, cp);
    assert.equal(a.sinceWaxM, 30000);
    // the same state again (same worldTime) adds nothing either
    assert.equal(C.creditRide(d, st(30000, 3000, 3000000)), 0);
    assert.equal(a.sinceWaxM, 30000);
});

test('a newer state with less distance is still a new ride', () => {
    const {d, a} = setup();
    C.creditRide(d, st(30000, 3000, 1000000));
    assert.equal(C.creditRide(d, st(5000, 500, 1000000 + 10 * 60 * 1000)), 5000);
    assert.equal(a.sinceWaxM, 35000);
});

test('pickLog: the log with more km becomes the shared one', () => {
    const log = km => {
        const d = C.normalize(null);
        const c = C.addChain(d, {name: 'A', limitKm: 300});
        c.totalM = km * 1000;
        c.sinceWaxM = Math.min(c.totalM, 100000);
        return d;
    };
    assert.equal(C.logMeters(log(1234)), 1234000);
    assert.equal(C.pickLog(null, log(5)), 'local');              // nothing shared yet
    assert.equal(C.pickLog(C.normalize(null), log(5)), 'local');  // shared log without chains
    assert.equal(C.pickLog(log(1000), log(0)), 'shared');        // the profile that started at 0
    assert.equal(C.pickLog(log(10), log(1000)), 'local');        // the real log came second
    assert.equal(C.pickLog(log(10), log(10)), 'shared');         // tie: no write
    assert.equal(C.pickLog(log(10), C.normalize(null)), 'shared');
    assert.equal(C.pickLog(null, null), 'shared');
});

test('savePlan: saves every 5 km, on a new ride and when an event starts or ends', () => {
    const at = (distance, t, extra = {}) =>
        ({athleteId: 7, sport: 'cycling', distance, time: t, worldTime: 5000000 + t * 1000, ...extra});
    const a = at(20000, 2000);
    const plan = (prev, state, saved) => C.savePlan(prev, state, saved);
    // first state of the window: save at once (catches up after a restart)
    assert.deepEqual(plan(null, a, null), {savePrev: false, saveNow: true});
    // riding on: nothing until 5 km since the last save
    assert.deepEqual(plan(a, at(24900, 2490), a), {savePrev: false, saveNow: false});
    assert.deepEqual(plan(at(24900, 2490), at(25000, 2500), a), {savePrev: false, saveNow: true});
    // joined an event: Zwift's distance starts over, so the free ride's last km go first
    const last = at(21000, 2100);
    assert.deepEqual(plan(last, at(0, 0, {eventSubgroupId: 99}), a), {savePrev: true, saveNow: true});
    // ...unless that last state was already saved
    assert.equal(plan(last, at(0, 0), last).savePrev, false);
    // event starts or finishes without a new ride
    const inEvent = at(21000, 2100, {eventSubgroupId: 99});
    assert.equal(plan(a, inEvent, a).saveNow, true);
    assert.equal(plan(inEvent, at(21100, 2110), inEvent).saveNow, true);
    assert.equal(plan(inEvent, at(21100, 2110, {eventSubgroupId: 99}), inEvent).saveNow, false);
    // switched sport or Zwift account
    assert.equal(plan(last, {...last, sport: 'running', worldTime: last.worldTime + 1000}, a).savePrev, true);
    assert.equal(plan(last, {...last, athleteId: 8, worldTime: last.worldTime + 1000}, a).savePrev, true);
});

test('standing still for hours (save screen) is the same ride, also when it goes on', () => {
    // The reported case: 30 km ride, chain at 330 km, Sauce restarted with Zwift on the save
    // screen for over 2 h showed 360 km.
    const {d, a} = setup();
    a.sinceWaxM = 300000;
    C.creditRide(d, st(30000, 3600, 10 * H));
    assert.equal(a.sinceWaxM, 330000);
    const before = d.ride;
    for (const idle of [1, 2.1, 5]) {
        const v = structuredClone(d);
        assert.equal(C.creditRide(v, st(30000, 3600, (10 + idle) * H)), 0, `${idle} h on the save screen`);
        assert.equal(C.getActive(v).sinceWaxM, 330000);
    }
    // Sauce running meanwhile moves the checkpoint's clock on (saved every 30 min) ...
    assert.equal(C.checkpointMoved(before, {...before, worldTime: before.worldTime + 10 * 60e3}), false);
    assert.equal(C.checkpointMoved(before, {...before, worldTime: before.worldTime + 30 * 60e3}), true);
    for (let t = 10.5; t <= 13; t += 0.5) {
        C.creditRide(d, st(30000, 3600, t * H));
    }
    // ... so the same ride going on after 3 h counts only the new 500 m
    assert.equal(C.creditRide(d, st(30500, 3660, 13 * H + 60e3)), 500);
    assert.equal(a.sinceWaxM, 330500);
});

test('savePlan saves the standing-still checkpoint every 30 min', () => {
    const s0 = st(30000, 3600, 10 * H);
    assert.equal(C.savePlan(s0, st(30000, 3600, 10 * H + 20 * 60e3), s0).saveNow, false);
    assert.equal(C.savePlan(s0, st(30000, 3600, 10 * H + 30 * 60e3), s0).saveNow, true);
});
