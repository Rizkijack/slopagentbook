// Record a demo of the live SlopAgentbook map as a video, headlessly.
//
// This is shoot-map.mjs with a different capture primitive. shoot-map takes one
// Page.captureScreenshot per vantage point; a video needs the frames in between,
// which is Page.startScreencast. Everything else — launching its own headless
// Chrome on its own port so nothing needs approval, driving the camera through
// the window.__hermes_xf the app already exposes, pinning the sim clock so the
// town does not walk into dusk mid-take — is the same problem, already solved.
//
// Usage:
//   node scripts/record-demo.mjs                 # full demo -> <OUT>/demo.mp4
//   SMOKE=1 node scripts/record-demo.mjs        # 4s capture, proves the path
//   APP_URL=... OUT_DIR=... node scripts/record-demo.mjs
//
// Writes frames as JPEG plus a concat list, and shells out to ffmpeg. If ffmpeg
// is missing the frames are still there, which is the useful half.
import { spawn, execFile } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9334);
const URL_APP = process.env.APP_URL ?? "https://slopagentbook.vercel.app/";
const OUT = process.env.OUT_DIR ?? "C:/Users/USER/AppData/Local/Temp/opencode/demo";
const SMOKE = process.env.SMOKE === "1";
const W = 1600, H = 900;
const FPS_MAX = 12;              // CDP screencast top rate; Chrome drops below this

/**
 * The storyboard. Each beat is one camera state held for `hold` ms.
 *
 * `theme` is set on <html data-theme> and `clock` on the engine, because a town
 * day is short enough to walk out of daylight while a later beat is settling —
 * shoot-map.mjs re-pins the clock per shot for exactly that reason.
 *
 * `hash` navigates the SPA's hash routes, which is how every non-map page is
 * reached; the camera state is then irrelevant, so those beats park it.
 */
const BEATS = [
  // 1 — the whole town, the first thing anyone sees
  { name: "01-overview",  hash: "#/town", x: 525, y: 315, zoom: 0.30, theme: "light", clock: 0.40, hold: 5200 },
  // 2 — push into the core, where residents are big enough to read
  { name: "02-core",      hash: "#/town", x: 524, y: 315, zoom: 1.00, theme: "light", clock: 0.40, hold: 4600 },
  // 3 — Northgate, the metro district north of the core
  { name: "03-northgate", hash: "#/town", x: 520, y: 178, zoom: 1.00, theme: "light", clock: 0.40, hold: 3600 },
  // 4 — Ironworks, west
  { name: "04-ironworks", hash: "#/town", x: 240, y: 150, zoom: 1.00, theme: "light", clock: 0.40, hold: 3600 },
  // 5 — Riverside Wharf
  { name: "05-wharf",     hash: "#/town", x: 260, y: 420, zoom: 1.00, theme: "light", clock: 0.40, hold: 3600 },
  // 6 — the whole 1050x640 grid. This is where the metro parcels, their
  //     protected forests and the district names all read at once.
  { name: "06-whole-map", hash: "#/town", x: 525, y: 320, zoom: 0.0547, theme: "light", clock: 0.40, hold: 5200 },
  // 7 — night, same core: lamps, headlights, the day/night cycle
  { name: "07-night",     hash: "#/town", x: 524, y: 315, zoom: 1.00, theme: "dark",  clock: 0.86, hold: 4600 },
  // 8 — the quest board, which is the loop the town actually runs
  { name: "08-quests",    hash: "#/quest", theme: "light", clock: 0.40, hold: 4200 },
  // 9 — the coin page, where the treasury address lives
  { name: "09-coin",      hash: "#/coin",  theme: "light", clock: 0.40, hold: 4200 },
];

const SMOKE_BEATS = [
  { name: "smoke-overview", hash: "#/town", x: 525, y: 315, zoom: 0.5, theme: "light", clock: 0.40, hold: 3000 },
];

const profile = "C:/Users/USER/AppData/Local/Temp/opencode/chrome-demo";
const framesDir = `${OUT}/frames`;
try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch {}
mkdirSync(framesDir, { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  // a screencast of a canvas app wants a steady compositor more than it wants
  // a fast GPU, and headless has no GPU to speak of
  "--disable-dev-shm-usage", "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, "about:blank",
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
async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("Chrome debugging endpoint never came up");
}

// ---- frame capture ------------------------------------------------------------
// CDP hands out one frame at a time and will not send the next until the last
// is acked, so the frame count is bounded by how fast we write, not by the
// timer. Frames are kept with the timestamp the compositor gave them, because
// wall-clock spacing is what ffmpeg needs to reproduce real motion speed — a
// flat -r would render a stuttering browser as a smooth slideshow.
const frames = [];
let capturing = false;
let frameSeq = 0;

function onMessage(ev) {
  const msg = JSON.parse(ev.data);
  if (capturing && msg.method === "Page.screencastFrame") {
    const { data, sessionId, metadata } = msg.params;
    frames.push({ data, t: metadata.timestamp });
    frameSeq++;
    // ack immediately so the next frame can be produced
    send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error.message));
  else p.resolve(msg.result);
}

const beats = SMOKE ? SMOKE_BEATS : BEATS;
let recorded = 0;

