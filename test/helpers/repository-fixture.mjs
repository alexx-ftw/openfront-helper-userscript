import { fileURLToPath } from "node:url";

export { executeClassicScript, readRepositoryFile } from "./classic-script.mjs";

export function repositoryFilePath(relativePath) {
  return fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
}
