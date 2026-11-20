import * as Core from './waxlog-core.mjs';

const doc = document.documentElement;
const $ = sel => document.querySelector(sel);

let Common = null;    // Sauce common module, null when opened outside Sauce (demo/preview)
let data = Core.defaultData();
const alertedLevel = new Map();  // chainId -> highest alert level already shown in this window
let liveState = null;            // latest Zwift state, maybe not saved yet (see Core.savePlan)
let savedState = null;           // the last state this window saved
let alertTimer;
let prefs = Core.normalizePrefs(null);  // own private key (Core.PREFS_KEY): the Demo button
let demoKind = null;             // null | 'url' (?demo, plain browser) | 'pref' (Demo button)
let urlDemoStart = 0;


// ---------- storage ----------
// Inside Sauce the log lives in Sauce's app storage (rpc.getSetting/setSetting under
// Core.DATA_KEY). localStorage is kept per window profile; the app storage is shared by all of
// them, so every profile sees the same chains and km. Outside Sauce (preview) it's localStorage.
// Every change re-reads the log first; the ride checkpoint makes that safe with several windows
// open, and when Sauce switches profiles in the middle of a ride.

let shared = false;   // true: Sauce's app storage; false: localStorage (preview)
let lastJSON = '';    // the log as this window last read or wrote it
let queue = Promise.resolve();


// Storage work runs one job at a time per window, so nothing lands between a read and its write.
function serial(fn) {
    const p = queue.then(fn);
    queue = p.catch(e => console.error('WaxLog: storage failed', e));
    return p;
}


async function readData() {
    if (!shared) {
        return readLocal();
    }
    // A failed read throws, so a caller never saves an empty log over the real one.
    return Core.normalize(await Common.rpc.getSetting(Core.DATA_KEY));
}


async function writeData(d) {
    const json = JSON.stringify(d);
    lastJSON = json;
    if (!shared) {
        writeLocal(json);
        return;
    }
    await Common.rpc.setSetting(Core.DATA_KEY, JSON.parse(json));
    try {
        localStorage.setItem(Core.PING_KEY, `${Date.now()}-${Math.random()}`);
    } catch(e) {/* the other windows still poll */}
}


// Re-read the log; true if it changed since this window last saw it.
async function refresh() {
    const d = await readData();
    const json = JSON.stringify(d);
    if (json === lastJSON) {
        return false;
    }
    data = d;
    lastJSON = json;
    return true;
}


function onLogChanged() {
    render();
    // Waxed / switched / edited in the settings window: drop an alert that no longer applies.
    const d = shown();
    const chain = Core.getActive(d);
    if (!chain || Core.level(chain, d.alertPct) < 2) {
        hideAlert();
    }
}


function syncNow() {
    serial(refresh).then(changed => changed && onLogChanged(), () => {});
}


// The profile's own log from before 0.6.0 (or 0.1.x), localStorage only.
function readLocal() {
    let raw;
    try {
        raw = localStorage.getItem(Core.DATA_KEY);
    } catch(e) {/* storage unavailable */}
    if (raw == null) {
        return migrateLegacy();
    }
    try {
        return Core.normalize(JSON.parse(raw));
    } catch(e) {
        console.error('WaxLog: unreadable data, starting fresh', e);
        return Core.normalize(null);
    }
}


function hasLocal() {
    try {
        return [Core.DATA_KEY, ...Core.LEGACY_KEYS].some(k => localStorage.getItem(k) != null);
    } catch(e) {
        return false;
    }
}


function migrateLegacy() {
    let legacy;
    try {
        const v = localStorage.getItem(Core.LEGACY_KEYS[0]);
        legacy = v ? JSON.parse(v) : null;
    } catch(e) {/* ignore */}
    const d = Core.normalize(legacy);
    if (legacy) {
        writeLocal(JSON.stringify(d));
        for (const k of Core.LEGACY_KEYS) {
            try {
                localStorage.removeItem(k);
            } catch(e) {/* ignore */}
        }
    }
    return d;
}


function writeLocal(json) {
    try {
        localStorage.setItem(Core.DATA_KEY, json);
    } catch(e) {
        console.error('WaxLog: save failed', e);
    }
    schedFlush();
}


