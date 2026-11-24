// Test harness for fc_decide, fc_init_fn and fc_switch_router in flows.json.
// Extracts each node's `func` source, wraps it in (msg, flow, global, node),
// and runs (1) the six in-flow scenarios fc_test1..6_setup, each with a
// counter-check that flips the input the scenario is about, and (2) the live
// path the in-flow tests skip: min-on gate, heartbeat resend, status
// hysteresis, freezer_plan merge, PV forecast slots, door recovery, routing.
// Run: node test_decide.js   (exit code 1 on any failure)
process.env.TZ = 'Europe/Vienna';

const fs = require('fs');
const path = require('path');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const src = id => {
  const n = flows.find(x => x && x.id === id);
  if (!n) { console.error(id + ' node not found'); process.exit(1); }
  return n.func;
};
const compile = id => new Function('msg', 'flow', 'global', 'node', 'return (function(){ ' + src(id) + ' })();');
const decideFn = compile('fc_decide'), initFn = compile('fc_init_fn'), routerFn = compile('fc_switch_router');

// ---- helpers ----
const SLOT_MS = 15 * 60000;
const MIN = 60000;
const ts = iso => new Date(iso).getTime();

function store(init = {}) {
  const v = JSON.parse(JSON.stringify(init));
  return { v, get: k => v[k], set: (k, x) => { v[k] = x; } };
}
// global: memory keys plus pp in the file store, as on big
function ctx({ cfg, freezers, pp = {}, ess = {}, plan } = {}) {
  const flow = store({ config: cfg });
  const mem = store({ freezers, ess, freezer_plan: plan });
  const file = store({ pp });
  const global = { get: (k, s) => (s === 'file' ? file : mem).get(k), set: (k, x, s) => (s === 'file' ? file : mem).set(k, x) };
  return { flow, global, mem };
}
const warns = [];
const node = { warn: m => warns.push(m) };
const decide = (c, msg) => decideFn(msg, c.flow, c.global, node);

function price24(now, n, ct) {
  const o = {}, t0 = Math.floor(now / SLOT_MS) * SLOT_MS;
  for (let i = 0; i < n; i++) {
    const d = new Date(t0 + i * SLOT_MS);
    o[String(d.getHours() * 100 + d.getMinutes())] = { idx: i, val: ct(i), from: d.toISOString() };
  }
  return o;
}
const predLabel = t => {
  const d = new Date(t), p = x => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}., ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const kitchenCfg = (extra = {}) => ({ pv_base_load_w: 400, min_on_minutes: 0, safety_margin_c: 0.5, ...extra,
  freezers: { freezer_kitchen: { t_max_c: -15, fallback_cooling_rate_c_per_min: -0.3, fallback_warming_rate_c_per_min: 0.03,
    fallback_running_power_w: 120 }, freezer_cellar: { t_max_c: -15 } } });
// last_temp_update: a fresh reading (Date.now() is mocked by at())
const dev = (extra = {}) => ({ name: 'freezer_kitchen', state: 'idle', override: 'AUTO', current_temp_c: -20, last_temp_update: Date.now(), model: {}, ...extra });

// ---- assertion helpers ----
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else      { failed++; console.log(`  FAIL  ${name}${detail ? '   -> ' + detail : ''}`); }
}
const j = x => JSON.stringify(x);

