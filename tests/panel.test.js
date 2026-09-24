"use strict";

// Regression tests for the ha-map loading logic in panel.js (see
// TripsRecorderPanel#ensureMapDefined). panel.js is a plain browser script
// (not a module), so it is executed here in a sandboxed vm context with
// minimal DOM/customElements/window stubs instead of adding a browser test
// framework dependency.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PANEL_PATH = path.join(
    __dirname,
    "..",
    "custom_components",
    "trips_recorder",
    "panel.js"
);
const PANEL_SOURCE = fs.readFileSync(PANEL_PATH, "utf8");

class FakeShadowRoot {
    querySelector() {
        return null;
    }
    querySelectorAll() {
        return [];
    }
}

class FakeHTMLElement {
    attachShadow() {
        this.shadowRoot = new FakeShadowRoot();
        return this.shadowRoot;
    }
}

function createCustomElementRegistry() {
    const registry = new Map();
    const waiters = new Map();
    return {
        define(name, ctor) {
            registry.set(name, ctor);
            const pending = waiters.get(name);
            if (pending) {
                pending.forEach((resolve) => resolve(ctor));
                waiters.delete(name);
            }
        },
        get(name) {
            return registry.get(name);
        },
        whenDefined(name) {
            if (registry.has(name)) return Promise.resolve(registry.get(name));
            return new Promise((resolve) => {
                const list = waiters.get(name) || [];
                list.push(resolve);
                waiters.set(name, list);
            });
        },
    };
}

function loadPanelModule({ customElements, document, window, fetchImpl, ResizeObserver }) {
    const sandbox = {
        module: { exports: {} },
        HTMLElement: FakeHTMLElement,
        customElements,
        document,
        window,
        fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ trips: [] }) })),
        setTimeout,
        clearTimeout,
        console,
        ResizeObserver,
    };
    vm.createContext(sandbox);
    new vm.Script(PANEL_SOURCE, { filename: "panel.js" }).runInContext(sandbox);
    return sandbox.module.exports.TripsRecorderPanel;
}

test("ensureMapDefined() ne force rien si ha-map est déjà défini", async () => {
    const customElements = createCustomElementRegistry();
    customElements.define("ha-map", class { });
    let resolverCreated = false;
    const document = {
        createElement(tag) {
            resolverCreated = resolverCreated || tag === "partial-panel-resolver";
            return {};
        },
    };
    const TripsRecorderPanel = loadPanelModule({ customElements, document, window: {} });
    const panel = new TripsRecorderPanel();

    await panel.ensureMapDefined();

    assert.equal(resolverCreated, false);
});

test("force le chargement du panneau Lovelace pour obtenir loadCardHelpers puis définit ha-map", async () => {
    const customElements = createCustomElementRegistry();
    customElements.define("partial-panel-resolver", class { });
    const calls = [];
    const createdTags = [];
    const routeConfigs = [];
    const window = {};
    const document = {
        createElement(tag) {
            // Ne pas faire d'assertions ici : cette fonction est appelée depuis le
            // try/catch de forceLoadLovelacePanel(), qui avalerait silencieusement
            // toute AssertionError et masquerait un vrai échec de test.
            createdTags.push(tag);
            return {
                _getRoutes(config) {
                    routeConfigs.push(config);
                    return {
                        routes: {
                            "trips-recorder-map-preload": {
                                async load() {
                                    window.loadCardHelpers = async () => ({
                                        createCardElement(cardConfig) {
                                            calls.push(cardConfig);
                                            customElements.define("ha-map", class { });
                                        },
                                    });
                                },
                            },
                        },
                    };
                },
            };
        },
    };
    const TripsRecorderPanel = loadPanelModule({ customElements, document, window });
    const panel = new TripsRecorderPanel();

    await panel.ensureMapDefined();

    // JSON round-trip comparison: values built inside the vm sandbox have a
    // different Object/Array prototype than this test realm, so
    // assert.deepEqual (reference-sensitive) reports false positives on
    // otherwise structurally identical plain objects.
    assert.deepEqual(createdTags, ["partial-panel-resolver"]);
    assert.equal(
        JSON.stringify(routeConfigs),
        JSON.stringify([[{ component_name: "lovelace", url_path: "trips-recorder-map-preload" }]])
    );
    assert.ok(customElements.get("ha-map"), "ha-map devrait être défini après ensureMapDefined()");
    assert.equal(JSON.stringify(calls), JSON.stringify([{ type: "map", entities: [] }]));
});

test("se rabat sur waitForCardHelpers() si l'API interne partial-panel-resolver échoue", async () => {
    const customElements = createCustomElementRegistry();
    customElements.define("partial-panel-resolver", class { });
    const window = {
        loadCardHelpers: async () => ({
            createCardElement() {
                customElements.define("ha-map", class { });
            },
        }),
    };
    const document = {
        // Pas de _getRoutes ici : simule une future rupture de cette API interne.
        createElement: () => ({}),
    };
    const TripsRecorderPanel = loadPanelModule({ customElements, document, window });
    const panel = new TripsRecorderPanel();

    await panel.ensureMapDefined();

    assert.ok(customElements.get("ha-map"));
});

