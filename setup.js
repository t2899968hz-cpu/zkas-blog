#!/usr/bin/env node
// One-time setup: generate the admin password + server secrets.
// Prints the plaintext password ONCE (capture it now — it is never stored or
// logged again; only its scrypt hash is written to secrets.json, mode 600).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STATE_DIR = process.env.ZB_STATE_DIR || "/root/zkas-blog";
const SECRETS = path.join(STATE_DIR, "secrets.json");

fs.mkdirSync(STATE_DIR, { recursive: true });

if (fs.existsSync(SECRETS) && !process.argv.includes("--force")) {
  console.error(`secrets.json already exists at ${SECRETS}. Re-run with --force to regenerate (this invalidates the current password & all sessions).`);
  process.exit(1);
}

// Readable-but-strong password: 24 base58-ish chars.
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randPassword(n = 24) {
  const bytes = crypto.randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const password = randPassword(24);
const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.scryptSync(password, salt, 32).toString("hex");
const sessionSecret = crypto.randomBytes(32).toString("hex");

fs.writeFileSync(
  SECRETS,
  JSON.stringify({ salt, hash, sessionSecret, createdAt: new Date().toISOString() }, null, 2),
  { mode: 0o600 },
);
fs.chmodSync(SECRETS, 0o600);

console.log("\n=====================================================");
console.log(" ZKas blog admin password (shown once — save it now):");
console.log("   " + password);
console.log(" Login at: https://zkas.info/blog/admin");
console.log(" Hash stored at: " + SECRETS + " (mode 600)");
console.log("=====================================================\n");
