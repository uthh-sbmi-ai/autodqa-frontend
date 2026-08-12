// AutoDQA static console — Cognito login (USER_PASSWORD_AUTH) + direct streaming
// invoke of the AgentCore Runtime with the bearer token. No framework, no SDK.
// Config (region, clientId, runtimeArn, model) comes from config.js.
"use strict";

const CFG = window.AUTODQA_CONFIG;
let accessToken = null;

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
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": "web-" + crypto.randomUUID(),
    },
    body: JSON.stringify({ task }),
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
  if (ev.type === "sandbox") {
    const sid = (ev.session || "").replace(/^run-/, "").slice(0, 8);
    const msg = ev.phase === "up" ? "🖥️ sandbox microVM spinning up" : "🖥️ sandbox microVM released";
    announce(ev.phase === "up" ? "Sandbox starting." : "Sandbox released.");
    return addLine("sandbox", sid ? `${msg} · ${sid}` : msg);
  }
  // Terminal event: every run ends with exactly one of these, so "it just stopped"
  // is never ambiguous. Emitted by entrypoint.py's produce() on every exit path.
  if (ev.type === "done") {
    const n = `${ev.model_turns} model turn(s), ${ev.tool_calls} tool call(s)`;
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

// ---- Palette switcher (TEMPORARY evaluation aid) ----
// Remove this block, the .palette control and the extra :root[data-palette]
// rules once a palette is chosen. The <head> applies the saved value before
// first paint; this only keeps the control in sync and stores changes.
const PALETTE_KEY = "autodqa-palette";
const paletteSel = $("paletteSel");
if (paletteSel) {
  paletteSel.value = document.documentElement.getAttribute("data-palette") || "terracotta";
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
    $("task").focus();
  }
});
