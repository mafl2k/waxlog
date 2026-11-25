// Pure logic for WaxLog (no DOM, no Sauce imports) so it can be tested with plain node.

// Private localStorage key. It deliberately does NOT start with "/" (Sauce broadcasts those
// to every window's settings store) nor with "<windowId>-", so Sauce ignores it entirely.
export const DATA_KEY = 'waxlog:data:v1';
// Keys used by 0.1.x, migrated once and then removed.
export const LEGACY_KEYS = ['/waxlog-v1', '/waxlog-counter-v1'];
// Since 0.6.0 the log lives in Sauce's app storage under DATA_KEY (rpc.getSetting/setSetting),
// which all window profiles share; localStorage is kept per profile. A profile's old
// localStorage log is moved to this key once it has been compared with the shared one.
export const BACKUP_KEY = 'waxlog:data:v1:profile-backup';
// Changed after every save of the shared log, so windows in the same profile re-read it at once
// (storage event); windows in other profiles poll.
export const PING_KEY = 'waxlog:changed';

// A checkpoint older than the ride time explains by more than this is treated as a new ride
// (e.g. yesterday's ride was longer than today's ride so far when the window opened).
export const NEW_RIDE_GAP_MS = 2 * 3600 * 1000;
// While Zwift's state stands still (save screen, or in the game without riding), the
// checkpoint's clock is moved on and saved this often, so a ride resumed after a long pause
// isn't mistaken for a new one by the NEW_RIDE_GAP_MS rule.
export const CP_REFRESH_MS = 30 * 60 * 1000;

// Blue first: a healthy chain shouldn't wear the alarm color.
export const PALETTE = ['#1e88e5', '#43a047', '#8e24aa', '#fb8c00', '#e53935', '#fdd835', '#212121',
                        '#eeeeee'];


export function defaultData() {
    return {
        version: 2,
        activeId: null,
        alertPct: 90,
        alertMessage: true,  // the on-screen alert; off: the colors (and the beep) only
        beep: true,
        minimal: true,  // stay invisible until the active chain hits the alert threshold
        ride: null,     // checkpoint: how far into the current Zwift ride we've credited
        chains: [],
    };
}


export function normalize(raw) {
    const d = Object.assign(defaultData(), raw && typeof raw === 'object' ? raw : {});
    const seen = new Set();
    d.chains = (Array.isArray(d.chains) ? d.chains : []).filter(c => {
        if (!c || !c.id || seen.has(c.id)) {
            return false;
        }
        seen.add(c.id);
        return true;
    });
    for (const c of d.chains) {
        c.name = String(c.name || 'Chain');
        c.color = /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : PALETTE[0];
        c.limitKm = positive(c.limitKm, 300);
        c.sinceWaxM = nonNeg(c.sinceWaxM);
        c.totalM = nonNeg(c.totalM);
        c.waxCount = nonNeg(c.waxCount) | 0;
        c.waxedAt = Number.isFinite(c.waxedAt) && c.waxedAt > 0 ? c.waxedAt : null;
    }
    if (!d.chains.some(c => c.id === d.activeId)) {
        d.activeId = d.chains[0] ? d.chains[0].id : null;
    }
    d.alertPct = Math.round(Math.min(99, Math.max(50, Number(d.alertPct) || 90)));
    d.alertMessage = d.alertMessage !== false;
    d.beep = d.beep !== false;
    d.minimal = d.minimal !== false;
    d.ride = isCheckpoint(d.ride) ? d.ride : null;
    d.version = 2;
    return d;
}


function isCheckpoint(r) {
    return !!r && typeof r === 'object' && Number.isFinite(r.distance) && Number.isFinite(r.time) &&
        Number.isFinite(r.worldTime);
}


function positive(v, def) {
    v = Number(v);
    return Number.isFinite(v) && v > 0 ? v : def;
}


function nonNeg(v) {
    v = Number(v);
    return Number.isFinite(v) && v > 0 ? v : 0;
}


export function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}


export function addChain(data, {name, color, limitKm}) {
    const chain = {
        id: makeId(),
        name: String(name || '').trim() || `Chain ${data.chains.length + 1}`,
        color: color || PALETTE[data.chains.length % PALETTE.length],
        limitKm: positive(limitKm, 300),
        sinceWaxM: 0,
        totalM: 0,
        waxCount: 0,
        waxedAt: Date.now(),
    };
    data.chains.push(chain);
    if (!data.activeId) {
        data.activeId = chain.id;
    }
    return chain;
}


export function getActive(data) {
    return data.chains.find(c => c.id === data.activeId) || null;
}


export function markWaxed(chain) {
    chain.sinceWaxM = 0;
    chain.waxCount = (chain.waxCount | 0) + 1;
    chain.waxedAt = Date.now();
}


