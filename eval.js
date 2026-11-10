// AutoDQA static console — the Evaluation view. Launches a batch and monitors it,
// following the AutoDQA Evaluation Design doc. A batch evaluates one phase:
//
//   Discovery      one session per table, per run, per condition; graded on the
//                  flags it raises.
//   Investigation  one conversation per brief, per run, per model. A brief is a
//                  planted defect's symptom in the form of a discovery flag, the
//                  same for every model (investigation_briefs/, bundled into the
//                  Runtime), so models are compared on the same defects described
//                  the same way, not on whatever their own discovery happened to
//                  flag. Graded on the root cause each records.
//
// Two harnesses behind one monitor. RuntimeHarness runs either phase for real: it
// drives the deployed Runtime from this tab through the same invoke API the chat
// uses, so every model call goes through the LiteLLM proxy like any other run. It
// covers what the Runtime can do today -- the reference condition and custom
// runs, per table or whole warehouse, and the briefs -- and the Runtime fixes the
// tools. MockHarness plays a discovery run in the browser with random numbers, for
// judging the design of the experiments the Runtime cannot run yet. The design's
// eventual harness runs server-side; both keep the event shapes described on
// MockHarness, so either can be replaced without touching the view.
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
// A session that fails for a reason outside the agent -- a stalled or dropped
// stream, an error the Runtime caught -- starts over in a new conversation, this
// many times at most, after a short wait. One that ends on its own terms (the step
// or output limit) keeps its ending, and a request the Runtime refuses would only
// be refused again. The same for a discovery session and an investigation.
const SESSION_RETRIES = 3;
const RETRY_WAIT_MS = 15000;

// The anchor for every comparison. Each experiment changes one thing from it.
const REFERENCE = { model: "us.anthropic.claude-sonnet-5-5", effort: "high", prompt: "K1", cap: 10, tools: "all",
                    workflow: "per_table", known_issues: "clean-baseline" };
const REF_RUNS = 3;
const REF_PARALLEL = 8;
// An investigation evaluation runs every brief once per model unless asked for
// more: fifty briefs are already fifty samples of each model.
const INV_RUNS = 1;
// The brief sets the form offers. Which version the Runtime holds, and which briefs,
// it says at launch (briefCheck); a request names that version, so a redeploy
// partway through is refused rather than mixing two versions in one evaluation.
const BRIEF_SETS = { "planted-defects": "One brief per planted defect" };

const AXIS_NAMES = { model: "model", prompt: "prompt", cap: "issue cap", tools: "tools", workflow: "workflow" };

// What a live run can change. A request sets the model, prompt variant and cap, so
// E3 and E5 go live; the other experiments vary something the deployed Runtime
// holds fixed, or (E2's synthesis and chained workflows) need a harness that is
// not built.
const LIVE_PRESETS = new Set(["ref", "E3", "E5", "custom"]);
// Tools, workflow and the known-issues list are not on the form: every live
// session has all tools, works on one table and is shown the list. Discovery's
// flags are not investigated: the investigation phase is its own evaluation.

