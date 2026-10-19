// AutoDQA static console — the Evaluation view. Launches a batch of discovery
// sessions (one per table, per run, per condition) and monitors it, following the
// AutoDQA Evaluation Design doc.
//
// DESIGN PREVIEW. There is no harness behind this yet: MockHarness below plays one
// in the browser so the view can be judged against something that moves. Nothing
// reaches the runtime and every number it shows is random. A real harness -- the
// design runs it server-side, through the existing Runtime API -- replaces
// MockHarness and keeps its event shapes (see the comment on it).
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
const REFERENCE = { model: CFG.model, prompt: "K1", cap: 10, tools: "all",
                    workflow: "per_table", investigate: false, snapshot: "injected" };
const REF_RUNS = 3;
const REF_PARALLEL = 8;

const AXIS_NAMES = { model: "model", prompt: "prompt", cap: "issue cap", tools: "tools", workflow: "workflow" };

// One entry per experiment in the design doc. `axis` is the setting it varies and
// `conds` its conditions as [value, short label, long label, ticked by default];
// `set` is anything else it moves off the reference. E1 and C vary the model over
// the free-text list instead of a fixed set.
const PRESETS = {
  ref: { help: "Per-table workflow, K1 prompt, cap 10, the reference model, detection only. " +
               "Every experiment changes one thing from it." },
  E1: { axis: "model", set: { investigate: true },
        help: "Detection and attribution against cost, by model. Every flag is investigated. " +
              "Scored on test and holdout, all five credit levels." },
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
                 awaiting_scoring: "Awaiting scoring", stopped: "Stopped" };
const ROW_NAMES = { "*": "All tables (one session)", "+": "Synthesis pass" };
// The glyph repeats the state; the state is always also spelled out. Shapes are
// from the ones every system font carries -- quarter and half circles are not.
const GLYPH = { queued: "○", discovery: "►", investigating: "◆", done: "●",
                step_limit: "▲", error: "✕", cancelled: "–" };
const ENDED = ["done", "step_limit", "error", "cancelled"];

const fmt = (n) => n.toLocaleString("en-US");
const plural = (n, word, many = word + "s") => `${fmt(n)} ${n === 1 ? word : many}`;
const sum = (list, k) => list.reduce((a, s) => a + s[k], 0);
const optText = (id, v) => $(id).querySelector(`option[value="${v}"]`).textContent;
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
  $("evTools").value = s.tools;
  $("evWorkflow").value = s.workflow;
  $("evInvestigate").checked = s.investigate;
  setRadio("evSnapshot", s.snapshot);
  $("evRunCount").value = p.runs || REF_RUNS;
  $("evPresetHelp").textContent = p.help;

  // The varied setting's own control gives way to the Conditions box.
  document.querySelectorAll(".ev-field[data-axis]").forEach((f) => {
    const varied = f.dataset.axis === p.axis;
    f.querySelector(".ev-ctl").hidden = varied;
    f.querySelector(".ev-varied").hidden = !varied;
  });
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
    model: $("evModel").value.trim(), prompt: radio("evPrompt"), cap: Number(radio("evCap")),
    tools: $("evTools").value, workflow: $("evWorkflow").value,
    investigate: $("evInvestigate").checked, snapshot: radio("evSnapshot"),
  };
  const p = PRESETS[preset];
  let conds;
  if (!p.axis) {
    conds = [{ label: preset === "ref" ? "Reference" : "Custom", settings: base }];
  } else if (p.axis === "model") {
    conds = modelLines().map((m) => ({ label: shortModel(m), settings: { ...base, model: m } }));
  } else {
    conds = [...$("evCondList").querySelectorAll("input:checked")].map((cb) => ({
      label: cb.dataset.short,
      settings: { ...base, [p.axis]: p.axis === "cap" ? Number(cb.value) : cb.value },
    }));
  }
  return {
    preset, base, conds,
    tables: tableBoxes.filter((c) => c.checked).map((c) => c.value),
    runs: Number($("evRunCount").value),
    parallel: Number($("evParallel").value),
    tag: $("evTag").value.trim() || "untagged",
  };
}