// ---- 1. in-flow scenarios ----
console.log('In-flow scenarios (fc_test1..6_setup)');
function scenario(i, tweak) {
  const m = compile(`fc_test${i}_setup`)({}, null, null, node);
  if (tweak) tweak(m._test);
  return decideFn(m, null, null, node)[2].payload;
}
for (let i = 1; i <= 6; i++) {
  const r = scenario(i);
  check(r.label, r.pass === true, `expected ${j(r.expected)}, got ${j(r.got)}`);
}
// counter-checks: each scenario must flip when the input it is about flips
const flip = (i, what, tweak, cmd) => {
  const r = scenario(i, tweak);
  check(`T${i} flips without ${what}`, r.got.command === cmd, j(r.got));
};
flip(1, 'the ceiling (-14.5 -> -20)', t => { t.freezers.freezer_kitchen.current_temp_c = -20; t.price24 = price24(t.now, 4, () => 30); }, 'OFF');
flip(2, 'the short horizon (8 -> 24 slots)', t => { t.price24 = price24(t.now, 24, () => 30); }, 'ON');
flip(3, 'PV (3000 -> 0 W)', t => { t.ess_pac = 0; }, 'OFF');
flip(4, 'the cheap hours (5 -> 60 ct)', t => { t.price24 = price24(t.now, 24, () => 60); }, 'ON');
flip(5, 'the ceiling (-15.5 -> -20)', t => { t.freezers.freezer_kitchen.current_temp_c = -20; }, 'OFF');
flip(6, 'the override (ON -> AUTO)', t => { t.freezers.freezer_kitchen.override = 'AUTO'; t.price24 = price24(t.now, 8, () => 60); }, 'OFF');

// ---- 2. live path ----
console.log('\nLive path');
const NOW = ts('2026-04-21T18:00:00+02:00');
const realNow = Date.now;
const at = t => { Date.now = () => t; };

