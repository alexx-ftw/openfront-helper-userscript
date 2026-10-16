// Runs the memory-gated native Silo fixtures + typecheck sequentially, but only
// when the current chatgpt cgroup has headroom, so the chain can never be the
// process that triggers a cgroup-wide OOM. See docs/legendary-metric-ceilings.md.
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/* eslint-disable no-console -- CLI evidence output is this script's contract. */

// Scope names drift across reboots/relaunches (chatgpt.slice backend vs
// chatgpt-gui launcher scopes), so resolve the live cgroup from /proc.
const LEGACY_CGDIR =
  "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/chatgpt.slice/chatgpt-backend.slice";
const FALLBACK_LIMIT = 4 * 1024 ** 3;
const NEED_FREE = 1.5 * 1024 ** 3;
const HEAP_CAP = "--max-old-space-size=768";

const steps = [
  "node test/nuke-trade-partner-discount.mjs",
  "npx tsx --tsconfig openfront-engine/tsconfig.json test/silo-slot-pressure-scenario.mts",
  "npx tsx --tsconfig openfront-engine/tsconfig.json test/silo-neighbor-sam-demand-scenario.mts",
  "npx tsx --tsconfig openfront-engine/tsconfig.json test/silo-neighbor-sam-level-upgrade-scenario.mts",
  "npm run check",
];

function ownCgroupDir() {
  const line = readFileSync("/proc/self/cgroup", "utf8")
    .split("\n")
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- cgroup v2 hierarchy marker, not a network address.
    .find((entry) => entry.startsWith("0::"));
  if (!line) return null;
  const path = line.slice(3).trim();
  if (!path || path === "/") return null;
  const dir = `/sys/fs/cgroup${path}`;
  return existsSync(`${dir}/memory.current`) ? dir : null;
}

function memorySnapshot() {
  const dir =
    ownCgroupDir() ?? (existsSync(`${LEGACY_CGDIR}/memory.current`) ? LEGACY_CGDIR : null);
  if (dir) {
    const used = Number(readFileSync(`${dir}/memory.current`, "utf8").trim());
    const rawLimit = readFileSync(`${dir}/memory.max`, "utf8").trim();
    const limit = rawLimit === "max" ? FALLBACK_LIMIT : Number(rawLimit);
    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
      return { used, limit, free: limit - used, scope: dir };
    }
  }
  // No cgroup limit visible: fall back to system-wide memory so the gate
  // still refuses to launch near an OOM instead of failing to open a path.
  const meminfo = readFileSync("/proc/meminfo", "utf8");
  const total = Number(/^MemTotal:\s+(\d+)/m.exec(meminfo)?.[1]) * 1024;
  const available = Number(/^MemAvailable:\s+(\d+)/m.exec(meminfo)?.[1]) * 1024;
  if (Number.isFinite(total) && Number.isFinite(available) && total > 0) {
    return { used: total - available, limit: total, free: available, scope: "system" };
  }
  return null;
}

function hasValidationHeadroom(step) {
  const snapshot = memorySnapshot();
  if (snapshot?.free >= NEED_FREE) return true;
  if (snapshot === null) {
    console.log(`gated: cannot read a finite cgroup or system memory limit; skipping ${step}`);
  } else {
    console.log(
      `gated[${snapshot.scope}]: ${(snapshot.used / 2 ** 30).toFixed(2)} GiB used of ` +
        `${(snapshot.limit / 2 ** 30).toFixed(2)} GiB; need >= ` +
        `${(NEED_FREE / 2 ** 30).toFixed(1)} GiB free; skipping ${step}`,
    );
  }
  return false;
}

if (!hasValidationHeadroom("native validation")) {
  process.exit(0);
}

for (const step of steps) {
  if (!hasValidationHeadroom(step)) {
    console.log("GATED VALIDATION DEFERRED");
    process.exit(0);
  }
  console.log(`gated-validation run: ${step}`);
  try {
    execSync(step, {
      stdio: "inherit",
      env: { ...process.env, NODE_OPTIONS: HEAP_CAP },
    });
    // eslint-disable-next-line no-restricted-syntax -- each step reports and stops its own failure.
  } catch {
    console.error(`gated-validation FAIL: ${step}`);
    process.exit(1);
  }
}
console.log("GATED VALIDATION PASS");
