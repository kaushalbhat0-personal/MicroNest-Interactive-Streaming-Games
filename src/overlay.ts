import { bootRenderer } from "./renderer/renderer";

// T4F-B renderer entry: one Phaser.Game + read-only snapshot/SSE
// subscription. No engine, no ingestion, no simulation fallback —
// see src/renderer/renderer.ts.
void bootRenderer();
