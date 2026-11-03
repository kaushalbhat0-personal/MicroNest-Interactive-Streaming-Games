import { createRuntime } from "./app";
import "./presentation/tidebound.css";

// Overlay entry: game + read-only HUD, no panel, never writes persistence.
void createRuntime({ withPanel: false });