// Chains rotate in list order (#1, #2, …): the next one after the chain on the bike that is
// still under the alert threshold, wrapping around. Null when none is: the rotation is used up.
export function nextInRotation(data) {
    const n = data.chains.length;
    const i = data.chains.findIndex(c => c.id === data.activeId);
    for (let k = 1; k < n; k++) {
        const c = data.chains[(i + k + n) % n];
        if (pctUsed(c) < data.alertPct) {
            return c;
        }
    }
    return null;
}


// "Wax all": every chain freshly waxed, and the rotation starts over with #1 on the bike.
export function waxAll(data) {
    for (const chain of data.chains) {
        markWaxed(chain);
    }
    if (data.chains.length) {
        data.activeId = data.chains[0].id;
    }
}


// 0 = ok (green), 1 = getting close (yellow), 2 = due (red), 3 = over limit
export function level(chain, alertPct) {
    const pct = pctUsed(chain);
    if (pct >= 100) {
        return 3;
    } else if (pct >= alertPct) {
        return 2;
    } else if (pct >= alertPct - 10) {
        return 1;
    }
    return 0;
}


export function pctUsed(chain) {
    return chain.sinceWaxM / 1000 / chain.limitKm * 100;
}


export function remainingKm(chain) {
    return chain.limitKm - chain.sinceWaxM / 1000;
}


export function fmtKm(m, digits=1) {
    return (m / 1000).toFixed(digits);
}


/**
 * Is `state` part of a different Zwift ride than checkpoint `cp`?
 *
 * Zwift's `distance` and `time` count up from 0 for each ride, so a drop in either means a new
 * ride. A change of sport or Zwift account does too. Finally, if far more wall-clock time has
 * passed since the checkpoint than ride time, the old ride ended and this is a new one that
 * has simply gone further than the old one by now.
 */
export function isNewRide(cp, state) {
    if (!cp) {
        return true;
    }
    if (state.athleteId !== cp.athleteId || state.sport !== cp.sport) {
        return true;
    }
    if (state.distance < cp.distance || state.time < cp.time) {
        return true;
    }
    if (state.distance === cp.distance && state.time === cp.time) {
        // Standing still (Zwift's save screen, or in the game without riding): the same ride,
        // however long ago the checkpoint was. Without this the rule below credited the whole
        // ride again after 2 h.
        return false;
    }
    const wallMs = state.worldTime - cp.worldTime;
    const rideMs = (state.time - cp.time) * 1000;
    return wallMs - rideMs > NEW_RIDE_GAP_MS;
}


/**
 * Is `state` no newer than checkpoint `cp` for the same rider and sport? Then another window
 * (Sauce throttles background windows) has already credited past it. Without this check its
 * smaller distance would look like a new ride and the whole ride would be credited again.
 */
export function isStale(cp, state) {
    return !!cp && state.athleteId === cp.athleteId && state.sport === cp.sport &&
        state.worldTime <= cp.worldTime;
}


/**
 * Did crediting move checkpoint `cp` (from `before`) enough to save it? Distance or ride time
 * moved, or its clock moved on by CP_REFRESH_MS while standing still. A stale state leaves the
 * checkpoint object as it was.
 */
export function checkpointMoved(before, cp) {
    return !!cp && cp !== before && (!before || before.distance !== cp.distance ||
        before.time !== cp.time || cp.worldTime - before.worldTime >= CP_REFRESH_MS);
}


/**
 * Credit the active chain with whatever part of the current ride hasn't been credited yet,
 * and move the checkpoint. Idempotent: calling it again with the same state adds nothing, so
 * several windows, reopened windows and gaps in the data stream never lose or double km. A
 * state older than the checkpoint (isStale) credits nothing and leaves the checkpoint alone.
 * Returns the meters credited.
 */
export function creditRide(data, state) {
    if (!state || !Number.isFinite(state.distance) || !Number.isFinite(state.time) ||
        !Number.isFinite(state.worldTime)) {
        return 0;
    }
    const cp = data.ride;
    if (isStale(cp, state)) {
        return 0;
    }
    const base = isNewRide(cp, state) ? 0 : cp.distance;
    const delta = Math.max(0, state.distance - base);
    data.ride = {
        athleteId: state.athleteId,
        sport: state.sport,
        distance: state.distance,
        time: state.time,
        worldTime: state.worldTime,
    };
    const chain = getActive(data);
    // Zwift running km obviously don't wear a bike chain; the checkpoint still moves.
    if (chain && delta > 0 && state.sport !== 'running') {
        chain.sinceWaxM += delta;
        chain.totalM += delta;
        return delta;
    }
    return 0;
}