// Once per profile: its own log meets the shared one, and the one with more km is kept
// (Core.pickLog). The profile's log then moves to Core.BACKUP_KEY, so it's never compared again
// but isn't thrown away either.
async function moveLocalToShared() {
    if (!hasLocal()) {
        return;
    }
    const local = readLocal();
    const raw = await Common.rpc.getSetting(Core.DATA_KEY);
    const sharedLog = raw == null ? null : Core.normalize(raw);
    if (Core.pickLog(sharedLog, local) === 'local') {
        await Common.rpc.setSetting(Core.DATA_KEY, local);
        console.info('WaxLog: this profile\'s log has the most km and is now the shared log');
    }
    try {
        localStorage.setItem(Core.BACKUP_KEY, JSON.stringify(local));
        localStorage.removeItem(Core.DATA_KEY);
    } catch(e) {
        console.warn('WaxLog: could not move the profile log to its backup key', e);
    }
    schedFlush();
}


// Prefs sit under their own key, so starting or stopping the demo never rewrites the km log.
function readPrefs() {
    try {
        return Core.normalizePrefs(JSON.parse(localStorage.getItem(Core.PREFS_KEY)));
    } catch(e) {
        return Core.normalizePrefs(null);
    }
}


function writePrefs(changes) {
    prefs = Core.normalizePrefs({...readPrefs(), ...changes});
    try {
        localStorage.setItem(Core.PREFS_KEY, JSON.stringify(prefs));
    } catch(e) {
        console.error('WaxLog: saving prefs failed', e);
    }
    schedFlush();
    return prefs;
}


// Ask Sauce to commit localStorage to disk now and then (it's otherwise lazy).
let lastFlush = 0;
let flushTimer;
function schedFlush() {
    if (!Common || flushTimer) {
        return;
    }
    const wait = Math.max(0, lastFlush + 60000 - Date.now());
    flushTimer = setTimeout(flushNow, wait);
}


function flushNow() {
    clearTimeout(flushTimer);
    flushTimer = null;
    lastFlush = Date.now();
    if (Common) {
        Common.rpc.flushSessionStorage().catch(e => console.warn('WaxLog: flush failed', e));
    }
}


function onStorage(ev) {
    if (ev.key === Core.PING_KEY || (!shared && ev.key === Core.DATA_KEY)) {
        syncNow();
    } else if (ev.key === Core.LIVE_KEY && !$('#wax-display')) {
        liveState = readLive();  // settings window: the overlay's ride, not saved yet
        render();
    } else if (ev.key === Core.PREFS_KEY) {
        prefs = readPrefs();
        demoTick();
        if ($('#wax-demo')) {
            renderDemoControls();
        }
    }
}


// ---------- demo ----------
// The overlay shows a made-up ride on a copy of the log (Core.demoView) and ignores Zwift
// meanwhile. Nothing of it is saved: neither km nor the ride checkpoint.

function wantedDemo(now) {
    return urlDemoStart ? 'url' : Core.demoOn(prefs, now) ? 'pref' : null;
}


function demoM(now) {
    if (demoKind === 'pref') {
        return Core.demoDistance(prefs.demoUntil - Core.DEMO_MS, now);
    }
    return demoKind === 'url' ? Core.demoDistance(urlDemoStart, now) : 0;
}


// What the windows show: the demo's copy of the log, or the log with the latest Zwift state
// credited on a copy (it's saved only now and then, see Core.savePlan). The settings window
// gets that state from the overlay through Core.LIVE_KEY.
function shown() {
    if (demoKind) {
        return Core.demoView(data, demoM(Date.now()));
    }
    if (!liveState) {
        return data;
    }
    const v = structuredClone(data);
    Core.creditRide(v, liveState);
    return v;
}


// Overlay, once a second: starts or stops the demo when the button (or its end) says so, and
// moves the demo ride along. Alerts start over either way, so demo and real ones never mix.
function demoTick() {
    if (!$('#wax-display')) {
        return;
    }
    const now = Date.now();
    const want = wantedDemo(now);
    if (want !== demoKind) {
        demoKind = want;
        doc.classList.toggle('wax-demo', !!demoKind);
        alertedLevel.clear();
        hideAlert();
        flushRide();
        render();
        syncNow();
    }
    if (demoKind) {
        render();
        const d = shown();
        const chain = Core.getActive(d);
        if (chain) {
            checkAlert(d, chain);
        }
    }
}


function mmss(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}


