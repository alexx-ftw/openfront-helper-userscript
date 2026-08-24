import assert from "node:assert/strict";

import { findTarget } from "../scripts/probe-runtime.mjs";

const calls = [];
const target = {
  id: "openfront-target",
  type: "page",
  url: "https://openfront.example/game",
};

const result = await findTarget(
  {
    host: "127.0.0.1",
    ports: [9222, 9223],
    url: "openfront",
  },
  async ({ port }) => {
    calls.push(port);
    if (port === 9222) return Promise.reject(new Error("ECONNREFUSED"));
    return [target];
  },
);

assert.deepEqual(calls, [9222, 9223], "a refused first port must not stop the probe");
assert.deepEqual(result, { port: 9223, target });

process.stdout.write("runtime probe fallback test passed\n");
