import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { rmSync } from "node:fs";

const outfile = "test/.scenario.bundle.mjs";
await build({
  entryPoints: ["test/scenario.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  logLevel: "warning",
});
try {
  const mod = await import(pathToFileURL(outfile).href);
  await mod.run();
} finally {
  rmSync(outfile, { force: true });
}