// Settings window: the Demo button and what it says.
function renderDemoControls() {
    const now = Date.now();
    const on = Core.demoOn(prefs, now);
    setText($('#wax-demo-btn'), on ? 'Stop demo' : 'Start demo');
    setText($('#wax-demo-status'), on ?
        `Demo running, ends in ${mmss(prefs.demoUntil - now)}. Zwift data is ignored until then.` :
        'Shows a made-up ride in the WaxLog window for 10 minutes, so you can place and size it ' +
        'without Zwift. Your chains and km are not changed.');
}


function onDemoButton() {
    const now = Date.now();
    writePrefs(Core.demoChange(!Core.demoOn(readPrefs(), now), now));
    renderDemoControls();
}


// ---------- riding ----------

// When the ride is saved: Core.savePlan (every 5 km, a new ride, an event starting or ending).
// Leaving the game (no data for 15 s), the demo starting and the window closing save too.
function onAthlete(ad) {
    const s = ad && ad.state;
    if (demoKind) {
        // The demo runs: the checkpoint picks up where it left off later.
        return;
    }
    if (!s) {
        flushRide();  // no data for 15 s (left the game, or idling): save what's pending now
        return;
    }
    const state = {
        athleteId: ad.athleteId ?? s.athleteId,
        sport: s.sport,
        distance: s.distance,
        time: s.time,
        worldTime: s.worldTime,
        eventSubgroupId: Number(ad.eventSubgroupId || s.eventSubgroupId) || null,
    };
    const plan = Core.savePlan(liveState, state, savedState);
    if (plan.savePrev) {
        saveRide(liveState);
    }
    setLive(state);
    if (plan.saveNow) {
        saveRide(state);
    }
    render();
    const d = shown();
    const chain = Core.getActive(d);
    if (chain) {
        checkAlert(d, chain);
    }
}


// The overlay's latest state, also for the settings window (localStorage is enough: it's only
// for showing, and a missing one just shows the saved km).
function setLive(state) {
    liveState = state;
    try {
        if (state) {
            localStorage.setItem(Core.LIVE_KEY, JSON.stringify(state));
        } else {
            localStorage.removeItem(Core.LIVE_KEY);
        }
    } catch(e) {/* only the settings window's display */}
}


function readLive() {
    try {
        return JSON.parse(localStorage.getItem(Core.LIVE_KEY)) || null;
    } catch(e) {
        return null;
    }
}


function saveRide(state) {
    savedState = state;
    Core.creditRide(data, state);  // shows at once; commitRide re-reads and credits again (idempotent)
    serial(() => commitRide(state)).catch(() => {});
}


// Save a pending state now (no data, demo starts) and forget it.
function flushRide() {
    const state = liveState;
    setLive(null);
    if (state && state !== savedState) {
        saveRide(state);
    }
}


// The window closes (Sauce quits, profile switch, window closed). Only a message sent right now
// still gets out, so no re-read first: the save goes from what this window holds. That's safe,
// since every window credits from the same checkpoint and PING_KEY keeps `data` current.
function saveOnExit() {
    const state = liveState;
    setLive(null);
    if (!state || state === savedState) {
        return;
    }
    const d = structuredClone(data);
    const before = JSON.stringify(d.ride);
    Core.creditRide(d, state);
    if (JSON.stringify(d.ride) !== before) {
        writeData(d).catch(() => {});  // sends the RPC (or writes localStorage) before returning
    }
}


async function commitRide(state) {
    data = await readData();  // another WaxLog window, maybe in another profile, may be ahead
    const before = data.ride;
    Core.creditRide(data, state);
    if (Core.checkpointMoved(before, data.ride)) {
        await writeData(data);
    } else {
        lastJSON = JSON.stringify(data);
    }
}


// `d` is the log the overlay shows: the real one, or the demo's copy.
function checkAlert(d, chain) {
    const lvl = Core.level(chain, d.alertPct);
    const shown = alertedLevel.get(chain.id) || 0;
    if (lvl < 2) {
        alertedLevel.set(chain.id, lvl);
    } else if (lvl > shown) {
        alertedLevel.set(chain.id, lvl);
        showAlert(d, chain, lvl);
    }
}


function nextReadyChain(d) {
    return d.chains
        .filter(c => c.id !== d.activeId && Core.pctUsed(c) < d.alertPct)
        .sort((a, b) => Core.pctUsed(a) - Core.pctUsed(b))[0] || null;
}


