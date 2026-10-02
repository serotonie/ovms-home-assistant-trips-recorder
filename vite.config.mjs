import { defineConfig } from "vite";

// Bundles src/panel.js (and its Leaflet dependency/stylesheet) into a single
// self-contained panel.js, served as-is by TripsRecorderModuleView. Home
// Assistant loads this file directly as a native panel module, so the output
// must stay a single plain script with no external chunks or assets.
export default defineConfig({
    build: {
        outDir: "custom_components/ovms_trips_recorder",
        emptyOutDir: false,
        assetsInlineLimit: Number.MAX_SAFE_INTEGER,
        cssCodeSplit: false,
        minify: false,
        lib: {
            entry: "src/panel.js",
            formats: ["iife"],
            name: "TripsRecorderPanel",
            fileName: () => "panel.js",
        },
    },
});
