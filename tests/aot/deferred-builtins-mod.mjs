import http, { STATUS_CODES } from "node:http";
import * as path from "node:path";
import * as fsNs from "node:fs";
import fs, { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import * as tls from "node:tls";
import http2 from "node:http2";
import https, { Agent as HttpsAgent } from "node:https";
import * as net from "node:net";
import { parse as parseQuery } from "node:querystring";
import Bun2 from "bun";
import Database, { Database as NamedDatabase } from "bun:sqlite";
import * as processNs from "node:process";
import processDefault from "node:process";

export function describe() {
  return [typeof http.createServer, STATUS_CODES[404], path.join("a", "b"), hashOf("deferred")].join(" ");
}

function hashOf(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function namespace() {
  return [typeof fsNs.readFileSync, typeof fsNs.default, "existsSync" in fsNs].join(" ");
}

export class Emitter extends EventEmitter {
  ping() {
    this.emit("ping", 7);
  }
}

export function network() {
  return [typeof tls.connect, typeof http2.connect, typeof https.request, new HttpsAgent() instanceof http.Agent, typeof net.connect, parseQuery("a=1&b=2").b].join(" ");
}

// A wrapper put over a builtin's function that calls the original through the name it was imported by.
export function patchAndCall() {
  let calls = 0;
  const original = fs.existsSync;
  fs.existsSync = function (p) {
    calls++;
    return existsSync(p);
  };
  try {
    return [fs.existsSync("/"), calls].join(" ");
  } finally {
    fs.existsSync = original;
  }
}

export function buns() {
  return [typeof Bun2.version, typeof Database, Database === NamedDatabase].join(" ");
}

export function processes() {
  return [typeof processNs.on, typeof processNs.cwd, processDefault === process, typeof processDefault.once].join(" ");
}

export const gz = zlib.gunzipSync(zlib.gzipSync("round trip")).toString();
export default path.basename("/x/y.txt");