{ // min-on gate: cooling for 20 of 60 min, plan says OFF -> stays ON, status says gated_min_on; heartbeat resends ON
  at(NOW);
  const c = ctx({ cfg: kitchenCfg({ min_on_minutes: 60 }), freezers: { freezer_kitchen: dev({ state: 'cooling', last_state_change_at: NOW - 20 * MIN }) },
    pp: { price24: price24(NOW, 8, () => 30) } });
  const [sw, st] = decide(c, { device_name: 'freezer_kitchen', trigger: 'tick' });
  const s = JSON.parse(st.payload);
  check('min-on gate holds a running cycle', s.reason === 'gated_min_on' && s.target_command === 'OFF' && s.state === 'cooling', st.payload);
  check('gated heartbeat resends ON', sw && sw.payload === 'ON' && sw.reason === 'gated_min_on', j(sw));
  check('gated: state unchanged', c.mem.v.freezers.freezer_kitchen.state === 'cooling');
  at(NOW + 41 * MIN);
  const [sw2, st2] = decide(c, { device_name: 'freezer_kitchen', trigger: 'state_update' });
  check('after 60 min the gate opens -> OFF', sw2 && sw2.payload === 'OFF' && JSON.parse(st2.payload).state === 'idle', j(sw2));
}
{ // safety ceiling bypasses the gate (and an over-ceiling idle freezer starts at once)
  at(NOW);
  const c = ctx({ cfg: kitchenCfg({ min_on_minutes: 60 }), freezers: { freezer_kitchen: dev({ current_temp_c: -14, last_state_change_at: NOW - MIN }) },
    pp: { price24: price24(NOW, 8, () => 60) } });
  const [sw, st] = decide(c, { device_name: 'freezer_kitchen', trigger: 'state_update' });
  check('safety ceiling -> ON at once', sw && sw.payload === 'ON' && sw.reason === 'safety_ceiling' && JSON.parse(st.payload).state === 'safety', j(sw));
}
{ // hysteresis + heartbeat: same decision again publishes nothing; on a tick >= 2 min later it resends both
  at(NOW);
  const c = ctx({ cfg: kitchenCfg(), freezers: { freezer_kitchen: dev() }, pp: { price24: price24(NOW, 8, () => 30) } });
  const first = decide(c, { device_name: 'freezer_kitchen', trigger: 'tick' });
  check('first decision publishes switch + status', first[0] && first[0].payload === 'OFF' && first[1] && first[1].retain === true, j(first[0]));
  at(NOW + MIN);
  const again = decide(c, { device_name: 'freezer_kitchen', trigger: 'tick' });
  check('unchanged within 2 min: nothing published', again[0] === null && again[1] === null, j(again));
  at(NOW + 90 * 1000 + MIN);
  const temp = decide(c, { device_name: 'freezer_kitchen', trigger: 'state_update' });
  check('temperature update, unchanged: no heartbeat', temp[0] === null && temp[1] === null, j(temp));
  at(NOW + 2 * MIN);
  const hb = decide(c, { device_name: 'freezer_kitchen', trigger: 'tick' });
  check('tick after 2 min: heartbeat resends OFF + status', hb[0] && hb[0].payload === 'OFF' && hb[1] !== null, j(hb[0]));
}
{ // freezer_plan: one entry per price24 slot, this freezer's slice written, the other freezer's slice kept
  at(NOW);
  const p24 = price24(NOW, 8, () => 30);
  const k0 = Object.keys(p24)[0];
  const plan = { [k0]: { ...p24[k0], freezer_cellar: { state: 'ON', temp: -18, reason: 'cheapest_fill' } } };
  const c = ctx({ cfg: kitchenCfg(), freezers: { freezer_kitchen: dev() }, pp: { price24: p24 }, plan });
  decide(c, { device_name: 'freezer_kitchen', trigger: 'tick' });
  const fp = c.mem.v.freezer_plan;
  check('freezer_plan has every price24 slot', Object.keys(fp).length === 8 && fp[k0].val === 30, Object.keys(fp).length);
  check('own slice written', fp[k0].freezer_kitchen && fp[k0].freezer_kitchen.state === 'OFF' && fp[k0].freezer_kitchen.reason === 'drift', j(fp[k0]));
  check('other freezer kept', j(fp[k0].freezer_cellar) === j(plan[k0].freezer_cellar), j(fp[k0]));
}
{ // PV forecast: a future slot with surplus in pp.prediction is planned ON (pv_surplus), the status shows its pv_w
  at(NOW);
  const p24 = price24(NOW, 8, () => 30);
  const t3 = Math.floor(NOW / SLOT_MS) * SLOT_MS + 3 * SLOT_MS;
  const c = ctx({ cfg: kitchenCfg(), freezers: { freezer_kitchen: dev() }, pp: { price24: p24, prediction: [{ time: predLabel(t3), pvPower: 2500, loadEst: 600 }] } });
  const [, st] = decide(c, { device_name: 'freezer_kitchen', trigger: 'tick' });
  const s = JSON.parse(st.payload);
  check('forecast PV slot planned ON', s.plan[3].state === 'ON' && s.plan[3].reason === 'pv_surplus' && s.plan[3].pv_w === 2500, j(s.plan[3]));
  check('other slots drift', s.plan.filter(x => x.state === 'ON').length === 1, j(s.plan.map(x => x.state)));
}
{ // negative price: forced ON (feed-in penalty)
  at(NOW);
  const c = ctx({ cfg: kitchenCfg(), freezers: { freezer_kitchen: dev() }, pp: { price24: price24(NOW, 8, i => (i === 0 ? -1 : 30)) } });
  const [sw] = decide(c, { device_name: 'freezer_kitchen', trigger: 'tick' });
  check('negative price slot -> ON', sw && sw.payload === 'ON' && sw.reason === 'plan_cool', j(sw));
}
{ // door recovery: a recent door event forces ON in a cheap slot, not in an expensive one
  at(NOW);
  const cheapNow = price24(NOW, 8, i => (i === 0 ? 5 : 30)), dearNow = price24(NOW, 8, i => (i === 0 ? 60 : 30));
  const mk = p24 => ctx({ cfg: kitchenCfg(), freezers: { freezer_kitchen: dev({ door_event_at: NOW - 10 * MIN }) }, pp: { price24: p24 } });
  const [a] = decide(mk(cheapNow), { device_name: 'freezer_kitchen', trigger: 'state_update' });
  const [b, bs] = decide(mk(dearNow), { device_name: 'freezer_kitchen', trigger: 'state_update' });
  check('door event + cheap slot -> ON', a && a.payload === 'ON' && a.reason === 'door_recovery', j(a));
  check('door event + expensive slot -> no recovery, stays OFF', b === null && JSON.parse(bs.payload).reason === 'plan_off', bs && bs.payload.slice(0, 80));
}
{ // v0.15 fail-safe: anything the planner can't trust -> ON, never OFF
  at(NOW);
  const run = (extra = {}, { cfg = kitchenCfg(), p24 = price24(NOW, 8, () => 30) } = {}) => {
    const c = ctx({ cfg, freezers: { freezer_kitchen: dev({ current_temp_c: -22, ...extra }) }, pp: { price24: p24 } });
    const [sw, st] = decide(c, { device_name: 'freezer_kitchen', trigger: 'tick' });
    return { sw, st: JSON.parse(st.payload) };
  };
  const on = (r, reason) => r.st.reason === reason && r.st.state === 'cooling' && r.sw && r.sw.payload === 'ON';
  const base = run();
  check('baseline: fresh -22 degC, 30 ct -> plan_off (OFF)', base.st.reason === 'plan_off' && base.sw.payload === 'OFF', j(base.st.reason));
  const stale = run({ last_temp_update: NOW - 100 * MIN });
  check('reading 100 min old -> ON stale_reading', on(stale, 'stale_reading') && stale.st.temp_age_min === 100, j(stale));
  const fresh = run({ last_temp_update: NOW - 30 * MIN });
  check('counter: reading 30 min old -> plans (off)', fresh.st.reason === 'plan_off' && fresh.st.temp_age_min === 30, j(fresh.st.reason));
  check('reading 89 min old -> not stale yet', run({ last_temp_update: NOW - 89 * MIN }).st.reason === 'plan_off');
  check('reading without timestamp -> ON stale_reading', on(run({ last_temp_update: null }), 'stale_reading'));
  const noAge = run({ last_temp_update: NOW - 100 * MIN }, { cfg: kitchenCfg({ stale_temp_minutes: 0 }) });
  check('stale_temp_minutes 0 disables the age check (still aged: -22 + 0.03 x 100 = -19)', noAge.st.reason !== 'stale_reading' && noAge.st.temp_est_c === -19, j([noAge.st.reason, noAge.st.temp_est_c]));
  // v0.16: aged estimate, stuck sensor, measurement time
  const aged = run({ current_temp_c: -16.5, last_temp_update: NOW - 60 * MIN });
  check('60 min old -16.5 degC -> T_est -14.7 over the -15 ceiling -> ON safety', aged.st.reason === 'safety_ceiling' && aged.st.temp_est_c === -14.7 && aged.sw.payload === 'ON', j([aged.st.reason, aged.st.temp_est_c]));
  const agedFresh = run({ current_temp_c: -16.5 });
  check('counter: fresh -16.5 degC -> no safety ceiling', agedFresh.st.reason !== 'safety_ceiling' && agedFresh.st.temp_est_c === -16.5, j(agedFresh.st.reason));
  const stuck = run({ temp_changed_at: NOW - 200 * MIN });
  check('value unchanged 200 min (reports keep coming) -> ON stuck_reading', on(stuck, 'stuck_reading') && stuck.st.temp_unchanged_min === 200, j(stuck.st.reason));
  check('counter: unchanged 60 min -> plans', run({ temp_changed_at: NOW - 60 * MIN }).st.reason === 'plan_off');
  check('stuck_temp_minutes 0 disables the stuck check', run({ temp_changed_at: NOW - 200 * MIN }, { cfg: kitchenCfg({ stuck_temp_minutes: 0 }) }).st.reason === 'plan_off');
  check('override OFF beats the fail-safe (explicit user choice)', run({ last_temp_update: NOW - 100 * MIN, override: 'OFF' }).sw.payload === 'OFF');
  check('no reading, idle (restart) -> ON no_reading', on(run({ state: 'idle', current_temp_c: null }), 'no_reading'));
  check('implausible -60 degC -> ON invalid_reading', on(run({ current_temp_c: -60 }), 'invalid_reading'));
  check('non-number reading -> ON invalid_reading', on(run({ current_temp_c: 'abc' }), 'invalid_reading'));   // (NaN becomes null in the JSON-cloned test store)
  const noTmax = kitchenCfg(); delete noTmax.freezers.freezer_kitchen.t_max_c;
  check('t_max_c missing -> ON bad_config', on(run({}, { cfg: noTmax }), 'bad_config'));
  check('no price slots -> ON no_prices', on(run({}, { p24: {} }), 'no_prices'));
  check('only past price slots -> ON no_prices', on(run({}, { p24: price24(NOW - 24 * 3600e3, 8, () => 30) }), 'no_prices'));
  const badMin = kitchenCfg(); badMin.freezers.freezer_kitchen.t_min_c = 'x';
  check('NaN in the simulation -> ON plan_invalid', on(run({}, { cfg: badMin }), 'plan_invalid'));
  const inf = run({ current_temp_c: -15.2, model: { cooling_rate_c_per_min: 0.1 } });
  check('infeasible plan -> ON plan_infeasible', on(inf, 'plan_infeasible'), j(inf.st.reason));
  const ceil = run({ current_temp_c: -14 }, { p24: {} });
  check('safety ceiling still wins without prices', ceil.st.reason === 'safety_ceiling' && ceil.st.state === 'safety' && ceil.sw.payload === 'ON', j(ceil.st.reason));
}
Date.now = realNow;