// ---------- when to save the ride ----------
// The overlay shows the ride every second from the latest state, but saves it only every
// SAVE_EVERY_M and when something happens: a new ride starts (the old one's last km first, e.g.
// an event pen resets Zwift's distance), an event starts or ends, Zwift sends no data for 15 s,
// or the window closes. Unsaved km aren't lost while the ride goes on: the checkpoint still
// points before them and the next save credits them. Only a crash can lose them (at most
// SAVE_EVERY_M), and only if that Zwift ride ends before Sauce runs again.
export const SAVE_EVERY_M = 5000;
export const LIVE_KEY = 'waxlog:live';  // localStorage: the overlay's latest state, for the settings window


/**
 * A new Zwift state arrives. `prev` is the previous one, `saved` the last one this window saved
 * (either may be null). Returns {savePrev, saveNow}: save `prev` first (its ride ended), and/or
 * save `state` now.
 */
export function savePlan(prev, state, saved) {
    const savePrev = !!prev && prev !== saved && isNewRide(prev, state);
    const eventChange = !!prev && (prev.eventSubgroupId || null) !== (state.eventSubgroupId || null);
    const saveNow = savePrev || eventChange || !saved || isNewRide(saved, state) ||
        state.distance - saved.distance >= SAVE_EVERY_M ||
        state.worldTime - saved.worldTime >= CP_REFRESH_MS;
    return {savePrev, saveNow};
}


// ---------- one log for all profiles ----------

// All km a log has seen, over all chains (waxing doesn't reset totalM).
export function logMeters(d) {
    return d && Array.isArray(d.chains) ? d.chains.reduce((m, c) => m + (Number(c.totalM) || 0), 0) : 0;
}


/**
 * A profile's own (pre-0.6.0) log meets the shared one: which becomes the shared log? The one
 * with more km in total. A profile log without chains never wins; on a tie the shared log stays.
 * Returns 'local' (write the profile's log to the shared store) or 'shared' (keep it).
 */
export function pickLog(shared, local) {
    if (!local || !local.chains.length) {
        return 'shared';
    }
    if (!shared || !shared.chains.length) {
        return 'local';
    }
    return logMeters(local) > logMeters(shared) ? 'local' : 'shared';
}


// ---------- demo ----------
// The settings window's Demo button stores an end time in WaxLog's prefs, a private key of its
// own next to the km log. While it runs, the overlay shows a made-up ride on a copy of the log
// (demoView) and ignores Zwift: demo km are never saved and the ride checkpoint stays put, so
// whatever is ridden in Zwift meanwhile is still credited once the demo ends.

export const PREFS_KEY = 'waxlog:prefs:v1';
export const DEMO_MS = 10 * 60 * 1000;    // the demo stops by itself after this
export const DEMO_SPEED_MPS = 600;         // 36 km/h, 60x faster


export function normalizePrefs(raw) {
    const until = raw && typeof raw === 'object' ? raw.demoUntil : null;
    return {demoUntil: Number.isFinite(until) ? until : null};
}


// The changes for starting (true) or stopping (false) the demo.
export function demoChange(on, now) {
    return {demoUntil: on ? now + DEMO_MS : null};
}


// True while the demo runs. An end further away than DEMO_MS (clock set back) counts as over.
export function demoOn(prefs, now) {
    const until = prefs && prefs.demoUntil;
    return Number.isFinite(until) && now < until && until - now <= DEMO_MS;
}


// Meters of made-up riding since `start` (ms). Every window computes the same from the clock.
export function demoDistance(start, now) {
    return Math.max(0, now - start) / 1000 * DEMO_SPEED_MPS;
}


// A copy of the log with `demoM` added to the active chain, for display only. Without chains it
// has a half-used sample chain, so the demo reaches "wax due" and "over limit" within minutes.
// The sample chain keeps one id across calls: the overlay remembers alerts per chain id, so a
// new id every second would pop (and beep) the alert again every second.
export const DEMO_CHAIN_ID = 'demo-sample';

export function demoView(data, demoM) {
    const v = structuredClone(data);
    v.ride = null;
    if (!v.chains.length) {
        const c = addChain(v, {name: 'Demo chain', color: PALETTE[0], limitKm: 300});
        c.id = v.activeId = DEMO_CHAIN_ID;
        c.sinceWaxM = c.totalM = 150000;
    }
    const chain = getActive(v);
    if (chain) {
        chain.sinceWaxM += demoM;
        chain.totalM += demoM;
    }
    return v;
}


// ---------- display stages ----------
// The overlay picks how much it shows from the window size, largest first:
//   full  name + status, big km, bar, "km left · this ride" line
//   sub   one row (name, km, status), bar, "km left" line
//   bar   one row, bar
//   row   one row
export const SIZES = ['full', 'sub', 'bar', 'row'];


// `fits(size)` tries a stage; returns the largest that fits, or the smallest when none does.
export function pickSize(fits) {
    return SIZES.find(s => fits(s)) || SIZES[SIZES.length - 1];
}
