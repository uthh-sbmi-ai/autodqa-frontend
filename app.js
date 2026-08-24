// AutoDQA static console — Cognito login (USER_PASSWORD_AUTH) + direct streaming
// invoke of the AgentCore Runtime with the bearer token. No framework, no SDK.
// Config (region, clientId, runtimeArn, model) comes from config.js.
"use strict";

const CFG = window.AUTODQA_CONFIG;
let accessToken = null;

// ---- Conversation identity --------------------------------------------------
// One id per conversation, used as BOTH the AgentCore session id (which pins the
// session's microVM) and the checkpointer's thread id. The agent's memory lives in
// that microVM's RAM, so the id is the only handle we need — no transcript is
// uploaded, and nothing is stored anywhere durable.
//
// It is regenerated on sign-in and on "New chat". Ending a conversation is
// best-effort from here (see endConversation); the guarantee is the runtime's idle
// timeout, which terminates the microVM and takes the state with it whether or not
// the browser ever says goodbye.
let conversationId = null;

const newConversationId = () => "web-" + crypto.randomUUID();   // >=33 chars, as the runtime requires

const $ = (id) => document.getElementById(id);

// ---- Cognito USER_PASSWORD_AUTH (unauthenticated Cognito API, browser-callable) ----
async function login(email, password) {
  const res = await fetch(`https://cognito-idp.${CFG.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CFG.clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || JSON.stringify(data));
  return data.AuthenticationResult.AccessToken;
}

// ---- Direct streaming invoke of the runtime (SSE over fetch) ----
const runtimeUrl = () =>
  `https://bedrock-agentcore.${CFG.region}.amazonaws.com/runtimes/` +
  `${encodeURIComponent(CFG.runtimeArn)}/invocations?qualifier=DEFAULT`;

const runtimeHeaders = () => ({
  "Authorization": `Bearer ${accessToken}`,
  "Content-Type": "application/json",
  // Stable across the conversation: this is what routes every turn back to the same
  // session microVM, where the checkpointer's thread and the issue list live -- and
  // what lets a stop request find the process running the job.
  "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": conversationId,
});

// Aborts the CURRENT streaming read. This ends only the browser's side of it; the
// server-side stop is a separate request (see the Stop button), because a client
// disconnect is not a signal we can rely on reaching the runtime promptly.
let currentAbort = null;
function abortStream() {
  try { if (currentAbort) currentAbort.abort(); } catch (e) { /* already gone */ }
}

// A short, non-streaming invoke for control actions. Returns the parsed events
// rather than a stream, since these replies are one line long.
async function controlInvoke(body) {
  const res = await fetch(runtimeUrl(), {
    method: "POST",
    headers: runtimeHeaders(),
    body: JSON.stringify({ ...body, conversation: conversationId }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text.split("\n").reduce((acc, line) => {
    const t = line.trim();
    if (t.startsWith("data:")) { try { acc.push(JSON.parse(t.slice(5).trim())); } catch (e) { /* skip */ } }
    return acc;
  }, []);
}

async function invoke(body, onEvent) {
  currentAbort = new AbortController();
  const res = await fetch(runtimeUrl(), {
    method: "POST",
    headers: runtimeHeaders(),
    body: JSON.stringify({ ...body, conversation: conversationId }),
    signal: currentAbort.signal,
  });
  if (!res.ok) { onEvent({ type: "error", content: `HTTP ${res.status}: ${await res.text()}` }); return; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      try { onEvent(JSON.parse(payload)); }
      catch { onEvent({ type: "raw", content: payload }); }
    }
  }
}

// ---- Rendering ----
function scrollDown() { const s = $("stream"); s.scrollTop = s.scrollHeight; }

function addBubble(role, text) {
  const m = document.createElement("div"); m.className = "msg " + role;
  const b = document.createElement("div"); b.className = "bubble"; b.textContent = text;
  m.appendChild(b); $("stream").appendChild(m); scrollDown();
}

function addLine(cls, text) {
  const d = document.createElement("div"); d.className = "line " + cls; d.textContent = text;
  $("stream").appendChild(d); scrollDown();
}

function prettyJSON(v) {
  if (typeof v === "string") { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } }
  return JSON.stringify(v, null, 2);
}

function addToolCard(block) {
  const d = document.createElement("details"); d.className = "tool";
  const s = document.createElement("summary"); s.textContent = "🔧 " + block.name;
  const input = block.input && (block.input.sql || block.input.code || block.input.query || block.input.path);
  const pre = document.createElement("pre");
  pre.textContent = typeof input === "string" ? input : JSON.stringify(block.input, null, 2);
  d.appendChild(s); d.appendChild(pre); $("stream").appendChild(d); scrollDown();
  return d;
}

function addToolResult(card, text) {
  const pre = document.createElement("pre"); pre.className = "result"; pre.textContent = prettyJSON(text);
  card.appendChild(pre); scrollDown();
}

// The end-of-phase report. Rendered from the tickets the runtime sends, so it says
// exactly what the panel says — this is about WHERE the findings are, not about
// producing a second, differently-worded account of them.
//
// It goes in the message stream rather than the panel on purpose: the panel is the
// durable record you go to, this is the summary that arrives where you are already
// looking when the batch ends.
function addReport(issues) {
  const box = el("section", "report");
  box.setAttribute("aria-label", "Investigation report");
  const n = issues.length;
  box.appendChild(el("h3", null, `Investigation report \u00b7 ${n} issue${n === 1 ? "" : "s"}`));

  for (const issue of issues) {
    const item = el("article", "report-item s-" + issue.status);
    const head = el("h4");
    head.appendChild(el("span", "num", "#" + issue.n));
    head.appendChild(el("span", "ttl", issue.title));
    if (STATUS_LABEL[issue.status]) head.appendChild(el("span", "pill", STATUS_LABEL[issue.status]));
    item.appendChild(head);

    const rc = issue.root_cause || {};
    const dl = document.createElement("dl");
    const row = (label, value, mono) => {
      if (!value) return;
      dl.appendChild(el("dt", null, label));
      dl.appendChild(el("dd", mono ? "mono" : null, value));
    };
    // Label the hedge. An unestablished cause presented in the same words as a
    // proven one is the failure mode worth spending a line of UI on.
    row(rc.conclusive ? "Root cause" : "Root cause (not established)",
        rc.root_cause || "No cause was recorded for this issue.");
    row("Traced to", rc.evidence, true);
    row("Recommendation", rc.recommendation);
    item.appendChild(dl);
    box.appendChild(item);
  }
  $("stream").appendChild(box);
  scrollDown();
}

// Shown at the top of an empty conversation. The console gives no other clue about
// what the agent expects to be asked for, or that a run stops halfway for the user's
// judgement — and someone who does not know a second phase is coming reads the end
// of discovery as the agent giving up early.
const EXAMPLE_TASK =
  "Profile CDW.dbo.DEMOGRAPHIC for data quality issues, column by column. " +
  "Constrain the profiling to BIRTH_DATE, RACE, SEX and HISPANIC.";

// Drop any existing block first: the welcome is written for the current auth state,
// so the copy shown before sign-in must not survive it.
function refreshWelcome() {
  const existing = $("stream").querySelector(".welcome");
  if (existing) existing.remove();
  showWelcome();
}

function showWelcome() {
  if ($("stream").querySelector(".welcome")) return;   // never two of them

  const box = el("section", "welcome");
  box.appendChild(el("h2", null, "Profiling the warehouse with AutoDQA"));
  box.appendChild(el("p", null,
    "Name the table you want profiled, and the columns to focus on if you have "
    + "particular ones in mind. Here's an example:"));

  // The example is the useful half of any instruction like this, so it is offered as
  // something to edit rather than something to retype. It fills the box; it does not
  // submit, because the table and columns are exactly what the user should change.
  const ex = el("div", "example");
  ex.appendChild(el("code", null, EXAMPLE_TASK));
  const use = el("button", null, "Use this");
  use.type = "button";
  use.addEventListener("click", () => {
    $("task").value = EXAMPLE_TASK;
    $("task").focus();
    announce("Example task copied into the box. Edit the table and columns, then press Run.");
  });
  ex.appendChild(use);
  box.appendChild(ex);

  const ol = document.createElement("ol");
  const step = (name, text) => {
    const li = document.createElement("li");
    li.appendChild(el("strong", null, name));
    li.append(" " + text);
    ol.appendChild(li);
  };
  step("Discovery.",
    "The agent profiles the data you named and flags each potential issue it can "
    + "identify into the Issues panel on the right.");
  step("Your review.",
    "Tick the issues worth pursuing and press Investigate selected. Anything you leave "
    + "unticked is marked ignored, and can still be picked up later.");
  step("Investigation.",
    "The agent works through each issue that you selected one at a time, tracing the "
    + "issue back to a root cause — within the source database(s) or in the ETL that "
    + "loads the data. A report will be presented to you at the end of the session with "
    + "a list of what issues the agent found and each issue's root cause.");
  box.appendChild(ol);

  box.appendChild(el("p", "foot",
    "The warehouse is synthetic — it holds no PHI. Stop ends a run at any point; "
    + "New chat clears the conversation and the issue list."));

  // Rendered before sign-in too, so it has to say what is blocking the Run button.
  if (!accessToken) {
    box.appendChild(el("p", "foot signin",
      "Sign in with the form at the top of the page to run a profiling task."));
  }

  // Prepend: on a fresh conversation the stream is empty, but this way it stays at
  // the top even if anything has already been written there.
  $("stream").prepend(box);
}

// The hand-off notice. A discovery run ends at a decision point that is not the
// agent's to make, and nothing else on screen says so: the run footer reads as
// "done", and the next control the user needs is in the other column. Spell out
// what happened and what to do next, at the bottom where they are already reading.
function addDiscoveryNotice(completed) {
  // Same rule refreshTriage uses: an issue is actionable exactly when it rendered a
  // checkbox. Derived from the DOM rather than recounted, so the notice can never
  // disagree with the panel it is pointing at.
  const n = document.querySelectorAll('#issues input[type="checkbox"]').length;

  const box = el("aside", "notice");
  box.appendChild(el("h3", null, completed ? "Discovery phase complete"
                                           : "Discovery phase ended early"));
  const p = el("p");
  if (!n) {
    p.append("No issues are waiting for a decision. Give the agent another profiling "
           + "task to look further, or start a new chat.");
  } else {
    p.append("Review the ");
    p.appendChild(el("strong", null, `${n} issue${n === 1 ? "" : "s"}`));
    p.append(" in the Issues panel, tick the ones worth a root-cause investigation, then press ");
    p.appendChild(el("strong", null, "Investigate selected"));
    p.append(" to begin the Investigation phase. Anything left unticked is marked "
           + "ignored, and can still be picked up in a later round.");
  }
  box.appendChild(p);
  $("stream").appendChild(box);
  scrollDown();
  announce(n
    ? `Discovery ${completed ? "complete" : "ended early"}. ${n} issue(s) awaiting your review. `
      + "Select the ones to investigate in the Issues panel, then press Investigate selected."
    : `Discovery ${completed ? "complete" : "ended early"}. No issues are awaiting a decision.`);
}

// ---- Issues panel ----
// Event-driven, never rebuilt from a fetch — there is no endpoint to rebuild it
// from, by design. The runtime emits `issue` when a ticket is created and
// `issue_update` when its status or root cause changes; a rejected report_issue (a
// duplicate title, a bad enum, a full list) emits nothing at all, so the panel and
// the agent's list cannot drift apart.
// Set for the duration of any run. The panel reads it so checkboxes and the
// investigate button are inert while the agent is working -- re-triaging mid-batch
// would desync the user's selection from the work already queued on the server.
let runBusy = false;
let issueMax = 10;                 // authoritative value arrives with the first event
const issueEls = new Map();        // n -> <li>, so an update re-renders that row in place
const picked = new Set();          // n's the user has ticked but not yet submitted

// Statuses that are still the user's to decide, and so still carry a checkbox.
// `ignored` stays checkable on purpose: passing on an issue in one round should
// not be a permanent verdict.
const TRIAGE_ABLE = new Set(["flagged", "ignored"]);
// `flagged` gets no pill — during discovery every ticket is flagged, so a column of
// identical pills would be noise rather than information.
const STATUS_LABEL = {
  selected: "selected", ignored: "ignored", investigating: "investigating…",
  explained: "root cause found", inconclusive: "inconclusive",
};

// Sort groups, most actionable first: what the agent is working, then what still
// needs a decision, then what was passed over. Ordering is by GROUP only — inside a
// group the issue number decides, so a ticket never moves for any reason the user
// did not cause, and its position stays predictable across a batch.
//
// This is inert during discovery: every ticket is `flagged`, so the sort collapses
// to ascending by number, which is the order they were appended in anyway. It only
// does visible work at the moment of triage.
const SORT_RANK = {
  selected: 0, investigating: 0, explained: 0, inconclusive: 0,   // the investigation set
  flagged: 1,                                                     // still awaiting the user
  ignored: 2,                                                     // passed over
};

// Every field below is model-authored text, so it is set with textContent and
// never innerHTML -- a finding that quotes SQL or a column named <b> has to
// render as characters, not markup.
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function issueDetails(issue) {
  const d = el("details", "issue s-" + issue.status);
  const sum = document.createElement("summary");
  sum.appendChild(el("span", "num", "#" + issue.n));
  sum.appendChild(el("span", "ttl", issue.title));
  const meta = el("div", "meta");
  if (STATUS_LABEL[issue.status]) meta.appendChild(el("span", "pill", STATUS_LABEL[issue.status]));
  meta.appendChild(el("span", null, issue.dimension));
  const where = [issue.table, issue.column].filter(Boolean).join(".");
  if (where) meta.appendChild(el("span", "where", where));
  sum.appendChild(meta);
  d.appendChild(sum);

  const dl = document.createElement("dl");
  const row = (label, value, mono) => {
    if (!value) return;              // optional fields collapse rather than show empty
    dl.appendChild(el("dt", null, label));
    dl.appendChild(el("dd", mono ? "mono" : null, value));
  };
  row("Finding", issue.finding);
  row("Evidence", issue.evidence, true);
  const rc = issue.root_cause;
  if (rc) {
    // Say so when the agent did not actually establish the cause. Presenting a
    // hypothesis in the same style as a proven answer is the failure mode worth
    // spending a line of UI on.
    row(rc.conclusive ? "Root cause" : "Root cause (not established)", rc.root_cause);
    row("Traced to", rc.evidence, true);
    row("Recommendation", rc.recommendation);
  }
  d.appendChild(dl);

  // One open at a time. The column is narrow and evidence blocks are long, so two
  // open issues push the rest of the list out of view. Done on toggle rather than
  // with <details name> so it works in browsers without exclusive accordions.
  d.addEventListener("toggle", () => {
    if (!d.open) return;
    $("issues").querySelectorAll("details.issue[open]").forEach((o) => { if (o !== d) o.open = false; });
  });
  return d;
}

// Create or replace one row. The checkbox sits OUTSIDE the <details> rather than
// inside its <summary>: a control nested in a summary fights the disclosure for
// clicks and keystrokes, and screen readers announce the pair ambiguously.
function upsertIssue(issue) {
  const existing = issueEls.get(issue.n);
  const wasOpen = existing ? existing.querySelector("details").open : false;

  const row = el("div", "issue-row");
  if (TRIAGE_ABLE.has(issue.status)) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = picked.has(issue.n);
    cb.disabled = runBusy;
    cb.setAttribute("aria-label", `Investigate issue ${issue.n}: ${issue.title}`);
    cb.addEventListener("change", () => {
      if (cb.checked) picked.add(issue.n); else picked.delete(issue.n);
      refreshTriage();
    });
    row.appendChild(cb);
  } else {
    picked.delete(issue.n);          // no longer the user's to choose
    row.appendChild(el("span", "cb-spacer"));
  }
  const d = issueDetails(issue);
  // An update must not collapse what the user opened -- except on the way to
  // `ignored`, where collapsing is the point: a passed-over issue should not keep
  // holding open a screenful of evidence above the ones being worked. Reopening it
  // afterwards still works; nothing here forces it shut again.
  d.open = wasOpen && issue.status !== "ignored";
  row.appendChild(d);

  const li = existing || document.createElement("li");
  li.dataset.status = issue.status;  // read by reorderIssues
  li.replaceChildren(row);
  if (!existing) { $("issues").appendChild(li); issueEls.set(issue.n, li); }
  reorderIssues();
  updateIssueCount();
  refreshTriage();
}

// Reorder the rows in place. appendChild on an element already in the parent MOVES
// it, so this reshuffles without rebuilding any DOM — an open disclosure stays open
// and keyboard focus inside a row survives the move.
//
// The visible issue number comes from the ticket, not from list position (the <ol>
// markers are suppressed), so reordering can never renumber anything.
function reorderIssues() {
  const ol = $("issues");
  [...issueEls.entries()]
    .sort(([an, ali], [bn, bli]) =>
      (SORT_RANK[ali.dataset.status] ?? 1) - (SORT_RANK[bli.dataset.status] ?? 1) || an - bn)
    .forEach(([, li]) => ol.appendChild(li));
}

function updateIssueCount() {
  $("issueCount").textContent = `${issueEls.size}/${issueMax}`;
  $("issuesEmpty").hidden = issueEls.size > 0;
}

// The triage control only exists while there is something to triage, so the panel
// is not carrying a dead button through discovery or through a running batch.
function refreshTriage() {
  const any = [...issueEls.values()].some((li) => li.querySelector('input[type="checkbox"]'));
  $("triage").hidden = !any;
  $("investigateBtn").disabled = runBusy || picked.size === 0;
  $("investigateBtn").textContent = picked.size
    ? `Investigate ${picked.size} selected`
    : "Investigate selected";
}

function clearIssues() {
  $("issues").replaceChildren();
  issueEls.clear();
  picked.clear();
  updateIssueCount();
  refreshTriage();
}

// ---- Architecture diagram trace (nodes glow along the active path) ----
const archSvgEl = document.querySelector(".arch-svg");
const nodeEls = document.querySelectorAll(".anode");
const archStepEl = $("archStep");
const ARCH_DEFAULT = "The active path lights up as the agent runs.";
const ISSUES_CAP_DEFAULT = "Distinct data-quality findings the agent has recorded, newest last.";

function setTrace(active, label) {
  const set = new Set(active || []);
  if (archSvgEl) archSvgEl.classList.toggle("running", set.size > 0);
  nodeEls.forEach((n) => n.classList.toggle("active", set.has(n.dataset.id)));
  if (label) { archStepEl.textContent = "▸ " + label; archStepEl.classList.add("live"); }
  else { archStepEl.textContent = ARCH_DEFAULT; archStepEl.classList.remove("live"); }
}

// ---- Screen-reader announcements ----
// The stream itself is deliberately NOT a live region: it would read every tool
// result aloud, JSON and all. Instead we announce what happened, and leave the
// payload on screen for the user to navigate to in their own time.
const announcerEl = $("announcer");

function announce(msg) {
  if (!announcerEl || !msg) return;
  const p = document.createElement("p");
  p.textContent = msg;
  announcerEl.appendChild(p);
  // keep the log bounded — it is never seen, only spoken
  while (announcerEl.childElementCount > 20) announcerEl.removeChild(announcerEl.firstChild);
}

// on_tool_end fires per tool call in order (serialized), so match results to open
// tool cards in order. Carries the tool name so the result can say which one.
const pendingTools = [];

function renderEvent(ev) {
  if (ev.type === "trace") return setTrace(ev.active, ev.label);
  if (ev.type === "heartbeat") return;  // keepalive, nothing to render
  if (ev.type === "issue") {
    if (ev.max) issueMax = ev.max;
    upsertIssue(ev.issue);
    // Read the title, not the finding: the panel is where the detail belongs,
    // and the evidence block can be many lines of SQL.
    announce(`Issue ${ev.issue.n} flagged. ${ev.issue.title}`);
    return;
  }
  if (ev.type === "repaired") {
    // Say so rather than silently redoing work: the agent is about to reissue tool
    // calls the user already watched it request, and unexplained repetition looks
    // like a bug.
    const c = ev.calls;
    announce(`Recovered ${c} interrupted tool call(s) from the previous run.`);
    return addLine("stopped",
      `\u21ba recovered ${c} tool call(s) left unfinished by the previous run \u2014 ` +
      `they returned no result, so the agent may repeat them.`);
  }
  if (ev.type === "report") {
    const list = ev.issues || [];
    if (!list.length) return;
    addReport(list);
    const open = list.filter((i) => i.status !== "explained").length;
    // Announce the shape of the result, not its content -- the report is on screen
    // and navigable, and reading every root cause aloud would bury the headline.
    announce(`Investigation report. ${list.length} issue(s)` +
             (open ? `, ${open} without an established cause.` : ", all explained."));
    return;
  }
  if (ev.type === "issue_update") {
    upsertIssue(ev.issue);
    return;                    // status churn is visible in the panel; do not narrate every step
  }
  if (ev.type === "phase") {
    if (ev.phase === "idle") { $("issuesCap").textContent = ISSUES_CAP_DEFAULT; return; }
    if (!ev.issue) return;
    const where = `${ev.index} of ${ev.total}`;
    $("issuesCap").textContent = `Investigating #${ev.issue} (${where})…`;
    announce(`Investigating issue ${ev.issue}, ${where}. ${ev.title}`);
    return addLine("phase", `\u25b8 investigating #${ev.issue} (${where}) \u00b7 ${ev.title}`);
  }
  if (ev.type === "sandbox") {
    const sid = (ev.session || "").replace(/^run-/, "").slice(0, 8);
    const msg = ev.phase === "up" ? "🖥️ sandbox microVM spinning up" : "🖥️ sandbox microVM released";
    announce(ev.phase === "up" ? "Sandbox starting." : "Sandbox released.");
    return addLine("sandbox", sid ? `${msg} · ${sid}` : msg);
  }
  // Terminal event: every run ends with exactly one of these, so "it just stopped"
  // is never ambiguous. Emitted by entrypoint.py's produce() on every exit path.
  if (ev.type === "done") {
    // Report replayed turns too: continuity is otherwise invisible, so "did it
    // actually still have my context?" would be unanswerable from the UI.
    const carried = ev.thread_messages ? ` \u00b7 ${ev.thread_messages} message(s) in context` : "";
    // Reconcile rather than assume: if a rejected call or a dropped event ever put
    // the panel out of step with the agent's list, the count in the footer is where
    // it shows up instead of going unnoticed.
    if (ev.issue_max) issueMax = ev.issue_max;
    updateIssueCount();
    const listed = ev.issue_count ? ` \u00b7 ${ev.issue_count} issue(s) listed` : "";
    const did = ev.phase === "investigation" ? `investigated ${ev.investigated} issue(s) \u00b7 ` : "";
    const n = `${did}${ev.model_turns} model turn(s), ${ev.tool_calls} tool call(s)${carried}${listed}`;
    if (ev.reason === "completed") {
      announce(`Run finished. ${n}.`);
      addLine("done", `\u2713 finished \u00b7 ${n}`);
    } else if (ev.reason === "cancelled") {
      // A run the user stopped is not a failure, and styling it as one trains people
      // to ignore the red lines that do matter.
      announce(`Run stopped. ${n}.`);
      addLine("stopped", `\u23f9 stopped \u00b7 ${n}`);
    } else {
      const why = ev.reason === "step_limit" ? `STOPPED AT STEP LIMIT (${ev.step_limit})`
                : ev.reason === "truncated"  ? "RUN TRUNCATED"
                : `STOPPED (${ev.reason})`;
      announce(`Run stopped. ${why}. ${n}. ${ev.message || ""}`);
      addLine("error", `\u26a0 ${why} \u00b7 ${n}\n${ev.message || ""}`);
    }
    // Shown however the run ended, not only on success: a discovery run that was
    // stopped or truncated can still have flagged issues worth investigating, and
    // leaving the user to guess whether they may proceed is the worse outcome. The
    // heading says which happened; the error line above carries the detail.
    if (ev.phase === "discovery") addDiscoveryNotice(ev.reason === "completed");
    return;
  }
  const c = ev.content;
  if (ev.type === "error") {
    const t = ev.message ?? c;   // produce() sends `message`; the fetch path sends `content`
    const text = typeof t === "string" ? t : JSON.stringify(t);
    announce("Error. " + text);
    return addLine("error", text);
  }
  if (ev.type === "ToolMessage") {
    const text = Array.isArray(c) ? c.map((b) => b.text || "").join("") : c;
    const pending = pendingTools.shift();
    // announce that it returned, not what it returned — the payload stays on
    // screen inside the tool card, reachable by keyboard.
    announce(pending ? `${pending.name} returned.` : "Tool returned.");
    if (pending) addToolResult(pending.card, text); else addLine("result", "→ " + text);
    return;
  }
  if (ev.type === "AIMessage") {
    if (typeof c === "string") { if (c.trim()) { addBubble("agent", c); announce(c); } return; }
    for (const b of c || []) {
      if (b.type === "text" && b.text) { addBubble("agent", b.text); announce(b.text); }
      else if (b.type === "tool_use") {
        announce(`Calling ${b.name}.`);
        pendingTools.push({ card: addToolCard(b), name: b.name });
      }
    }
  }
  // HumanMessage / raw — nothing to render.
}

// ---- Palette switcher ----
// Slate & Sage is the default and comes straight from :root, so the page is
// correct with no stored value and no JavaScript. The <head> applies a saved
// choice before first paint; this only keeps the control in sync and stores
// changes.
const PALETTE_KEY = "autodqa-palette";
const paletteSel = $("paletteSel");
if (paletteSel) {
  paletteSel.value = document.documentElement.getAttribute("data-palette") || "sage";
  paletteSel.addEventListener("change", () => {
    document.documentElement.setAttribute("data-palette", paletteSel.value);
    try { localStorage.setItem(PALETTE_KEY, paletteSel.value); } catch (e) { /* private mode */ }
  });
}

// ---- Wiring ----
if (CFG.model) $("model").textContent = CFG.model;

// The console is shown at page load rather than after sign-in: someone landing here
// should be able to read what the tool does and what it will ask of them without
// authenticating first, and the architecture diagram and the empty Issues panel are
// part of that explanation. Nothing here reaches the runtime.
//
// The task form is the one part that cannot work yet -- invoke() would send
// `Bearer null` -- so it is disabled rather than left to fail on submit.
function setComposerEnabled(on) {
  $("task").disabled = !on;
  $("send").disabled = !on;
  $("newChat").disabled = !on;
}

$("appBody").hidden = false;
setComposerEnabled(false);
clearIssues();
showWelcome();

$("loginBtn").addEventListener("click", async () => {
  $("loginErr").textContent = "";
  $("loginBtn").disabled = true;
  try {
    accessToken = await login($("email").value.trim(), $("password").value);
    $("login").hidden = true;             // hide the header login form
    $("who").textContent = $("email").value.trim();
    conversationId = newConversationId();
    setComposerEnabled(true);
    clearIssues();
    refreshWelcome();                     // same block, minus the sign-in line
    $("task").focus();
  } catch (e) {
    $("loginErr").textContent = e.message;
  } finally {
    $("loginBtn").disabled = false;
  }
});

// Enter in the email/password fields submits the login.
["email", "password"].forEach((id) => $(id).addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("loginBtn").click(); }
}));

