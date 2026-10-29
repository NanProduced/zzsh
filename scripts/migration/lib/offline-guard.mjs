/**
 * Offline guard for the rehearsal CLI.
 *
 * The guard is installed before any product module is loaded. It makes every
 * network attempt fail loudly and counts it, so a "plan" run can prove that it
 * performed zero DB/HTTP work instead of merely claiming so.
 */
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import Module from "node:module";

export function installOfflineGuard(io) {
  const deny = (what) => {
    io.networkAttempts += 1;
    const error = new Error(`OFFLINE_GUARD:${what}`);
    error.code = "OFFLINE_GUARD";
    throw error;
  };

  net.Socket.prototype.connect = function deniedSocketConnect() {
    return deny("NET_SOCKET_CONNECT");
  };
  net.connect = () => deny("NET_CONNECT");
  net.createConnection = () => deny("NET_CONNECT");
  tls.connect = () => deny("TLS_CONNECT");
  http.request = () => deny("HTTP_REQUEST");
  http.get = () => deny("HTTP_GET");
  https.request = () => deny("HTTPS_REQUEST");
  https.get = () => deny("HTTPS_GET");
  dns.lookup = () => deny("DNS_LOOKUP");
  dns.promises.lookup = () => deny("DNS_LOOKUP");

  const patchPg = (pg) => {
    if (!pg || pg.__rehearsalGuarded) return;
    pg.__rehearsalGuarded = true;
    if (pg.Client?.prototype?.connect) {
      pg.Client.prototype.connect = function deniedPgClientConnect() {
        io.dbConnects += 1;
        return deny("PG_CLIENT_CONNECT");
      };
    }
    if (pg.Pool?.prototype?.connect) {
      pg.Pool.prototype.connect = function deniedPgPoolConnect() {
        io.dbConnects += 1;
        return deny("PG_POOL_CONNECT");
      };
    }
  };

  // Patch pg lazily if any product module requires it. Loading pg alone does
  // not open a socket, and the frozen planner entry should not require it.
  const load = Module._load;
  Module._load = function guardedLoad(request, parent, isMain) {
    const exported = load.call(this, request, parent, isMain);
    if (request === "pg" || request === "pg/lib/index.js") patchPg(exported);
    return exported;
  };
}

export function assertOffline(io) {
  if (io.networkAttempts !== 0) throw new Error(`OFFLINE_VIOLATION:NETWORK:${io.networkAttempts}`);
  if (io.dbConnects !== 0) throw new Error(`OFFLINE_VIOLATION:DB:${io.dbConnects}`);
  if (io.writerCalls !== 0) throw new Error(`OFFLINE_VIOLATION:WRITER:${io.writerCalls}`);
}
