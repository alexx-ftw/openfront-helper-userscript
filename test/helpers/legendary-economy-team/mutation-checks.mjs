// Run directly: node test/helpers/legendary-economy-team/mutation-checks.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scenarios = [
  ["01-fleet-saturation", "addLegendaryFactoryRouteCandidates"],
  ["02-landlocked-teammate", "addLegendaryFactoryRouteCandidates"],
  ["03-port-seed-pair", "addLegendaryPortRouteCandidates"],
  ["04-ally-affordability", "availableGoldAfterReserve"],
  ["05-horizon", "availableGoldAfterReserve"],
  ["06-upgrade-new-route", "probeLegendaryThroughputUpgradeCandidates"],
];
for (const [name, seam] of scenarios) {
  const file = fileURLToPath(
    new URL(`../../legendary-economy-team-scenario-${name}.mjs`, import.meta.url),
  );
  for (const method of [
    null,
    "legendaryConstructionCandidates",
    "legendaryConstructionActionGroups",
    "maybeSpawnStructure",
    seam,
    ...(name.startsWith("06-") ? ["maybeUpgradeLegendaryThroughput"] : []),
  ]) {
    const env = { ...process.env };
    delete env.OFH_SCENARIO_DISABLE_METHOD;
    if (method) env.OFH_SCENARIO_DISABLE_METHOD = method;
    const result = spawnSync(process.execPath, [file], { env, encoding: "utf8" });
    assert.equal(result.error, undefined, `${name}: child must start`);
    assert.equal(result.signal, null, `${name}: child must terminate normally`);
    assert.equal(
      result.status,
      method ? 1 : 0,
      `${name} ${method ?? "baseline"}: ${result.stderr}`,
    );
    if (method)
      assert.match(result.stderr, /AssertionError/, "RED must be an output assertion failure");
    process.stdout.write(`PASS ${name} ${method ?? "baseline"}: exit=${result.status}\n`);
  }
}