try {
  const wsUrl = await connect();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP socket failed")); });
  ws.onmessage = onMessage;

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  await send("Page.navigate", { url: URL_APP });
  await sleep(9000);

  const clock = await evaluate(`(() => { const xf = window.__hermes_xf; xf.clock = 0.40; return xf.clock; })()`);
  console.log("clock pinned:", clock);

  const ready = await evaluate(`(() => {
    const xf = window.__hermes_xf;
    if (!xf) return { ok: false, why: "no __hermes_xf" };
    return { ok: true, agents: xf.byId ? xf.byId.size : -1,
             cam: { x: Math.round(xf.cam.x), y: Math.round(xf.cam.y), zoom: +xf.cam.zoom.toFixed(4) },
             world: { w: xf.worldW, h: xf.worldH } };
  })()`);
  console.log("page ready:", JSON.stringify(ready));
  if (!ready?.ok) throw new Error(`engine not ready: ${JSON.stringify(ready)}`);

  await send("Page.startScreencast", {
    format: "jpeg", quality: 82, maxWidth: W, maxHeight: H, everyNthFrame: 1,
  });
  capturing = true;
  const t0 = Date.now();

  for (const b of beats) {
    const before = frames.length;
    const info = await evaluate(`(() => {
      if (${JSON.stringify(b.hash ?? "#/town")} !== location.hash) location.hash = ${JSON.stringify(b.hash ?? "#/town")};
      document.documentElement.setAttribute("data-theme", ${JSON.stringify(b.theme)});
      // window.__hermes_xf only exists while the map canvas is mounted. On the
      // coin page the canvas unmounts and the handle goes with it, so every
      // camera write has to be behind the guard — the beat still records, it
      // just has nothing to steer.
      const xf = window.__hermes_xf;
      if (xf) {
        xf.setFollow?.(null);
        xf.clock = ${b.clock};
        ${b.x !== undefined ? `xf.cam.x = xf.cam.tx = ${b.x} * 16; xf.cam.y = xf.cam.ty = ${b.y} * 16; xf.cam.zoom = xf.cam.tz = ${b.zoom}; xf.clampCam();` : ""}
      }
      return { zoom: xf ? +xf.cam.zoom.toFixed(4) : null, hasEngine: !!xf,
               theme: document.documentElement.getAttribute("data-theme"),
               hash: location.hash };
    })()`);
    // hold the beat; re-pin the clock halfway because sim time walks on
    await sleep(Math.round(b.hold / 2));
    await evaluate(`(() => { const xf = window.__hermes_xf; if (xf) xf.clock = ${b.clock}; })()`).catch(() => {});
    await sleep(Math.round(b.hold / 2));
    const got = frames.length - before;
    recorded += got;
    console.log(`  beat ${b.name.padEnd(14)} theme=${String(info.theme).padEnd(5)} zoom=${String(info.zoom ?? "—").padEnd(7)} engine=${info.hasEngine ? "y" : "n"} ${String(got).padStart(3)} frames`);
  }

  await sleep(600);
  capturing = false;
  await send("Page.stopScreencast").catch(() => {});

  console.log(`\ncaptured ${frames.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
              `(${(frames.length / ((Date.now() - t0) / 1000)).toFixed(1)} fps)`);
  if (!frames.length) throw new Error("screencast produced no frames");

  // ---- write frames + concat list ------------------------------------------------
  const tFirst = frames[0].t;
  const list = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const name = `f${String(i).padStart(5, "0")}.jpg`;
    writeFileSync(`${framesDir}/${name}`, Buffer.from(f.data, "base64"));
    const next = frames[i + 1]?.t ?? (f.t + 1 / FPS_MAX);
    const dur = Math.max(0.001, next - f.t);
    // The list lives in OUT and the frames in OUT/frames, so the entry has to
    // carry the subdirectory. The concat demuxer resolves relative entries
    // against the list's own directory, so this works from any cwd — which is
    // the fix for ffmpeg reporting "Impossible to open 'f00000.jpg'" on a run
    // whose frames were all sitting right there.
    list.push(`file 'frames/${name}'`, `duration ${dur.toFixed(5)}`);
  }
  // the concat demuxer needs the final frame repeated or it drops it
  list.push(`file 'frames/f${String(frames.length - 1).padStart(5, "0")}.jpg'`);
  const listPath = `${OUT}/frames.txt`;
  writeFileSync(listPath, list.join("\n"));
  console.log(`wrote ${frames.length} frames + concat list to ${OUT}`);

  // ---- assemble -------------------------------------------------------------------
  const mp4 = `${OUT}/slopagentbook-demo.mp4`;
  if (SMOKE) {
    console.log("SMOKE=1 — frames written, skipping ffmpeg");
  } else {
    try {
      await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath,
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30",
        "-c:v", "libx264", "-preset", "slow", "-crf", "20",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4],
        { maxBuffer: 1 << 26 });
      console.log("wrote", mp4);
    } catch (e) {
      console.error("ffmpeg failed:", e.stderr?.toString().slice(0, 600) ?? e.message);
      console.error("frames are still at", framesDir);
      process.exitCode = 1;
    }
  }
} catch (e) {
  console.error("record failed:", e.message);
  console.error("frames so far:", frames.length);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(1200);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch {}
}