$("task").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("taskForm").requestSubmit(); }
});

// Both phases are the same endpoint, the same stream and the same controls-locked
// window; only the payload differs. Keeping one runner means the busy state cannot
// be right for a discovery turn and wrong for an investigation batch.
let stopWatchdog = null;

async function runAgent(body, running) {
  runBusy = true;
  $("send").disabled = true;
  $("newChat").disabled = true;   // clearing mid-run would strand the stream
  $("stopBtn").hidden = false;    // the only control that stays live during a run
  $("stopBtn").disabled = false;
  refreshTriage();                // locks the checkboxes and the investigate button
  setTrace([]);
  const status = document.createElement("div");
  status.className = "status";
  status.innerHTML = '<span class="spinner"></span>' + running;
  $("stream").appendChild(status); scrollDown();
  announce(running);   // the spinner is created per run, so it cannot itself be live
  try {
    await invoke(body, renderEvent);
  } catch (e) {
    // An abort is the user pressing Stop, not a failure. The run's own `done`
    // event may or may not have arrived first, depending on which side won.
    if (e && e.name === "AbortError") addLine("stopped", "\u23f9 stream closed locally.");
    else { announce("Error. " + String(e)); addLine("error", String(e)); }
  } finally {
    runBusy = false;
    clearTimeout(stopWatchdog);
    stopWatchdog = null;
    currentAbort = null;
    $("stopBtn").hidden = true;
    status.remove();
    setTrace([]);
    $("issuesCap").textContent = ISSUES_CAP_DEFAULT;
    $("send").disabled = false;
    $("newChat").disabled = false;
    // The rows were rendered with disabled checkboxes while runBusy was set; the
    // run may have ended without an update for every one of them, so re-enable
    // them directly rather than waiting for a re-render that may not come.
    document.querySelectorAll('#issues input[type="checkbox"]').forEach((c) => { c.disabled = false; });
    refreshTriage();
  }
}

