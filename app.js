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
async function invoke(task, onEvent) {
  const escaped = encodeURIComponent(CFG.runtimeArn);
  const url = `https://bedrock-agentcore.${CFG.region}.amazonaws.com/runtimes/${escaped}/invocations?qualifier=DEFAULT`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      // Stable across the conversation: this is what routes every turn back to the
      // same session microVM, where the checkpointer's thread lives.
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": conversationId,
    },
    body: JSON.stringify({ task, conversation: conversationId }),
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

// ---- Issues panel ----
// Append-driven: the runtime emits one `issue` event per issue it actually
// recorded, in order, and never re-emits one. Rejected report_issue calls (a
// duplicate title, a bad enum, a full list) produce no event, so the panel and
// the agent's list cannot drift apart. Nothing here is ever rebuilt from a
// fetch -- there is no endpoint to rebuild it from, by design.
let issueMax = 10;      // authoritative value arrives on the first event
let issueCount = 0;

// Every field below is model-authored text, so it is set with textContent and
// never innerHTML -- a finding that quotes SQL or a column named <b> has to
// render as characters, not markup.
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function updateIssueCount() {
  $("issueCount").textContent = `${issueCount}/${issueMax}`;
  $("issuesEmpty").hidden = issueCount > 0;
}

function addIssue(issue) {
  const d = el("details", "issue");
  const sum = document.createElement("summary");
  sum.appendChild(el("span", "num", "#" + issue.n));
  sum.appendChild(el("span", "ttl", issue.title));
  const meta = el("div", "meta");
  meta.appendChild(el("span", "sev " + issue.severity, issue.severity));
  meta.appendChild(el("span", null, issue.dimension));
  const where = [issue.table, issue.column].filter(Boolean).join(".");
  if (where) meta.appendChild(el("span", "where", where));
  sum.appendChild(meta);
  d.appendChild(sum);

  const dl = document.createElement("dl");
  const row = (label, value, mono) => {
    if (!value) return;                 // optional fields collapse rather than show empty
    dl.appendChild(el("dt", null, label));
    dl.appendChild(el("dd", mono ? "mono" : null, value));
  };
  row("Finding", issue.finding);
  row("Evidence", issue.evidence, true);
  row("Recommendation", issue.recommendation);
  d.appendChild(dl);

  // One open at a time. The column is narrow and evidence blocks are long, so
  // two open issues push the rest of the list out of view. Done on toggle rather
  // than with <details name> so it works in browsers without exclusive accordions.
  d.addEventListener("toggle", () => {
    if (!d.open) return;
    $("issues").querySelectorAll("details.issue[open]").forEach((o) => { if (o !== d) o.open = false; });
  });

  const li = document.createElement("li");
  li.appendChild(d);
  $("issues").appendChild(li);
}

function clearIssues() {
  $("issues").replaceChildren();
  issueCount = 0;
  updateIssueCount();
}

// ---- Architecture diagram trace (nodes glow along the active path) ----
const archSvgEl = document.querySelector(".arch-svg");
const nodeEls = document.querySelectorAll(".anode");
const archStepEl = $("archStep");
const ARCH_DEFAULT = "The active path lights up as the agent runs.";

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
    addIssue(ev.issue);
    issueCount = ev.issue.n;   // the runtime numbers them 1..max, in order
    updateIssueCount();
    // Read the title, not the finding: the panel is where the detail belongs,
    // and the evidence block can be many lines of SQL.
    announce(`Issue ${ev.issue.n} recorded. ${ev.issue.severity} severity. ${ev.issue.title}`);
    return;
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
    if (typeof ev.issue_count === "number") { issueCount = ev.issue_count; updateIssueCount(); }
    const listed = ev.issue_count ? ` \u00b7 ${ev.issue_count} issue(s) listed` : "";
    const n = `${ev.model_turns} model turn(s), ${ev.tool_calls} tool call(s)${carried}${listed}`;
    if (ev.reason === "completed") {
      announce(`Run finished. ${n}.`);
      return addLine("done", `\u2713 finished \u00b7 ${n}`);
    }
    const why = ev.reason === "step_limit" ? `STOPPED AT STEP LIMIT (${ev.step_limit})`
              : ev.reason === "truncated"  ? "RUN TRUNCATED"
              : ev.reason === "cancelled"  ? "CANCELLED"
              : `STOPPED (${ev.reason})`;
    announce(`Run stopped. ${why}. ${n}. ${ev.message || ""}`);
    return addLine("error", `\u26a0 ${why} \u00b7 ${n}\n${ev.message || ""}`);
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

$("loginBtn").addEventListener("click", async () => {
  $("loginErr").textContent = "";
  $("loginBtn").disabled = true;
  try {
    accessToken = await login($("email").value.trim(), $("password").value);
    $("login").hidden = true;             // hide the header login form
    $("appBody").hidden = false;          // reveal the diagram + chat
    $("who").textContent = $("email").value.trim();
    conversationId = newConversationId();
    clearIssues();
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

$("taskForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const task = $("task").value.trim();
  if (!task) return;
  addBubble("user", task);
  $("task").value = "";
  $("send").disabled = true;
  $("newChat").disabled = true;   // clearing mid-run would strand the stream
  setTrace([]);
  const status = document.createElement("div");
  status.className = "status";
  status.innerHTML = '<span class="spinner"></span>agent running…';
  $("stream").appendChild(status); scrollDown();
  announce("Agent running.");   // the spinner is created per run, so it cannot itself be live
  try {
    await invoke(task, renderEvent);
  } catch (e) {
    announce("Error. " + String(e));
    addLine("error", String(e));
  } finally {
    status.remove();
    setTrace([]);
    $("send").disabled = false;
    $("newChat").disabled = false;
    $("task").focus();
  }
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
  setTrace([]);
  announce("New conversation started. The agent no longer has the previous context, and the issue list is empty.");
  $("task").focus();
});

// Tab close / navigation away — the way sessions actually end. pagehide fires in
// cases beforeunload does not (notably the bfcache and mobile Safari).
window.addEventListener("pagehide", () => endConversation(conversationId));