test("waitForCardHelpers() abandonne proprement si loadCardHelpers n'apparaît jamais", async () => {
    const customElements = createCustomElementRegistry();
    const document = { createElement: () => ({}) };
    const TripsRecorderPanel = loadPanelModule({ customElements, document, window: {} });
    const panel = new TripsRecorderPanel();

    const result = await panel.waitForCardHelpers(50, 10);

    assert.equal(result, null);
});

test("renderTrips() affiche une carte au-dessus des détails de chaque trajet", () => {
    const customElements = createCustomElementRegistry();
    customElements.define("ha-map", class { });
    const document = { createElement: () => ({}) };
    const olderTrip = { start_time: "2026-09-20T10:00:00Z", vehicle: "OVMS", waypoints: [] };
    const newerTrip = { start_time: "2026-09-21T10:00:00Z", vehicle: "OVMS", waypoints: [] };
    const TripsRecorderPanel = loadPanelModule({ customElements, document, window: {} });
    const panel = new TripsRecorderPanel();
    panel.filteredTrips = [olderTrip, newerTrip];

    const markup = panel.renderTrips();

    assert.equal((markup.match(/class="native-map"/g) || []).length, 2);
    assert.doesNotMatch(markup, /auto-fit/);
    assert.ok(markup.indexOf('data-index="0"') < markup.indexOf('class="trip-details"'));
});

test("renderNativeMaps() configure la carte de chaque trajet", async () => {
    const customElements = createCustomElementRegistry();
    const document = { createElement: () => ({ style: {} }) };
    const observers = [];
    class FakeResizeObserver {
        constructor(callback) {
            this.callback = callback;
            observers.push(this);
        }
        observe(target) {
            this.target = target;
        }
        disconnect() {
            this.disconnected = true;
        }
    }
    const TripsRecorderPanel = loadPanelModule({
        customElements,
        document,
        window: {},
        ResizeObserver: FakeResizeObserver,
    });
    const panel = new TripsRecorderPanel();
    const connection = {};
    panel._hass = { connection };
    const maps = ["0", "1"].map((index) => ({
        dataset: { index },
        _engine: {
            addPath(path) {
                this.path = path;
                return { remove() {} };
            },
        },
        addEventListener(event, handler, options) {
            this.readyListener = { event, handler, options };
        },
        fitBounds(points) {
            this.fitBoundsCalls = (this.fitBoundsCalls || 0) + 1;
            this.fitBoundsPoints = points;
        },
        setView(center, zoom) {
            this.center = center;
            this.zoom = zoom;
        },
    }));
    panel.shadowRoot.querySelectorAll = (selector) => selector === ".native-map" ? maps : [];
    panel.filteredTrips = [
        { vehicle: "OVMS 1", waypoints: [
            { position_lat: "48.0", position_long: "2.0", timestamp: "2026-09-20T10:00:00Z" },
            { position_lat: "48.1", position_long: "2.1", timestamp: "2026-09-20T10:05:00Z" },
        ] },
        { vehicle: "OVMS 2", waypoints: [
            { position_lat: "49.0", position_long: "3.0", timestamp: "2026-09-21T10:00:00Z" },
            { position_lat: "49.1", position_long: "3.1", timestamp: "2026-09-21T10:05:00Z" },
        ] },
    ];

    panel.renderNativeMaps();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(maps[0].paths[0].name, "OVMS 1");
    assert.equal(maps[0]._connection.connection, connection);
    assert.deepEqual(JSON.parse(JSON.stringify(maps[0].paths[0].points.map((point) => point.point))), [[48, 2], [48.1, 2.1]]);
    assert.deepEqual(JSON.parse(JSON.stringify(maps[0].fitBoundsPoints)), [[48, 2], [48.1, 2.1]]);
    assert.deepEqual(JSON.parse(JSON.stringify(maps[1].fitBoundsPoints)), [[49, 3], [49.1, 3.1]]);
    assert.deepEqual(JSON.parse(JSON.stringify(maps[0].center)), [48.05, 2.05]);
    assert.equal(maps[0].zoom, undefined);
    assert.equal(maps[0].autoFit, true);
    assert.equal(JSON.stringify(maps[0].editableLocations), JSON.stringify([
        { id: "start", location: [48, 2], title: "Départ", element: { style: { cssText: "display:block;width:14px;height:14px;box-sizing:border-box;border:2px solid #fff;border-radius:50%;background:#2196f3;box-shadow:0 1px 3px rgba(0,0,0,.45);" } }, elementSize: [14, 14] },
        { id: "stop", location: [48.1, 2.1], title: "Arrivée", element: { style: { cssText: "display:block;width:14px;height:14px;box-sizing:border-box;border:2px solid #fff;border-radius:50%;background:#ff9800;box-shadow:0 1px 3px rgba(0,0,0,.45);" } }, elementSize: [14, 14] },
    ]));
    observers[0].callback([{ contentRect: { width: 320, height: 260 } }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(observers[0].disconnected, true);
    assert.equal(maps[0].fitBoundsCalls, 2);
    assert.equal(maps[0].readyListener.event, "editing-available-changed");
    assert.equal(maps[0].readyListener.options.once, true);
    maps[0].readyListener.handler();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(maps[0].fitBoundsCalls, 3);
});
