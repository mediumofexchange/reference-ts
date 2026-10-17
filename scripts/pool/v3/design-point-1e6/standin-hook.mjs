// 10⁶ design-point probe tooling, disposable (M13h's, its memory sampler moved to sample-hook.mjs): loaded with
// `node --import` into a `moe` process (serve, reader supply, wallet sync). It routes `dist/cli/backend.js` to
// standin-backend.mjs, whose verifier verifies a kept real proof in place of each stand-in proof (M11c2's load verifier).
import { registerHooks } from "node:module";

const WRAP = new URL("./standin-backend.mjs", import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  if (resolved.url.endsWith("/dist/cli/backend.js") && context.parentURL !== WRAP) return { ...resolved, url: WRAP, shortCircuit: true };
  return resolved;
} });
