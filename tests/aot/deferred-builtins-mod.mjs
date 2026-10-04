import http, { STATUS_CODES } from "node:http";
import * as path from "node:path";
import * as fsNs from "node:fs";
import { EventEmitter } from "node:events";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

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

export const gz = zlib.gunzipSync(zlib.gzipSync("round trip")).toString();
export default path.basename("/x/y.txt");
