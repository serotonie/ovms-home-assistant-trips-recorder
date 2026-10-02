"use strict";

// Regression tests for the Trips Recorder sidebar panel. panel.js is built
// by Vite (see vite.config.mjs) from src/panel.js into
// custom_components/ovms_trips_recorder/panel.js, bundling Leaflet directly
// instead of depending on Home Assistant's internal ha-map/loadCardHelpers()
// APIs. The build output is a plain IIFE script (not a module), so it is
// executed here in a sandboxed vm context with minimal DOM/customElements
// stubs instead of adding a browser test framework dependency. Leaflet
// itself is replaced with a lightweight fake (see createFakeLeaflet) through
// TripsRecorderPanel#loadLeaflet so these tests don't need a real DOM/canvas.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PANEL_PATH = path.join(
    __dirname,
    "..",
    "custom_components",
    "ovms_trips_recorder",
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
    return {
        define(name, ctor) {
            registry.set(name, ctor);
        },
        get(name) {
            return registry.get(name);
        },
        whenDefined(name) {
            return registry.has(name) ? Promise.resolve(registry.get(name)) : new Promise(() => { });
        },
    };
}

function createFakeMapInstance() {
    return {
        layers: [],
        addLayer(layer) {
            this.layers.push(layer);
        },
        setView(center, zoom) {
            this.center = center;
            this.zoom = zoom;
        },
        fitBounds(points, options) {
            this.fitBoundsCalls = (this.fitBoundsCalls || 0) + 1;
            this.fitBoundsPoints = points;
            this.fitBoundsOptions = options;
        },
        invalidateSize() {
            this.invalidated = (this.invalidated || 0) + 1;
        },
        remove() {
            this.removed = true;
        },
    };
}

function createFakeLeaflet() {
    const maps = [];
    const tileLayers = [];
    const polylines = [];
    const circleMarkers = [];
    return {
        maps,
        tileLayers,
        polylines,
        circleMarkers,
        map(container, options) {
            const map = createFakeMapInstance();
            map.container = container;
            map.options = options;
            maps.push(map);
            return map;
        },
        tileLayer(url, options) {
            const layer = {
                url, options,
                addTo(map) {
                    map.addLayer(this);
                    return this;
                },
            };
            tileLayers.push(layer);
            return layer;
        },
        polyline(points, options) {
            const layer = {
                points, options,
                setLatLngs(nextPoints) {
                    this.points = nextPoints;
                },
                addTo(map) {
                    map.addLayer(this);
                    return this;
                },
            };
            polylines.push(layer);
            return layer;
        },
        circleMarker(point, options) {
            const marker = {
                point, options,
                setLatLng(nextPoint) {
                    this.point = nextPoint;
                },
                addTo(map) {
                    map.addLayer(this);
                    return this;
                },
            };
            circleMarkers.push(marker);
            return marker;
        },
    };
}