$("taskForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const task = $("task").value.trim();
  if (!task) return;
  addBubble("user", task);
  $("task").value = "";
  await runAgent({ task }, "discovery: profiling and flagging issues…");
  $("task").focus();
});

// Phase 2. The selection goes to the server as issue numbers and the SERVER applies
// the triage, so what the panel shows and what actually gets worked come from one
// decision. Everything left unticked is marked ignored there, not here.
$("investigateBtn").addEventListener("click", async () => {
  const selected = [...picked].sort((a, b) => a - b);
  if (!selected.length) return;
  addBubble("user", `Investigate issue${selected.length > 1 ? "s" : ""} ${selected.map((n) => "#" + n).join(", ")}.`);
  picked.clear();
  await runAgent({ action: "investigate", selected },
                 `investigation: working ${selected.length} issue(s)…`);
  $("task").focus();
});

// Stop. Two layers, because they carry different guarantees:
//
//   1. The server-side cancel. A second invoke on the SAME session id lands in the
//      same microVM -- the property the checkpointer already relies on -- where the
//      runtime cancels the asyncio task running the job. That interrupts it even
//      mid-tool-call, and the run tears its own sandbox down on the way out.
//   2. Aborting our read of the stream. Instant and always available, but it only
//      ends the browser's side; on its own the agent would keep going server-side.
//
// So we ask the server first and only fall back to (2). The reply says whether the
// cancel actually found the running task, which is the one thing we must not guess
// about: "I pressed stop and nothing happened" and "the stop reached a different
// instance" look identical from here otherwise.
$("stopBtn").addEventListener("click", async () => {
  if (!runBusy) return;
  $("stopBtn").disabled = true;
  addLine("stopped", "\u23f9 stop requested\u2026");
  announce("Stop requested.");

  let events = [];
  try {
    events = await controlInvoke({ action: "stop" });
  } catch (e) {
    addLine("error", "Could not reach the runtime to stop the run: " + e.message);
  }
  const landed = events.some((x) => x.type === "stopping" && x.found);

  if (!landed) {
    addLine("error", "The stop did not reach the process running this job — the request "
                   + "was routed elsewhere, or the run had already finished. Closing the "
                   + "stream locally; if it was still running it will keep going until it "
                   + "finishes or the session times out.");
    return abortStream();
  }
  // The cancel landed, so the run should now close its own stream with a
  // `cancelled` done event. Give it a window, then stop waiting rather than
  // leaving the UI locked on a stream that is never going to end.
  stopWatchdog = setTimeout(() => {
    addLine("error", "The runtime accepted the stop but the stream has not closed. "
                   + "Closing it locally.");
    abortStream();
  }, 15000);
});

