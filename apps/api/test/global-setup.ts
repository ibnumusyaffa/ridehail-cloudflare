import { execFileSync } from "node:child_process";
import { TEST_DATABASE_URL } from "../vitest.config";

export default function setup() {
  execFileSync("node", ["scripts/migrate.mjs", "--reset", TEST_DATABASE_URL], { stdio: "inherit" });
}