// ---- 3. real config + switch router ----
console.log('\nConfig and switch router');
{
  const c = ctx({ freezers: {} });
  initFn({}, c.flow, c.global, node);
  const cfg = c.flow.v.config;
  check('init: both freezers configured', j(Object.keys(cfg.freezers)) === j(['og_gefrierschrank', 'kg_kuehltruhe']), j(Object.keys(cfg.freezers)));
  check('init: state created for both', Object.keys(c.mem.v.freezers).length === 2 && c.mem.v.freezers.kg_kuehltruhe.state === 'idle');
  check('init: stale_temp_minutes 90, stuck_temp_minutes 180', cfg.stale_temp_minutes === 90 && cfg.stuck_temp_minutes === 180, j([cfg.stale_temp_minutes, cfg.stuck_temp_minutes]));
  const route = (topic, payload) => routerFn({ topic, payload, reason: 'plan_off' }, c.flow, c.global, node);
  const og = route('home/freezer/og_gefrierschrank/set', 'OFF');
  check('OG OFF -> Tasmota event poweroff', og && og.topic === 'tm/cmnd/OgSpGfr/event' && og.payload === 'poweroff' && og._reason === 'plan_off', j(og));
  const kg = route('home/freezer/kg_kuehltruhe/set', 'OFF');
  check('KG OFF -> KuehltruheAus PRESS_SHORT 1 (number)', kg && kg.topic === 'hm/set/KuehltruheAus/PRESS_SHORT' && kg.payload === 1, j(kg));
  const on = route('home/freezer/kg_kuehltruhe/set', 'ON');
  check('KG ON -> STATE true', on && on.topic === 'hm/set/HM-ES-PMSw1-Pl NEQ1809653:1/STATE' && on.payload === true, j(on));
  check('unknown freezer dropped with a warning', route('home/freezer/nope/set', 'OFF') === null && warns.some(w => /unknown freezer nope/.test(w)));
  check('other payloads dropped', route('home/freezer/kg_kuehltruhe/set', 'AUTO') === null);
}

