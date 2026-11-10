#!/usr/bin/env node
/**
 * Add, update or remove a PropLab sign-in (site/users.json).
 *
 *   node scripts/add-user.mjs <username> [password] [--name "Display Name"]   # random password if omitted
 *   node scripts/add-user.mjs --remove <username>
 *   node scripts/add-user.mjs --list
 *
 * Only a salted PBKDF2-SHA256 hash is stored (310,000 iterations), never the password. The password is
 * printed once when generated: save it somewhere safe.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, pbkdf2Sync } from "node:crypto";

const FILE = process.env.USERS_FILE || "site/users.json", ITER = 310000;
const args = process.argv.slice(2);
const users = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : [];
const save = () => writeFileSync(FILE, JSON.stringify(users, null, 1) + "\n");
const flag = k => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };

export function makeUser(u, password, name) {
  const salt = randomBytes(16).toString("base64");
  const hash = pbkdf2Sync(password, Buffer.from(salt, "base64"), ITER, 32, "sha256").toString("base64");
  return { u, name: name || u, salt, iter: ITER, hash, created: new Date().toISOString().slice(0, 10) };
}
// readable random password: 4 groups of 4 from an unambiguous alphabet (~80 bits)
const randomPassword = () => { const A = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = randomBytes(16);
  return Array.from({ length: 4 }, (_, g) => Array.from({ length: 4 }, (_, i) => A[b[g * 4 + i] % A.length]).join("")).join("-"); };

if (import.meta.url === `file://${process.argv[1]}`) {
  if (args[0] === "--list") { for (const x of users) console.log(`${x.u}\t${x.name}\t${x.created || ""}`); process.exit(0); }
  if (args[0] === "--remove") { const u = args[1]; const n = users.length; users.splice(0, users.length, ...users.filter(x => x.u.toLowerCase() !== String(u).toLowerCase())); save(); console.log(n === users.length ? `no user ${u}` : `removed ${u}`); process.exit(0); }
  const name = flag("--name"), [u, given] = args;
  if (!u || !/^[A-Za-z0-9._-]{2,32}$/.test(u)) { console.error("usage: node scripts/add-user.mjs <username> [password] [--name \"Display Name\"]  (username: 2-32 letters, digits, . _ -)"); process.exit(1); }
  if (given && given.length < 10) { console.error("password must be at least 10 characters"); process.exit(1); }
  const password = given || randomPassword();
  const i = users.findIndex(x => x.u.toLowerCase() === u.toLowerCase()), rec = makeUser(u, password, name);
  if (i >= 0) users[i] = rec; else users.push(rec);
  save();
  console.log(`${i >= 0 ? "updated" : "added"} ${u} in ${FILE}`);
  if (!given) console.log(`password: ${password}`);
}