function showAlert(d, chain, lvl) {
    const el = $('#wax-alert');
    const over = lvl >= 3;
    const used = `${Core.fmtKm(chain.sinceWaxM, 0)} / ${chain.limitKm} km`;
    const rem = Core.remainingKm(chain);
    const next = nextReadyChain(d);
    el.querySelector('.wax-alert-title').textContent =
        `${chain.name}: ${over ? 'over limit' : 'wax due'}`;
    let msg = over ? `${(-rem).toFixed(0)} km over (${used}).` : `${rem.toFixed(0)} km left (${used}).`;
    if (next) {
        msg += over ? ` Swap to ${next.name}.` : ` Next ready: ${next.name}.`;
    }
    el.querySelector('.wax-alert-msg').textContent = msg;
    el.dataset.level = over ? 'over' : 'due';
    doc.classList.add('wax-alerting');
    clearTimeout(alertTimer);
    if (!over) {
        alertTimer = setTimeout(hideAlert, 30000);
    }
    if (d.beep) {
        beep(over ? 3 : 2);
    }
}


function hideAlert() {
    clearTimeout(alertTimer);
    doc.classList.remove('wax-alerting');
}


let audioCtx;
function beep(count) {
    try {
        audioCtx = audioCtx || new AudioContext();
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();  // needed in plain browsers; Sauce's Electron allows audio anyway
        }
        const t0 = audioCtx.currentTime + 0.05;
        for (let i = 0; i < count; i++) {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.frequency.value = 880;
            gain.gain.setValueAtTime(0.0001, t0 + i * 0.3);
            gain.gain.exponentialRampToValueAtTime(0.25, t0 + i * 0.3 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.3 + 0.2);
            osc.connect(gain).connect(audioCtx.destination);
            osc.start(t0 + i * 0.3);
            osc.stop(t0 + i * 0.3 + 0.22);
        }
    } catch(e) {
        console.warn('WaxLog beep failed:', e);
    }
}


// ---------- rendering ----------

const levelNames = ['ok', 'close', 'due', 'over'];
const statusText = ['ok', 'wax soon', 'wax due', 'over limit'];

function paintBar(el, chain, d = data) {
    const lvl = Core.level(chain, d.alertPct);
    el.dataset.level = levelNames[lvl];
    el.style.setProperty('--chain-color', chain.color);
    el.querySelector('.wax-bar-fill').style.width = `${Math.min(100, Core.pctUsed(chain))}%`;
    return lvl;
}


function setText(el, text) {
    if (el.textContent !== text) {
        el.textContent = text;
    }
}


// Renders whichever parts this page has: the overlay box (waxlog.html) and/or the chain
// manager (waxlog-settings.html).
function render() {
    if ($('#wax-display')) {
        renderDisplay();
    }
    if ($('#wax-chains')) {
        renderManage();
    }
}


function renderDisplay() {
    const now = Date.now();
    const d = shown();
    const chain = Core.getActive(d);
    const disp = $('#wax-display');
    disp.classList.toggle('empty', !chain);
    // "Hide until alert" (data.minimal): invisible while the chain is fine. Still shown when
    // there is no chain yet (so it can be set up), and during the demo (so it can be placed).
    const hidden = !!(d.minimal && chain && !demoKind && Core.level(chain, d.alertPct) < 2);
    doc.classList.toggle('wax-hidden', hidden);
    // Otherwise Sauce paints the window (theme, transparency, texture); while hidden its
    // invisible-overlay class drops that, and Sauce still shows the window on hover.
    document.body.classList.toggle('transparent-bg', hidden);
    setText($('#wax-demo-badge'), demoKind === 'pref' ? `DEMO ${mmss(prefs.demoUntil - now)}` : 'DEMO');
    if (chain) {
        const lvl = paintBar(disp, chain, d);
        // "This ride" only while Zwift sends data: the stored checkpoint may be days old.
        const rm = demoKind ? demoM(now) :
            liveState && d.ride && d.ride.sport !== 'running' ? d.ride.distance : 0;
        setText(disp.querySelector('.wax-name'), chain.name);
        setText(disp.querySelector('.wax-since'), Core.fmtKm(chain.sinceWaxM));
        setText(disp.querySelector('.wax-limit'), String(chain.limitKm));
        setText(disp.querySelector('.wax-status'), statusText[lvl]);
        const rem = Core.remainingKm(chain);
        const left = rem >= 0 ? `${rem.toFixed(0)} km left` : `${(-rem).toFixed(0)} km over`;
        const ride = rm > 0 ? ` · this ride ${Core.fmtKm(rm)} km` : '';
        // Big box: big km, "km left" below. One-row stages: km left in the row, km below.
        setText(disp.querySelector('.wax-sub'), left + ride);
        setText(disp.querySelector('.wax-left-num'), Math.abs(rem).toFixed(0));
        setText(disp.querySelector('.wax-left-unit'), rem >= 0 ? ' km left' : ' km over');
        setText(disp.querySelector('.wax-sub-km'),
                `${Core.fmtKm(chain.sinceWaxM)} / ${chain.limitKm} km` + ride);
    }
    if (!chain !== hadEmpty) {
        hadEmpty = !chain;
        fitSize();  // after the texts are in: an empty line has no height
    }
}