// ---- 3b. fc_temp_parse + fc_state_update: measurement time, change tracking ----
console.log('\nReading age (parse + state update)');
{
  const parseFn = compile('fc_temp_parse'), suFn = compile('fc_state_update');
  const c = ctx({ freezers: {} });
  initFn({}, c.flow, c.global, node);
  const T0 = Date.now();
  const feed = (value, tst) => {
    const m = parseFn({ topic: 'sensor/status/temperature/og_speis/ht/4', payload: { value, tst } }, c.flow, c.global, node);
    return suFn(m, c.flow, c.global, node);
  };
  feed(-19.4, new Date(T0 - 30 * MIN).toISOString());
  let d = c.mem.v.freezers.og_gefrierschrank;
  check('age counts from payload tst (30 min old message)', Math.abs(d.last_temp_update - (T0 - 30 * MIN)) < 1000 && Math.abs(d.temp_changed_at - (T0 - 30 * MIN)) < 1000, j([d.last_temp_update - T0]));
  feed(-19.4, new Date(T0 + 3600e3).toISOString());
  d = c.mem.v.freezers.og_gefrierschrank;
  check('tst in the future -> arrival time; same value keeps temp_changed_at', Math.abs(d.last_temp_update - Date.now()) < 1000 && Math.abs(d.temp_changed_at - (T0 - 30 * MIN)) < 1000);
  feed(-19.3, 'garbage');
  d = c.mem.v.freezers.og_gefrierschrank;
  check('invalid tst -> arrival time; new value moves temp_changed_at', Math.abs(d.last_temp_update - Date.now()) < 1000 && Math.abs(d.temp_changed_at - Date.now()) < 1000);
}