function problems(f) {
  const p = PRESETS[f.preset];
  if (!f.conds.length) return p.axis === "model" ? "List at least one model ID." : "Tick at least one condition.";
  // "Pinned by full model ID": an alias or a family name could resolve to a
  // different model next month, and the comparison would quietly change.
  const loose = f.conds.map((c) => c.settings.model).find((m) => !/:\d+$/.test(m));
  if (loose !== undefined) {
    return `“${loose || "(blank)"}” is not a full model ID. Include the version suffix ` +
           `(for example …-v1:0) so the run is pinned.`;
  }
  if (f.conds.some((c) => c.settings.tools === "no_etl" && !c.settings.investigate)) {
    return "Investigation without ETL tools only changes anything when every flag is investigated.";
  }
  if (!f.tables.length) return "Select at least one table.";
  if (!Number.isInteger(f.runs) || f.runs < 1 || f.runs > 10) return "Runs per condition must be a whole number from 1 to 10.";
  if (!Number.isInteger(f.parallel) || f.parallel < 1 || f.parallel > 32) {
    return "Sessions in parallel must be a whole number from 1 to 32.";
  }
  return "";
}

// Where the configuration departs from the reference, in words. An experiment is
// meant to change one thing, so anything beyond its own axis is called out.
function describeDiff(f) {
  const p = PRESETS[f.preset], b = f.base, out = [];
  if (p.axis !== "model" && b.model !== REFERENCE.model) out.push(`model (${shortModel(b.model) || "blank"})`);
  if (p.axis !== "prompt" && b.prompt !== REFERENCE.prompt) out.push(`prompt (${b.prompt})`);
  if (p.axis !== "cap" && b.cap !== REFERENCE.cap) out.push(`cap (${b.cap})`);
  if (p.axis !== "tools" && b.tools !== REFERENCE.tools) out.push(`tools (${optText("evTools", b.tools)})`);
  if (p.axis !== "workflow" && b.workflow !== REFERENCE.workflow) {
    out.push(`workflow (${optText("evWorkflow", b.workflow).toLowerCase()})`);
  }
  if (b.investigate !== REFERENCE.investigate) out.push(b.investigate ? "every flag investigated" : "no investigation");
  if (b.snapshot !== REFERENCE.snapshot) out.push(`${b.snapshot} snapshot set`);
  if (f.tables.length !== TABLES.length) out.push(`${f.tables.length} of ${TABLES.length} tables`);
  const lead = p.axis ? `Varies the ${AXIS_NAMES[p.axis]} over ${plural(f.conds.length, "condition")}. ` : "";
  if (!out.length) return lead + (p.axis ? "Otherwise matches the reference." : "Matches the reference condition.");
  return lead + `${p.axis ? "Otherwise differs" : "Differs"} from the reference in: ${out.join(", ")}.`;
}

// The run's size before it starts: sessions, the most flags they can raise, and
// the most investigations those can trigger -- investigation is what drives cost.
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

function renderScale(f) {
  const { sessions, flags, invest } = scale(f);
  const strong = (t) => el("strong", null, t);
  const box = $("evScale");
  box.replaceChildren(
    strong(plural(sessions, "discovery session")),
    ` (${plural(f.conds.length, "condition")} × ${plural(f.runs, "run")}), raising up to `,
    strong(plural(flags, "flag")),
    invest ? "; investigating every flag adds up to " : ". Detection only: nothing is investigated.");
  if (invest) box.append(strong(plural(invest, "investigation")), ` of up to ${STEP_LIMIT} steps each.`);
}

function refresh() {
  const n = tableBoxes.filter((c) => c.checked).length;
  $("evTablesCount").textContent = `${n} of ${TABLES.length}`;
  $("evTablesAll").textContent = n === TABLES.length ? "Clear all" : "Select all";
  const f = readForm();
  $("evDiff").textContent = describeDiff(f);
  renderScale(f);
  // Re-check a standing error as the user fixes it; do not raise new ones mid-edit.
  if ($("evErr").textContent) $("evErr").textContent = problems(f);
}

$("evPreset").addEventListener("change", () => applyPreset($("evPreset").value));
$("evForm").addEventListener("input", (e) => { if (e.target.id !== "evPreset") refresh(); });
$("evForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = readForm();
  const err = problems(f);
  $("evErr").textContent = err;
  if (!err) launch(f);
});

$("evModels").value = CFG.model;
$("evTag").value = "untagged";
$("evParallel").value = REF_PARALLEL;
applyPreset("ref");
setEvalFormShown(false);

// ---- Evaluations ----------------------------------------------------------------
// Held in memory only, like the chat. Where runs live durably -- so a monitor can
// reattach after a reload -- is a question for the real harness.
const evals = [];
const listBtns = new Map();   // evaluation -> its button in the list
let shown = null;             // the evaluation on screen
let view = null;              // its DOM handles, rebuilt whenever `shown` changes

