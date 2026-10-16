  sandbox.autoBotBuildReleaseNukeLaunchClaim = undefined;
  sandbox.autoBotBuildNukeSlots = undefined;
}

await import("./nuke-campaign-scenario.mjs");
process.stdout.write("nuke salvo recheck tests passed\n");
