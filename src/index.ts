import { PresenceRoom } from "./presence-room";
import {
  sha256Hex, timingSafeEqualHex, toCsv, validateCheckinPayload, validateRunPayload,
  type CheckinRecord, type RunRecord,
} from "./validation";

export { PresenceRoom };

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PRESENCE_ROOM: DurableObjectNamespace<PresenceRoom>;
  ADMIN_TOKEN?: string;
}

type RunRow = Omit<RunRecord, "done"> & { done: number; created_at: number; updated_at: number };

const runColumns = ["id", "name", "score", "xp", "day", "done", "rank", "calmed", "riots", "ts",
  "created_at", "updated_at"] as const;
const checkinColumns = ["id", "run_id", "nama", "sudah_mencoba", "perasaan", "tersulit",
  "pertanyaan_refleksi", "refleksi", "created_at"] as const;
const leaderboard = `SELECT ${runColumns.join(", ")} FROM runs ORDER BY score DESC, xp DESC, updated_at DESC`;
const recentCheckins = `SELECT ${checkinColumns.join(", ")} FROM checkins ORDER BY created_at DESC`;
const privateHeaders = { "Cache-Control": "no-store" };

function error(message: string, status: number): Response {
  return Response.json({ ok: false, error: message }, { status, headers: privateHeaders });
}

function room(env: Env): DurableObjectStub<PresenceRoom> {
  return env.PRESENCE_ROOM.get(env.PRESENCE_ROOM.idFromName("global-village-room"));
}

async function board(db: D1Database) {
  const { results } = await db.prepare(leaderboard + " LIMIT 200").all<RunRow>();
  return results.map(row => ({ ...row, done: Boolean(row.done) }));
}

function csv<K extends string>(filename: string, columns: readonly K[], rows: Record<K, string | number | boolean | null>[]): Response {
  return new Response("\uFEFF" + toCsv(columns, rows.map(row => columns.map(column => row[column]))), {
    headers: {
      ...privateHeaders,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function admin(request: Request, env: Env, path: string): Promise<Response> {
  if (!env.ADMIN_TOKEN) return error("Admin token is not configured", 503);
  const bearer = request.headers.get("Authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!bearer || !timingSafeEqualHex(await sha256Hex(bearer), await sha256Hex(env.ADMIN_TOKEN))) {
    return Response.json({ ok: false, error: "Unauthorized" }, {
      status: 401,
      headers: { ...privateHeaders, "WWW-Authenticate": 'Bearer realm="Jejak Empati"' },
    });
  }

  const db = env.DB;
  if (path === "/api/admin/checkins.csv") {
    const { results } = await db.prepare(recentCheckins).all<CheckinRecord>();
    return csv("checkins.csv", checkinColumns, results);
  }
  if (path === "/api/admin/runs.csv") {
    const { results } = await db.prepare(leaderboard).all<RunRow>();
    return csv("runs.csv", runColumns, results);
  }

  const [checkins, runs, checkinStats, runStats, feelings, challenges] = await Promise.all([
    db.prepare(recentCheckins + " LIMIT 200").all<CheckinRecord>(),
    board(db),
    db.prepare(`SELECT COUNT(*) AS total, COUNT(NULLIF(refleksi, '')) AS reflections,
                       COUNT(CASE WHEN sudah_mencoba <> '' THEN 1 END) AS answered
                FROM checkins`).first(),
    db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS completed FROM runs").first(),
    db.prepare(`SELECT perasaan AS label, COUNT(*) AS count FROM checkins WHERE perasaan <> ''
                GROUP BY perasaan ORDER BY count DESC, label LIMIT 20`).all(),
    db.prepare(`SELECT tersulit AS label, COUNT(*) AS count FROM checkins WHERE tersulit <> ''
                GROUP BY tersulit ORDER BY count DESC, label LIMIT 20`).all(),
  ]);
  return Response.json({
    ok: true,
    stats: { checkins: checkinStats, runs: runStats, feelings: feelings.results, challenges: challenges.results },
    checkins: checkins.results,
    runs,
  }, { headers: privateHeaders });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const { method } = request;

    if (method === "GET" && pathname === "/api/health") return Response.json({ ok: true });
    if (method === "GET" && pathname === "/api/board") {
      return Response.json({ runs: await board(env.DB) }, { headers: privateHeaders });
    }

    if (method === "POST" && pathname === "/api/runs/start") {
      const run = validateRunPayload(await request.json().catch(() => null));
      if (!run) return error("Invalid run", 400);
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const writeToken = Array.from(tokenBytes, byte => byte.toString(16).padStart(2, "0")).join("");
      const tokenHash = await sha256Hex(writeToken);
      const now = Date.now();
      const { meta } = await env.DB.prepare(`
        INSERT INTO runs (id, name, score, xp, day, done, rank, calmed, riots, ts, token_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).bind(run.id, run.name, run.score, run.xp, run.day, Number(run.done), run.rank, run.calmed,
        run.riots, run.ts, tokenHash, now, now).run();
      if (!meta.changes) return error("Run already exists", 409);
      ctx.waitUntil(room(env).broadcastBoardUpdate());
      return Response.json({ ok: true, id: run.id, writeToken }, { status: 201, headers: privateHeaders });
    }

    const runPath = pathname.match(/^\/api\/runs\/([a-z0-9]{6,20})$/);
    if (method === "PUT" && runPath) {
      const id = runPath[1];
      const row = await env.DB.prepare("SELECT token_hash FROM runs WHERE id = ?").bind(id).first<{ token_hash: string }>();
      if (!row) return error("Run not found", 404);
      const token = request.headers.get("X-Run-Token");
      if (!token || !timingSafeEqualHex(await sha256Hex(token), row.token_hash)) return error("Invalid run token", 403);
      const run = validateRunPayload(await request.json().catch(() => null));
      if (!run || run.id !== id) return error("Invalid run", 400);
      await env.DB.prepare(`
        UPDATE runs SET score = ?, xp = ?, day = ?, done = ?, rank = ?, calmed = ?, riots = ?, ts = ?, updated_at = ?
        WHERE id = ?
      `).bind(run.score, run.xp, run.day, Number(run.done), run.rank, run.calmed, run.riots, run.ts, Date.now(), id).run();
      ctx.waitUntil(room(env).broadcastBoardUpdate());
      return Response.json({ ok: true });
    }

    if (method === "POST" && pathname === "/api/checkins") {
      const checkin = validateCheckinPayload(await request.json().catch(() => null));
      if (!checkin) return error("Invalid check-in", 400);
      const id = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO checkins (id, run_id, nama, sudah_mencoba, perasaan, tersulit, pertanyaan_refleksi, refleksi, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, checkin.runId, checkin.nama, checkin.sudah_mencoba, checkin.perasaan, checkin.tersulit,
        checkin.pertanyaan_refleksi, checkin.refleksi, Date.now()).run();
      return Response.json({ ok: true, id }, { status: 201 });
    }

    if (method === "GET" && pathname === "/api/room") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error("WebSocket upgrade required", 426);
      return room(env).fetch(request);
    }

    if (method === "GET" &&
        ["/api/admin/summary", "/api/admin/checkins.csv", "/api/admin/runs.csv"].includes(pathname)) {
      return admin(request, env, pathname);
    }

    // Static Assets resolves /admin to admin.html using its default HTML routing.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