function launch(f) {
  const ev = {
    id: `ev-${evals.length + 1}`, preset: f.preset, f,
    title: optText("evPreset", f.preset), short: f.preset === "ref" ? "Reference" : f.preset === "custom" ? "Custom" : f.preset,
    conds: f.conds.map((c, i) => ({ ...c, key: "c" + i })),
    status: "resetting", started: Date.now(), ended: null,
    units: [], sessions: new Map(), log: [],
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
  ev.handle = MockHarness({ units: ev.units, parallel: f.parallel, conds, snapshot: f.base.snapshot },
                          (e) => onHarnessEvent(ev, e));
  $("evIntro").hidden = true;
  show(ev);
  announce(`Evaluation ${ev.id} launched: ${plural(ev.units.length, "discovery session")}.`);
  view.title.focus();
}

function onHarnessEvent(ev, e) {
  if (e.type === "status") {
    ev.status = e.status;
    if (e.status === "awaiting_scoring" || e.status === "stopped") ev.ended = Date.now();
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
    b.textContent = `${ev.id} · ${ev.short} · ${STATUS[ev.status].toLowerCase()}`;
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
  root.append(head, chips(ev));

  // One bar per phase the plan has. Investigation's total is not known up front --
  // it is however many flags discovery raises -- so its bar grows as they land.
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

  const dl = el("dl", "ev-totals");
  view.tot = {};
  for (const [k, label] of [["sessions", "Sessions complete"], ["flags", "Flags raised"], ["inv", "Investigations"],
                            ["turns", "Model turns"], ["tools", "Tool calls"], ["limit", "Step-limit hits"],
                            ["failed", "Failed"], ["tokens", "Tokens"]]) {
    const d = el("div");
    view.tot[k] = el("dd");
    d.append(el("dt", null, label), view.tot[k]);
    dl.appendChild(d);
  }
  // Cost needs per-call token counts, which the Runtime's done event does not carry yet.
  view.tot.tokens.className = "small";
  view.tot.tokens.textContent = "not reported yet";
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

function chips(ev) {
  const ul = el("ul", "ev-chips");
  ul.setAttribute("aria-label", "Settings for this evaluation");
  const b = ev.f.base, axis = PRESETS[ev.preset].axis;
  const add = (text, vary) => ul.appendChild(el("li", vary ? "vary" : null, text));
  if (axis) add(`Varies ${AXIS_NAMES[axis]}: ${ev.conds.map((c) => c.label).join(", ")}`, true);
  if (axis !== "model") add(`Model ${shortModel(b.model)}`);
  if (axis !== "prompt") add(`Prompt ${b.prompt}`);
  if (axis !== "cap") add(`Cap ${b.cap}`);
  if (axis !== "tools") add(optText("evTools", b.tools));
  if (axis !== "workflow") add(optText("evWorkflow", b.workflow));
  add(b.investigate ? "Every flag investigated" : "Detection only");
  add(`Snapshot: ${b.snapshot}`);
  add(`${ev.f.tables.length} of ${TABLES.length} tables`);
  add(`${plural(ev.f.runs, "run")} per condition`);
  add(`${ev.f.parallel} in parallel`);
  add(`Tag: ${ev.f.tag}`);
  return ul;
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
    "and transcripts show any flag that matches a test defect as “[held-out match]”." +
    (ev.f.base.snapshot === "clean" ? " On the clean set every flag is pre-existing or a false positive." : "")));
  return box;
}

function stateText(s) {
  switch (s.state) {
    case "discovery": return `discovery ${s.steps}/${STEP_LIMIT}`;
    case "investigating": return `investigating ${s.invDone}/${s.invTotal}`;
    case "step_limit": return "step limit";
    case "error": return "failed";
    default: return s.state;      // queued, done, cancelled
  }
}

function cellText(s) {
  const t = stateText(s);
  if (s.state === "queued" || (s.state === "cancelled" && !s.flags)) return t;
  return `${t} · ${plural(s.flags, "flag")}`;
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
  view.stop.hidden = !(ev.status === "resetting" || ev.status === "running");
  view.elapsed.textContent = clock((ev.ended || Date.now()) - ev.started);

  const all = [...ev.sessions.values()];
  const past = (s) => s.state !== "queued" && s.state !== "discovery";
  const investigates = (s) => ev.conds.find((c) => c.key === s.cond).settings.investigate;
  const disc = all.filter((s) => s.kind !== "synthesis"), syn = all.filter((s) => s.kind === "synthesis");
  const inv = all.filter(investigates);
  const invDone = sum(inv, "invDone"), invTotal = sum(inv, "invTotal");
  const discoveryOver = all.every(past);

  const bar = (k, done, total, unit, open, units) => {
    if (!view.bars[k]) return;
    view.bars[k].bar.max = Math.max(total, 1);
    view.bars[k].bar.value = done;
    view.bars[k].txt.textContent = `${fmt(done)} / ${plural(total, unit, units)}${open ? " so far" : ""}`;
  };
  bar("disc", disc.filter(past).length, disc.length, "session");
  bar("synth", syn.filter(past).length, syn.length, "pass", false, "passes");
  bar("inv", invDone, invTotal, "flag", !discoveryOver && ev.status !== "stopped");

  const ended = all.filter((s) => ENDED.includes(s.state)).length;
  view.tot.sessions.textContent = `${fmt(ended)} / ${fmt(all.length)}`;
  view.tot.flags.textContent = fmt(sum(all, "flags"));
  if (inv.length) view.tot.inv.textContent = `${fmt(invDone)} / ${fmt(invTotal)}`;
  else {
    view.tot.inv.className = "small";
    view.tot.inv.textContent = "none (detection only)";
  }
  view.tot.turns.textContent = fmt(sum(all, "turns"));
  view.tot.tools.textContent = fmt(sum(all, "tools"));
  view.tot.limit.textContent = fmt(all.filter((s) => s.result === "step_limit").length + sum(all, "invLimit"));
  view.tot.failed.textContent = fmt(all.filter((s) => s.result === "error").length);

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
  row("Discovery steps", `${s.steps} / ${STEP_LIMIT}`);
  row("Flags", fmt(s.flags));
  if (c.settings.investigate) {
    row("Investigated", `${s.invDone} / ${s.invTotal}` + (s.invLimit ? ` (${s.invLimit} at the step limit)` : ""));
  }
  row("Model turns", fmt(s.turns));
  row("Tool calls", fmt(s.tools));
  row("Elapsed", s.started ? clock((s.ended || Date.now()) - s.started) : "—");
  row("Session ID", s.id || "assigned when it starts", s.id ? "mono" : null);
  box.replaceChildren(dl, el("p", "foot",
    "Turns and tool calls include the session's investigations. The transcript opens after scoring, " +
    "with any match to a held-out defect redacted."));
}

// ---- MockHarness ----------------------------------------------------------------
// Stands in for the harness the design calls for, so the monitor has something to
// show. The contract a real harness keeps:
//   MockHarness(plan, onEvent) -> { stop() }
//   plan:  { units: [{ key, cond, run, table, kind, after }], parallel,
//            conds: { [key]: { label, ...settings } }, snapshot }
//   onEvent receives
//     { type: "status", status }             resetting | running | awaiting_scoring | stopped
//     { type: "session", key, ...counters }  a session's state and running totals
//     { type: "log", text, bad }             one line for the activity log
// It reports how many flags a session raised, never what they say: flag text is
// for the scorer, which redacts test-set matches before anyone reads it.
//
// Everything under the contract is make-believe. Step counts, flag counts and
// failure rates are random, chosen only to look like a run in motion.
function MockHarness(plan, onEvent) {
  const TICK_MS = 300;
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const ended = (j) => ENDED.includes(j.state);
  const jobs = new Map(plan.units.map((u) => [u.key, {
    ...u, state: "queued", result: null, steps: 0, turns: 0, tools: 0, flags: 0,
    invDone: 0, invTotal: 0, invLimit: 0, id: null, started: null, ended: null }]));
  let slots = [];               // what holds a session slot: { job } or { job, inv }
  const invQueue = [];          // investigations waiting for a slot, one per flag
  const investigated = new Set();
  let timer = null, stopped = false;

  // Sessions start interleaved -- by position within their run, then run, then
  // condition -- rather than one condition after another, so any drift in the
  // hosted model over the hours a batch takes lands on every condition alike.
  const condIndex = Object.fromEntries(Object.keys(plan.conds).map((k, i) => [k, i]));
  const seen = new Map();
  const order = [...jobs.values()].map((j) => {
    const g = `${j.cond}|${j.run}`;
    seen.set(g, (seen.get(g) ?? -1) + 1);
    return { j, at: seen.get(g) };
  }).sort((a, b) => a.at - b.at || a.j.run - b.j.run || condIndex[a.j.cond] - condIndex[b.j.cond])
    .map((x) => x.j);

  const multi = Object.keys(plan.conds).length > 1;
  const runName = (j) => `${multi ? plan.conds[j.cond].label + " · " : ""}Run ${j.run}`;
  const name = (j) => `${runName(j)} · ${ROW_NAMES[j.table] || j.table}`;
  const log = (text, bad) => onEvent({ type: "log", text, bad });
  const emit = (j) => onEvent({ type: "session", key: j.key, state: j.state, result: j.result,
    steps: j.steps, turns: j.turns, tools: j.tools, flags: j.flags, invDone: j.invDone,
    invTotal: j.invTotal, invLimit: j.invLimit, id: j.id, started: j.started, ended: j.ended });

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

  function finish(j, result) {
    j.state = j.result = result;
    j.ended = Date.now();
    if (result === "done") j.flags = j.finalFlags;
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
    if (j.fate === "error" && j.steps >= j.failAt) return finish(j, "error");
    if (j.steps >= j.target) return finish(j, j.fate);
    emit(j);
    return false;
  }

  function stepInvestigation(j, inv) {
    inv.steps = Math.min(inv.target, inv.steps + rnd(10, 30));
    if (inv.steps < inv.target) return false;
    j.invDone++;
    j.turns += Math.ceil(inv.steps / 2);
    j.tools += Math.floor(inv.steps * 0.55);
    if (inv.limit) j.invLimit++;
    if (j.invDone === j.invTotal) {
      j.state = j.result;
      log(`${name(j)}: ${plural(j.invTotal, "flag")} investigated` +
          (j.invLimit ? `, ${j.invLimit} at the step limit.` : "."), j.invLimit > 0);
    }
    emit(j);
    return true;
  }

  // Once every discovery session of a run, synthesis included, has ended, the
  // run's flags are queued for investigation: one per flag, each its own budget.
  function queueInvestigations() {
    const byRun = new Map();
    for (const j of jobs.values()) {
      const k = `${j.cond}|${j.run}`;
      if (!byRun.has(k)) byRun.set(k, []);
      byRun.get(k).push(j);
    }
    for (const [k, list] of byRun) {
      if (investigated.has(k) || !plan.conds[list[0].cond].investigate || !list.every(ended)) continue;
      investigated.add(k);
      let n = 0;
      for (const j of list.filter((x) => x.flags)) {
        j.invTotal = j.flags;
        j.state = "investigating";
        n += j.flags;
        for (let i = 0; i < j.flags; i++) invQueue.push(j);
        emit(j);
      }
      log(`${runName(list[0])}: discovery complete, ${plural(n, "flag")} queued for investigation.`);
    }
  }

  function tick() {
    slots = slots.filter((s) => !(s.inv ? stepInvestigation(s.job, s.inv) : stepDiscovery(s.job)));
    queueInvestigations();
    // Free slots go to queued investigations first, since they complete a run
    // that is otherwise finished, then to sessions whose prerequisites have ended.
    while (slots.length < plan.parallel && invQueue.length) {
      const limit = Math.random() < 0.08;
      slots.push({ job: invQueue.shift(), inv: { steps: 0, target: limit ? STEP_LIMIT : rnd(30, 200), limit } });
    }
    for (const j of order) {
      if (slots.length >= plan.parallel) break;
      if (j.state === "queued" && j.after.every((k) => ended(jobs.get(k)))) begin(j);
    }
    if (!slots.length && !invQueue.length && [...jobs.values()].every(ended)) {
      clearInterval(timer);
      log("Every session has ended. The flags are ready for the scorer.");
      onEvent({ type: "status", status: "awaiting_scoring" });
    }
  }

  onEvent({ type: "status", status: "resetting" });
  log(`Resetting the warehouse to snapshots/${plan.snapshot} (simulated).`);
  const resetTimer = setTimeout(() => {
    onEvent({ type: "status", status: "running" });
    log("Warehouse reset. Discovery started.");
    timer = setInterval(tick, TICK_MS);
  }, 2000);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(resetTimer);
      clearInterval(timer);
      for (const j of jobs.values()) {
        if (ended(j)) continue;
        j.state = "cancelled";
        j.ended = j.ended || Date.now();
        emit(j);
      }
      slots = [];
      invQueue.length = 0;
      log("Stopped. Sessions in flight were cancelled; the ones that had ended keep their flags.", true);
      onEvent({ type: "status", status: "stopped" });
    },
  };
}

})();
