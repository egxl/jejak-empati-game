export interface RunRecord {
  id: string;
  name: string;
  score: number;
  xp: number;
  day: number;
  done: boolean;
  rank: string;
  calmed: number;
  riots: number;
  ts: number;
}

interface CheckinPayload {
  runId: string | null;
  nama: string;
  sudah_mencoba: string;
  perasaan: string;
  tersulit: string;
  pertanyaan_refleksi: string;
  refleksi: string;
}

export interface CheckinRecord extends Omit<CheckinPayload, "runId"> {
  id: string;
  run_id: string | null;
  created_at: number;
}

const runIdPattern = /^[a-z0-9]{6,20}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function cleanName(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 20) : "";
}

export function validateRunPayload(value: unknown): RunRecord | null {
  if (!isRecord(value)) return null;

  const { id, score, xp, day, done = false, rank = "", calmed = 0, riots = 0, ts = 0 } = value;
  const name = cleanName(value.name);
  if (typeof id !== "string" || !runIdPattern.test(id) || name.length < 2 ||
      !integerIn(score, 0, 20000) || !integerIn(xp, 0, 99999) || !integerIn(day, 1, 3) ||
      typeof done !== "boolean" || typeof rank !== "string" ||
      !integerIn(calmed, 0, 99999) || !integerIn(riots, 0, 99999) ||
      !integerIn(ts, 0, Number.MAX_SAFE_INTEGER)) return null;

  return { id, name, score, xp, day, done, rank: rank.trim().slice(0, 30), calmed, riots, ts };
}

export function validateCheckinPayload(value: unknown): CheckinPayload | null {
  if (!isRecord(value)) return null;
  const {
    runId = null,
    "bot-field": honeypot = "",
    sudah_mencoba = "",
    perasaan = "",
    tersulit = "",
    pertanyaan_refleksi = "",
    refleksi = "",
  } = value;
  const nama = cleanName(value.nama);
  if (honeypot !== "" || nama.length < 2 ||
      (runId !== null && (typeof runId !== "string" || !runIdPattern.test(runId))) ||
      typeof sudah_mencoba !== "string" || typeof perasaan !== "string" ||
      typeof tersulit !== "string" || typeof pertanyaan_refleksi !== "string" ||
      typeof refleksi !== "string") return null;

  return {
    runId, nama,
    sudah_mencoba: sudah_mencoba.trim().slice(0, 120),
    perasaan: perasaan.trim().slice(0, 120),
    tersulit: tersulit.trim().slice(0, 120),
    pertanyaan_refleksi: pertanyaan_refleksi.trim().slice(0, 350),
    refleksi: refleksi.trim().slice(0, 350),
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length || !/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) return false;
  left = left.toLowerCase();
  right = right.toLowerCase();
  let difference = 0;
  for (let i = 0; i < left.length; i++) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

type CsvCell = string | number | boolean | null | undefined;

export function toCsv(columns: readonly string[], rows: ReadonlyArray<ReadonlyArray<CsvCell>>): string {
  const escape = (value: CsvCell): string => {
    let cell = String(value ?? "");
    if (typeof value === "string" && /^(?:[\t\r\n]|\s*[=+\-@＝＋－＠])/u.test(cell)) cell = "'" + cell;
    return /[",\r\n]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell;
  };
  return [columns, ...rows].map(row => row.map(escape).join(",")).join("\r\n") + "\r\n";
}