// Mean cost of a Sonnet 4.5 discovery session, and of investigating one flag, as
// measured on ev-1 (2026-10-19, Runtime v22, prompt caching on) from the
// per-call cost in the Cloudflare AI Gateway's log (the model route until
// 2026-10-28): 15 completed sessions, 138 flags. Rough by
// nature, and only for that model and per-table sessions: a whole-warehouse
// session has never been measured.
const COST = { model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", discovery: 0.80, perFlag: 0.42 };

// One entry per discovery experiment in the design doc. `axis` is the setting it
// varies and `conds` its conditions as [value, short label, long label, ticked by
// default]; `set` is anything else it moves off the reference. E1 and C vary the
// model over the free-text list instead of a fixed set.
const PRESETS = {
  ref: {},
  E1: { axis: "model",
        help: "Detection against cost, by model. Scored on test and holdout, detection. Attribution is " +
              "the investigation phase's: run the same models on the briefs." },
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
  E4: { axis: "tools",
        conds: [["all", "All tools", "All tools (E1's reference-model runs can stand in)", false],
                ["no_valuesets", "No get_valuesets", "No get_valuesets", true]],
        help: "Does get_valuesets matter? Scored on test, detection. Investigation without ETL tools " +
              "belongs to the investigation phase, on the briefs." },
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
                 awaiting_scoring: "Awaiting scoring", stopped: "Stopped" };
// While a live run is in one of these, closing the tab loses it.
const LIVE_STATUSES = ["running"];
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

// The effort levels a model takes, as agent.py's EFFORTS has them: Claude's five,
// and the OpenAI models' six with "none" -- except GPT-6.1 Sol, which refuses it.
// The provider is the ID's second part ("us.openai.gpt-6-luna").
const EFFORT_NAMES = { none: "None", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const EFFORTS = { anthropic: ["low", "medium", "high", "xhigh", "max"],
                  openai: ["none", "low", "medium", "high", "xhigh", "max"] };
const EFFORTS_REFUSED = { "us.openai.gpt-6.1-sol": ["none"] };
const effortsFor = (id) => (EFFORTS[id.split(".")[1]] || [])
  .filter((e) => !(EFFORTS_REFUSED[id] || []).includes(e));

// Refill the Effort dropdown for the model chosen, keeping the level picked if
// the model takes it and falling back to the reference's otherwise.
function syncEffort(want = $("evEffort").value) {
  const levels = effortsFor($("evModel").value);
  $("evEffort").replaceChildren(...levels.map((v) => new Option(EFFORT_NAMES[v], v)));
  $("evEffort").value = levels.includes(want) ? want : REFERENCE.effort;
}
$("evModel").addEventListener("change", () => syncEffort());

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
let evalPhase = "discovery";   // which phase the form launches: discovery | investigation
// Every run goes to the deployed Runtime. The simulated harness below is not
// reachable from the form; `mode` stays in the results so files compare.
const mode = "live";

$("evBriefSet").replaceChildren(...Object.entries(BRIEF_SETS).map(([k, v]) => new Option(`${k} · ${v}`, k)));

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
// experiment varies it. An investigation is one model, from the Model dropdown
// as for a single discovery condition, and the prompt and cap are discovery's
// alone, so they go.
function syncFields() {
  const inv = evalPhase === "investigation";
  const axis = inv ? null : PRESETS[preset].axis;
  document.querySelectorAll(".ev-field[data-axis]").forEach((f) => {
    const varied = f.dataset.axis === axis;
    f.hidden = inv && f.dataset.axis !== "model";
    f.querySelector(".ev-ctl").hidden = varied;
    f.querySelector(".ev-varied").hidden = !varied;
  });
  $("evConds").hidden = !axis;
  $("evModelsField").hidden = axis !== "model";
  $("evCondsLegend").textContent = axis ? `Conditions · ${AXIS_NAMES[axis]}` : "Conditions";
}

// The phase picks which half of the form shows: an experiment and its tables for
// discovery, a brief set for investigation. What is shared -- model, effort, runs
// and parallelism -- stays as it was, except the run count, which each phase
// defaults on its own.
function applyPhase(p) {
  evalPhase = p;
  const inv = p === "investigation";
  $("evPresetField").hidden = inv;
  $("evTablesField").hidden = inv;
  $("evBriefsField").hidden = !inv;
  $("evRunCount").value = inv ? INV_RUNS : PRESETS[preset].runs || REF_RUNS;
  const help = inv ? "Every model investigates the same briefs, each in a new conversation: a planted " +
                     "defect's symptom, stated as a discovery flag would state it and nothing more. One " +
                     "model per evaluation: to compare models, launch one for each."
                   : PRESETS[preset].help || "";
  $("evPresetHelp").textContent = help;
  $("evPresetHelp").hidden = !help;
  $("evPhaseHelp").textContent = inv ? "Independent of any discovery run." : "";
  syncFields();
  refresh();
}
document.querySelectorAll('input[name="evPhase"]').forEach((r) => {
  r.addEventListener("change", () => applyPhase(radio("evPhase")));
});

// An experiment fills the whole form from the reference, then moves what it
// moves. Tables, parallelism and the tag are left as they were: they say how to
// run, not what is being compared.
function applyPreset(key) {
  preset = key;
  const p = PRESETS[key];
  const s = { ...REFERENCE, ...p.set };
  $("evModel").value = s.model;
  syncEffort(s.effort);
  setRadio("evPrompt", s.prompt);
  setRadio("evCap", s.cap);
  $("evRunCount").value = p.runs || REF_RUNS;
  $("evPresetHelp").textContent = p.help || "";
  $("evPresetHelp").hidden = !p.help;

  syncFields();
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
// "BUG-015, BUG-031" or one per line -> the ids, in the order given, once each.
const briefLines = () => [...new Set($("evBriefIds").value.split(/[\s,]+/).filter(Boolean))];

function readForm() {
  const common = { mode, runs: Number($("evRunCount").value), parallel: Number($("evParallel").value) };
  if (evalPhase === "investigation") {
    // One model, and effort the only setting besides it: an investigation has no
    // prompt variant, cap or known-issues list. `briefs` is filled in by briefCheck.
    const base = { model: $("evModel").value, effort: $("evEffort").value, tools: REFERENCE.tools };
    return {
      ...common, phase: "investigation", preset: "investigation", base,
      conds: [{ label: modelName(base.model), settings: base }],
      briefSet: $("evBriefSet").value, briefIds: briefLines(), briefs: null,
    };
  }
  const base = {
    model: $("evModel").value, effort: $("evEffort").value, prompt: radio("evPrompt"), cap: Number(radio("evCap")),
    tools: REFERENCE.tools, workflow: REFERENCE.workflow, known_issues: REFERENCE.known_issues,
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
  return { ...common, phase: "discovery", preset, base, conds,
           tables: tableBoxes.filter((c) => c.checked).map((c) => c.value) };
}

function problems(f) {
  const inv = f.phase === "investigation";
  const p = PRESETS[f.preset];
  // The option is disabled, so this only catches a stale form.
  if (!inv && f.mode === "live" && !LIVE_PRESETS.has(f.preset)) {
    return "This experiment cannot run on the deployed Runtime yet.";
  }
  if (!f.conds.length) return p.axis === "model" ? "List at least one model ID." : "Tick at least one condition.";
  // Only the models the dropdown offers: the Runtime refuses any other. (E1's
  // free-text list is where another one could come from.)
  const unknown = f.conds.map((c) => c.settings.model).find((m) => !modelOpt(m));
  if (unknown !== undefined) return `“${unknown || "(blank)"}” is not one of the models the Runtime offers.`;
  // E1's list can pair the effort chosen with a model that does not take it.
  const odd = f.conds.find((c) => !effortsFor(c.settings.model).includes(c.settings.effort));
  if (odd) return `${modelName(odd.settings.model)} does not take ${EFFORT_NAMES[odd.settings.effort]} effort.`;
  if (!inv && !f.tables.length) return "Select at least one table.";
  if (!Number.isInteger(f.runs) || f.runs < 1 || f.runs > 10) return "Runs per condition must be a whole number from 1 to 10.";
  if (!Number.isInteger(f.parallel) || f.parallel < 1 || f.parallel > 32) {
    return "Sessions in parallel must be a whole number from 1 to 32.";
  }
  return "";
}

// A discovery run's size before it starts: its sessions.
function scale(f) {
  let sessions = 0;
  for (const { settings: s } of f.conds) {
    // The synthesis pass is a session of its own.
    sessions += (s.workflow === "whole" ? 1 : f.tables.length + (s.workflow === "synthesis" ? 1 : 0)) * f.runs;
  }
  return { sessions };
}

// From COST, so only when every condition is that model (and, for discovery, per
// table). An investigation of a brief is costed as one of a flag.
function estimate(f) {
  if (!f.conds.every((c) => c.settings.model === COST.model)) return null;
  if (f.phase === "investigation") return f.briefs.ids.length * f.conds.length * f.runs * COST.perFlag;
  if (!f.conds.every((c) => c.settings.workflow === "per_table")) return null;
  return scale(f).sessions * COST.discovery;
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
let checking = false;         // an investigation launch is waiting on briefCheck
$("evForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (checking) return;
  const f = readForm();
  const err = problems(f);
  $("evErr").textContent = err;
  if (err) return;
  if (f.phase === "discovery") {
    if (f.mode !== "live" || confirmLive(f)) launch(f);
    return;
  }
  // An investigation's units are its briefs, and only the Runtime knows which it
  // holds, so it is asked before the run is laid out (and before the cost is put).
  const btn = $("evLaunch"), label = btn.textContent;
  checking = true;
  btn.disabled = true;
  btn.textContent = "Checking the Runtime…";
  try {
    f.briefs = await briefCheck(f);
  } catch (x) {
    $("evErr").textContent = x.message;
    return;
  } finally {
    checking = false;
    btn.disabled = false;
    btn.textContent = label;
  }
  if (confirmBriefs(f)) launch(f);
});

// The step that spends money, so it asks first. A native dialog: it takes focus,
// traps it, and is announced, with nothing to build.
const KEEP_OPEN = "Keep this tab open until it ends: the tab is what drives the run, and closing it stops it.";
function confirmLive(f) {
  const cost = estimate(f);
  const money = cost == null ? "Each session is billed; there is no measured cost for this configuration yet."
    : `Rough cost of discovery: about ${usd(cost)}.`;
  return window.confirm(
    `Launch a live evaluation?\n\n${plural(scale(f).sessions, "discovery session")} on the deployed Runtime, ` +
    `up to ${f.parallel} at a time, each billed through the LiteLLM proxy. ${money}\n\n${KEEP_OPEN}`);
}

function confirmBriefs(f) {
  const { set, version, ids } = f.briefs;
  const cost = estimate(f);
  const money = cost == null ? "Each one is billed; there is no measured cost for this model yet."
    : `Rough cost: about ${usd(cost)}, at what investigating one discovery flag cost.`;
  return window.confirm(
    `Launch a live investigation evaluation?\n\n${plural(ids.length * f.runs, "investigation")} by ` +
    `${f.conds[0].label} at ${EFFORT_NAMES[f.base.effort]} effort: ${plural(ids.length, "brief")} of ${set} ` +
    `v${version}${f.runs > 1 ? `, ${plural(f.runs, "run")} of each` : ""}. Each is its own conversation on the deployed Runtime, ` +
    `up to ${f.parallel} at a time, billed through the LiteLLM proxy. ${money}\n\n${KEEP_OPEN}`);
}

$("evModels").value = REFERENCE.model;
$("evParallel").value = REF_PARALLEL;
applyPreset("ref");
setRadio("evPhase", "discovery");
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
  const inv = f.phase === "investigation";
  const ev = {
    id: `ev-${evals.length + 1}`, mode: f.mode, phase: f.phase, preset: f.preset, f,
    // An investigation is named by its model, so evaluations of several models
    // launched side by side can be told apart in the list.
    title: inv ? `Investigation · ${f.conds[0].label} · ${f.briefs.set} v${f.briefs.version}`
               : presetOpts.find((o) => o.value === f.preset).dataset.text,
    short: inv ? `Investigation · ${f.conds[0].label}`
               : f.preset === "ref" ? "Reference" : f.preset === "custom" ? "Custom" : f.preset,
    conds: f.conds.map((c, i) => ({ ...c, key: "c" + i })),
    status: f.mode === "live" ? "running" : "resetting", started: Date.now(), ended: null,
    units: [], sessions: new Map(), log: [],
  };
  // One unit per session the plan needs. An investigation's are keyed cond|run|brief,
  // one per brief, with the brief id where a discovery session has its table.
  // Discovery's are keyed cond|run|table, with "*" for a whole-warehouse session and
  // "+" for a run's synthesis pass; `after` holds what must end first: the previous
  // table in a chain, or every table of the run for its synthesis pass.
  for (const c of ev.conds) {
    const w = c.settings.workflow;
    for (let r = 1; r <= f.runs; r++) {
      if (inv) {
        for (const id of f.briefs.ids) {
          ev.units.push({ key: `${c.key}|${r}|${id}`, cond: c.key, run: r, table: id, brief: id, kind: "brief",
                          after: [] });
        }
        continue;
      }
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
    const { type, ...counters } = sessionEvent(newJob(u));
    ev.sessions.set(u.key, { ...u, ...counters });
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
  ev.handle = harness({ phase: f.phase, units: ev.units, parallel: f.parallel, conds, tables: f.tables,
                        briefs: f.briefs }, (e) => onHarnessEvent(ev, e));
  $("evIntro").hidden = true;
  show(ev);
  announce(`Evaluation ${ev.id} launched: ${plural(ev.units.length, inv ? "investigation" : "discovery session")}.`);
  view.title.focus();
}

function onHarnessEvent(ev, e) {
  if (e.type === "status") {
    ev.status = e.status;
    if (e.status === "awaiting_scoring" || e.status === "stopped") ev.ended = Date.now();
    if (e.status === "awaiting_scoring") {
      const all = [...ev.sessions.values()];
      announce(`Evaluation ${ev.id} finished. ` + (ev.phase === "investigation"
        ? `${plural(all.filter((s) => s.outcome).length, "investigation")} await the judge.`
        : `${plural(sum(all, "flags"), "flag")} await scoring.`));
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
  view = { ev, cond: ev.conds[0].key, cells: new Map(), rowTotals: new Map(), selected: null, open: new Set(),
           logCount: 0 };

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

  // One bar per kind of session the plan has.
  const prog = el("div", "ev-progress");
  view.bars = {};
  const phases = ev.phase === "investigation" ? [["inv", "Investigation"]] : [["disc", "Discovery"]];
  if (ev.units.some((u) => u.kind === "synthesis")) phases.push(["synth", "Synthesis"]);
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

  // An investigation's counts are of what the agent claimed, as a discovery's flags
  // are: a conclusive cause is not a correct one, and only the judge says which.
  const dl = el("dl", "ev-totals");
  view.tot = {};
  const totals = ev.phase === "investigation"
    ? [["sessions", "Investigations complete"], ["conclusive", "Conclusive causes"],
       ["inconclusive", "Inconclusive or none"], ["turns", "Model turns"]]
    : [["sessions", "Sessions complete"], ["flags", "Flags raised"], ["turns", "Model turns"]];
  for (const [k, label] of totals) {
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
  const heads = ev.phase === "investigation" ? ["Condition", "Investigated", "Conclusive", "Problems"]
                                             : ["Condition", "Discovery", "Flags", "Problems"];
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
// pass) or briefs, columns are runs. Rebuilt only when the condition on show
// changes. A cell opens to the list of its session's flags (an investigation's
// one ticket), and closes again on a second pick; several can be open at once.
function buildGrid() {
  const ev = view.ev, c = ev.conds.find((x) => x.key === view.cond);
  const inv = ev.phase === "investigation";
  view.cells.clear();
  view.rowTotals.clear();
  const t = el("table", "ev-matrix");
  t.appendChild(el("caption", null, `${inv ? "Investigations" : "Sessions"}` +
    `${ev.conds.length > 1 ? " · " + c.label : ""}. ` + (inv
      ? "Rows are briefs, columns are runs; pick a cell for its ticket and counters."
      : "Rows are tables, columns are runs; pick a cell for its flags and counters.")));
  const hr = el("tr");
  const heads = [inv ? "Brief" : "Table", ...Array.from({ length: ev.f.runs }, (_, i) => `Run ${i + 1}`),
                 inv ? "Conclusive" : "Flags"];
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
      const sym = el("span", "sym"), text = el("span"), chev = el("span", "chev");
      sym.setAttribute("aria-hidden", "true");
      chev.setAttribute("aria-hidden", "true");
      b.append(sym, text, chev);
      const list = el("ol", "ev-cellflags");
      list.id = `${ev.id}-flags-${key.replace(/[^\w-]/g, "_")}`;
      list.hidden = true;
      b.setAttribute("aria-controls", list.id);
      b.addEventListener("click", () => {
        view.selected = key;
        if (!view.open.delete(key)) view.open.add(key);
        render();
      });
      td.append(b, list);
      tr.appendChild(td);
      view.cells.set(key, { b, sym, text, chev, list, sig: null });
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
  const inv = ev.phase === "investigation";
  const rows = inv
    ? [["Attribution, mean (0–2)", "—"], ["Explanation, mean (0–2)", "—"], ["Cost per run", "—"]]
    : [["Recall, level 1", "—"], ["Level 2", "—"], ["Precision", "—"], ["F2", "—"],
       ["False positives per run", "—"], ["Pre-existing flags", "—"], ["Recall@k", "—"], ["Cost per run", "—"]];
  for (const [k, v] of rows) dl.append(el("dt", null, k), el("dd", null, v));
  box.append(dl, el("p", "foot", inv
    ? "The judge is not built yet. It grades each recorded root cause 0–2 for attribution and for " +
      "explanation against the defect's manifest, without knowing which model wrote it."
    : "The scorer is not built yet. Until the freeze it reports the dev split (15 defects) only, " +
      "and transcripts show any flag that matches a test defect as “[held-out match]”."));
  return box;
}

function stateText(s) {
  switch (s.state) {
    // Turns, not graph steps: the Runtime reports each model turn as it lands,
    // and a turn plus its tool calls is about two of the 250 steps.
    case "discovery": return `discovery · ${plural(s.turns, "turn")}`;
    case "investigating": return `investigating · ${plural(s.turns, "turn")}`;
    case "step_limit": return "step limit";
    case "error": return "failed";
    default: return s.state;      // queued, done, cancelled
  }
}

function cellText(s) {
  const t = stateText(s);
  const again = s.retried?.length ? ` · ${plural(s.retried.length, "retry", "retries")}` : "";
  if (s.kind === "brief") return s.outcome && s.state !== "investigating" ? `${t} · ${s.outcome}${again}` : t + again;
  if (s.state === "queued" || (s.state === "cancelled" && !s.flags)) return t;
  return `${t} · ${plural(s.flags, "flag")}${again}`;
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
  view.stop.hidden = !["resetting", "running"].includes(ev.status);
  view.elapsed.textContent = clock((ev.ended || Date.now()) - ev.started);

  const all = [...ev.sessions.values()];
  const past = (s) => ENDED.includes(s.state);
  const conclusive = (list) => list.filter((s) => s.outcome === "conclusive").length;
  const inconclusive = (list) => list.filter((s) => s.outcome && s.outcome !== "conclusive").length;
  const main = all.filter((s) => s.kind !== "synthesis"), syn = all.filter((s) => s.kind === "synthesis");

  const bar = (k, done, total, unit, units) => {
    if (!view.bars[k]) return;
    view.bars[k].bar.max = Math.max(total, 1);
    view.bars[k].bar.value = done;
    view.bars[k].txt.textContent = `${fmt(done)} / ${plural(total, unit, units)}`;
  };
  bar("disc", main.filter(past).length, main.length, "session");
  bar("inv", main.filter(past).length, main.length, "brief");
  bar("synth", syn.filter(past).length, syn.length, "pass", "passes");

  view.tot.sessions.textContent = `${fmt(all.filter(past).length)} / ${fmt(all.length)}`;
  if (view.tot.flags) view.tot.flags.textContent = fmt(sum(all, "flags"));
  if (view.tot.conclusive) {
    view.tot.conclusive.textContent = fmt(conclusive(all));
    view.tot.inconclusive.textContent = fmt(inconclusive(all));
  }
  view.tot.turns.textContent = fmt(sum(all, "turns"));

  if (view.condRows) {
    for (const [key, { b, tds }] of view.condRows) {
      const mine = all.filter((s) => s.cond === key);
      const d = mine.filter((s) => s.kind !== "synthesis");
      const cols = [`${d.filter(past).length} / ${d.length}`,
                    fmt(ev.phase === "investigation" ? conclusive(mine) : sum(mine, "flags"))];
      cols.push(fmt(mine.filter((s) => s.result === "step_limit" || s.result === "error").length));
      cols.forEach((v, i) => { tds[i].textContent = v; });
      b.setAttribute("aria-current", String(key === view.cond));
    }
  }

  for (const [key, cell] of view.cells) {
    const s = ev.sessions.get(key), open = view.open.has(key);
    cell.b.className = `ev-cell st-${s.state}`;
    cell.sym.textContent = GLYPH[s.state];
    cell.text.textContent = cellText(s);
    cell.chev.textContent = open ? "▾" : "▸";
    cell.b.setAttribute("aria-current", String(key === view.selected));
    cell.b.setAttribute("aria-expanded", String(open));
    cell.list.hidden = !open;
    if (open) renderCellFlags(cell, s, ev.handle.sessionFlags(key));
  }
  for (const [table, td] of view.rowTotals) {
    const row = all.filter((s) => s.cond === view.cond && s.table === table);
    td.textContent = fmt(ev.phase === "investigation" ? conclusive(row) : sum(row, "flags"));
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

// An open cell's flags, one line each: number, title, dimension, and status when
// it is not plain "flagged" (a withdrawn known issue; an investigation's ticket,
// once worked). Rebuilt only when they change, not on every tick of the clock.
function renderCellFlags(cell, s, flags) {
  const sig = JSON.stringify([s.state, flags.map((f) => [f.n, f.title, f.dimension, f.status])]);
  if (sig === cell.sig) return;
  cell.sig = sig;
  const brief = s.kind === "brief";
  const items = flags.map((f) => {
    const li = el("li");
    const tag = [f.dimension, f.status !== "flagged" && f.status].filter(Boolean).join(" · ");
    if (!brief) li.append(el("span", "n", `#${f.n}`));    // a brief's ticket is always #1
    li.append(f.title || "(untitled)");
    if (tag) li.append(el("span", "dim", ` · ${tag}`));
    return li;
  });
  if (!items.length) {
    const over = ENDED.includes(s.state);
    items.push(el("li", "none", s.state === "queued" ? "Not started yet."
      : brief ? "No ticket: the Runtime did not start this brief." : over ? "No flags." : "No flags yet."));
  }
  cell.list.replaceChildren(...items);
}

function renderDetail() {
  const box = view.detail;
  const s = view.selected && view.ev.sessions.get(view.selected);
  if (!s) {
    if (!box.firstChild) box.appendChild(el("p", "empty", "Pick a cell in the session grid to see its counters."));
    return;
  }
  const c = view.ev.conds.find((x) => x.key === s.cond);
  const brief = s.kind === "brief";
  const dl = el("dl");
  const row = (k, v, cls) => dl.append(el("dt", null, k), el("dd", cls, v));
  row(brief ? "Brief" : "Session", `${ROW_NAMES[s.table] || s.table} · run ${s.run}`);
  if (view.ev.conds.length > 1) row("Condition", c.label);
  row("State", stateText(s));
  if (s.why) row("Why", s.why);
  (s.warnings || []).forEach((w, i) => row(i ? "" : "Warnings", w));
  (s.retried || []).forEach((w, i) => row(i ? "" : "Started over after", w));
  if (brief) row("Outcome", s.outcome || "—");
  else row("Flags", fmt(s.flags));
  row("Model turns", fmt(s.turns));
  row("Tool calls", fmt(s.tools));
  row("Time", s.started ? clock((s.ended || Date.now()) - s.started) : "—");
  row("Session ID", s.id || "assigned when it starts", s.id ? "mono" : null);
  box.replaceChildren(dl, el("p", "foot", view.ev.mode !== "live"
    ? "The transcript opens after scoring, with any match to a held-out defect redacted."
    : brief ? "The ticket, the root cause it recorded and the transcript are in the downloaded results."
    : "Each flag's finding and evidence, and the transcript, are in the downloaded results."));
}

// The scorer's input: everything a live run captured, flag text included.
function downloadResults(ev) {
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const data = {
    evaluation: ev.id, phase: ev.phase, mode: ev.mode, status: ev.status, started: iso(ev.started),
    ended: iso(ev.ended), saved: iso(Date.now()), runtime: CFG.runtimeArn, preset: ev.preset,
    settings: ev.f.base,
    // What the run covered: a discovery's tables, or the brief set, its version (as
    // the Runtime reported it) and the briefs run.
    ...(ev.phase === "investigation" ? { briefs: ev.f.briefs } : { tables: ev.f.tables }),
    runs: ev.f.runs, parallel: ev.f.parallel, session_retries: SESSION_RETRIES,
    conditions: ev.conds.map((c) => ({ key: c.key, label: c.label, settings: c.settings })),
    sessions: ev.handle.results(),
  };
  const stamp = iso(ev.started).slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = `autodqa-${ev.id}${ev.phase === "investigation" ? "-investigation" : ""}-${stamp}.json`;
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
const newJob = (u) => ({ ...u, state: "queued", result: null, steps: 0, turns: 0, tools: 0, flags: 0,
                         outcome: null, id: null, started: null, ended: null,
                         why: null, warnings: [], attempts: [] });

// `why` is what ended a session that did not finish; `warnings`, what went wrong
// along the way that the session carried on past; `retried`, what ended each attempt
// the session started over after; `outcome`, how an investigation's ticket ended.
const sessionEvent = (j) => ({ type: "session", key: j.key, state: j.state, result: j.result,
  steps: j.steps, turns: j.turns, tools: j.tools, flags: j.flags, outcome: j.outcome, id: j.id,
  started: j.started, ended: j.ended, why: j.why, warnings: j.warnings.map((w) => w.message),
  retried: j.attempts.map((a) => a.why) });

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

// How the activity log names a session: "Run 2 · ENCOUNTER", or "Run 1 · BUG-015".
function sessionNamer(conds) {
  const multi = Object.keys(conds).length > 1;
  return { name: (j) => `${multi ? conds[j.cond].label + " · " : ""}Run ${j.run} · ${ROW_NAMES[j.table] || j.table}` };
}

// ---- Asking the Runtime ---------------------------------------------------------
const runtimeHeaders = (conv, token) => ({
  "Authorization": `Bearer ${token}`,
  "Content-Type": "application/json",
  "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": conv,   // pins the conversation's microVM
});

// Best-effort, like the chat's New chat: the idle timeout is the guarantee.
async function purgeConversation(conv) {
  try {
    const token = await freshAccessToken();
    await fetch(runtimeUrl(), { method: "POST", headers: runtimeHeaders(conv, token),
                                body: JSON.stringify({ action: "end_session", conversation: conv }) });
  } catch { /* nothing to do: the Runtime drops it after 15 idle minutes anyway */ }
}

// One question outside any run, on conversation `conv`: the first event of type
// `want` in the answer, or null when there is none (a Runtime that predates the
// question answers with an error event instead).
async function askRuntime(conv, body, want) {
  let res;
  try {
    const token = await freshAccessToken();
    res = await fetch(runtimeUrl(), { method: "POST", headers: runtimeHeaders(conv, token),
                                      body: JSON.stringify({ ...body, conversation: conv }) });
  } catch (e) {
    throw new Error(`Could not reach the deployed Runtime: ${e.message}`);
  }
  if (!res.ok) throw new Error(`The deployed Runtime answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  // A short answer that ends on its own, so it is read whole rather than streamed.
  for (const raw of (await res.text()).split("\n")) {
    const t = raw.trim();
    if (!t.startsWith("data:")) continue;
    let e;
    try { e = JSON.parse(t.slice(5).trim()); } catch { continue; }
    if (e.type === want) return e;
  }
  return null;
}

// Before an investigation launches: does the Runtime take every model at its
// effort, and briefs at all, and which briefs of the set does it hold? Returns
// { set, version, status, ids }, the ids the run covers in the set's order (every
// brief, or the ones the form names, matched whatever their case). Both questions
// go on one conversation, purged after.
async function briefCheck(f) {
  const conv = "eval-" + crypto.randomUUID();
  try {
    const have = await askRuntime(conv, { action: "settings" }, "settings");
    if (!have?.briefs) {
      throw new Error("The deployed Runtime cannot investigate a brief yet. Deploy agentcore-runtime.");
    }
    for (const { settings: c } of f.conds) {
      if (!have.models.includes(c.model)) throw new Error(`The deployed Runtime does not offer ${modelName(c.model)}.`);
      if (!have.efforts[c.model]?.includes(c.effort)) {
        throw new Error(`The deployed Runtime does not offer ${EFFORT_NAMES[c.effort]} effort for ${modelName(c.model)}.`);
      }
    }
    const sets = (await askRuntime(conv, { action: "briefs" }, "briefs"))?.sets || [];
    const s = sets.find((x) => x.set === f.briefSet);
    if (!s) {
      throw new Error(`The deployed Runtime has no brief set “${f.briefSet}”` +
                      (sets.length ? `; it has ${sets.map((x) => x.set).join(", ")}.` : "."));
    }
    const up = (id) => id.toUpperCase();
    const missing = f.briefIds.filter((id) => !s.ids.some((x) => up(x) === up(id)));
    if (missing.length) throw new Error(`${s.set} v${s.version} has no brief ${missing.join(", ")}.`);
    const want = new Set(f.briefIds.map(up));
    const ids = want.size ? s.ids.filter((x) => want.has(up(x))) : s.ids;
    if (!ids.length) throw new Error(`${s.set} v${s.version} holds no briefs.`);
    return { set: s.set, version: s.version, status: s.status ?? null, ids };
  } finally {
    purgeConversation(conv);
  }
}

// ---- RuntimeHarness ---------------------------------------------------------------
// The live harness. Each unit is a conversation of its own with the deployed
// Runtime, and so its own session microVM:
//
//   discovery      the table's task, with the known-issues list's entries for the
//                  table;
//   investigation  { action: "investigate", brief: { set, version, id } }. The
//                  Runtime seeds the brief as ticket #1 of the new conversation and
//                  investigates it alone. The request names the brief; its text
//                  comes from the Runtime's bundle, and back on the stream as the
//                  ticket, like any other.
//
// When every session has ended, the run is over. Discovery's flags are not
// investigated here: the investigation phase is an evaluation of its own, on the
// briefs, so what a model happened to flag never decides what it is graded on.
//
// Everything a session streams -- flags or the ticket, the transcript -- is kept
// here for results(), and only counts go to the monitor. Every conversation is
// purged on the Runtime as soon as it ends, so the download is the record.
//
// Each request names its condition's model and effort, a discovery request its
// prompt variant and cap, and an investigation its brief; the Runtime echoes them
// in its done event, and a session it ran on anything else fails. Not covered:
// resetting the warehouse, the synthesis and chained workflows, and varying the
// tools. Each needs a change on the Runtime side.
function RuntimeHarness(plan, onEvent) {
  const STOP_GRACE_MS = 15000;   // how long a stopped conversation gets to say it has stopped
  const inv = plan.phase === "investigation";
  const ended = (j) => ENDED.includes(j.state);
  const jobs = new Map(plan.units.map((u) => [u.key, {
    ...newJob(u), task: null, issues: new Map(), transcript: [], errors: [],
    discovery: null, investigation: null, known: null }]));
  const order = startOrder([...jobs.values()], plan.conds);
  const { name } = sessionNamer(plan.conds);
  const log = (text, bad) => onEvent({ type: "log", text, bad });
  const emit = (j) => onEvent(sessionEvent(j));
  const status = (s) => onEvent({ type: "status", status: s });
  // What holds a parallel slot: one conversation, { j, conv, abort }.
  const running = new Set();
  let stopping = false;           // the run was asked to stop
  let finished = false;
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

  // An error that says nothing about the session itself, so it can start over.
  const retryable = (e) => Object.assign(e, { retry: true });

  // One streaming invoke on a conversation. Resolves when the stream ends; the
  // caller checks that a done event arrived. A network failure, or a 429 or 5xx
  // from the Runtime's endpoint, comes out marked retryable.
  async function call(w, body, onEv) {
    const token = await freshAccessToken();
    w.abort = new AbortController();
    const res = await fetch(runtimeUrl(), {
      method: "POST",
      headers: runtimeHeaders(w.conv, token),
      body: JSON.stringify({ ...body, conversation: w.conv }),
      signal: w.abort.signal,
    }).catch((e) => { throw retryable(e); });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      throw res.status === 429 || res.status >= 500 ? retryable(err) : err;
    }
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
      const { value, done } = await reader.read().catch((e) => { throw retryable(e); });
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

  // Counts what every session streams; returns false for events it does not handle.
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
    model: d.model, effort: d.effort ?? null, max_output_tokens: d.max_output_tokens ?? null,
    thread_messages: d.thread_messages, runtime_session: d.session, known_check: d.known_check ?? null,
    brief: d.brief ?? null });

  // A request the Runtime refuses (a list or version, model, prompt, cap or brief it
  // does not have) gets one error event before any model turn, and no done: that
  // error is the reason. A stream that just stops is retryable.
  const noDone = (j) => {
    const refused = !j.turns && j.errors.at(-1)?.message;
    return refused ? new Error(refused) : retryable(new Error("the stream ended without saying why"));
  };

  // How a done event's reason reads as the session's state. An error the Runtime
  // caught, such as a model call that failed past its own retries, is retryable.
  // "truncated" is the agent's own ending (its last reply ran out of output partway
  // through a call) and stays "error" without a retry.
  function ending(done) {
    if (done.reason === "error") throw retryable(new Error(done.message || "the Runtime reported an error"));
    return { completed: "done", step_limit: "step_limit", cancelled: "cancelled" }[done.reason] || "error";
  }

  // With a known-issues list, the Runtime appends the session's slice of it -- the
  // entries for j.table, or every entry for "*" -- to the task, and says which ids
  // it showed before any model call. When the agent has finished, its check of the
  // flags against those entries withdraws the ones that repeat one (issue_update,
  // status "known"). A session's count is of the flags it kept.
  async function discover(j, w) {
    let done = null;
    const { known_issues: list, model, effort, prompt, cap } = plan.conds[j.cond];
    const body = { task: j.task, model, effort, prompt_variant: prompt, max_issues: cap };
    if (list !== "off") {
      Object.assign(body, { table: j.table, known_issues: { list, version: known.get(list) }, known_check: true });
    }
    await call(w, body, (e) => {
      if (e.type === "issue" || e.type === "issue_update") {
        j.issues.set(e.issue.n, e.issue);
        j.flags = [...j.issues.values()].filter((i) => i.status !== "known").length;
      } else if (e.type === "known_issues") {
        j.known = { list: e.list, version: e.version, table: e.table, ids: e.ids };
        return;
      } else if (e.type === "done") {
        done = e;
        return;
      } else if (!common(j, "discovery", e)) return;   // trace, heartbeat, sandbox
      emit(j);
    });
    if (!done) throw noDone(j);
    if (list !== "off" && !j.known) throw new Error("the Runtime ran the session without the known-issues list");
    j.discovery = doneStats(done);
    if (done.model !== model || done.effort !== effort || done.prompt_variant !== prompt || done.issue_max !== cap) {
      throw new Error(`the Runtime ran the session on ${done.model ?? "its default model"} at effort ` +
                      `${done.effort ?? "(default)"} with prompt ${done.prompt_variant ?? "(none)"} and cap ` +
                      `${done.issue_max}, not ${model} at ${effort}, ${prompt} and ${cap}`);
    }
    return ending(done);
  }

  // How an investigation's ticket ended, in its own terms: a cause the agent called
  // conclusive, one it did not, or none -- the Runtime closed the ticket for it,
  // which leaves no evidence. Null while the ticket is open.
  const outcomeOf = (i) => (i.status === "explained" ? "conclusive"
    : i.status !== "inconclusive" ? null
    : i.root_cause?.evidence == null ? "no cause recorded" : "inconclusive");

  // One brief, as ticket #1 of a new conversation. The ticket arrives on the stream
  // (issue_update) as soon as the Runtime has seeded it, and again as it is worked.
  async function investigate(j, w) {
    let done = null;
    const { model, effort } = plan.conds[j.cond];
    const brief = { set: plan.briefs.set, version: plan.briefs.version, id: j.brief };
    const take = (i) => {
      j.issues.set(i.n, i);
      j.outcome = outcomeOf(i);
    };
    await call(w, { action: "investigate", brief, model, effort }, (e) => {
      if (e.type === "issue_update") take(e.issue);
      else if (e.type === "report") e.issues.forEach(take);
      else if (e.type === "done") { done = e; return; }
      else if (!common(j, "investigation", e)) return;   // brief, phase, trace, heartbeat, sandbox
      emit(j);
    });
    if (!done) throw noDone(j);
    j.investigation = doneStats(done);
    const got = done.brief;
    if (got?.set !== brief.set || String(got?.version) !== String(brief.version) || got?.id !== brief.id) {
      throw new Error(`the Runtime investigated ${got ? `${got.set} v${got.version} ${got.id}` : "no brief"}, ` +
                      `not ${brief.set} v${brief.version} ${brief.id}`);
    }
    if (done.model !== model || done.effort !== effort) {
      throw new Error(`the Runtime investigated on ${done.model ?? "its default model"} at effort ` +
                      `${done.effort ?? "(default)"}, not ${model} at ${effort}`);
    }
    return ending(done);
  }

  // Files a failed attempt under j.attempts and clears what the next one rebuilds,
  // so the session's flags (or ticket), transcript and counters are its last
  // attempt's alone.
  function startOver(j, conv, began, why) {
    const iso = (t) => new Date(t).toISOString();
    j.attempts.push({ session: conv, started: iso(began), ended: iso(Date.now()), why,
                      model_turns: j.turns, tool_calls: j.tools, flags: [...j.issues.values()],
                      known_issues: j.known, errors: j.errors, warnings: j.warnings, transcript: j.transcript });
    Object.assign(j, { issues: new Map(), flags: 0, outcome: null, turns: 0, tools: 0, transcript: [], errors: [],
                       warnings: [], known: null, discovery: null, investigation: null });
  }

  // One slot for the whole session: its retries keep it rather than queueing again.
  async function runJob(j) {
    const w = { j, conv: null, abort: null };
    const phase = inv ? "investigation" : "discovery";
    j.state = inv ? "investigating" : "discovery";   // before any await, so the pump cannot start it twice
    j.started = Date.now();
    if (!inv) j.task = taskFor(j);
    running.add(w);
    for (;;) {
      w.conv = j.id = "eval-" + crypto.randomUUID();
      const began = Date.now();
      emit(j);
      let retry = false;
      try {
        j.result = await (inv ? investigate(j, w) : discover(j, w));
      } catch (e) {
        j.result = stopping ? "cancelled" : "error";
        retry = !!e.retry;
        if (!stopping && j.errors.at(-1)?.message !== e.message) j.errors.push({ phase, message: e.message });
      }
      purgeConversation(w.conv);
      if (!retry || stopping || j.attempts.length >= SESSION_RETRIES) break;
      const why = j.errors.at(-1)?.message ?? "the attempt failed";
      log(`${name(j)}: ${why.slice(0, 240)}`, true);
      log(`${name(j)}: starting over in a new conversation (retry ${j.attempts.length + 1} of ` +
          `${SESSION_RETRIES}); what this attempt did is set aside (${plural(j.turns, "model turn")}` +
          `${inv ? "" : `, ${plural(j.flags, "flag")}`}).`, true);
      startOver(j, w.conv, began, why);
      emit(j);
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
      if (stopping) {
        j.result = "cancelled";
        break;
      }
    }
    running.delete(w);
    j.state = j.result || "error";
    j.ended = Date.now();
    if (j.state === "error" || j.state === "step_limit") j.why = j.errors.at(-1)?.message ?? null;
    emit(j);
    if (j.result === "error" && j.errors.length) log(`${name(j)}: ${j.errors.at(-1).message.slice(0, 240)}`, true);
    const what = { done: "done", step_limit: `hit the ${STEP_LIMIT}-step limit${inv ? "" : ", flags so far kept"}`,
                   error: "failed", cancelled: "cancelled" }[j.state];
    const got = inv ? j.outcome || "no ticket" : plural(j.flags, "flag");
    const warned = j.warnings.length ? `, ${plural(j.warnings.length, "warning")}` : "";
    const again = j.attempts.length ? `, after ${plural(j.attempts.length, "retry", "retries")}` : "";
    log(`${name(j)}: ${what} · ${got}, ${plural(j.turns, "model turn")}${warned}${again}, ` +
        `${clock(j.ended - j.started)}.`, j.state !== "done");
  }

  function pump() {
    if (finished) return;
    for (const j of order) {
      if (stopping || running.size >= plan.parallel) break;
      if (j.state === "queued" && j.after.every((k) => ended(jobs.get(k)))) {
        runJob(j).catch((e) => log(`${name(j)}: ${e.message}`, true)).finally(pump);
      }
    }
    if (running.size || ![...jobs.values()].every(ended)) return;
    finished = true;
    if (stopping) return log("Every session has ended. What they found before the stop is in the results.");
    log(inv ? "Every investigation has ended. Download the results for the judge."
            : "Every session has ended. Download the results for the scorer.");
    status("awaiting_scoring");
  }

  // Ask the Runtime to cancel a conversation's job. It says whether it found one;
  // the stream then ends with a cancelled done event, or is cut after the grace period.
  function stopOne(conv, token, keepalive) {
    try {
      fetch(runtimeUrl(), { method: "POST", headers: runtimeHeaders(conv, token), keepalive,
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

  // The models and their effort levels, prompt variants and cap range the Runtime
  // takes, and whether it checks flags against the known issues. One from before
  // 2026-10-27 answers with an error, as for knownLists(); v29 has no model list,
  // v30 no effort levels, and one from before 2026-10-28 no known-issues check.
  async function settings() {
    const w = { conv: "eval-" + crypto.randomUUID(), abort: null };
    let have = null;
    await call(w, { action: "settings" }, (e) => { if (e.type === "settings") have = e; });
    if (!have?.models || !have.efforts) {
      throw new Error("The deployed Runtime cannot take a model, effort, prompt or cap from the console yet. " +
                      "Deploy agentcore-runtime.");
    }
    for (const c of Object.values(plan.conds)) {
      if (!have.models.includes(c.model)) throw new Error(`The deployed Runtime does not offer ${modelName(c.model)}.`);
      if (!have.efforts[c.model]?.includes(c.effort)) {
        throw new Error(`The deployed Runtime does not offer ${EFFORT_NAMES[c.effort]} effort for ${modelName(c.model)}.`);
      }
      if (!have.prompt_variants.includes(c.prompt)) throw new Error(`The deployed Runtime has no prompt ${c.prompt}.`);
      if (c.cap > have.cap_ceiling) throw new Error(`The deployed Runtime caps a session at ${have.cap_ceiling} issues.`);
      if (c.known_issues !== "off" && !have.known_check) {
        throw new Error("The deployed Runtime does not check flags against the known issues yet. Deploy agentcore-runtime.");
      }
    }
  }

  // A discovery run starts once the Runtime has said it takes every condition's
  // model, prompt and cap and, with a known-issues list, which version of the list
  // it holds. An investigation run's questions were asked before launch
  // (briefCheck), since its sessions are the briefs the Runtime holds.
  async function start() {
    if (inv) {
      const { set, version, ids } = plan.briefs;
      log(`Each investigation starts from one brief of ${set} v${version}, as the only ticket of a new ` +
          `conversation: ${plural(ids.length, "brief")} per run.`);
      log(`Starting ${plural(jobs.size, "investigation")}, up to ${plan.parallel} at a time.`);
      return pump();
    }
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
      finished = true;
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
    // Ends the run: the sessions not started are cancelled, and the ones in flight
    // are told to stop. What the ended ones found is kept.
    stop() {
      if (stopping || finished) return;
      stopping = true;
      for (const j of jobs.values()) {
        if (j.state !== "queued") continue;
        j.state = j.result = "cancelled";
        emit(j);
      }
      stopRunning();
      log(running.size ? `Stopping ${plural(running.size, "session")} in flight; ` +
                         "the ones that had ended keep what they found." : "Stopped.", true);
      status("stopped");
      pump();
    },
    sessionFlags: (key) => [...(jobs.get(key)?.issues.values() ?? [])].sort((a, b) => a.n - b.n)
      .map(({ n, title, dimension, status }) => ({ n, title, dimension, status })),
    results() {
      const iso = (t) => (t ? new Date(t).toISOString() : null);
      // Attempts that failed for reasons outside the agent, set aside before the
      // retry: what they found is a record, not part of the session's.
      return order.map((j) => (inv ? {
        key: j.key, condition: plan.conds[j.cond].label, run: j.run, brief: j.brief, session: j.id,
        state: j.state, started: iso(j.started), ended: iso(j.ended),
        // The ticket as the Runtime last sent it: the brief's served fields, its
        // status, and the root cause the agent recorded (or the Runtime's note when
        // it recorded none).
        ticket: [...j.issues.values()][0] ?? null, outcome: j.outcome, investigation: j.investigation,
        errors: j.errors, warnings: j.warnings, transcript: j.transcript, attempts: j.attempts,
      } : {
        key: j.key, condition: plan.conds[j.cond].label, run: j.run,
        table: j.table === "*" ? null : j.table, kind: j.kind, session: j.id, task: j.task,
        state: j.state, started: iso(j.started), ended: iso(j.ended),
        flags: [...j.issues.values()], known_issues: j.known, discovery: j.discovery,
        errors: j.errors, warnings: j.warnings, transcript: j.transcript, attempts: j.attempts,
      }));
    },
  };
}

// ---- MockHarness ----------------------------------------------------------------
// Stands in for the harness the design calls for, so the monitor has something to
// show for a discovery experiment the Runtime cannot run yet. The contract every
// harness keeps:
//   Harness(plan, onEvent) -> { stop(), sessionFlags(key) }, and RuntimeHarness
//     adds results()
//   plan:  { phase, units: [{ key, cond, run, table, kind, after }], parallel,
//            conds: { [key]: { label, ...settings } }, tables, briefs }
//   onEvent receives
//     { type: "status", status }             resetting | running | awaiting_scoring | stopped
//     { type: "session", key, ...counters }  a session's state and running totals
//     { type: "log", text, bad }             one line for the activity log
// When every session has ended the run awaits scoring; stop() ends it early.
// sessionFlags(key) gives one session's flags so far (an investigation's one
// ticket), at any point, as { n, title, dimension, status }.
// Counts reach the monitor through onEvent, and flag text only through
// sessionFlags(), for a grid cell someone opens. Findings, evidence, root causes
// and transcripts are for the scorer.
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
  let slots = [];               // the sessions in flight
  let timer = null, over = false;

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
    slots.push(j);
    emit(j);
  }

  function settle(j, result) {
    j.state = j.result = result;
    j.ended = Date.now();
    if (result === "done") j.flags = j.finalFlags;
    // A placeholder per flag raised, for a cell's list.
    j.list = Array.from({ length: j.flags }, (_, i) => ({
      n: i + 1, title: `Simulated flag ${i + 1}`, dimension: DIMS[rnd(0, 2)] }));
    emit(j);
    const what = { done: "done", step_limit: `hit the ${STEP_LIMIT}-step limit, flags so far kept`,
                   error: "failed (simulated sandbox error)" }[result];
    log(`${name(j)}: ${what} · ${plural(j.flags, "flag")}, ${j.steps} steps.`, result !== "done");
    return true;
  }

  // Returns true when the slot is free again.
  function step(j) {
    j.steps = Math.min(j.target, j.steps + rnd(5, 15));
    j.turns = Math.ceil(j.steps / 2);
    j.tools = Math.floor(j.steps * 0.55);
    j.flags = Math.floor(j.finalFlags * j.steps / j.target);
    if (j.fate === "error" && j.steps >= j.failAt) return settle(j, "error");
    if (j.steps >= j.target) return settle(j, j.fate);
    emit(j);
    return false;
  }

  function tick() {
    slots = slots.filter((j) => !step(j));
    for (const j of order) {
      if (slots.length >= plan.parallel) break;
      if (j.state === "queued" && j.after.every((k) => ended(jobs.get(k)))) begin(j);
    }
    if (slots.length || ![...jobs.values()].every(ended)) return;
    clearInterval(timer);
    over = true;
    log("Every session has ended. The flags are ready for the scorer.");
    status("awaiting_scoring");
  }

  status("resetting");
  log(`Resetting the warehouse to snapshots/${plan.snapshot} (simulated).`);
  const resetTimer = setTimeout(() => {
    status("running");
    log("Warehouse reset. Discovery started.");
    timer = setInterval(tick, TICK_MS);
  }, 2000);

  return {
    stop() {
      if (over) return;
      over = true;
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
    },
    sessionFlags: (key) => (jobs.get(key)?.list ?? []).map(({ n, title, dimension }) =>
      ({ n, title, dimension, status: "flagged" })),
  };
}

})();
