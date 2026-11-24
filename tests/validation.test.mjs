import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/validation.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  fileName: "src/validation.ts",
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
assert.deepEqual(compiled.diagnostics, []);

const validation = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.outputText, "utf8").toString("base64")
);

const {
  cleanName,
  validateRunPayload,
  validateCheckinPayload,
  sha256Hex,
  timingSafeEqualHex,
  toCsv,
} = validation;

test("cleanName strips control characters and angle brackets, trims, and caps at 20 chars", () => {
  assert.equal(cleanName("  <Budi\x00>  "), "Budi");
  assert.equal(cleanName("A".repeat(30)), "A".repeat(20));
  assert.equal(cleanName(12345), "");
  assert.equal(cleanName(null), "");
});

test("validateRunPayload accepts valid payloads and trims rank", () => {
  const valid = validateRunPayload({
    id: "run123abc",
    name: " <Dewi> ",
    score: 1250,
    xp: 780,
    day: 1,
    done: true,
    rank: "  Satgas Lapangan " + "x".repeat(30),
    calmed: 3,
    riots: 1,
    ts: 1700000000000,
  });

  assert.deepEqual(valid, {
    id: "run123abc",
    name: "Dewi",
    score: 1250,
    xp: 780,
    day: 1,
    done: true,
    rank: ("Satgas Lapangan " + "x".repeat(30)).slice(0, 30),
    calmed: 3,
    riots: 1,
    ts: 1700000000000,
  });
});

test("validateRunPayload rejects invalid ids, short names, non-integers, and out-of-bounds fields", () => {
  const base = { id: "run123abc", name: "Dewi", score: 100, xp: 50, day: 1 };
  assert.equal(validateRunPayload(null), null);
  assert.equal(validateRunPayload([]), null);
  assert.equal(validateRunPayload({ ...base, id: "BAD_ID" }), null);
  assert.equal(validateRunPayload({ ...base, id: "abc" }), null);
  assert.equal(validateRunPayload({ ...base, name: "A" }), null);
  assert.equal(validateRunPayload({ ...base, score: -1 }), null);
  assert.equal(validateRunPayload({ ...base, score: 20001 }), null);
  assert.equal(validateRunPayload({ ...base, score: 10.5 }), null);
  assert.equal(validateRunPayload({ ...base, xp: 100000 }), null);
  assert.equal(validateRunPayload({ ...base, day: 4 }), null);
  assert.equal(validateRunPayload({ ...base, done: "true" }), null);
});

test("validateCheckinPayload validates fields, enforces honeypot, and bounds reflection length", () => {
  const ok = validateCheckinPayload({
    runId: "run123abc",
    nama: "  <Sari> ",
    sudah_mencoba: "Sudah, berhasil 5 menit",
    perasaan: "Tersentuh",
    tersulit: "Tidak memotong pembicaraan",
    pertanyaan_refleksi: "Apa hal baru?",
    refleksi: "  " + "r".repeat(400),
    "bot-field": "",
  });

  assert.equal(ok.nama, "Sari");
  assert.equal(ok.runId, "run123abc");
  assert.equal(ok.refleksi.length, 350);

  assert.equal(validateCheckinPayload({ nama: "Sari", "bot-field": "spam" }), null);
  assert.equal(validateCheckinPayload({ nama: "S" }), null);
  assert.equal(validateCheckinPayload({ nama: "Sari", runId: "BAD" }), null);
});

test("sha256Hex and timingSafeEqualHex verify hashes safely", async () => {
  const digest = await sha256Hex("abc");
  assert.equal(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(timingSafeEqualHex(digest, digest.toUpperCase()), true);
  assert.equal(timingSafeEqualHex(digest, digest.slice(0, -1) + "0"), false);
  assert.equal(timingSafeEqualHex("abc", "abcd"), false);
  assert.equal(timingSafeEqualHex("zzzz", "zzzz"), false);
});

test("toCsv escapes RFC 4180 delimiters and neutralizes spreadsheet formula injection", () => {
  const out = toCsv(
    ["nama", "catatan", "skor"],
    [
      ["Dewi", 'Halo, "dunia"', 120],
      ["Bot", "=HYPERLINK(\"http://evil\")", -10],
      ["Lead", "+SUM(A1:A2)", 0],
      ["Full", "＝cmd", 5],
    ]
  );

  assert.equal(
    out,
    [
      "nama,catatan,skor",
      'Dewi,"Halo, ""dunia""",120',
      'Bot,"\'=HYPERLINK(""http://evil"")",-10',
      "Lead,'+SUM(A1:A2),0",
      "Full,'＝cmd,5",
      "",
    ].join("\r\n")
  );
});
