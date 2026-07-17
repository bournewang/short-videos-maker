import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["--watch", "--watch-preserve-output", "scripts/render-service.mjs"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev:web"], { stdio: "inherit" }),
];

function stop(signal = "SIGTERM") {
  for (const child of children) if (!child.killed) child.kill(signal);
}

process.on("SIGINT", () => { stop("SIGINT"); process.exit(0); });
process.on("SIGTERM", () => { stop("SIGTERM"); process.exit(0); });
children.forEach((child) => child.on("exit", (code) => { if (code && code !== 0) { stop(); process.exit(code); } }));
