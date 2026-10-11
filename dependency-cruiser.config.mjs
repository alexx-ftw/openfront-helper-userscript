export default {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies make initialization order ambiguous.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolved",
      severity: "error",
      comment: "Every import must resolve deterministically.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-deprecated-core",
      severity: "error",
      comment: "Deprecated Node core modules are forbidden.",
      from: {},
      to: { dependencyTypes: ["core"], path: "^(?:punycode|domain|constants|sys|_linklist)$" },
    },
    {
      name: "no-dev-dependency-in-production",
      severity: "error",
      comment: "Production shell code must not import development-only packages.",
      from: { path: "^src/" },
      to: { dependencyTypes: ["npm-dev"] },
    },
    {
      name: "no-test-imports-in-production",
      severity: "error",
      comment: "Production code must not depend on tests.",
      from: { path: "^(?:src|engine|scripts|build\\.mjs)" },
      to: { path: "^test/" },
    },
  ],
  options: {
    // The official engine is an independently validated submodule boundary.
    // Harness imports may point into it, but this repository must not cruise
    // and re-audit the engine's aliases, dependencies, or intentional cycles.
    doNotFollow: { path: "(?:^|/)node_modules|^openfront-engine/" },
    exclude: "(?:^|/)node_modules/|openfront-helper\\.user\\.js$",
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
