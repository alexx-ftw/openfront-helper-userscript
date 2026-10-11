import { execFileSync } from "node:child_process";

export function foreignGitEnvironment() {
  const environment = { ...process.env };
  const names = execFileSync("/usr/bin/git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  for (const name of names) delete environment[name];
  return environment;
}
