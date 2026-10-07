// Drill tooling, not shipped (M12a): loaded with `node --import` into a holder's `moe` process, it ends the process
// (exit 97) at any outbound TCP connection to a port `MOE_DRILL_PORTS` (comma-separated) does not name, before the
// connection is made: the proxy's and the node's. A holder that reached the operator's service other than through the
// proxy fails the drill, where a refused connection could otherwise read as an unanswered service.
import net from "node:net";

const allowed = new Set((process.env.MOE_DRILL_PORTS ?? "").split(",").filter(port => port !== "").map(Number));
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === "object" && first !== null ? first : { port: first, host: args[1] };
  if (options.path === undefined && !allowed.has(Number(options.port))) {
    process.stderr.write(`direct-guard: a direct connection to ${options.host ?? "localhost"}:${options.port}\n`);
    process.exit(97);
  }
  return connect.apply(this, args);
};