function loadPanelModule({ customElements, document, window, fetchImpl, ResizeObserver }) {
    const sandbox = {
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
    return customElements.get("trips-recorder-panel");
}

function createPanelWithFakeLeaflet(options = {}) {
    const customElements = createCustomElementRegistry();
    const TripsRecorderPanel = loadPanelModule({
        customElements,
        document: { createElement: () => ({}) },
        window: {},
        ResizeObserver: options.ResizeObserver,
    });
    const panel = new TripsRecorderPanel();
    const fakeLeaflet = createFakeLeaflet();
    panel.loadLeaflet = () => fakeLeaflet;
    return { panel, fakeLeaflet };
}

test("renderTrips() affiche un conteneur de carte au-dessus des détails de chaque trajet", () => {
    const customElements = createCustomElementRegistry();
    const document = { createElement: () => ({}) };
    const olderTrip = { start_time: "2026-09-20T10:00:00Z", vehicle: "OVMS", waypoints: [] };
    const newerTrip = { start_time: "2026-09-21T10:00:00Z", vehicle: "OVMS", waypoints: [] };
    const TripsRecorderPanel = loadPanelModule({ customElements, document, window: {} });
    const panel = new TripsRecorderPanel();
    panel.filteredTrips = [olderTrip, newerTrip];

    const markup = panel.renderTrips();

    assert.equal((markup.match(/class="trip-map-canvas"/g) || []).length, 2);
    assert.ok(markup.indexOf('data-index="0"') < markup.indexOf('class="trip-details"'));
});

test("render() adds the standard Home Assistant header shell", () => {
    const customElements = createCustomElementRegistry();
    const TripsRecorderPanel = loadPanelModule({
        customElements,
        document: { createElement: () => ({}) },
        window: {},
    });
    const panel = new TripsRecorderPanel();

    panel.render();

    assert.match(panel.shadowRoot.innerHTML, /<ha-top-app-bar-fixed/);
    assert.match(panel.shadowRoot.innerHTML, /<ha-menu-button slot="navigationIcon" aria-label="Menu"><\/ha-menu-button>/);
    assert.match(panel.shadowRoot.innerHTML, /<span slot="title">Trips<\/span>/);
    assert.match(panel.shadowRoot.innerHTML, /<h1 class="visually-hidden">Trips<\/h1>/);
});

test("renderError() keeps the standard Home Assistant header shell", () => {
    const customElements = createCustomElementRegistry();
    const TripsRecorderPanel = loadPanelModule({
        customElements,
        document: { createElement: () => ({}) },
        window: {},
    });
    const panel = new TripsRecorderPanel();

    panel.renderError("Unable to load trips.");

    assert.match(panel.shadowRoot.innerHTML, /<ha-top-app-bar-fixed/);
    assert.match(panel.shadowRoot.innerHTML, /<span slot="title">Trips<\/span>/);
    assert.match(panel.shadowRoot.innerHTML, /Unable to load trips\./);
});

test("render() forwards narrow mode to the Home Assistant shell", () => {
    const customElements = createCustomElementRegistry();
    const TripsRecorderPanel = loadPanelModule({
        customElements,
        document: { createElement: () => ({}) },
        window: {},
    });
    const panel = new TripsRecorderPanel();
    panel.narrow = true;

    panel.render();

    assert.match(panel.shadowRoot.innerHTML, /<ha-top-app-bar-fixed has-scrolling-content narrow>/);
});

test("traduit les libellés selon la langue Home Assistant avec repli anglais", () => {
    const customElements = createCustomElementRegistry();
    const TripsRecorderPanel = loadPanelModule({
        customElements,
        document: { createElement: () => ({}) },
        window: {},
    });
    const panel = new TripsRecorderPanel();

    panel._hass = { locale: { language: "fr" } };
    panel.locale = panel.getLocale();
    assert.equal(panel.t("trips"), "Trajets");
    assert.equal(panel.t("arrival"), "Arrivée");

    panel._hass = { locale: { language: "pt-BR" } };
    panel.locale = panel.getLocale();
    assert.equal(panel.t("reset"), "Redefinir");

    panel._hass = { locale: { language: "xx" } };
    panel.locale = panel.getLocale();
    assert.equal(panel.t("trips"), "Trips");
});

test("getTileUrl() utilise les tuiles OpenStreetMap sans clé d'API", () => {
    const { panel } = createPanelWithFakeLeaflet();

    assert.equal(panel.getTileUrl(), "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png");
    assert.match(panel.getTileAttribution(), /openstreetmap\.org\/copyright/);
    assert.doesNotMatch(panel.getTileAttribution(), /CARTO/);
});

test("renderLeafletMaps() crée une carte Leaflet par trajet avec le tracé et les marqueurs de départ/arrivée", async () => {
    const { panel, fakeLeaflet } = createPanelWithFakeLeaflet();
    const container0 = { dataset: { index: "0" } };
    const container1 = { dataset: { index: "1" } };
    panel.shadowRoot.querySelectorAll = (selector) => selector === ".trip-map-canvas" ? [container0, container1] : [];
    panel.filteredTrips = [
        {
            vehicle: "OVMS 1", waypoints: [
                { position_lat: "48.0", position_long: "2.0" },
                { position_lat: "48.1", position_long: "2.1" },
            ],
        },
        {
            vehicle: "OVMS 2", waypoints: [
                { position_lat: "49.0", position_long: "3.0" },
            ],
        },
    ];

    await panel.renderLeafletMaps();

    assert.equal(fakeLeaflet.maps.length, 2);
    assert.equal(JSON.stringify(fakeLeaflet.polylines[0].points), JSON.stringify([[48, 2], [48.1, 2.1]]));
    assert.equal(JSON.stringify(fakeLeaflet.circleMarkers[0].point), JSON.stringify([48, 2]));
    assert.equal(fakeLeaflet.circleMarkers[0].options.fillColor, "#2196f3");
    assert.equal(JSON.stringify(fakeLeaflet.circleMarkers[1].point), JSON.stringify([48.1, 2.1]));
    assert.equal(fakeLeaflet.circleMarkers[1].options.fillColor, "#ff9800");
    assert.equal(JSON.stringify(fakeLeaflet.maps[0].fitBoundsPoints), JSON.stringify([[48, 2], [48.1, 2.1]]));
    // A single waypoint cannot be fitted into bounds, so it falls back to setView().
    assert.equal(JSON.stringify(fakeLeaflet.maps[1].center), JSON.stringify([49, 3]));
    assert.equal(fakeLeaflet.maps[1].zoom, 15);
});

test("renderLeafletMaps() réutilise les cartes existantes au lieu d'en recréer", async () => {
    const { panel, fakeLeaflet } = createPanelWithFakeLeaflet();
    const container = { dataset: { index: "0" } };
    panel.shadowRoot.querySelectorAll = () => [container];
    panel.filteredTrips = [
        { vehicle: "OVMS", waypoints: [{ position_lat: "48.0", position_long: "2.0" }, { position_lat: "48.1", position_long: "2.1" }] },
    ];

    await panel.renderLeafletMaps();
    panel.filteredTrips[0].waypoints.push({ position_lat: "48.2", position_long: "2.2" });
    await panel.renderLeafletMaps();

    assert.equal(fakeLeaflet.maps.length, 1);
    assert.equal(
        JSON.stringify(fakeLeaflet.polylines[0].points),
        JSON.stringify([[48, 2], [48.1, 2.1], [48.2, 2.2]])
    );
});

test("renderLeafletMaps() ne crée pas de marqueurs quand le trajet n'a pas de point GPS", async () => {
    const { panel, fakeLeaflet } = createPanelWithFakeLeaflet();
    const container = { dataset: { index: "0" } };
    panel.shadowRoot.querySelectorAll = () => [container];
    panel.filteredTrips = [{ vehicle: "OVMS", waypoints: [] }];

    await panel.renderLeafletMaps();

    assert.equal(fakeLeaflet.maps.length, 1);
    assert.equal(fakeLeaflet.circleMarkers.length, 0);
});

test("observeMapResize() réajuste la carte sur les points du trajet après un redimensionnement", async () => {
    const observers = [];
    class FakeResizeObserver {
        constructor(callback) {
            this.callback = callback;
            observers.push(this);
        }
        observe() { }
        disconnect() { }
    }
    const { panel, fakeLeaflet } = createPanelWithFakeLeaflet({ ResizeObserver: FakeResizeObserver });
    const container = { dataset: { index: "0" } };
    panel.shadowRoot.querySelectorAll = () => [container];
    panel.filteredTrips = [
        { vehicle: "OVMS", waypoints: [{ position_lat: "48.0", position_long: "2.0" }, { position_lat: "48.1", position_long: "2.1" }] },
    ];

    await panel.renderLeafletMaps();
    const fitBoundsCallsBeforeResize = fakeLeaflet.maps[0].fitBoundsCalls;
    observers[0].callback([{ contentRect: { width: 320, height: 260 } }]);

    assert.equal(fakeLeaflet.maps[0].invalidated, 1);
    assert.equal(fakeLeaflet.maps[0].fitBoundsCalls, fitBoundsCallsBeforeResize + 1);
});

test("destroyLeafletMaps() supprime les cartes Leaflet suivies", async () => {
    const { panel, fakeLeaflet } = createPanelWithFakeLeaflet();
    const container = { dataset: { index: "0" } };
    panel.shadowRoot.querySelectorAll = () => [container];
    panel.filteredTrips = [{ vehicle: "OVMS", waypoints: [] }];

    await panel.renderLeafletMaps();
    await panel.destroyLeafletMaps();

    assert.equal(fakeLeaflet.maps[0].removed, true);
    assert.equal(panel.maps.size, 0);
});

function createVersionPanel({ stored, version }) {
    const store = new Map();
    if (stored !== undefined) store.set("ovms_trips_recorder_frontend_version", stored);
    const deleted = [];
    const win = {
        localStorage: {
            getItem: (key) => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, value),
        },
        caches: {
            keys: async () => ["a", "b"],
            delete: async (key) => deleted.push(key),
        },
        location: { reloads: 0, reload() { this.reloads += 1; } },
    };
    const customElements = createCustomElementRegistry();
    const TripsRecorderPanel = loadPanelModule({
        customElements,
        document: { createElement: () => ({}) },
        window: win,
        fetchImpl: async () => ({ ok: true, json: async () => ({ trips: [], version }) }),
    });
    const panel = new TripsRecorderPanel();
    panel.updateTrips = () => { panel.updated = true; };
    return { panel, win, store, deleted };
}

test("loadTrips() enregistre la version au premier chargement sans vider le cache", async () => {
    const { panel, win, store, deleted } = createVersionPanel({ version: "2.0.0" });
    await panel.loadTrips();
    assert.equal(store.get("ovms_trips_recorder_frontend_version"), "2.0.0");
    assert.equal(win.location.reloads, 0);
    assert.deepEqual(deleted, []);
    assert.equal(panel.updated, true);
});

test("loadTrips() ne recharge pas quand la version est inchangée", async () => {
    const { panel, win, deleted } = createVersionPanel({ stored: "2.0.0", version: "2.0.0" });
    await panel.loadTrips();
    assert.equal(win.location.reloads, 0);
    assert.deepEqual(deleted, []);
});

test("loadTrips() vide les caches et recharge quand la version change", async () => {
    const { panel, win, store, deleted } = createVersionPanel({ stored: "1.0.0", version: "2.0.0" });
    await panel.loadTrips();
    assert.deepEqual(deleted, ["a", "b"]);
    assert.equal(win.location.reloads, 1);
    assert.equal(store.get("ovms_trips_recorder_frontend_version"), "2.0.0");
    assert.equal(panel.updated, undefined);
});