// Ask the runtime to drop a conversation's thread now rather than waiting for the
// idle timeout. `keepalive` is what lets this survive the page going away — a normal
// fetch is cancelled on unload, and sendBeacon cannot carry the Authorization header.
// Best-effort by nature: a crash, a dead network or a sleeping laptop all skip it,
// which is why the runtime's idle timeout is the actual guarantee.
function endConversation(id) {
  if (!id || !accessToken) return;
  const escaped = encodeURIComponent(CFG.runtimeArn);
  try {
    fetch(`https://bedrock-agentcore.${CFG.region}.amazonaws.com/runtimes/${escaped}/invocations?qualifier=DEFAULT`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": id,
      },
      body: JSON.stringify({ action: "end_session", conversation: id }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* unload path — nothing useful to do */ }
}

// Start over: purge the thread the agent is holding, then open a new one, so what
// the user sees and what the agent remembers stay in step.
$("newChat").addEventListener("click", () => {
  endConversation(conversationId);
  conversationId = newConversationId();
  pendingTools.length = 0;
  $("stream").replaceChildren();
  clearIssues();   // the runtime purges its copy in the same end_session call
  refreshWelcome();
  setTrace([]);
  announce("New conversation started. The agent no longer has the previous context, and the issue list is empty.");
  $("task").focus();
});

// Tab close / navigation away — the way sessions actually end. pagehide fires in
// cases beforeunload does not (notably the bfcache and mobile Safari).
window.addEventListener("pagehide", () => endConversation(conversationId));
