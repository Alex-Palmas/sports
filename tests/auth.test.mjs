import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { makeUser } from "../scripts/add-user.mjs";
const A = createRequire(import.meta.url)("../site/auth.js");

test("sign-in: the browser's PBKDF2 check matches add-user's hash; wrong passwords and names fail", async () => {
  const users = [makeUser("alice", "correct horse battery", "Alice"), makeUser("bob", "another-password-1")];
  assert.ok(!JSON.stringify(users).includes("correct horse"));          // only the hash is stored
  assert.deepEqual(await A.verify(users, "alice", "correct horse battery"), { u: "alice", name: "Alice" });
  assert.deepEqual(await A.verify(users, "ALICE ", "correct horse battery"), { u: "alice", name: "Alice" }); // names are case-insensitive
  assert.equal(await A.verify(users, "alice", "correct horse batter"), null);
  assert.equal(await A.verify(users, "carol", "correct horse battery"), null);
  assert.equal(await A.verify([], "alice", "x"), null);
});

test("users.json holds only salted hashes", () => {
  const users = JSON.parse(readFileSync(new URL("../site/users.json", import.meta.url), "utf8"));
  assert.ok(users.length >= 1);
  for (const u of users) { assert.deepEqual(Object.keys(u).sort(), ["created", "hash", "iter", "name", "salt", "u"]); assert.ok(u.iter >= 300000); }
});
