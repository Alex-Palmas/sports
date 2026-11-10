#!/usr/bin/env node
/**
 * Set PropLab's site password (site/access.json).
 *
 *   node scripts/set-password.mjs                 # generates a strong password and prints it once
 *   node scripts/set-password.mjs 'my passphrase' # or choose one (10+ characters)
 *   node scripts/set-password.mjs --lock-all      # keep the password, but lock every device now
 *
 * Only a salted PBKDF2-SHA256 hash (310,000 iterations) is stored, never the password. Commit and push
 * site/access.json afterwards. Every device re-checks on each page load, so a new password or --lock-all
 * locks everyone out (until they enter the password again) as soon as the deploy is live.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes, pbkdf2Sync } from "node:crypto";

const FILE = process.env.ACCESS_FILE || "site/access.json", ITER = 310000;
export function makeAccess(password) {
  const salt = randomBytes(16).toString("base64");
  return { salt, iter: ITER, hash: pbkdf2Sync(password, Buffer.from(salt, "base64"), ITER, 32, "sha256").toString("base64"), set: new Date().toISOString().slice(0, 10) };
}
// readable random password: 4 groups of 4 from an unambiguous alphabet (~80 bits)
const randomPassword = () => { const A = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = randomBytes(16);
  return Array.from({ length: 4 }, (_, g) => Array.from({ length: 4 }, (_, i) => A[b[g * 4 + i] % A.length]).join("")).join("-"); };

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "--lock-all") {
    if (!existsSync(FILE)) { console.error(`no ${FILE} yet: set a password first`); process.exit(1); }
    const a = JSON.parse(readFileSync(FILE, "utf8")); a.epoch = (a.epoch || 0) + 1; a.locked = new Date().toISOString();
    writeFileSync(FILE, JSON.stringify(a, null, 1) + "\n"); console.log(`locked every device (epoch ${a.epoch}); commit and push ${FILE}`); process.exit(0);
  }
  const given = process.argv[2];
  if (given && given.length < 10) { console.error("password must be at least 10 characters"); process.exit(1); }
  const password = given || randomPassword();
  writeFileSync(FILE, JSON.stringify(makeAccess(password), null, 1) + "\n");
  console.log(`wrote ${FILE}`);
  if (!given) console.log(`password: ${password}`);
}