// Shows the largest display stage that fits the window (Core.SIZES). Runs when the window is
// resized or the box switches between empty and a chain, never on live km, so nothing jumps
// during a ride.
let hadEmpty = null;
function fitSize() {
    const disp = $('#wax-display');
    const main = disp.querySelector('.wax-main');
    if (disp.classList.contains('empty')) {
        return;
    }
    doc.dataset.waxSize = Core.pickSize(size => {
        doc.dataset.waxSize = size;
        const cs = getComputedStyle(disp);
        const room = disp.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        return main.offsetHeight <= room + 0.5;
    });
}


// Updates the chain list in place (never rebuilds it), so live km updates can't swallow a
// click mid-press or wipe what's being typed into an open edit form.
function renderManage() {
    const data = shown();  // with the overlay's unsaved ride
    const list = $('#wax-chains');
    const existing = new Map([...list.children].map(li => [li.dataset.id, li]));
    data.chains.forEach((chain, i) => {
        let li = existing.get(chain.id);
        existing.delete(chain.id);
        if (!li) {
            li = $('#wax-chain-tpl').content.firstElementChild.cloneNode(true);
            li.dataset.id = chain.id;
            fillEditForm(li, chain);
        }
        if (list.children[i] !== li) {
            list.insertBefore(li, list.children[i] || null);
        }
        const active = chain.id === data.activeId;
        li.classList.toggle('active', active);
        paintBar(li, chain);
        setText(li.querySelector('.wax-chain-name'), chain.name + (active ? ' · on bike' : ''));
        setText(li.querySelector('.wax-chain-km'), `${Core.fmtKm(chain.sinceWaxM)} / ${chain.limitKm} km`);
        setText(li.querySelector('.wax-chain-meta'),
                `Total ${Core.fmtKm(chain.totalM, 0)} km · waxed ${chain.waxCount}×` +
                (chain.waxedAt ? ` · last ${new Date(chain.waxedAt).toLocaleDateString()}` : ''));
        li.querySelector('[data-act="activate"]').disabled = active;
        if (!li.classList.contains('editing')) {
            fillEditForm(li, chain);
        }
    });
    for (const li of existing.values()) {
        li.remove();
    }
    $('#wax-all').hidden = data.chains.length < 2;
    const add = $('#wax-add');
    if (!add.open) {
        add.querySelector('form').color.value = Core.PALETTE[data.chains.length % Core.PALETTE.length];
    }
    const s = $('#wax-settings');
    if (!s.contains(document.activeElement)) {
        s.alertPct.value = data.alertPct;
        s.beep.checked = data.beep;
        s.minimal.checked = data.minimal;
    }
}


function fillEditForm(li, chain) {
    const form = li.querySelector('.wax-edit');
    form.label.value = chain.name;
    form.color.value = chain.color;
    form.limitKm.value = chain.limitKm;
    form.sinceWaxKm.value = Core.fmtKm(chain.sinceWaxM);
    delete form.dataset.kmDirty;
}


// ---------- manage actions ----------

// Two-step confirm for destructive actions (window.confirm is unreliable in overlays).
// The first click relabels the button; a second click within 5 s goes through.
const confirmTimers = new WeakMap();

function resetConfirm(btn) {
    clearTimeout(confirmTimers.get(btn));
    if (btn.classList.contains('confirming')) {
        btn.classList.remove('confirming');
        btn.textContent = btn.dataset.label;
    }
}


