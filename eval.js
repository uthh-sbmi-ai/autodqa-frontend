// AutoDQA static console — the Evaluation view. Launches a batch of discovery
// sessions (one per table, per run, per condition) and monitors it, following the
// AutoDQA Evaluation Design doc.
//
// Two harnesses behind one monitor. RuntimeHarness runs the evaluation for real:
// it drives the deployed Runtime from this tab through the same invoke API the
// chat uses, so every model call goes through the Cloudflare AI Gateway like any
// other run. It covers what the Runtime can do today -- the reference condition
// and custom runs, per table or whole warehouse -- and the Runtime fixes the
// model, prompt, cap and tools. MockHarness plays a run in the browser with
// random numbers, for judging the design of the experiments the Runtime cannot run
// yet. The design's eventual harness runs server-side; both keep the event shapes
// described on MockHarness, so either can be replaced without touching the view.
//
// Loaded after app.js and reuses its globals ($, el, announce, CFG). Everything
// here sits in one function scope: a top-level name that collided with one of
// app.js's would be a SyntaxError, and this whole file would silently not run.
"use strict";

(() => {

// ---- View tabs --------------------------------------------------------------
// The ARIA tabs pattern with automatic activation: arrows move the selection and
// show the panel at once. That is safe because switching only hides the other
// view -- a chat run in flight keeps streaming into its hidden panel.
const tabs = [$("tabChat"), $("tabEval")];
const panels = tabs.map((t) => $(t.getAttribute("aria-controls")));
// HTML allows one <main> without `hidden`, so the inactive view's main carries it
// as well as its panel, and the skip link follows whichever is showing.
const mains = [$("main"), $("evMain")];

function selectTab(i, focus) {
  tabs.forEach((t, j) => {
    const on = i === j;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    panels[j].hidden = !on;
    mains[j].hidden = !on;
  });
  document.querySelector(".skip-link").setAttribute("href", "#" + mains[i].id);
  if (focus) tabs[i].focus();
}

tabs.forEach((t, i) => {
  t.addEventListener("click", () => selectTab(i));
  t.addEventListener("keydown", (e) => {
    const last = tabs.length - 1;
    const to = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1,
                 Home: 0, End: last }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    selectTab(to, true);
  });
});
selectTab(0);
$("viewTabs").hidden = false;

// ---- The design's fixed points ------------------------------------------------
// Every populated CDM table in the synthetic warehouse -- all of them, always, and
// nothing in this view tells them apart. Which tables hold planted defects is
// answer-key information and stays in the registry, which is also why there are
// no per-table defect counts anywhere here.
const TABLES = ["DEMOGRAPHIC", "ENROLLMENT", "ENCOUNTER", "DIAGNOSIS", "PROCEDURES",
  "VITAL", "DISPENSING", "LAB_RESULT_CM", "CONDITION", "PRESCRIBING", "DEATH",
  "MED_ADMIN", "PROVIDER", "OBS_CLIN", "IMMUNIZATION", "LDS_ADDRESS_HISTORY", "HARVEST"];
const STEP_LIMIT = 250;        // per session and per investigation (AUTODQA_STEP_LIMIT)

// The anchor for every comparison. Each experiment changes one thing from it.
const REFERENCE = { model: "us.anthropic.claude-sonnet-5-5", prompt: "K1", cap: 10, tools: "all",
                    workflow: "per_table", investigate: true, known_issues: "clean-baseline" };
const REF_RUNS = 3;
const REF_PARALLEL = 8;

const AXIS_NAMES = { model: "model", prompt: "prompt", cap: "issue cap", tools: "tools", workflow: "workflow" };

// What a live run can change. A request sets the model, prompt variant and cap, so
// E3 and E5 go live; the other experiments vary something the deployed Runtime
// holds fixed, or (E2's synthesis and chained workflows) need a harness that is
// not built.
const LIVE_PRESETS = new Set(["ref", "E3", "E5", "custom"]);
// Tools, workflow, investigation and the known-issues list are not on the form:
// every live session has all tools, works on one table and is shown the list, and
// every run pauses after discovery for a pick.

// Mean cost of a Sonnet 4.5 discovery session, and of investigating one flag, as
// measured on ev-1 (2026-10-19, Runtime v22, prompt caching on) from the
// Cloudflare log's per-call cost: 15 completed sessions, 138 flags. Rough by
// nature, and only for that model and per-table sessions: a whole-warehouse
// session has never been measured.
const COST = { model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", discovery: 0.80, perFlag: 0.42 };

// One entry per experiment in the design doc. `axis` is the setting it varies and
// `conds` its conditions as [value, short label, long label, ticked by default];
// `set` is anything else it moves off the reference. E1 and C vary the model over
// the free-text list instead of a fixed set.
const PRESETS = {
  ref: {},
  E1: { axis: "model", set: { investigate: true },
        help: "Detection and attribution against cost, by model. Every flag is investigated: pick all " +
              "of them at the pause. Scored on test and holdout, all five credit levels." },
  E2: { axis: "workflow",
        conds: [["whole", "Whole warehouse", "One whole-warehouse session", true],
                ["per_table", "Per table", "Per table, independent", true],
                ["synthesis", "Per table + synthesis", "Per table, plus a synthesis pass", true],
                ["chained", "Chained", "Per table, chained with carryover", true]],
        help: "Does the workflow matter? Scored on test, detection (levels 1–2)." },
  E3: { axis: "prompt",
        conds: [["K0", "K0", "K0 · dimension definitions only", true],
                ["K1", "K1", "K1 · plus the Kahn block", true]],
        help: "Does the Kahn prompt matter? Scored on test, detection." },
  E4: { axis: "tools", set: { investigate: true },
        conds: [["all", "All tools", "All tools (E1's reference-model runs can stand in)", false],
                ["no_valuesets", "No get_valuesets", "No get_valuesets", true],
                ["no_etl", "No ETL tools", "Investigation without ETL tools", true]],
        help: "Do the tools matter? Scored on test: detection for valuesets, levels 3–5 for ETL access." },
  E5: { axis: "cap",
        conds: [["10", "Cap 10", "Cap 10 per session", true],
                ["20", "Cap 20", "Cap 20 per session", true]],
        help: "Does the cap bind? Scored on test, recall@k." },
  C:  { axis: "model", set: { snapshot: "clean" }, runs: 1,
        help: "What does the clean warehouse raise? Every E1 model once, on the clean set: " +
              "the pre-existing catalogue and the false-positive rate." },
  custom: { help: "Any combination, run as a single condition. Where it departs from the " +
                  "reference is listed under the form." },
};

const STATUS = { resetting: "Resetting warehouse", running: "Running",
                 awaiting_selection: "Paused for a pick", investigating: "Investigating",
                 awaiting_scoring: "Awaiting scoring", stopped: "Stopped" };
// While a live run is in one of these, closing the tab loses it.
const LIVE_STATUSES = ["running", "awaiting_selection", "investigating"];
const ROW_NAMES = { "*": "All tables (one session)", "+": "Synthesis pass" };
// The glyph repeats the state; the state is always also spelled out. Shapes are
// from the ones every system font carries -- quarter and half circles are not.
const GLYPH = { queued: "○", discovery: "►", investigating: "◆", done: "●",
                step_limit: "▲", error: "✕", cancelled: "–" };
const ENDED = ["done", "step_limit", "error", "cancelled"];

const fmt = (n) => n.toLocaleString("en-US");
const usd = (x) => "$" + (x < 100 ? x.toFixed(2) : fmt(Math.round(x)));
const plural = (n, word, many = word + "s") => `${fmt(n)} ${n === 1 ? word : many}`;
const sum = (list, k) => list.reduce((a, s) => a + s[k], 0);
const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const setRadio = (name, v) => document.querySelectorAll(`input[name="${name}"]`)
  .forEach((r) => { r.checked = r.value === String(v); });

function clock(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// "us.anthropic.claude-sonnet-4-5-20250929-v1:0" -> "claude-sonnet-4-5". The
// region, vendor, date stamp and version are what pin a run, not what a reader
// compares on; the full ID stays in the form and in the run's settings.
function shortModel(id) {
  return id.replace(/^(us|eu|apac|global)\./, "").replace(/^[a-z]+\./, "")
           .replace(/-\d{8}/, "").replace(/-v\d+(:\d+)?$/, "") || id;
}

// A model's name as the dropdown gives it ("Claude Sonnet 5.5"), or shortModel's
// for an ID it does not offer.
const modelOpt = (id) => [...$("evModel").options].find((o) => o.value === id);
const modelName = (id) => modelOpt(id)?.textContent || shortModel(id);

// ---- Sign-in gate -------------------------------------------------------------
// The same gate as the chat's task form (setComposerShown in app.js): hidden and
// inert until sign-in, with a line saying what to do instead.
function setEvalFormShown(on) {
  $("evForm").hidden = !on;
  $("evForm").inert = !on;
  $("evSignin").hidden = on;
}
document.addEventListener("autodqa:signedin", () => {
  setEvalFormShown(true);
  if (!$("evalBody").hidden) $("evPreset").focus();
});

// ---- Launch form --------------------------------------------------------------
const grid = $("evTableGrid");
for (const t of TABLES) {
  const lab = el("label");
  const cb = el("input");
  cb.type = "checkbox";
  cb.value = t;
  cb.checked = true;
  lab.append(cb, el("span", null, t));
  grid.appendChild(lab);
}
const tableBoxes = [...grid.querySelectorAll("input")];

$("evTablesAll").addEventListener("click", () => {
  const all = tableBoxes.every((c) => c.checked);
  tableBoxes.forEach((c) => { c.checked = !all; });
  refresh();
});

let preset = "ref";
// Every run goes to the deployed Runtime. The simulated harness below is not
// reachable from the form; `mode` stays in the results so files compare.
const mode = "live";

// The console cannot pick what the Runtime cannot run, so the presets it lacks are
// disabled (and say why in their text), and the settings the Runtime fixes are
// shown instead of offered.
const presetOpts = [...$("evPreset").options];
for (const o of presetOpts) {
  o.dataset.text = o.textContent;
  if (o.disabled || LIVE_PRESETS.has(o.value)) continue;
  o.disabled = true;
  o.textContent += " (not live yet)";
}

// Which control each setting shows: its own, or the Conditions box when the
// experiment varies it.
function syncFields() {
  const axis = PRESETS[preset].axis;
  document.querySelectorAll(".ev-field[data-axis]").forEach((f) => {
    const varied = f.dataset.axis === axis;
    f.querySelector(".ev-ctl").hidden = varied;
    f.querySelector(".ev-varied").hidden = !varied;
  });
}

// An experiment fills the whole form from the reference, then moves what it
// moves. Tables, parallelism and the tag are left as they were: they say how to
// run, not what is being compared.
function applyPreset(key) {
  preset = key;
  const p = PRESETS[key];
  const s = { ...REFERENCE, ...p.set };
  $("evModel").value = s.model;
  setRadio("evPrompt", s.prompt);
  setRadio("evCap", s.cap);
  $("evRunCount").value = p.runs || REF_RUNS;
  $("evPresetHelp").textContent = p.help || "";
  $("evPresetHelp").hidden = !p.help;

  syncFields();
  $("evConds").hidden = !p.axis;
  $("evModelsField").hidden = p.axis !== "model";
  $("evCondsLegend").textContent = p.axis ? `Conditions · ${AXIS_NAMES[p.axis]}` : "Conditions";
  const list = $("evCondList");
  list.replaceChildren();
  for (const [value, short, long, on] of p.conds || []) {
    const lab = el("label");
    const cb = el("input");
    cb.type = "checkbox";
    cb.value = value;
    cb.checked = on;
    cb.dataset.short = short;
    lab.append(cb, el("span", null, long));
    list.appendChild(lab);
  }
  refresh();
}

const modelLines = () => [...new Set($("evModels").value.split("\n").map((l) => l.trim()).filter(Boolean))];

function readForm() {
  const base = {
    model: $("evModel").value, prompt: radio("evPrompt"), cap: Number(radio("evCap")),
    tools: REFERENCE.tools, workflow: REFERENCE.workflow, investigate: REFERENCE.investigate,
    known_issues: REFERENCE.known_issues,
  };
  const p = PRESETS[preset];
  let conds;
  if (!p.axis) {
    conds = [{ label: preset === "ref" ? "Reference" : "Custom", settings: base }];
  } else if (p.axis === "model") {
    conds = modelLines().map((m) => ({ label: modelName(m), settings: { ...base, model: m } }));
  } else {
    conds = [...$("evCondList").querySelectorAll("input:checked")].map((cb) => ({
      label: cb.dataset.short,
      settings: { ...base, [p.axis]: p.axis === "cap" ? Number(cb.value) : cb.value },
    }));
  }
  return {
    mode, preset, base, conds,
    tables: tableBoxes.filter((c) => c.checked).map((c) => c.value),
    runs: Number($("evRunCount").value),
    parallel: Number($("evParallel").value),
  };
}

function problems(f) {
  const p = PRESETS[f.preset];
  // The option is disabled, so this only catches a stale form.
  if (f.mode === "live" && !LIVE_PRESETS.has(f.preset)) {
    return "This experiment cannot run on the deployed Runtime yet.";
  }
  if (!f.conds.length) return p.axis === "model" ? "List at least one model ID." : "Tick at least one condition.";
  // Only the models the dropdown offers: the Runtime refuses any other. (E1's
  // free-text list is where another one could come from.)
  const unknown = f.conds.map((c) => c.settings.model).find((m) => !modelOpt(m));
  if (unknown !== undefined) return `“${unknown || "(blank)"}” is not one of the models the Runtime offers.`;
  if (f.conds.some((c) => c.settings.tools === "no_etl" && !c.settings.investigate)) {
    return "Investigation without ETL tools only changes anything with the investigation phase on.";
  }
  if (!f.tables.length) return "Select at least one table.";
  if (!Number.isInteger(f.runs) || f.runs < 1 || f.runs > 10) return "Runs per condition must be a whole number from 1 to 10.";
  if (!Number.isInteger(f.parallel) || f.parallel < 1 || f.parallel > 32) {
    return "Sessions in parallel must be a whole number from 1 to 32.";
  }
  return "";
}

// The run's size before it starts: sessions, the most flags they can raise, and
// the most investigations a pick of all of them could start -- investigation is
// what drives cost.
function scale(f) {
  let sessions = 0, flags = 0, invest = 0;
  for (const { settings: s } of f.conds) {
    const perRun = s.workflow === "whole" ? 1 : f.tables.length + (s.workflow === "synthesis" ? 1 : 0);
    // The synthesis pass is counted at the session cap; whether it gets its own
    // is an open question in the design.
    sessions += perRun * f.runs;
    flags += perRun * s.cap * f.runs;
    if (s.investigate) invest += perRun * s.cap * f.runs;
  }
  return { sessions, flags, invest };
}

// From COST, so only when every condition is that model, per table.
function estimate(f) {
  if (!f.conds.every((c) => c.settings.model === COST.model && c.settings.workflow === "per_table")) return null;
  const { sessions, invest } = scale(f);
  return { discovery: sessions * COST.discovery, inv: invest * COST.perFlag };
}

function refresh() {
  const n = tableBoxes.filter((c) => c.checked).length;
  $("evTablesCount").textContent = `${n} of ${TABLES.length}`;
  $("evTablesAll").textContent = n === TABLES.length ? "Clear all" : "Select all";
  // Re-check a standing error as the user fixes it; do not raise new ones mid-edit.
  if ($("evErr").textContent) $("evErr").textContent = problems(readForm());
}

$("evPreset").addEventListener("change", () => applyPreset($("evPreset").value));
$("evForm").addEventListener("input", (e) => { if (e.target.id !== "evPreset") refresh(); });
$("evForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = readForm();
  const err = problems(f);
  $("evErr").textContent = err;
  if (!err && (f.mode !== "live" || confirmLive(f))) launch(f);
});

// One of the two steps that spend money, so it asks first; the pick asks again
// before investigating (confirmRound). A native dialog: it takes focus, traps it,
// and is announced, with nothing to build.
function confirmLive(f) {
  const { sessions, invest } = scale(f);
  const cost = estimate(f);
  const money = !cost ? "Each session is billed; there is no measured cost for this configuration yet."
    : `Rough cost of discovery: about ${usd(cost.discovery)}.`;
  const pause = invest ? "\n\nThe run pauses when discovery is over. Nothing is investigated until you pick " +
                         "flags and confirm their cost." : "";
  return window.confirm(
    `Launch a live evaluation?\n\n${plural(sessions, "discovery session")} on the deployed Runtime, ` +
    `up to ${f.parallel} at a time, each billed through the Cloudflare AI Gateway. ${money}${pause}\n\n` +
    "Keep this tab open until it ends: the tab is what drives the run, and closing it stops it.");
}

// What investigating one flag costs, from COST: only when every condition is that model.
const flagCost = (ev) => (ev.conds.every((c) => c.settings.model === COST.model) ? COST.perFlag : null);

function confirmRound(ev, k) {
  const per = flagCost(ev);
  return window.confirm(
    `Investigate ${plural(k, "flag")} on the deployed Runtime?\n\nEach one is its own conversation, ` +
    `up to ${ev.f.parallel} at a time, billed through the Cloudflare AI Gateway. ` +
    (per ? `Rough cost: about ${usd(k * per)}.` : "There is no measured cost for this model yet.") +
    "\n\nKeep this tab open until the round ends.");
}

$("evModels").value = REFERENCE.model;
$("evParallel").value = REF_PARALLEL;
applyPreset("ref");
setEvalFormShown(false);

// ---- Evaluations ----------------------------------------------------------------
// Held in memory only, like the chat. Where runs live durably -- so a monitor can
// reattach after a reload -- is a question for the server-side harness; until
// then a live run's results leave this tab only by being downloaded.
const evals = [];
const listBtns = new Map();   // evaluation -> its button in the list
let shown = null;             // the evaluation on screen
let view = null;              // its DOM handles, rebuilt whenever `shown` changes

function launch(f) {
  const ev = {
    id: `ev-${evals.length + 1}`, mode: f.mode, preset: f.preset, f,
    title: presetOpts.find((o) => o.value === f.preset).dataset.text,
    short: f.preset === "ref" ? "Reference" : f.preset === "custom" ? "Custom" : f.preset,
    conds: f.conds.map((c, i) => ({ ...c, key: "c" + i })),
    status: f.mode === "live" ? "running" : "resetting", started: Date.now(), ended: null,
    units: [], sessions: new Map(), log: [],
    // The pause between the phases: each round of investigation the user started
    // ({ at, offered, picks: [{ key, n }] }), the ticks not yet submitted (as
    // "key#n"), and the time spent waiting, which the elapsed clock leaves out.
    rounds: [], pick: new Set(), pausedAt: null, pausedMs: 0,
  };
  // One unit per discovery session the plan needs, keyed cond|run|table, with "*"
  // for a whole-warehouse session and "+" for a run's synthesis pass. `after`
  // holds what must end first: the previous table in a chain, or every table of
  // the run for its synthesis pass.
  for (const c of ev.conds) {
    const w = c.settings.workflow;
    for (let r = 1; r <= f.runs; r++) {
      let prev = null;
      for (const t of w === "whole" ? ["*"] : f.tables) {
        const key = `${c.key}|${r}|${t}`;
        ev.units.push({ key, cond: c.key, run: r, table: t, kind: t === "*" ? "whole" : "table",
                        after: w === "chained" && prev ? [prev] : [] });
        prev = key;
      }
      if (w === "synthesis") {
        ev.units.push({ key: `${c.key}|${r}|+`, cond: c.key, run: r, table: "+", kind: "synthesis",
                        after: f.tables.map((t) => `${c.key}|${r}|${t}`) });
      }
    }
  }
  for (const u of ev.units) {
    ev.sessions.set(u.key, { ...u, state: "queued", result: null, steps: 0, turns: 0, tools: 0, flags: 0,
                             invDone: 0, invTotal: 0, invLimit: 0, id: null, started: null, ended: null });
  }
  evals.push(ev);

  let ul = $("evList");
  if (!ul) {
    ul = el("ul", "ev-runs");
    ul.id = "evList";
    ul.setAttribute("aria-label", "Evaluations launched in this tab");
    $("evIntro").before(ul);
  }
  const li = el("li");
  const b = el("button");
  b.type = "button";
  b.addEventListener("click", () => show(ev));
  li.appendChild(b);
  ul.appendChild(li);
  listBtns.set(ev, b);

  const conds = Object.fromEntries(ev.conds.map((c) => [c.key, { label: c.label, ...c.settings }]));
  const harness = f.mode === "live" ? RuntimeHarness : MockHarness;
  ev.handle = harness({ units: ev.units, parallel: f.parallel, conds, tables: f.tables },
                      (e) => onHarnessEvent(ev, e));
  $("evIntro").hidden = true;
  show(ev);
  announce(`Evaluation ${ev.id} launched: ${plural(ev.units.length, "discovery session")}.`);
  view.title.focus();
}

function onHarnessEvent(ev, e) {
  if (e.type === "status") {
    const now = Date.now();
    if (ev.pausedAt) {
      ev.pausedMs += now - ev.pausedAt;
      ev.pausedAt = null;
    }
    ev.status = e.status;
    if (e.status === "awaiting_scoring" || e.status === "stopped") ev.ended = now;
    if (e.status === "awaiting_selection") {
      ev.pausedAt = now;
      announce(`Evaluation ${ev.id} paused. ${plural(ev.handle.flags().length, "flag")} ` +
               "can be picked for investigation.");
    }
    if (e.status === "awaiting_scoring") {
      announce(`Evaluation ${ev.id} finished. ${plural(sum([...ev.sessions.values()], "flags"), "flag")} await scoring.`);
    }
    if (e.status === "stopped") announce(`Evaluation ${ev.id} stopped.`);
    syncList();
  } else if (e.type === "session") {
    const { type, ...counters } = e;
    Object.assign(ev.sessions.get(e.key), counters);
  } else if (e.type === "log") {
    ev.log.push({ t: new Date(), text: e.text, bad: !!e.bad });
  }
  if (ev === shown) queueRender();
}

function syncList() {
  for (const [ev, b] of listBtns) {
    b.textContent = `${ev.id} · ${ev.short}${ev.mode === "live" ? "" : " (simulated)"} · ${STATUS[ev.status].toLowerCase()}`;
    b.setAttribute("aria-current", String(ev === shown));
  }
}

// ---- Monitor ------------------------------------------------------------------
// Built once per evaluation on show; render() then updates it in place, so a
// focused button keeps its focus while the counters move.
function show(ev) {
  shown = ev;
  const root = $("evMonitor");
  root.hidden = false;
  root.replaceChildren();
  view = { ev, cond: ev.conds[0].key, cells: new Map(), rowTotals: new Map(), selected: null, logCount: 0 };

  const head = el("div", "ev-runhead");
  view.head = head;
  view.title = el("h3");
  view.title.tabIndex = -1;     // focus target after launch
  view.title.append(ev.title + " ", el("span", "rid", ev.id));
  view.status = el("span", "pill");
  view.elapsed = el("span", "ev-elapsed");
  view.stop = el("button", "ev-stop", "Stop evaluation");
  view.stop.type = "button";
  view.stop.addEventListener("click", () => ev.handle.stop());
  head.append(view.title, view.status, view.elapsed, view.stop);
  root.append(head);

  // A live run's findings exist nowhere else once its sessions are purged -- the
  // Runtime keeps a conversation only in its microVM's memory -- so they can be
  // saved at any point, partial or not.
  if (ev.mode === "live") {
    const bar = el("div", "ev-resultsbar");
    const note = el("p", null, "Results exist only in this tab until you download them. The file holds every " +
                               "flag and transcript in full, unredacted, for the scorer.");
    note.id = `${ev.id}-dlnote`;
    const dl = el("button", "ev-dl", "Download results (JSON)");
    dl.type = "button";
    dl.setAttribute("aria-describedby", note.id);
    dl.addEventListener("click", () => downloadResults(ev));
    bar.append(note, dl);
    root.appendChild(bar);
  }

  // One bar per phase the plan has. Investigation's total is not known up front --
  // it is however many flags the user picks -- so its bar starts at each pick.
  const prog = el("div", "ev-progress");
  view.bars = {};
  const phases = [["disc", "Discovery"]];
  if (ev.units.some((u) => u.kind === "synthesis")) phases.push(["synth", "Synthesis"]);
  if (ev.conds.some((c) => c.settings.investigate)) phases.push(["inv", "Investigation"]);
  for (const [k, label] of phases) {
    const lab = el("span", null, label);
    lab.id = `${ev.id}-${k}`;
    const bar = el("progress");
    bar.setAttribute("aria-labelledby", lab.id);
    const txt = el("span", "cnt");
    prog.append(lab, bar, txt);
    view.bars[k] = { bar, txt };
  }
  root.appendChild(prog);

  // Where the run waits between its phases, filled by syncPick.
  if (view.bars.inv) {
    view.pick = el("section", "ev-pick");
    view.pick.hidden = true;
    view.pickKey = null;
    root.appendChild(view.pick);
  }

  const dl = el("dl", "ev-totals");
  view.tot = {};
  for (const [k, label] of [["sessions", "Sessions complete"], ["flags", "Flags raised"], ["inv", "Investigations"],
                            ["turns", "Model turns"]]) {
    const d = el("div");
    view.tot[k] = el("dd");
    d.append(el("dt", null, label), view.tot[k]);
    dl.appendChild(d);
  }
  root.appendChild(dl);

  if (ev.conds.length > 1) root.appendChild(condTable(ev));
  view.gridWrap = el("div", "ev-matrixwrap");
  root.appendChild(view.gridWrap);
  buildGrid();

  const lower = el("div", "ev-lower");
  const left = el("div"), right = el("div");
  const logSec = el("section");
  const logHead = el("h4", null, "Activity");
  logHead.id = `${ev.id}-log`;
  // Not a live region: it would read out every session as it ends. Milestones go
  // through announce() instead. tabindex so it can be scrolled from the keyboard.
  view.log = el("div", "ev-logbox");
  view.log.tabIndex = 0;
  view.log.setAttribute("role", "region");
  view.log.setAttribute("aria-labelledby", logHead.id);
  logSec.append(logHead, view.log);
  left.appendChild(logSec);
  const detSec = el("section");
  view.detail = el("div", "ev-box");
  detSec.append(el("h4", null, "Session"), view.detail);
  const scoreSec = el("section");
  scoreSec.append(el("h4", null, "Scoring"), scoringBox(ev));
  right.append(detSec, scoreSec);
  lower.append(left, right);
  root.appendChild(lower);

  syncList();
  render();
}

// With several conditions, one summary row each; its button picks which one the
// session grid below shows.
function condTable(ev) {
  const wrap = el("div", "ev-matrixwrap");
  const t = el("table", "ev-matrix");
  t.appendChild(el("caption", null, "Conditions. Pick one to show its sessions in the grid below."));
  const hr = el("tr");
  // No Investigated column when nothing is investigated: it would be all dashes.
  const heads = ev.conds.some((c) => c.settings.investigate)
    ? ["Condition", "Discovery", "Flags", "Investigated", "Problems"] : ["Condition", "Discovery", "Flags", "Problems"];
  for (const h of heads) {
    const th = el("th", h === "Condition" ? null : "num", h);
    th.scope = "col";
    hr.appendChild(th);
  }
  const thead = el("thead");
  thead.appendChild(hr);
  const tb = el("tbody");
  view.condRows = new Map();
  for (const c of ev.conds) {
    const tr = el("tr");
    const th = el("th");
    th.scope = "row";
    const b = el("button", "ev-condbtn", c.label);
    b.type = "button";
    b.addEventListener("click", () => { view.cond = c.key; buildGrid(); render(); });
    th.appendChild(b);
    const tds = heads.slice(1).map(() => el("td", "num"));
    tr.append(th, ...tds);
    tb.appendChild(tr);
    view.condRows.set(c.key, { b, tds });
  }
  t.append(thead, tb);
  wrap.appendChild(t);
  return wrap;
}

// Rows are tables (or the one whole-warehouse session, plus a run's synthesis
// pass), columns are runs. Rebuilt only when the condition on show changes.
function buildGrid() {
  const ev = view.ev, c = ev.conds.find((x) => x.key === view.cond);
  view.cells.clear();
  view.rowTotals.clear();
  const t = el("table", "ev-matrix");
  t.appendChild(el("caption", null, `Sessions${ev.conds.length > 1 ? " · " + c.label : ""}. ` +
                                    "Rows are tables, columns are runs; pick a cell for its counters."));
  const hr = el("tr");
  const heads = ["Table", ...Array.from({ length: ev.f.runs }, (_, i) => `Run ${i + 1}`), "Flags"];
  heads.forEach((h, i) => {
    const th = el("th", i === heads.length - 1 ? "num" : null, h);
    th.scope = "col";
    hr.appendChild(th);
  });
  const thead = el("thead");
  thead.appendChild(hr);
  const tb = el("tbody");
  for (const table of new Set(ev.units.filter((u) => u.cond === c.key).map((u) => u.table))) {
    const tr = el("tr");
    const th = el("th", null, ROW_NAMES[table] || table);
    th.scope = "row";
    tr.appendChild(th);
    for (let r = 1; r <= ev.f.runs; r++) {
      const key = `${c.key}|${r}|${table}`;
      const td = el("td");
      const b = el("button", "ev-cell");
      b.type = "button";
      const sym = el("span", "sym");
      sym.setAttribute("aria-hidden", "true");
      b.append(sym, el("span"));
      b.addEventListener("click", () => { view.selected = key; render(); });
      td.appendChild(b);
      tr.appendChild(td);
      view.cells.set(key, b);
    }
    const tot = el("td", "num");
    tr.appendChild(tot);
    view.rowTotals.set(table, tot);
    tb.appendChild(tr);
  }
  t.append(thead, tb);
  view.gridWrap.replaceChildren(t);
}

// The scorer's output, laid out ahead of the scorer: every value is a dash until
// it exists. Nothing here is estimated from the live counters -- a flag count is
// not a detection, and showing one as recall would be inventing a result.
function scoringBox(ev) {
  const box = el("div", "ev-box");
  const dl = el("dl");
  const rows = [["Recall, level 1", "—"], ["Levels 2–5", "— · — · — · —"],
                ["Precision", "—"], ["F2", "—"], ["False positives per run", "—"],
                ["Pre-existing flags", "—"], ["Recall@k", "—"], ["Cost per run", "—"]];
  for (const [k, v] of rows) dl.append(el("dt", null, k), el("dd", null, v));
  box.append(dl, el("p", "foot",
    "The scorer is not built yet. Until the freeze it reports the dev split (15 defects) only, " +
    "and transcripts show any flag that matches a test defect as “[held-out match]”."));
  return box;
}

function stateText(s) {
  switch (s.state) {
    // Turns, not graph steps: the Runtime reports each model turn as it lands,
    // and a turn plus its tool calls is about two of the 250 steps.
    case "discovery": return `discovery · ${plural(s.turns, "turn")}`;
    case "investigating": return `investigating ${s.invDone}/${s.invTotal}`;
    case "step_limit": return "step limit";
    case "error": return "failed";
    default: return s.state;      // queued, done, cancelled
  }
}

function cellText(s) {
  const t = stateText(s);
  if (s.state === "queued" || (s.state === "cancelled" && !s.flags)) return t;
  const inv = s.invTotal && s.state !== "investigating" ? ` · ${s.invDone}/${s.invTotal} investigated` : "";
  return `${t} · ${plural(s.flags, "flag")}${inv}`;
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}
// The elapsed clocks tick on their own while a run is live.
setInterval(() => { if (view && !view.ev.ended) queueRender(); }, 1000);

function render() {
  if (!view) return;
  const ev = view.ev;
  view.head.className = "ev-runhead r-" + ev.status;
  view.status.textContent = STATUS[ev.status];
  // Stopping discovery ends the run; stopping a round of investigation only ends
  // the round, and the run pauses for another pick.
  view.stop.hidden = !["resetting", "running", "investigating"].includes(ev.status);
  view.stop.textContent = ev.status === "investigating" ? "Stop investigating" : "Stop evaluation";
  view.elapsed.textContent = clock((ev.ended || ev.pausedAt || Date.now()) - ev.started - ev.pausedMs);

  const all = [...ev.sessions.values()];
  const past = (s) => s.state !== "queued" && s.state !== "discovery";
  const investigates = (s) => ev.conds.find((c) => c.key === s.cond).settings.investigate;
  const disc = all.filter((s) => s.kind !== "synthesis"), syn = all.filter((s) => s.kind === "synthesis");
  const inv = all.filter(investigates);
  const invDone = sum(inv, "invDone"), invTotal = sum(inv, "invTotal");

  const bar = (k, done, total, unit, units) => {
    if (!view.bars[k]) return;
    view.bars[k].bar.max = Math.max(total, 1);
    view.bars[k].bar.value = done;
    view.bars[k].txt.textContent = `${fmt(done)} / ${plural(total, unit, units)}`;
  };
  bar("disc", disc.filter(past).length, disc.length, "session");
  bar("synth", syn.filter(past).length, syn.length, "pass", "passes");
  if (ev.rounds.length) bar("inv", invDone, invTotal, "picked flag");
  else if (view.bars.inv) {
    view.bars.inv.bar.value = 0;
    view.bars.inv.txt.textContent = ev.status === "awaiting_selection" ? "waiting for your pick"
      : ev.ended ? "none picked" : "starts with your pick";
  }
  syncPick();

  // A session whose flags are being investigated has finished its discovery.
  const ended = all.filter((s) => ENDED.includes(s.state) || s.state === "investigating").length;
  view.tot.sessions.textContent = `${fmt(ended)} / ${fmt(all.length)}`;
  view.tot.flags.textContent = fmt(sum(all, "flags"));
  if (inv.length) view.tot.inv.textContent = `${fmt(invDone)} / ${fmt(invTotal)}`;
  else {
    view.tot.inv.className = "small";
    view.tot.inv.textContent = "none (detection only)";
  }
  view.tot.turns.textContent = fmt(sum(all, "turns"));

  if (view.condRows) {
    for (const [key, { b, tds }] of view.condRows) {
      const mine = all.filter((s) => s.cond === key);
      const d = mine.filter((s) => s.kind !== "synthesis");
      const cols = [`${d.filter(past).length} / ${d.length}`, fmt(sum(mine, "flags"))];
      if (tds.length === 4) cols.push(investigates(mine[0]) ? `${sum(mine, "invDone")} / ${sum(mine, "invTotal")}` : "—");
      cols.push(fmt(mine.filter((s) => s.result === "step_limit" || s.result === "error").length));
      cols.forEach((v, i) => { tds[i].textContent = v; });
      b.setAttribute("aria-current", String(key === view.cond));
    }
  }

  for (const [key, b] of view.cells) {
    const s = ev.sessions.get(key);
    b.className = `ev-cell st-${s.state}`;
    b.firstChild.textContent = GLYPH[s.state];
    b.lastChild.textContent = cellText(s);
    b.setAttribute("aria-current", String(key === view.selected));
  }
  for (const [table, td] of view.rowTotals) {
    td.textContent = fmt(sum(all.filter((s) => s.cond === view.cond && s.table === table), "flags"));
  }

  // Append only what is new, and follow the tail only if the reader is already there.
  const box = view.log;
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
  for (const { t, text, bad } of ev.log.slice(view.logCount)) {
    const p = el("p", bad ? "bad" : null);
    const time = el("time", null, t.toLocaleTimeString("en-US", { hour12: false }));
    time.dateTime = t.toISOString();
    p.append(time, text);
    box.appendChild(p);
  }
  view.logCount = ev.log.length;
  if (atEnd) box.scrollTop = box.scrollHeight;

  renderDetail();
}

function renderDetail() {
  const box = view.detail;
  const s = view.selected && view.ev.sessions.get(view.selected);
  if (!s) {
    if (!box.firstChild) box.appendChild(el("p", "empty", "Pick a cell in the session grid to see its counters."));
    return;
  }
  const c = view.ev.conds.find((x) => x.key === s.cond);
  const dl = el("dl");
  const row = (k, v, cls) => dl.append(el("dt", null, k), el("dd", cls, v));
  row("Session", `${ROW_NAMES[s.table] || s.table} · run ${s.run}`);
  if (view.ev.conds.length > 1) row("Condition", c.label);
  row("State", stateText(s));
  if (s.why) row("Why", s.why);
  (s.warnings || []).forEach((w, i) => row(i ? "" : "Warnings", w));
  row("Flags", fmt(s.flags));
  if (c.settings.investigate) {
    row("Investigated", `${s.invDone} / ${s.invTotal}` + (s.invLimit ? ` (${s.invLimit} at the step limit)` : ""));
  }
  row("Model turns", fmt(s.turns));
  row("Tool calls", fmt(s.tools));
  row("Discovery time", s.started ? clock((s.ended || Date.now()) - s.started) : "—");
  row("Session ID", s.id || "assigned when it starts", s.id ? "mono" : null);
  box.replaceChildren(dl, el("p", "foot",
    "Turns and tool calls include the session's investigations. " + (view.ev.mode === "live"
      ? "Flag text and the transcript are in the downloaded results, not shown here."
      : "The transcript opens after scoring, with any match to a held-out defect redacted.")));
}

// ---- The pick -----------------------------------------------------------------
// When discovery is over, a run that investigates pauses here, and again after
// every round of investigation while flags are left. Like the chat's issue panel:
// tick the flags worth a root cause, then start them; the rest stay open for a
// later round, until Finish ends the run. The list sits behind a disclosure, so
// Select all can send every flag without anyone reading one -- E1 and E4 want
// attribution that no one's choice has shaped, and the list shows flag text
// unredacted.
const fid = (f) => `${f.key}#${f.n}`;

// Rebuilt only when what the box should show changes, not on every render: the
// ticks and an open disclosure have to survive the one-second clock.
function syncPick() {
  const ev = view.ev, box = view.pick;
  if (!box) return;
  const key = ev.status === "awaiting_selection" ? `pick|${ev.rounds.length}`
    : ev.rounds.length || ev.ended ? `sum|${ev.status}|${ev.rounds.length}` : null;
  if (key === view.pickKey) return;
  // Focus inside the box would fall to the page as it is rebuilt; keep it here.
  const hadFocus = box.contains(document.activeElement);
  view.pickKey = key;
  box.hidden = !key;
  view.pickHead = null;
  if (!key) box.replaceChildren();
  else if (key.startsWith("pick")) buildPick();
  else buildSummary();
  if (hadFocus) view.pickHead?.focus();
}

function pickHead(text) {
  const h = el("h4", null, text);
  h.id = `${view.ev.id}-pick`;
  h.tabIndex = -1;              // focus target once the buttons that had it are gone
  view.pick.setAttribute("aria-labelledby", h.id);
  view.pickHead = h;
  return h;
}

function buildPick() {
  const ev = view.ev, box = view.pick;
  const flags = ev.handle.flags();
  const open = new Set(flags.map(fid));
  for (const id of ev.pick) if (!open.has(id)) ev.pick.delete(id);
  const round = ev.rounds.length;
  const per = flagCost(ev);
  const groups = new Map();
  for (const f of flags) {
    if (!groups.has(f.key)) groups.set(f.key, []);
    groups.get(f.key).push(f);
  }

  const lead = el("p", "lead", round
    ? `${plural(flags.length, "flag")} from ${plural(groups.size, "session")} not investigated yet. ` +
      "Pick more, or finish the run."
    : `Discovery is over and the run is paused. It raised ${plural(flags.length, "flag")} in ` +
      `${plural(groups.size, "session")}: pick the ones to investigate.`);
  if (per) lead.append(` One costs about ${usd(per)} at ev-1's measured rate, so all of them would be about ` +
                       `${usd(flags.length * per)}.`);

  const allBtn = el("button", "ev-pickall");
  allBtn.type = "button";
  const count = el("p", "ev-pickcount");
  count.setAttribute("aria-live", "polite");
  const tools = el("div", "ev-picktools");
  tools.append(allBtn, count);

  const list = el("details", "ev-pickflags");
  list.appendChild(el("summary", null, `Show the ${plural(flags.length, "flag")}`));
  const grid = el("div", "ev-pickgroups");
  const multi = ev.conds.length > 1;
  const rows = [];              // { id, cb, group }
  const heads = [];             // { cb, ids }
  for (const [key, fs] of groups) {
    const s = ev.sessions.get(key);
    const where = `${multi ? ev.conds.find((c) => c.key === s.cond).label + " · " : ""}` +
                  `${ROW_NAMES[s.table] || s.table}${ev.f.runs > 1 ? ` · run ${s.run}` : ""}`;
    const set = el("fieldset", "ev-pickgroup");
    const legend = el("legend");
    const lab = el("label", "ev-check");
    const all = el("input");
    all.type = "checkbox";
    lab.append(all, el("span", null, `${where} · ${plural(fs.length, "flag")}`));
    legend.appendChild(lab);
    const ol = el("ol", "issues");
    const ids = fs.map(fid);
    for (const f of fs) {
      const row = el("div", "issue-row");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = ev.pick.has(fid(f));
      cb.setAttribute("aria-label", `Investigate ${where} flag ${f.n}: ${f.title}`);
      cb.addEventListener("change", () => {
        if (cb.checked) ev.pick.add(fid(f)); else ev.pick.delete(fid(f));
        update();
      });
      // A copy without status or root cause: an earlier round's failed attempt
      // left its note on the flag, and the flag is being offered afresh.
      row.append(cb, issueDetails({ ...f, status: "flagged", root_cause: null }));
      const li = el("li");
      li.appendChild(row);
      ol.appendChild(li);
      rows.push({ id: fid(f), cb });
    }
    all.addEventListener("change", () => {
      for (const id of ids) if (all.checked) ev.pick.add(id); else ev.pick.delete(id);
      update();
    });
    heads.push({ cb: all, ids });
    set.append(legend, ol);
    grid.appendChild(set);
  }
  list.appendChild(grid);

  const go = el("button");
  go.type = "button";
  go.addEventListener("click", () => startRound(ev, flags));
  const fin = el("button", "ev-finish", round ? "Finish" : "Finish without investigating");
  fin.type = "button";
  fin.addEventListener("click", () => {
    if (!window.confirm(`Finish evaluation ${ev.id}? No more flags can be investigated after this.`)) return;
    ev.handle.finish();
    render();
    view.pickHead?.focus();
  });
  const actions = el("div", "ev-pickgo");
  actions.append(go, fin);

  const note = el("p", "ev-help", "Picking every flag keeps attribution free of anyone's choice, as E1 and E4 " +
    "require, and Select all does it without opening the list. The list shows flag text unredacted, including " +
    "any match to a held-out defect. Each pick is recorded in the results.");

  function update() {
    for (const r of rows) r.cb.checked = ev.pick.has(r.id);
    for (const h of heads) {
      const k = h.ids.filter((id) => ev.pick.has(id)).length;
      h.cb.checked = k === h.ids.length;
      h.cb.indeterminate = k > 0 && k < h.ids.length;
    }
    const k = ev.pick.size;
    count.textContent = `${fmt(k)} of ${plural(flags.length, "flag")} picked` +
                        (per && k ? `, about ${usd(k * per)}` : "");
    allBtn.textContent = k === flags.length ? "Clear all" : `Select all ${fmt(flags.length)}`;
    go.disabled = !k;
    go.textContent = k ? `Investigate ${plural(k, "flag")}` : "Investigate picked flags";
  }
  allBtn.addEventListener("click", () => {
    const every = ev.pick.size === flags.length;
    for (const f of flags) if (every) ev.pick.delete(fid(f)); else ev.pick.add(fid(f));
    update();
  });
  update();
  box.replaceChildren(pickHead(round ? "Pick more flags to investigate" : "Pick the flags to investigate"),
                      lead, tools, list, actions, note);
}

function buildSummary() {
  const ev = view.ev, all = [...ev.sessions.values()];
  const n = ev.rounds.length;
  let text;
  if (ev.status === "investigating") {
    text = `Round ${n}: investigating ${plural(ev.rounds[n - 1].picks.length, "flag")}, up to ` +
           `${ev.f.parallel} at a time. Stop investigating ends the round and pauses for another pick.`;
  } else if (!n) {
    text = ev.status === "stopped" ? "Stopped during discovery, so nothing was investigated."
                                   : "Finished without investigating.";
  } else {
    text = `${fmt(sum(all, "invDone"))} of ${plural(sum(all, "invTotal"), "picked flag")} investigated, ` +
           `in ${plural(n, "round")}.`;
  }
  view.pick.replaceChildren(pickHead("Investigation"), el("p", "lead", text));
  if (ev.mode === "live" && n && ev.status !== "investigating") {
    view.pick.appendChild(el("p", "ev-help", "Root causes are in the downloaded results."));
  }
}

function startRound(ev, flags) {
  const picks = flags.filter((f) => ev.pick.has(fid(f))).map(({ key, n }) => ({ key, n }));
  if (!picks.length || (ev.mode === "live" && !confirmRound(ev, picks.length))) return;
  ev.rounds.push({ at: Date.now(), offered: flags.length, picks });
  ev.pick.clear();
  ev.handle.investigate(picks);
  announce(`Investigating ${plural(picks.length, "flag")}.`);
  render();
  view.pickHead?.focus();
}

// The scorer's input: everything a live run captured, flag text included.
function downloadResults(ev) {
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const data = {
    evaluation: ev.id, mode: ev.mode, status: ev.status, started: iso(ev.started), ended: iso(ev.ended),
    saved: iso(Date.now()), runtime: CFG.runtimeArn, preset: ev.preset,
    settings: ev.f.base, tables: ev.f.tables, runs: ev.f.runs, parallel: ev.f.parallel,
    conditions: ev.conds.map((c) => ({ key: c.key, label: c.label, settings: c.settings })),
    // Who chose what was investigated, for the scorer: a round that took every
    // open flag is the protocol's "every flag investigated".
    investigation_rounds: ev.rounds.map((r) => ({
      started: iso(r.at), offered: r.offered, picked: r.picks.length,
      every_open_flag: r.picks.length === r.offered, flags: r.picks })),
    sessions: ev.handle.results(),
  };
  const stamp = iso(ev.started).slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = `autodqa-${ev.id}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  announce(`Results for ${ev.id} downloaded.`);
}

// Closing the tab ends a live run (see RuntimeHarness), so ask first.
window.addEventListener("beforeunload", (e) => {
  if (evals.some((ev) => ev.mode === "live" && LIVE_STATUSES.includes(ev.status))) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---- Shared by both harnesses ---------------------------------------------------
// `picked` holds every flag number a session has had picked, and `inv` each one's
// latest state: queued, running, done, or failed (which takes in stopped). A
// failed flag is open to another pick; the others are not.
const newJob = (u) => ({ ...u, state: "queued", result: null, steps: 0, turns: 0, tools: 0, flags: 0,
                         invDone: 0, invTotal: 0, invLimit: 0, id: null, started: null, ended: null,
                         why: null, warnings: [], picked: new Set(), inv: new Map() });

// `why` is what ended a discovery that did not finish; `warnings`, what went wrong
// along the way that the session carried on past.
const sessionEvent = (j) => ({ type: "session", key: j.key, state: j.state, result: j.result,
  steps: j.steps, turns: j.turns, tools: j.tools, flags: j.flags, invDone: j.invDone,
  invTotal: j.invTotal, invLimit: j.invLimit, id: j.id, started: j.started, ended: j.ended,
  why: j.why, warnings: j.warnings.map((w) => w.message) });

// Sessions start interleaved -- by position within their run, then run, then
// condition -- rather than one condition after another, so any drift in the
// hosted model over the hours a batch takes lands on every condition alike.
function startOrder(jobs, conds) {
  const condIndex = Object.fromEntries(Object.keys(conds).map((k, i) => [k, i]));
  const seen = new Map();
  return jobs.map((j) => {
    const g = `${j.cond}|${j.run}`;
    seen.set(g, (seen.get(g) ?? -1) + 1);
    return { j, at: seen.get(g) };
  }).sort((a, b) => a.at - b.at || a.j.run - b.j.run || condIndex[a.j.cond] - condIndex[b.j.cond])
    .map((x) => x.j);
}

// How the activity log names a session: "Run 2 · ENCOUNTER".
function sessionNamer(conds) {
  const multi = Object.keys(conds).length > 1;
  return { name: (j) => `${multi ? conds[j.cond].label + " · " : ""}Run ${j.run} · ${ROW_NAMES[j.table] || j.table}` };
}

const isOpen = (j, n) => !j.inv.has(n) || j.inv.get(n) === "failed";

// The flags open to a pick, in session start order: the pick's list. `list(j)`
// gives a session's flags.
function openFlags(order, conds, list) {
  return order.filter((j) => conds[j.cond].investigate).flatMap((j) => list(j)
    .filter((i) => isOpen(j, i.n))
    .map((i) => ({ key: j.key, n: i.n, title: i.title, dimension: i.dimension, table: i.table,
                   column: i.column, finding: i.finding, evidence: i.evidence })));
}

// A pick as a queue of { j, n, prev }, interleaved across sessions -- every
// session's first pick, then every second -- so no one table's flags all go
// first. Each is marked queued; `prev` is its state before, for unqueue. A pick
// that is no longer open is dropped.
function roundQueue(picks, jobs, has) {
  const byJob = new Map();
  for (const { key, n } of picks) {
    const j = jobs.get(key);
    if (!j || !has(j, n) || !isOpen(j, n)) continue;
    if (!byJob.has(j)) byJob.set(j, new Set());
    byJob.get(j).add(n);
  }
  const lists = [...byJob].map(([j, ns]) => [j, [...ns]]);
  const out = [];
  for (let i = 0, more = true; more; i++) {
    more = false;
    for (const [j, ns] of lists) {
      if (i >= ns.length) continue;
      out.push({ j, n: ns[i], prev: j.inv.get(ns[i]) });
      more = true;
    }
  }
  for (const { j, n } of out) {
    j.inv.set(n, "queued");
    j.picked.add(n);
  }
  return out;
}

// A queued flag that never started goes back to how it was before the pick.
function unqueue({ j, n, prev }) {
  if (prev) j.inv.set(n, prev);
  else {
    j.inv.delete(n);
    j.picked.delete(n);
  }
}

// A session's investigation counters, from its flags' states. It reads as
// investigating while any of them is queued or in flight, and otherwise as how
// its discovery ended.
function invCounters(j) {
  const states = [...j.inv.values()];
  j.invTotal = j.picked.size;
  j.invDone = states.filter((s) => s === "done").length;
  j.state = states.some((s) => s === "queued" || s === "running") ? "investigating" : j.result;
}

const sessionInvNote = (name, j) =>
  `${name(j)}: ${fmt(j.invDone)} of ${plural(j.invTotal, "picked flag")} investigated` +
  (j.invLimit ? `, ${j.invLimit} at the step limit.` : ".");

const roundNote = (round, tally) => `Round ${round} is over: ${plural(tally.done, "flag")} investigated` +
  (tally.failed ? `, ${fmt(tally.failed)} failed or stopped.` : ".");

// What the log says when a run pauses for a pick.
function pauseNote(round, tally, open) {
  const left = `${plural(open.length, "flag")} from ${plural(new Set(open.map((f) => f.key)).size, "session")}`;
  return round ? `${roundNote(round, tally)} Paused with ${left} still open: pick more, or finish.`
               : `Discovery is over. Paused with ${left} to pick from: pick the ones to investigate, or finish.`;
}

// ---- RuntimeHarness ---------------------------------------------------------------
// The live harness, in two phases with a pause between them.
//
// Discovery: each unit is its own conversation with the deployed Runtime, and so
// its own session microVM, given the table's task. When every session has ended,
// a run that investigates pauses until the user picks flags (investigate) or ends
// it (finish).
//
// Investigation: each picked flag is a conversation of its own as well, with its
// ticket in the request. By then the discovery session has usually gone -- the
// Runtime drops a conversation after 15 idle minutes, and a pause can last longer
// -- and the ticket is all an investigation starts from anyway (entrypoint.py's
// _investigation_task), so nothing is lost by carrying it. It also lets flags
// from any session run side by side, up to the same parallel limit, each with its
// own thread and step budget, and a stream cut short loses only its own flag.
// When a round ends with flags still open, the run pauses again.
//
// Everything a session streams -- flags, transcript, the investigation reports --
// is kept here for results(), and only counts go to the monitor. Every
// conversation is purged on the Runtime as soon as it ends, so the download is
// the record.
//
// Each request names its condition's model, and a discovery request its prompt
// variant and cap; the Runtime echoes them in its done event. Not covered:
// resetting the warehouse, the synthesis and chained workflows, and varying the
// tools. Each needs a change on the Runtime side.
function RuntimeHarness(plan, onEvent) {
  const STOP_GRACE_MS = 15000;   // how long a stopped conversation gets to say it has stopped
  // All a Runtime from before 2026-10-20 answers an investigation that brings its
  // own ticket: it looks for the ticket in its memory and finds none.
  const NO_TICKET = "No issues were selected to investigate.";
  const ended = (j) => ENDED.includes(j.state);
  const jobs = new Map(plan.units.map((u) => [u.key, {
    ...newJob(u), task: null, issues: new Map(), transcript: [], errors: [],
    discovery: null, investigations: [], known: null }]));
  const order = startOrder([...jobs.values()], plan.conds);
  const { name } = sessionNamer(plan.conds);
  const log = (text, bad) => onEvent({ type: "log", text, bad });
  const emit = (j) => onEvent(sessionEvent(j));
  const status = (s) => onEvent({ type: "status", status: s });
  // What holds a parallel slot: one conversation, a discovery session's or one
  // flag's investigation: { j, n, conv, abort }.
  const running = new Set();
  const queue = [];               // the round's flags waiting for a slot
  let phase = "discovery";        // discovery | selection | investigation | finished
  let stopping = false;           // the current phase was asked to stop
  let round = 0, tally = null;
  // Known-issues list -> the version the Runtime reported at launch. Every session
  // names it, so a redeploy with another version partway through is refused by the
  // Runtime instead of mixing two lists in one evaluation.
  const known = new Map();

  // The design doc's per-table task, word for word, so live runs match what will be
  // frozen. The doc gives no whole-warehouse text; this one follows its pattern.
  const taskFor = (j) => j.kind === "whole"
    ? `Assess the data quality of the CDW database: ${plan.tables.map((t) => "CDW.dbo." + t).join(", ")}. ` +
      "You may query any table or database to check their rows against them."
    : `Assess the data quality of CDW.dbo.${j.table}. You may query any table or database to check ` +
      `${j.table}'s rows against them.`;

  const headers = (conv, token) => ({
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": conv,   // pins the conversation's microVM
  });

  // One streaming invoke on a conversation. Resolves when the stream ends; the
  // caller checks that a done event arrived.
  async function call(w, body, onEv) {
    const token = await freshAccessToken();
    w.abort = new AbortController();
    const res = await fetch(runtimeUrl(), {
      method: "POST",
      headers: headers(w.conv, token),
      body: JSON.stringify({ ...body, conversation: w.conv }),
      signal: w.abort.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const line = (raw) => {
      const t = raw.trim();
      if (!t.startsWith("data:")) return;
      let e;
      try { e = JSON.parse(t.slice(5).trim()); } catch { return; }
      onEv(e);    // outside the try: a bug in a handler should surface, not be skipped
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    line(buf + decoder.decode());
  }

  // Counts what every phase streams; returns false for events it does not handle.
  function common(j, phase, e) {
    if (e.type === "AIMessage") {
      j.turns++;
      j.transcript.push({ phase, kind: "ai", content: e.content });
    } else if (e.type === "ToolMessage") {
      j.tools++;
      // status "error": a call refused before it ran, and the error the model was given.
      j.transcript.push({ phase, kind: "tool", content: e.content, ...(e.status && { status: e.status }) });
    } else if (e.type === "error") {
      j.errors.push({ phase, message: e.message });
    } else if (e.type === "warning") {
      // The Runtime starts an investigation's warnings with "Issue #n: " already.
      j.warnings.push({ phase, message: e.message });
      log(`${name(j)}: ⚠ ${e.message}`);
    } else return false;
    return true;
  }

  const doneStats = (d) => ({ reason: d.reason, message: d.message ?? null, model_turns: d.model_turns,
    tool_calls: d.tool_calls, issue_count: d.issue_count, issue_max: d.issue_max, prompt_variant: d.prompt_variant,
    model: d.model, max_output_tokens: d.max_output_tokens ?? null,
    thread_messages: d.thread_messages, runtime_session: d.session });

  // With a known-issues list, the Runtime appends the session's slice of it -- the
  // entries for j.table, or every entry for "*" -- to the task, and says which ids
  // it showed before any model call.
  async function discover(j, w) {
    let done = null;
    const { known_issues: list, model, prompt, cap } = plan.conds[j.cond];
    const body = { task: j.task, model, prompt_variant: prompt, max_issues: cap };
    if (list !== "off") Object.assign(body, { table: j.table, known_issues: { list, version: known.get(list) } });
    await call(w, body, (e) => {
      if (e.type === "issue") {
        j.issues.set(e.issue.n, e.issue);
        j.flags = j.issues.size;
      } else if (e.type === "known_issues") {
        j.known = { list: e.list, version: e.version, table: e.table, ids: e.ids };
        return;
      } else if (e.type === "done") {
        done = e;
        return;
      } else if (!common(j, "discovery", e)) return;   // trace, heartbeat, sandbox
      emit(j);
    });
    // A request the Runtime refuses (a list or version, model, prompt or cap it does
    // not have) gets one error event before any model turn, and no done: that error
    // is the reason.
    const refused = !j.turns && j.errors.at(-1)?.message;
    if (!done) throw new Error(refused || "the stream ended without saying why");
    if (list !== "off" && !j.known) throw new Error("the Runtime ran the session without the known-issues list");
    j.discovery = doneStats(done);
    if (done.model !== model || done.prompt_variant !== prompt || done.issue_max !== cap) {
      throw new Error(`the Runtime ran the session on ${done.model ?? "its default model"} with prompt ` +
                      `${done.prompt_variant ?? "(none)"} and cap ${done.issue_max}, not ${model}, ${prompt} and ${cap}`);
    }
    return { completed: "done", step_limit: "step_limit", cancelled: "cancelled" }[done.reason] || "error";
  }

  // One flag, on a conversation of its own. The ticket goes with the request; the
  // Runtime seeds it into the new conversation and investigates just that one.
  async function investigate(j, w) {
    const n = w.n, phase = `investigation #${n}`;
    const { title, dimension, finding, evidence, table, column } = j.issues.get(n);
    const { model } = plan.conds[j.cond];
    let done = null, refused = false;
    await call(w, { action: "investigate", selected: [n], model,
                    issues: [{ n, title, dimension, finding, evidence, table, column }] }, (e) => {
      if (e.type === "issue_update") j.issues.set(e.issue.n, e.issue);
      else if (e.type === "report") e.issues.forEach((i) => j.issues.set(i.n, i));
      else if (e.type === "done") { done = e; return; }
      else if (!common(j, phase, e)) return;
      if (e.type === "error" && e.message === NO_TICKET) refused = true;
      // The Runtime settles a ticket that hit the limit as inconclusive and says so here.
      if (e.type === "error" && /step limit/.test(e.message)) j.invLimit++;
      emit(j);
    });
    if (refused) {
      const err = new Error("The deployed Runtime cannot take a flag from an earlier session yet. Deploy " +
                            "agentcore-runtime (2026-10-20 or later), then pick the flags again.");
      err.outdated = true;
      throw err;
    }
    if (!done) throw new Error("the stream ended without saying why");
    j.investigations.push({ issue: n, conversation: w.conv, ...doneStats(done) });
    if (done.model !== model) throw new Error(`the Runtime investigated on ${done.model ?? "its default model"}, not ${model}`);
    return done;
  }

  // Best-effort, like the chat's New chat: the idle timeout is the guarantee.
  async function purge(conv) {
    try {
      const token = await freshAccessToken();
      await fetch(runtimeUrl(), { method: "POST", headers: headers(conv, token),
                                  body: JSON.stringify({ action: "end_session", conversation: conv }) });
    } catch { /* nothing to do: the Runtime drops it after 15 idle minutes anyway */ }
  }

  async function runJob(j) {
    const w = { j, n: null, conv: "eval-" + crypto.randomUUID(), abort: null };
    j.state = "discovery";       // before any await, so the pump cannot start it twice
    j.started = Date.now();
    j.id = w.conv;
    j.task = taskFor(j);
    running.add(w);
    emit(j);
    try {
      j.result = await discover(j, w);
    } catch (e) {
      j.result = stopping ? "cancelled" : "error";
      if (!stopping && j.errors.at(-1)?.message !== e.message) j.errors.push({ phase: "discovery", message: e.message });
    } finally {
      running.delete(w);
      j.state = j.result || "error";
      j.ended = Date.now();
      if (j.state === "error" || j.state === "step_limit") j.why = j.errors.at(-1)?.message ?? null;
      emit(j);
    }
    if (j.result === "error" && j.errors.length) log(`${name(j)}: ${j.errors.at(-1).message.slice(0, 240)}`, true);
    const what = { done: "done", step_limit: `hit the ${STEP_LIMIT}-step limit, flags so far kept`,
                   error: "failed", cancelled: "cancelled" }[j.state];
    const warned = j.warnings.length ? `, ${plural(j.warnings.length, "warning")}` : "";
    log(`${name(j)}: ${what} · ${plural(j.flags, "flag")}, ${plural(j.turns, "model turn")}${warned}, ` +
        `${clock(j.ended - j.started)}.`, j.state !== "done");
    purge(w.conv);
  }

  async function runInv(t) {
    const { j, n } = t;
    const w = { j, n, conv: "eval-" + crypto.randomUUID(), abort: null };
    running.add(w);
    j.inv.set(n, "running");
    let done = null, outdated = null;
    try {
      done = await investigate(j, w);
    } catch (e) {
      if (e.outdated) outdated = e;
      else if (!stopping) {
        j.errors.push({ phase: `investigation #${n}`, message: e.message });
        log(`${name(j)}: the investigation of flag #${n} failed: ${e.message.slice(0, 200)}.`, true);
      }
    } finally {
      running.delete(w);
    }
    purge(w.conv);
    if (outdated) {
      // Every flag would be refused the same way, so the round stops at the first.
      // Nothing was attempted, so the flag goes back as if never picked.
      if (!stopping) {
        log(outdated.message, true);
        halt();
      }
      unqueue(t);
      invCounters(j);
      return emit(j);
    }
    if (done && done.reason !== "completed" && done.reason !== "cancelled") {
      log(`${name(j)}: the investigation of flag #${n} failed: ${(done.message || done.reason).slice(0, 200)}.`, true);
    }
    // A completed investigation closes the flag, and so does a cause recorded before
    // the stream was cut. Anything short of that can be picked again, and reads as
    // not investigated -- not as in flight, nor as the Runtime's "ended before a
    // cause was recorded".
    const issue = j.issues.get(n);
    const ok = done?.reason === "completed" || issue?.status === "explained";
    if (!ok && issue && issue.status !== "flagged") j.issues.set(n, { ...issue, status: "flagged", root_cause: null });
    j.inv.set(n, ok ? "done" : "failed");
    tally[ok ? "done" : "failed"]++;
    invCounters(j);
    emit(j);
    if (j.state !== "investigating") log(sessionInvNote(name, j), j.invLimit > 0 || j.invDone < j.invTotal);
  }

  function pump() {
    if (phase === "discovery") {
      for (const j of order) {
        if (stopping || running.size >= plan.parallel) break;
        if (j.state === "queued" && j.after.every((k) => ended(jobs.get(k)))) {
          runJob(j).catch((e) => log(`${name(j)}: ${e.message}`, true)).finally(pump);
        }
      }
      if (running.size || ![...jobs.values()].every(ended)) return;
      if (!stopping) return pause();
      phase = "finished";
      log("Every session has ended. What they found before the stop is in the results.");
    } else if (phase === "investigation") {
      while (!stopping && running.size < plan.parallel && queue.length) {
        const t = queue.shift();
        runInv(t).catch((e) => log(`${name(t.j)}: ${e.message}`, true)).finally(pump);
      }
      if (running.size || queue.length) return;
      stopping = false;
      pause();
    }
  }

  // After discovery, and after every round: wait for a pick, unless no flag is
  // left to pick.
  function pause() {
    const open = flags();
    if (open.length) {
      phase = "selection";
      log(pauseNote(round, tally, open));
      return status("awaiting_selection");
    }
    phase = "finished";
    log(round ? `${roundNote(round, tally)} Every flag has been investigated. Download the results for the scorer.`
              : "Every session has ended. Download the results for the scorer.");
    status("awaiting_scoring");
  }

  const flags = () => openFlags(order, plan.conds, (j) => [...j.issues.values()].sort((a, b) => a.n - b.n));

  // Ask the Runtime to cancel a conversation's job. It says whether it found one;
  // the stream then ends with a cancelled done event, or is cut after the grace period.
  function stopOne(conv, token, keepalive) {
    try {
      fetch(runtimeUrl(), { method: "POST", headers: headers(conv, token), keepalive,
                            body: JSON.stringify({ action: "stop", conversation: conv }) }).catch(() => {});
    } catch { /* unload path */ }
  }

  function stopRunning() {
    // A stream can outlast the hour-long access token, so renew first.
    const token = freshAccessToken().catch(() => accessToken);
    for (const w of running) {
      token.then((t) => stopOne(w.conv, t, false));
      setTimeout(() => w.abort?.abort(), STOP_GRACE_MS);
    }
  }

  // Ends the round, not the run: the flags not started go back to how they were,
  // the ones in flight are told to stop, and once they have, the run pauses.
  function halt() {
    stopping = true;
    const touched = new Set();
    for (const t of queue.splice(0)) {
      unqueue(t);
      touched.add(t.j);
    }
    for (const j of touched) {
      invCounters(j);
      emit(j);
    }
    stopRunning();
  }

  // The tab is what drives the run, so when it goes, the conversations in flight
  // are told to stop rather than left to burn tokens no one will collect. No
  // renewal here: an unloading page cannot wait for one.
  window.addEventListener("pagehide", () => running.forEach((w) => stopOne(w.conv, accessToken, true)));

  // The known-issues lists the Runtime carries. One from before 2026-10-20 takes the
  // question for a discovery request with no task, and answers with an error.
  async function knownLists() {
    const w = { conv: "eval-" + crypto.randomUUID(), abort: null };
    let lists = null;
    await call(w, { action: "known_issues" }, (e) => { if (e.type === "known_issues") lists = e.lists; });
    if (!lists) {
      throw new Error("The deployed Runtime cannot show a known-issues list yet. Deploy agentcore-runtime " +
                      "(2026-10-20 or later), or launch with the list off.");
    }
    return lists;
  }

  // The models, prompt variants and cap range the Runtime takes. One from before
  // 2026-10-27 answers with an error, as for knownLists(); v29 has no model list.
  async function settings() {
    const w = { conv: "eval-" + crypto.randomUUID(), abort: null };
    let have = null;
    await call(w, { action: "settings" }, (e) => { if (e.type === "settings") have = e; });
    if (!have?.models) {
      throw new Error("The deployed Runtime cannot take a model, prompt or cap from the console yet. " +
                      "Deploy agentcore-runtime.");
    }
    for (const c of Object.values(plan.conds)) {
      if (!have.models.includes(c.model)) throw new Error(`The deployed Runtime does not offer ${modelName(c.model)}.`);
      if (!have.prompt_variants.includes(c.prompt)) throw new Error(`The deployed Runtime has no prompt ${c.prompt}.`);
      if (c.cap > have.cap_ceiling) throw new Error(`The deployed Runtime caps a session at ${have.cap_ceiling} issues.`);
    }
  }

  // A run starts once the Runtime has said it takes every condition's model, prompt
  // and cap and, with a known-issues list, which version of the list it holds.
  async function start() {
    const wanted = new Set(Object.values(plan.conds).map((c) => c.known_issues).filter((k) => k !== "off"));
    try {
      await settings();
      const have = wanted.size ? await knownLists() : [];
      for (const name of wanted) {
        const l = have.find((x) => x.list === name);
        if (!l) throw new Error(`The deployed Runtime has no known-issues list “${name}”.`);
        known.set(name, l.version);
        log(`Each session is shown ${name} v${l.version}, the entries for its table ` +
            `(${plural(l.entries, "entry", "entries")} in all).`);
      }
    } catch (e) {
      if (stopping) return;
      log(`Not started: ${e.message}`, true);
      for (const j of jobs.values()) {
        j.state = j.result = "cancelled";
        emit(j);
      }
      phase = "finished";
      return status("stopped");
    }
    if (stopping) return;
    log(`Starting ${plural(jobs.size, "discovery session")}, up to ${plan.parallel} at a time.`);
    pump();
  }

  status("running");
  log("Live run on the deployed Runtime. The warehouse is not reset: sessions query CDW as it stands.");
  start();

  return {
    // In discovery this ends the run. In a round of investigation it ends only the
    // round, and the run pauses for another pick.
    stop() {
      if (stopping) return;
      if (phase === "discovery") {
        stopping = true;
        for (const j of jobs.values()) {
          if (j.state !== "queued") continue;
          j.state = j.result = "cancelled";
          emit(j);
        }
        stopRunning();
        log(running.size ? `Stopping ${plural(running.size, "session")} in flight; ` +
                           "the ones that had ended keep their flags." : "Stopped.", true);
        status("stopped");
        pump();
      } else if (phase === "investigation") {
        log(`Stopping the round: ${plural(running.size, "investigation")} in flight. Their flags, and the ` +
            "ones not started, can be picked again.", true);
        halt();
        pump();
      }
    },
    flags,
    investigate(picks) {
      if (phase !== "selection") return;
      const q = roundQueue(picks, jobs, (j, n) => j.issues.has(n));
      if (!q.length) return;
      queue.push(...q);
      phase = "investigation";
      round++;
      tally = { done: 0, failed: 0 };
      for (const j of new Set(q.map((t) => t.j))) {
        invCounters(j);
        emit(j);
      }
      log(`Round ${round}: investigating ${plural(q.length, "flag")}, up to ${plan.parallel} at a time.`);
      status("investigating");
      pump();
    },
    finish() {
      if (phase !== "selection") return;
      phase = "finished";
      log("Finished. Download the results for the scorer.");
      status("awaiting_scoring");
    },
    results() {
      const iso = (t) => (t ? new Date(t).toISOString() : null);
      return order.map((j) => ({
        key: j.key, condition: plan.conds[j.cond].label, run: j.run,
        table: j.table === "*" ? null : j.table, kind: j.kind, session: j.id, task: j.task,
        state: j.state, started: iso(j.started), ended: iso(j.ended),
        flags: [...j.issues.values()], picked: [...j.picked].sort((a, b) => a - b),
        known_issues: j.known, discovery: j.discovery, investigations: j.investigations,
        errors: j.errors, warnings: j.warnings, transcript: j.transcript,
      }));
    },
  };
}

// ---- MockHarness ----------------------------------------------------------------
// Stands in for the harness the design calls for, so the monitor has something to
// show. The contract every harness keeps:
//   Harness(plan, onEvent) -> { stop(), flags(), investigate(picks), finish() },
//     and RuntimeHarness adds results()
//   plan:  { units: [{ key, cond, run, table, kind, after }], parallel,
//            conds: { [key]: { label, ...settings } }, snapshot, tables }
//   onEvent receives
//     { type: "status", status }             resetting | running | awaiting_selection |
//                                            investigating | awaiting_scoring | stopped
//     { type: "session", key, ...counters }  a session's state and running totals
//     { type: "log", text, bad }             one line for the activity log
// When discovery is over, a run whose conditions investigate pauses at
// awaiting_selection. flags() then lists the flags open to a pick, as
// { key, n, title, dimension, table, column, finding, evidence };
// investigate([{ key, n }]) starts a round of them, and finish() ends the run. A
// round that leaves flags open pauses again. stop() ends discovery for good, but
// in investigation it ends only the round.
// Counts reach the monitor through onEvent, and flag text only through flags(),
// for the pick: the rest of it is for the scorer.
//
// Everything under the contract is make-believe. Step counts, flag counts and
// failure rates are random and the flags are placeholders, chosen only to look
// like a run in motion.
function MockHarness(plan, onEvent) {
  const TICK_MS = 300;
  const DIMS = ["conformance", "completeness", "plausibility"];
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const ended = (j) => ENDED.includes(j.state);
  const jobs = new Map(plan.units.map((u) => [u.key, { ...newJob(u), list: [] }]));
  let slots = [];               // what holds a session slot: { job } or { job, inv }
  const queue = [];             // the round's flags waiting for a slot
  let phase = "discovery", round = 0, tally = null, timer = null;

  const order = startOrder([...jobs.values()], plan.conds);
  const { name } = sessionNamer(plan.conds);
  const log = (text, bad) => onEvent({ type: "log", text, bad });
  const emit = (j) => onEvent(sessionEvent(j));
  const status = (s) => onEvent({ type: "status", status: s });

  function begin(j) {
    const cap = plan.conds[j.cond].cap;
    j.state = "discovery";
    j.started = Date.now();
    j.id = "eval-" + crypto.randomUUID();
    // A whole-warehouse session works longest and tends to fill its cap; a
    // synthesis pass mostly confirms what the table sessions already found.
    j.target = j.kind === "whole" ? rnd(170, 250) : j.kind === "synthesis" ? rnd(60, 180) : rnd(40, 230);
    const roll = Math.random();
    j.fate = roll < 0.02 ? "error" : roll < 0.07 ? "step_limit" : "done";
    if (j.fate === "step_limit") j.target = STEP_LIMIT;
    if (j.fate === "error") j.failAt = rnd(5, j.target - 1);
    j.finalFlags = j.kind === "whole" ? rnd(Math.ceil(cap * 0.6), cap)
                 : j.kind === "synthesis" ? rnd(0, Math.ceil(cap / 2))
                 : Math.min(cap, Math.floor(Math.random() ** 1.5 * (cap + 1)));
    slots.push({ job: j });
    emit(j);
  }

  function settle(j, result) {
    j.state = j.result = result;
    j.ended = Date.now();
    if (result === "done") j.flags = j.finalFlags;
    // A placeholder per flag raised, for the pick.
    j.list = Array.from({ length: j.flags }, (_, i) => ({
      n: i + 1, title: `Simulated flag ${i + 1}`, dimension: DIMS[rnd(0, 2)],
      table: TABLES.includes(j.table) ? j.table : null, column: null,
      finding: "Simulated: nothing was queried.", evidence: null }));
    emit(j);
    const what = { done: "done", step_limit: `hit the ${STEP_LIMIT}-step limit, flags so far kept`,
                   error: "failed (simulated sandbox error)" }[result];
    log(`${name(j)}: ${what} · ${plural(j.flags, "flag")}, ${j.steps} steps.`, result !== "done");
    return true;
  }

  // Returns true when the slot is free again.
  function stepDiscovery(j) {
    j.steps = Math.min(j.target, j.steps + rnd(5, 15));
    j.turns = Math.ceil(j.steps / 2);
    j.tools = Math.floor(j.steps * 0.55);
    j.flags = Math.floor(j.finalFlags * j.steps / j.target);
    if (j.fate === "error" && j.steps >= j.failAt) return settle(j, "error");
    if (j.steps >= j.target) return settle(j, j.fate);
    emit(j);
    return false;
  }

  function stepInvestigation(j, inv) {
    inv.steps = Math.min(inv.target, inv.steps + rnd(10, 30));
    if (inv.steps < inv.target) return false;
    j.turns += Math.ceil(inv.steps / 2);
    j.tools += Math.floor(inv.steps * 0.55);
    if (inv.limit) j.invLimit++;
    j.inv.set(inv.n, inv.fail ? "failed" : "done");
    tally[inv.fail ? "failed" : "done"]++;
    if (inv.fail) log(`${name(j)}: the investigation of flag #${inv.n} failed (simulated stream error).`, true);
    invCounters(j);
    if (j.state !== "investigating") log(sessionInvNote(name, j), j.invLimit > 0 || j.invDone < j.invTotal);
    emit(j);
    return true;
  }

  function tick() {
    slots = slots.filter((s) => !(s.inv ? stepInvestigation(s.job, s.inv) : stepDiscovery(s.job)));
    if (phase === "discovery") {
      for (const j of order) {
        if (slots.length >= plan.parallel) break;
        if (j.state === "queued" && j.after.every((k) => ended(jobs.get(k)))) begin(j);
      }
      if (!slots.length && [...jobs.values()].every(ended)) pause();
    } else if (phase === "investigation") {
      while (slots.length < plan.parallel && queue.length) {
        const { j, n } = queue.shift();
        const limit = Math.random() < 0.08;
        j.inv.set(n, "running");
        slots.push({ job: j, inv: { n, steps: 0, target: limit ? STEP_LIMIT : rnd(30, 200), limit,
                                    fail: Math.random() < 0.03 } });
      }
      if (!slots.length && !queue.length) pause();
    }
  }

  function pause() {
    clearInterval(timer);
    const open = flags();
    if (open.length) {
      phase = "selection";
      log(pauseNote(round, tally, open));
      return status("awaiting_selection");
    }
    phase = "finished";
    log(round ? `${roundNote(round, tally)} Every flag has been investigated. The flags are ready for the scorer.`
              : "Every session has ended. The flags are ready for the scorer.");
    status("awaiting_scoring");
  }

  const flags = () => openFlags(order, plan.conds, (j) => j.list);

  status("resetting");
  log(`Resetting the warehouse to snapshots/${plan.snapshot} (simulated).`);
  const resetTimer = setTimeout(() => {
    status("running");
    log("Warehouse reset. Discovery started.");
    timer = setInterval(tick, TICK_MS);
  }, 2000);

  return {
    stop() {
      if (phase === "discovery") {
        phase = "finished";
        clearTimeout(resetTimer);
        clearInterval(timer);
        for (const j of jobs.values()) {
          if (ended(j)) continue;
          j.state = "cancelled";
          j.ended = j.ended || Date.now();
          emit(j);
        }
        slots = [];
        log("Stopped. Sessions in flight were cancelled; the ones that had ended keep their flags.", true);
        status("stopped");
      } else if (phase === "investigation") {
        clearInterval(timer);
        const touched = new Set();
        for (const { job, inv } of slots) {
          job.inv.set(inv.n, "failed");
          tally.failed++;
          touched.add(job);
        }
        for (const t of queue.splice(0)) {
          unqueue(t);
          touched.add(t.j);
        }
        slots = [];
        for (const j of touched) {
          invCounters(j);
          emit(j);
        }
        log("Stopped the round. Its flags in flight, and the ones not started, can be picked again.", true);
        pause();
      }
    },
    flags,
    investigate(picks) {
      if (phase !== "selection") return;
      const q = roundQueue(picks, jobs, (j, n) => n >= 1 && n <= j.list.length);
      if (!q.length) return;
      queue.push(...q);
      phase = "investigation";
      round++;
      tally = { done: 0, failed: 0 };
      for (const j of new Set(q.map((t) => t.j))) {
        invCounters(j);
        emit(j);
      }
      log(`Round ${round}: investigating ${plural(q.length, "flag")} (simulated).`);
      status("investigating");
      timer = setInterval(tick, TICK_MS);
    },
    finish() {
      if (phase !== "selection") return;
      phase = "finished";
      log("Finished. The flags are ready for the scorer.");
      status("awaiting_scoring");
    },
  };
}

})();
