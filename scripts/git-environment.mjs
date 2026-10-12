import { execFileSync } from "node:child_process";

export function foreignGitEnvironment() {
  const environment = { ...process.env };
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- deployment supplies the installed Git on both Linux and Windows
  const names = execFileSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/);
  for (const name of names) delete environment[name];
  return environment;
}