// ---- 4. error fail-safe (fc_catch -> fc_failsafe_fn) ----
console.log('\nError fail-safe');
{
  const c = ctx({ freezers: {} });
  initFn({}, c.flow, c.global, node);
  const fsFn = compile('fc_failsafe_fn');
  const st = { status() {}, warn: m => warns.push(m) };
  const one = fsFn({ device_name: 'kg_kuehltruhe', error: { message: 'boom', source: { name: 'decide' } } }, c.flow, c.global, st)[0];
  check('error with device -> ON for that freezer only', one.length === 1 && one[0].topic === 'hm/set/HM-ES-PMSw1-Pl NEQ1809653:1/STATE' && one[0].payload === true, j(one));
  const all = fsFn({ error: { message: 'boom' } }, c.flow, c.global, st)[0];
  check('error without device -> ON for all freezers', j(all.map(m => m.topic + '=' + m.payload)) === j(['tm/cmnd/OgSpGfr/POWER=ON', 'hm/set/HM-ES-PMSw1-Pl NEQ1809653:1/STATE=true']), j(all));
  const cat = flows.find(n => n.id === 'fc_catch');
  const chain = ['fc_temp_parse', 'fc_pwr_parse', 'fc_state_update', 'fc_eval_fanout', 'fc_decide', 'fc_switch_router', 'fc_init_fn', 'fc_override_fn'];
  check('fc_catch covers the control chain and feeds the fail-safe', cat && chain.every(id => cat.scope.includes(id)) && cat.wires[0][0] === 'fc_failsafe_fn');
  const fsn = flows.find(n => n.id === 'fc_failsafe_fn');
  check('fail-safe publishes straight to the outlet mqtt out', fsn.wires[0].includes('fc_mqtt_out_switch'));
  // a decide that throws is caught by Node-RED -> fc_catch; check the real decide does throw on garbage state
  let threw = false;
  try { decide(ctx({ cfg: kitchenCfg(), freezers: { freezer_kitchen: { ...dev(), model: null, last_state_change_at: 0 } }, pp: { price24: price24(Date.now(), 8, () => 30) } }), { device_name: 'freezer_kitchen', trigger: 'tick' }); } catch (e) { threw = true; }
  check('null model does not throw (falls back to defaults)', !threw);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
