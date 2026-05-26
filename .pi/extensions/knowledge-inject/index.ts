import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Knowledge/protocol skill loading is unified into skill-inject. This extension
// remains as a compatibility no-op while bundled extension discovery still sees
// the directory.
export default function (_pi: ExtensionAPI) {}
