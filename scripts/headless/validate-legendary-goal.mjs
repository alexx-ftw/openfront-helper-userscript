import fs from "node:fs";
import { rowChecks } from "./score-basket.mjs";

export function validate(result) {
  const { fullGreen, failed, checks } = rowChecks(result);
  return { passed: fullGreen, failed, checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = fs.readFileSync(0, "utf8").trim();
  if (!input) {
    console.error("validate-legendary-goal: expected a JSON result on stdin");
    process.exitCode = 2;
  } else {
    const report = validate(JSON.parse(input));
    console.log(JSON.stringify(report));
    process.exitCode = report.passed ? 0 : 1;
  }
}
