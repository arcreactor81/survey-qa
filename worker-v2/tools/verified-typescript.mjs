import { pathToFileURL } from "node:url";
import {
  EXPECTED_TYPESCRIPT_VERSION,
  PinnedWranglerError,
  resolvePinnedTypeScriptToolchain,
} from "./pinned-wrangler-command.mjs";

/**
 * The canary control plane executes TypeScript's JSONC parser. Static package imports would run
 * compiler bytes before the deployment-toolchain pin had a chance to inspect them, so this module
 * first closes and verifies the installed Wrangler + TypeScript denominator and only then imports
 * the exact absolute compiler entrypoint from that descriptor.
 *
 * This boundary inherits the pin's explicitly named final-open race: a privileged local actor can
 * theoretically swap bytes after verification and restore them around the exact module read.
 */
const pinnedToolchain = resolvePinnedTypeScriptToolchain();
let namespace;
try {
  namespace = await import(pathToFileURL(pinnedToolchain.typescriptEntrypointPath).href);
} catch {
  throw new PinnedWranglerError(
    "TYPESCRIPT_IMPORT_FAILED",
    "the verified TypeScript compiler entrypoint could not be imported",
  );
}

const typescript = namespace.default;
if (
  typescript === null ||
  typeof typescript !== "object" ||
  typescript.version !== EXPECTED_TYPESCRIPT_VERSION ||
  typeof typescript.parseConfigFileTextToJson !== "function" ||
  typeof typescript.flattenDiagnosticMessageText !== "function"
) {
  throw new PinnedWranglerError(
    "TYPESCRIPT_EXPORT_INVALID",
    "the verified TypeScript compiler does not expose the required exact API surface",
  );
}

export const VERIFIED_TYPESCRIPT_TOOLCHAIN_EVIDENCE = pinnedToolchain.evidence;
export const VERIFIED_TYPESCRIPT_ENTRYPOINT_PATH = pinnedToolchain.typescriptEntrypointPath;
export default typescript;
