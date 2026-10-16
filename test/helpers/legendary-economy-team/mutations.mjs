/** Explicit negative controls, installed only in isolated mutation-test child processes. */
export function installScenarioMutation(sandbox) {
  const method = process.env.OFH_SCENARIO_DISABLE_METHOD;
  if (!method) return;
  const prototype = sandbox.__StructureBehavior.prototype;
  if (typeof prototype[method] !== "function")
    throw new Error(`Unknown production seam: ${method}`);
  prototype[method] =
    method === "availableGoldAfterReserve"
      ? function () {
          return this.player.gold() + 10_000_000_000n;
        }
      : () =>
          method.startsWith("legendaryConstruction") || method.startsWith("probe") ? [] : false;
}