function confirmed(btn) {
    if (!btn.dataset.confirm) {
        return true;
    }
    if (btn.classList.contains('confirming')) {
        resetConfirm(btn);
        return true;
    }
    btn.classList.add('confirming');
    btn.dataset.label = btn.textContent;
    btn.textContent = btn.dataset.confirm;
    confirmTimers.set(btn, setTimeout(() => resetConfirm(btn), 5000));
    return false;
}


// Every handler that changes data first re-reads storage, so it acts on the latest km
// (another window may have credited some since this one last looked).
// In the settings window the overlay's unsaved ride is credited first, so an edit (e.g. waxed)
// lands after the km ridden before it and saves them too.
function mutate(fn) {
    return serial(async () => {
        data = await readData();
        if (liveState) {
            Core.creditRide(data, liveState);
        }
        if (fn(data) !== false) {
            await writeData(data);
        }
    }).catch(e => alert(`WaxLog could not save this change: ${e.message || e}`)).finally(render);
}


function onWaxAll(ev) {
    if (!confirmed(ev.currentTarget)) {
        return;
    }
    mutate(d => {
        for (const chain of d.chains) {
            Core.markWaxed(chain);
        }
    });
    alertedLevel.clear();
    hideAlert();
}


function onChainAction(ev) {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) {
        return;
    }
    const li = btn.closest('.wax-chain');
    const id = li.dataset.id;
    const act = btn.dataset.act;
    if (act === 'edit') {
        const opening = !li.classList.contains('editing');
        const chain = shown().chains.find(c => c.id === id);
        if (opening && chain) {
            fillEditForm(li, chain);  // fresh values, not the ones from when the list was built
        }
        li.classList.toggle('editing', opening);
        return;
    }
    if (!confirmed(btn)) {
        return;
    }
    mutate(d => {
        const chain = d.chains.find(c => c.id === id);
        if (!chain) {
            return false;
        }
        if (act === 'activate') {
            d.activeId = chain.id;
        } else if (act === 'waxed') {
            Core.markWaxed(chain);
            alertedLevel.delete(chain.id);
        } else if (act === 'delete') {
            d.chains = d.chains.filter(c => c !== chain);
            Object.assign(d, Core.normalize(d));
        }
    });
}


function onEditInput(ev) {
    if (ev.target.name === 'sinceWaxKm') {
        ev.target.form.dataset.kmDirty = '1';
    }
}


function onEditSubmit(ev) {
    const form = ev.target.closest('.wax-edit');
    if (!form) {
        return;
    }
    ev.preventDefault();
    const li = form.closest('.wax-chain');
    // Read the form now: mutate runs later, after the render() below has refilled the form
    // with the stored values.
    const id = li.dataset.id;
    const name = form.label.value.trim();
    const color = form.color.value;
    const limit = Number(form.limitKm.value);
    // Only touch the km if the user actually typed there; otherwise the field holds a
    // rounded snapshot from when the form opened and would throw away km ridden since.
    const kmText = form.sinceWaxKm.value.trim();
    const km = form.dataset.kmDirty && kmText !== '' ? Number(kmText) : NaN;
    mutate(d => {
        const chain = d.chains.find(c => c.id === id);
        if (!chain) {
            return false;
        }
        chain.name = name || chain.name;
        chain.color = color;
        let changedKm = false;
        if (limit > 0 && limit !== chain.limitKm) {
            chain.limitKm = limit;
            changedKm = true;
        }
        if (Number.isFinite(km) && km >= 0) {
            chain.sinceWaxM = km * 1000;
            changedKm = true;
        }
        if (changedKm) {
            alertedLevel.delete(chain.id);
        }
    });
    li.classList.remove('editing');
    render();
}


function onAddSubmit(ev) {
    ev.preventDefault();
    const f = ev.target;
    // Read the form now: mutate runs later, after it has been cleared below.
    const chain = {name: f.label.value, color: f.color.value, limitKm: f.limitKm.value};
    mutate(d => {
        Core.addChain(d, chain);
    });
    f.label.value = '';
    $('#wax-add').open = false;
    render();
}


function onSettingsChange(ev) {
    const s = ev.currentTarget;
    // Read the form now: mutate runs later, and a render meanwhile may refill it.
    const pct = Math.round(Number(s.alertPct.value));
    const beep = s.beep.checked;
    const minimal = s.minimal.checked;
    mutate(d => {
        if (pct >= 50 && pct <= 99 && pct !== d.alertPct) {
            d.alertPct = pct;
            alertedLevel.clear();
        }
        d.beep = beep;
        d.minimal = minimal;
    });
}


