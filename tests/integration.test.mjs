import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8789;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/room`;
const ADMIN_TOKEN = "test-admin-secret-token";

function runWrangler(args) {
  if (process.platform === "win32") {
    return execFileSync("cmd.exe", ["/c", "npx", "wrangler", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    });
  }
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
  });
}

function spawnWranglerDev(persistDir) {
  const args = [
    "wrangler",
    "dev",
    "--local",
    "--port",
    String(PORT),
    "--ip",
    "127.0.0.1",
    "--persist-to",
    persistDir,
    "--var",
    `ADMIN_TOKEN:${ADMIN_TOKEN}`,
  ];
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/c", "npx", ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn("npx", args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function stopChild(child) {
  if (!child || child.killed) return Promise.resolve();
  return new Promise(resolve => {
    child.once("exit", () => resolve());
    if (process.platform === "win32" && child.pid) {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        child.kill();
      }
    } else {
      child.kill("SIGTERM");
    }
    setTimeout(resolve, 1500);
  });
}

async function waitForReady(proc, logs) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`wrangler dev exited early (${proc.exitCode}):\n${logs.join("")}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // Server not listening yet
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for wrangler dev:\n${logs.join("")}`);
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const messages = [];
    ws.on("message", data => {
      try {
        messages.push(JSON.parse(data.toString("utf8")));
      } catch {}
    });
    ws.once("open", () => resolve({ ws, messages }));
    ws.once("error", reject);
  });
}

function waitForMessage(ws, messages, predicate, timeoutMs = 4000) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`WebSocket message timeout. Seen: ${JSON.stringify(messages)}`));
    }, timeoutMs);

    function onMessage(raw) {
      try {
        const msg = JSON.parse(raw.toString("utf8"));
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(msg);
        }
      } catch {}
    }

    ws.on("message", onMessage);
  });
}

test("end-to-end Worker API, D1 persistence, Durable Object WebSocket presence, and Admin portal", async () => {
  const persistDir = mkdtempSync(join(tmpdir(), "jejak-empati-test-"));
  const logs = [];
  let devProc = null;

  try {
    runWrangler(["d1", "migrations", "apply", "jejak-empati-db", "--local", "--persist-to", persistDir]);
    devProc = spawnWranglerDev(persistDir);
    devProc.stdout.on("data", chunk => logs.push(chunk.toString("utf8")));
    devProc.stderr.on("data", chunk => logs.push(chunk.toString("utf8")));

    await waitForReady(devProc, logs);

    // 1. Static asset routes
    const homeRes = await fetch(`${BASE_URL}/`);
    assert.equal(homeRes.status, 200);
    assert.match(await homeRes.text(), /Jejak Empati/);

    const adminPageRes = await fetch(`${BASE_URL}/admin`);
    assert.equal(adminPageRes.status, 200);
    assert.match(await adminPageRes.text(), /Dashboard Fasilitator/);

    // 2. Check-in submission + honeypot rejection
    const badCheckin = await fetch(`${BASE_URL}/api/checkins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nama: "Bot", "bot-field": "filled" }),
    });
    assert.equal(badCheckin.status, 400);

    const runPayload = {
      id: "e2erun01",
      name: "Dewi",
      score: 120,
      xp: 90,
      day: 1,
      done: false,
      rank: "Relawan Desa",
      calmed: 1,
      riots: 0,
      ts: Date.now(),
    };

    const startRes = await fetch(`${BASE_URL}/api/runs/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(runPayload),
    });
    assert.equal(startRes.status, 201);
    const { writeToken } = await startRes.json();
    assert.match(writeToken, /^[0-9a-f]{64}$/);

    // Duplicate run ID rejected
    const dupRes = await fetch(`${BASE_URL}/api/runs/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(runPayload),
    });
    assert.equal(dupRes.status, 409);

    // Check-in linked to runId
    const okCheckin = await fetch(`${BASE_URL}/api/checkins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: runPayload.id,
        nama: "Dewi",
        sudah_mencoba: "Sudah, berhasil 5 menit",
        perasaan: "Tersentuh",
        tersulit: "Tidak memotong pembicaraan",
        pertanyaan_refleksi: "Apa hal baru?",
        refleksi: "=SUM(1,2)",
        "bot-field": "",
      }),
    });
    assert.equal(okCheckin.status, 201);

    // 3. WebSocket live presence across 2 clients + board_update broadcast
    const clientA = await connectWs();
    const clientB = await connectWs();

    const twoPeersPromise = waitForMessage(
      clientA.ws,
      clientA.messages,
      m => m.type === "peers" && m.peers.length === 2
    );
    const boardUpdatePromise = waitForMessage(
      clientA.ws,
      clientA.messages,
      m => m.type === "board_update"
    );

    clientA.ws.send(JSON.stringify({ type: "presence", run: runPayload }));
    clientB.ws.send(JSON.stringify({ type: "presence", run: { ...runPayload, id: "e2erun02", name: "Budi" } }));

    const twoPeers = await twoPeersPromise;
    assert.deepEqual(
      twoPeers.peers.map(p => p.id).sort(),
      ["e2erun01", "e2erun02"]
    );

    // 4. Token-protected run update + board check
    const badUpdate = await fetch(`${BASE_URL}/api/runs/${runPayload.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Run-Token": "0".repeat(64) },
      body: JSON.stringify({ ...runPayload, score: 999 }),
    });
    assert.equal(badUpdate.status, 403);

    const goodUpdate = await fetch(`${BASE_URL}/api/runs/${runPayload.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Run-Token": writeToken },
      body: JSON.stringify({ ...runPayload, score: 650, done: true, calmed: 4 }),
    });
    assert.equal(goodUpdate.status, 200);
    await boardUpdatePromise;

    // Peer disconnect removes peer
    const onePeerPromise = waitForMessage(
      clientA.ws,
      clientA.messages,
      m => m.type === "peers" && m.peers.length === 1 && m.peers[0].id === "e2erun01"
    );
    clientB.ws.close(1000);
    await onePeerPromise;
    clientA.ws.close(1000);

    const boardRes = await fetch(`${BASE_URL}/api/board`);
    assert.equal(boardRes.status, 200);
    const boardJson = await boardRes.json();
    assert.equal(boardJson.runs.length, 1);
    assert.equal(boardJson.runs[0].score, 650);
    assert.equal(boardJson.runs[0].done, true);
    assert.equal("token_hash" in boardJson.runs[0], false);

    // 5. Protected admin endpoints + CSV formula-injection neutralization
    assert.equal((await fetch(`${BASE_URL}/api/admin/summary`)).status, 401);
    const adminHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}` };
    const summaryRes = await fetch(`${BASE_URL}/api/admin/summary`, { headers: adminHeaders });
    assert.equal(summaryRes.status, 200);
    const summary = await summaryRes.json();
    assert.equal(summary.stats.checkins.total, 1);
    assert.equal(summary.stats.checkins.reflections, 1);
    assert.equal(summary.stats.runs.completed, 1);

    const checkinsCsv = await fetch(`${BASE_URL}/api/admin/checkins.csv`, { headers: adminHeaders });
    assert.equal(checkinsCsv.status, 200);
    assert.match(checkinsCsv.headers.get("content-disposition"), /attachment; filename="checkins\.csv"/);
    assert.match(await checkinsCsv.text(), /'=SUM\(1,2\)/);

    const runsCsv = await fetch(`${BASE_URL}/api/admin/runs.csv`, { headers: adminHeaders });
    assert.equal(runsCsv.status, 200);
    assert.match(await runsCsv.text(), /e2erun01,Dewi,650/);
  } finally {
    await stopChild(devProc);
    rmSync(persistDir, { recursive: true, force: true });
  }
});
