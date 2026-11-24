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
const dev = (extra = {}) => ({ name: 'freezer_kitchen', state: 'idle', override: 'AUTO', current_temp_c: -20, model: {}, ...extra });

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
{ // no temperature yet: keep the current state
  at(NOW);
  const c = ctx({ cfg: kitchenCfg(), freezers: { freezer_kitchen: dev({ state: 'cooling', current_temp_c: null }) }, pp: { price24: price24(NOW, 8, () => 30) } });
  const [, st] = decide(c, { device_name: 'freezer_kitchen', trigger: 'tick' });
  check('no reading -> keeps cooling', JSON.parse(st.payload).reason === 'no_reading' && JSON.parse(st.payload).state === 'cooling', st.payload);
}
{ // stale reading (sensor silent): fail-safe ON, even though the frozen value says "cold enough"
  at(NOW);
  const run = (extra, flowExtra = {}) => {
    const c = ctx({ cfg: kitchenCfg(), freezers: { freezer_kitchen: dev({ current_temp_c: -22, ...extra }) }, pp: { price24: price24(NOW, 8, () => 30) } });
    Object.assign(c.flow.v, flowExtra);
    const [sw, st] = decide(c, { device_name: 'freezer_kitchen', trigger: 'tick' });
    return { sw, st: JSON.parse(st.payload) };
  };
  const stale = run({ last_temp_update: NOW - 100 * MIN });
  check('reading 100 min old -> ON stale_reading', stale.st.reason === 'stale_reading' && stale.st.state === 'cooling' && stale.sw && stale.sw.payload === 'ON' && stale.st.temp_age_min === 100, j(stale));
  const fresh = run({ last_temp_update: NOW - 30 * MIN });
  check('counter: reading 30 min old -> plans (off)', fresh.st.reason === 'plan_off' && fresh.st.temp_age_min === 30, j(fresh.st.reason));
  const edge = run({ last_temp_update: NOW - 89 * MIN });
  check('reading 89 min old -> not stale yet', edge.st.reason !== 'stale_reading', edge.st.reason);
  const ovr = run({ last_temp_update: NOW - 100 * MIN, override: 'OFF' });
  check('override OFF beats stale', ovr.st.reason === 'override_off' && ovr.sw.payload === 'OFF', j(ovr.st.reason));
  const noTs = run({});
  check('reading without timestamp (tests, old state) -> not stale', noTs.st.reason === 'plan_off', noTs.st.reason);
  const off = run({ last_temp_update: NOW - 100 * MIN }, { config: kitchenCfg({ stale_temp_minutes: 0 }) });
  check('stale_temp_minutes 0 disables the guard', off.st.reason === 'plan_off', off.st.reason);
  const boot = run({ current_temp_c: null }, { started_at: NOW - 95 * MIN });
  check('no reading 95 min after start -> ON stale_reading', boot.st.reason === 'stale_reading' && boot.sw.payload === 'ON', j(boot.st.reason));
  const boot2 = run({ current_temp_c: null }, { started_at: NOW - 10 * MIN });
  check('counter: no reading 10 min after start -> no_reading', boot2.st.reason === 'no_reading', boot2.st.reason);
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
  check('init: stale_temp_minutes 90, started_at set', cfg.stale_temp_minutes === 90 && Math.abs(c.flow.v.started_at - Date.now()) < 5000, j([cfg.stale_temp_minutes, c.flow.v.started_at]));
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