function openSettings() {
    // Goes through the titlebar link so Sauce opens it as a sized child window (and, in a
    // browser, so initInteractionListeners has added our windowId to the URL).
    $('a.open-settings').click();
}


// ---------- boot ----------

// Sauce's per-window background fields, as its own windows and other mods use them. A box
// ticked without picking a color gives black at full opacity, which is what the form shows.
const BG_KEYS = ['solidBackground', 'backgroundColor', 'backgroundAlpha'];

function applyBackground() {
    try {
        Common.setBackground({backgroundColor: '#000000', backgroundAlpha: 100, ...Common.settingsStore.get()});
    } catch(e) {
        console.warn('WaxLog: could not apply the background setting', e);
    }
}


async function loadCommon() {
    try {
        Common = await import('/pages/src/common.mjs');
    } catch(e) {
        console.warn('WaxLog: Sauce common.mjs not available, running standalone.', e);
        doc.classList.add('wax-standalone');
    }
    shared = !!(Common && Common.rpc);
    if (shared) {
        try {
            await moveLocalToShared();
        } catch(e) {
            console.error('WaxLog: could not compare this profile\'s log with the shared one', e);
        }
    }
    try {
        await serial(refresh);
    } catch(e) {
        console.error('WaxLog: could not read the log', e);
    }
    prefs = readPrefs();
    window.addEventListener('storage', onStorage);
    if (shared) {
        // Windows in this profile get PING_KEY at once; this catches browser windows opened
        // through Sauce's web server, which have their own localStorage.
        setInterval(syncNow, 10000);
    }
}


// Overlay window: counts km, shows the box and the alert.
export async function main() {
    await loadCommon();
    window.addEventListener('pagehide', () => {
        saveOnExit();
        flushNow();
    });
    if (Common) {
        Common.initInteractionListeners();
        if (Common.settingsStore && Common.setBackground) {
            applyBackground();
            Common.settingsStore.addEventListener('set', ev => {
                if (ev.data && (ev.data.key == null || BG_KEYS.includes(ev.data.key))) {
                    applyBackground();
                }
            });
        }
        Common.subscribe('athlete/self', onAthlete, {persistent: true});
    } else if (new URLSearchParams(location.search).has('demo')) {
        // ?demo in a plain browser: the same made-up ride as the Demo button, for as long as
        // the page is open.
        urlDemoStart = Date.now();
    }
    $('#wax-display').addEventListener('click', openSettings);
    document.addEventListener('keydown', ev => {
        if (ev.key === 'Escape') {
            hideAlert();
        }
    });
    $('#wax-alert').addEventListener('click', hideAlert);
    render();
    fitSize();
    new ResizeObserver(fitSize).observe(doc);
    // Sauce's font changes the line heights, and it may arrive after the first measurement.
    document.fonts.ready.then(fitSize);
    document.fonts.addEventListener('loadingdone', fitSize);
    demoTick();
    setInterval(demoTick, 1000);
}


// Settings window: chain manager. It doesn't count km itself; it follows the overlay's
// saves through storage events.
export async function settingsMain() {
    await loadCommon();
    liveState = readLive();  // the overlay's ride so far, not saved yet
    if (Common) {
        Common.initInteractionListeners();
        // Sauce's own theme/background override selects, stored in Sauce's settings store
        // for this window (shared with the overlay, which is our parent window).
        await Common.initSettingsForm('#wax-appearance')();
    }
    $('#wax-done').addEventListener('click', () => window.close());
    $('#wax-chains').addEventListener('click', onChainAction);
    $('#wax-chains').addEventListener('input', onEditInput);
    $('#wax-chains').addEventListener('submit', onEditSubmit);
    $('#wax-all').addEventListener('click', onWaxAll);
    $('#wax-add-form').addEventListener('submit', onAddSubmit);
    $('#wax-settings').addEventListener('change', onSettingsChange);
    $('#wax-settings').addEventListener('submit', ev => ev.preventDefault());
    $('#wax-demo-btn').addEventListener('click', onDemoButton);
    renderDemoControls();
    setInterval(renderDemoControls, 1000);  // the countdown, and the demo ends by itself
    if (!data.chains.length) {
        $('#wax-add').open = true;
    }
    render();
}
