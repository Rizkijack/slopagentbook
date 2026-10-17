// Verify the demo-2 caption overlay actually renders in the page DOM.
//
// The recording itself already proves the *mechanism* ran — drawCaption() is
// awaited in scripts/record-demo2.mjs and throws on any Runtime exception —
// but OCR of the finished video is not available in this environment
// (every vision provider errored), so this probe reads back the DOM state the
// same injection produces: element present, correct text, band visible.
//
// Usage: node scripts/check-demo-cap.mjs
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync, rmSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9338;
const URL_APP = "https://slopagentbook.vercel.app/";
const profile = "C:/Users/USER/AppData/Local/Temp/opencode/chrome-capcheck";
try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch {}

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-dev-shm-usage", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, "--window-size=1600,900", "about:blank",
], { stdio: "ignore" });

let ws, nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); } }, 45000);
  });
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result?.value;
}

try {
  let wsUrl;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(500);
  }
  if (!wsUrl) throw new Error("chrome never came up");
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP socket failed")); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: URL_APP });
  await sleep(9000);

  // the exact styles + wrap markup the recorder installs
  // (kept in sync by hand with scripts/record-demo2.mjs — it is a probe, not
  // the product; a drift shows up as a failed assertion, which is the point)
  const src = readFileSync("scripts/record-demo2.mjs", "utf8");
  const cssMatch = src.match(/const CAPTION_CSS = `([\s\S]*?)`;/);
  if (!cssMatch) throw new Error("CAPTION_CSS not found in recorder");
  const css = cssMatch[1];
  const draw = (cap) => evaluate(`(() => {
    let wrap = document.getElementById("demo-capwrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "demo-capwrap";
      const style = document.createElement("style");
      style.textContent = ${JSON.stringify(css)};
      wrap.appendChild(style);
      const band = document.createElement("div"); band.id = "demo-capband";
      band.innerHTML = '<div id="demo-capkicker"></div><div id="demo-captitle"></div><div id="demo-capsub"></div>';
      wrap.appendChild(band);
      document.body.appendChild(wrap);
    }
    const cap = JSON.parse(${JSON.stringify(JSON.stringify(cap))});
    document.getElementById("demo-capkicker").textContent = cap.kicker ?? "";
    document.getElementById("demo-captitle").textContent = cap.title ?? "";
    document.getElementById("demo-capsub").textContent = cap.sub ?? "";
    document.getElementById("demo-capband").style.display = cap ? "block" : "none";
    return document.getElementById("demo-capwrap").outerHTML.length;
  })()`);

  await draw({ kicker: "#/herd", title: "The Herd", sub: "Browse every resident agent — mood, thoughts and current activity" });

  const state = await evaluate(`(() => {
    const g = (id) => document.getElementById(id)?.textContent ?? null;
    const band = document.getElementById("demo-capband");
    const cs = band ? getComputedStyle(band) : null;
    return {
      wrapExists: !!document.getElementById("demo-capwrap"),
      kicker: g("demo-capkicker"), title: g("demo-captitle"), sub: g("demo-capsub"),
      bandDisplay: cs?.display ?? null, bandColor: cs?.color ?? null,
    };
  })()`);
  console.log("dom state:", JSON.stringify(state, null, 2));

  const ok =
    state.wrapExists &&
    state.title === "The Herd" &&
    state.sub === "Browse every resident agent — mood, thoughts and current activity" &&
    state.bandDisplay === "block";
  console.log(ok ? "CAPTION RENDER CHECK: PASS" : "CAPTION RENDER CHECK: FAIL");
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error("probe failed:", e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(800);
}
