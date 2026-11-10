import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { makeAccess } from "../scripts/set-password.mjs";
const A = createRequire(import.meta.url)("../site/auth.js");

test("password gate: the browser's PBKDF2 check matches set-password's hash", async () => {
  const access = makeAccess("correct horse battery");
  assert.ok(!JSON.stringify(access).includes("correct horse"));       // only the hash is stored
  assert.equal(await A.verify(access, "correct horse battery"), true);
  assert.equal(await A.verify(access, "correct horse batter"), false);
  assert.equal(await A.verify(access, ""), false);
  assert.equal(await A.verify(null, "anything"), false);
});

test("access.json holds only a salted hash", () => {
  const a = JSON.parse(readFileSync(new URL("../site/access.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(a).sort(), ["hash", "iter", "salt", "set"]); assert.ok(a.iter >= 300000);
});
