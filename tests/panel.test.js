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
                setStyle(nextOptions) {
                    this.options = { ...this.options, ...nextOptions };
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

function loadPanelModule({ customElements, document, window, fetchImpl, ResizeObserver, IntersectionObserver }) {
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
        IntersectionObserver,
        URLSearchParams,
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
        window: options.window || {},
        ResizeObserver: options.ResizeObserver,
    });
    const panel = new TripsRecorderPanel();
    const fakeLeaflet = createFakeLeaflet();
    panel.loadLeaflet = () => fakeLeaflet;
    return { panel, fakeLeaflet };
}

function createPaginationPanel(callApiImpl, IntersectionObserver) {
    const customElements = createCustomElementRegistry();
    const Panel = loadPanelModule({
        customElements, document: {}, window: {}, IntersectionObserver,
        fetchImpl: () => assert.fail("Trips must use the authenticated Home Assistant API"),
    });
    const panel = new Panel();
    const nodes = new Map();
    for (const selector of ["#from", "#to", "#vehicle", ".filters",
        "#reset", "#pagination", "#load-more", "#retry", ".trip-count", ".trips-grid"]) {
        nodes.set(selector, {
            value: "",
            listeners: {},
            addEventListener(name, callback) { this.listeners[name] = callback; },
            setAttribute() {},
            checkValidity() { return Number(this.value) >= 1 && Number(this.value) <= 100; },
            reportValidity() { this.validityReported = true; },
            insertAdjacentHTML(position, html) { this.appended = (this.appended || "") + html; },
            reset() {
                for (const field of ["#from", "#to", "#vehicle", "#driver", "#category"]) {
                    if (nodes.has(field)) nodes.get(field).value = "";
                }
            },
        });
    }
    panel.shadowRoot.querySelector = (selector) => nodes.get(selector) || null;
    panel._hass = {
        config: { time_zone: "America/New_York" },
        async callApi(method, endpoint) {
            assert.equal(method, "GET");
            assert.ok(endpoint.startsWith("ovms_trips_recorder/trips?"));
            return callApiImpl(endpoint);
        },
    };
    panel.loadDriverSettings = async () => {};
    panel.loadCategorySettings = async () => {};
    return { panel, nodes };
}

function paginatedResponse(trips, count, nextOffset = null) {
    return {
        trips, count, vehicles: ["car", "other"],
        has_more: nextOffset !== null, next_offset: nextOffset,
    };
}

const paginationTrips = Array.from({ length: 23 }, (_, index) => ({
    vehicle: "car", start_time: `2026-10-${String(31 - index).padStart(2, "0")}T12:00:00Z`,
    stop_time: "2026-11-01T12:00:00Z", waypoints: [],
}));

test("trip loading uses the Home Assistant session and never falls back to anonymous fetch", async () => {
    const { panel } = createPaginationPanel();
    const calls = [];
    panel._hass.callApi = async (...args) => {
        calls.push(args);
        return paginatedResponse(paginationTrips.slice(0, 1), 1);
    };
    await panel.loadTrips();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "GET");
    assert.match(calls[0][1], /^ovms_trips_recorder\/trips\?limit=10&offset=0&/);
    assert.equal(panel.trips.length, 1);
    panel._hass.callApi = async () => { throw { status_code: 401 }; };
    await panel.loadTrips({ refresh: true });
    assert.equal(panel.loadError, true);
    assert.equal(panel.trips.length, 1);
});

test("driver selection escapes person names and keeps deleted assignments visible", () => {
    const { panel } = createPanelWithFakeLeaflet();
    panel._hass = { user: { is_admin: false } };
    panel.driverControlsEnabled = true;
    panel.drivers = [{ id: "person.alice", name: '<Alice & "Bob">' }];
    const html = panel.renderTripDetails({ id: "trip-1", driver: "person.alice", waypoints: [] });
    assert.match(html, /data-driver-kind="trip" data-driver-target="trip-1"/);
    assert.match(html, /value="person.alice" selected/);
    assert.match(html, /&lt;Alice &amp; &quot;Bob&quot;&gt;/);
    assert.doesNotMatch(html, /<Alice/);
    assert.match(panel.driverOptions("person.deleted"), /person.deleted \(Person unavailable\)/);
    assert.match(panel.renderTripDetails({ id: "empty" }), /driver-warning">Driver not set/);
});

test("default driver settings are absent from the panel for admins and other users", async () => {
    const { panel } = createPanelWithFakeLeaflet();
    const settings = { innerHTML: "", querySelector() { return null; } };
    panel.shadowRoot.querySelector = (selector) => selector === "#driver-settings" ? settings : null;
    const calls = [];
    panel._hass = {
        user: { is_admin: true },
        async callApi(...args) {
            calls.push(args);
            return { enabled: true, drivers: [{ id: "person.alice", name: "Alice" }], defaults: { car: "person.alice" }, vehicles: ["car"], user_driver_id: "person.alice" };
        },
    };
    await panel.loadDriverSettings();
    assert.deepEqual(calls, [["GET", "ovms_trips_recorder/drivers"]]);
    assert.doesNotMatch(settings.innerHTML, /Default drivers per vehicle|data-driver-kind="vehicle"/);
    panel._hass.user.is_admin = false;
    panel.updateDriverSettings();
    assert.doesNotMatch(settings.innerHTML, /data-driver-kind="vehicle"/);
});

test("editing a driver uses authenticated API and refreshes without dropping loaded trips", async () => {
    const { panel } = createPanelWithFakeLeaflet();
    const calls = [];
    panel._hass = { async callApi(...args) { calls.push(args); } };
    panel.loadTrips = async (options) => calls.push(options);
    const field = { dataset: { driverKind: "trip", driverTarget: "trip /1" }, value: "person.bob" };
    await panel.saveDriver(field);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
        ["PUT", "ovms_trips_recorder/drivers/trip/trip%20%2F1", { driver: "person.bob" }],
        { refresh: true },
    ]);
    assert.equal(panel.savingDriver, false);
    assert.equal(panel.driverError, "");
});

test("trip deletion is admin-only, confirmed, and refreshes the list", async () => {
    const calls = [];
    const { panel } = createPanelWithFakeLeaflet({
        window: { confirm: () => true },
    });
    panel._hass = {
        user: { is_admin: true },
        async callApi(...args) { calls.push(args); },
    };
    panel.loadTrips = async (options) => calls.push(options);

    await panel.deleteTrip("trip /1");

    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
        ["DELETE", "ovms_trips_recorder/trips/trip%20%2F1"],
        { refresh: true },
    ]);
    assert.equal(panel.deletingTripId, null);
    assert.equal(panel.deleteError, "");
    assert.match(panel.renderTripDetails({ id: "trip-1" }), /data-delete-trip="trip-1"/);
    panel._hass.user.is_admin = false;
    assert.doesNotMatch(panel.renderTripDetails({ id: "trip-1" }), /data-delete-trip/);
});

test("trip deletion respects cancellation and reports failures", async () => {
    let calls = 0;
    let confirmed = false;
    const { panel } = createPanelWithFakeLeaflet({
        window: { confirm: () => confirmed },
    });
    panel._hass = {
        user: { is_admin: true },
        async callApi() {
            calls++;
            throw new Error("HTTP 500");
        },
    };
    await panel.deleteTrip("trip-1");
    assert.equal(calls, 0);

    confirmed = true;
    panel._hass.user.is_admin = false;
    await panel.deleteTrip("trip-1");
    assert.equal(panel.deleteError, "");
    panel._hass.user.is_admin = true;
    await panel.deleteTrip("trip-1");
    assert.match(panel.deleteError, /Unable to delete the trip/);
});

test("trip merge previews the combined result before saving and then refreshes", async () => {
    const calls = [];
    const dialog = {
        open: false,
        showModal() { this.open = true; },
        close() { this.open = false; },
    };
    const { panel } = createPanelWithFakeLeaflet();
    panel._hass = {
        user: { is_admin: true },
        async callApi(...args) {
            calls.push(args);
            return args[0] === "GET" ? {
                trip_id: "first",
                next_trip_id: "following",
                trip: {
                    vehicle: "car",
                    start_time: "2026-10-16T10:00:00Z",
                    stop_time: "2026-10-16T12:00:00Z",
                    distance: 15,
                },
            } : {};
        },
    };
    panel.shadowRoot.querySelector = (selector) => (
        selector === "#trip-merge-dialog" ? dialog : null
    );
    panel.loadTrips = async (options) => calls.push(options);

    assert.match(panel.renderTripDetails({
        id: "first", vehicle: "car", stop_time: "2026-10-16T11:00:00Z",
        merge_next_id: "following",
    }), /data-merge-trip="first" data-merge-next="following"/);
    await panel.previewTripMerge("first", "following");
    assert.equal(dialog.open, true);
    assert.match(dialog.innerHTML, /15\.0 km/);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
        ["GET", "ovms_trips_recorder/trips/first/merge-preview"],
    ]);

    await panel.confirmTripMerge();

    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
        ["GET", "ovms_trips_recorder/trips/first/merge-preview"],
        ["POST", "ovms_trips_recorder/trips/first/merge", { next_trip_id: "following" }],
        { refresh: true },
    ]);
    assert.equal(dialog.open, false);
    assert.equal(panel.mergePreview, null);
    assert.equal(panel.mergingTripId, null);
});

test("trip merge action is shown to administrators only", () => {
    const { panel } = createPanelWithFakeLeaflet();
    panel._hass = { user: { is_admin: false } };
    panel.driverControlsEnabled = true;
    panel.userDriverId = "person.alice";
    const ownTrip = {
        id: "first", driver: "person.alice", stop_time: "2026-10-16T11:00:00Z",
        merge_next_id: "following",
    };
    const anotherTrip = { ...ownTrip, id: "other", driver: "person.bob" };
    assert.doesNotMatch(panel.renderTripDetails(ownTrip), /data-merge-trip/);
    assert.doesNotMatch(panel.renderTripDetails(anotherTrip), /data-merge-trip/);
    panel._hass.user.is_admin = true;
    assert.match(panel.renderTripDetails(anotherTrip), /data-merge-trip="other"/);
});

test("trip merge rejects unassigned users and reports preview and save failures", async () => {
    const dialog = {
        open: true,
        innerHTML: "",
        showModal() { this.open = true; },
        close() { this.open = false; },
    };
    const { panel } = createPanelWithFakeLeaflet();
    panel.shadowRoot.querySelector = (selector) => (
        selector === "#trip-merge-dialog" ? dialog : null
    );
    panel._hass = { user: { is_admin: false }, async callApi() { throw new Error("failed"); } };
    await panel.previewTripMerge("first", "following");
    assert.equal(panel.mergeError, "");

    panel._hass.user.is_admin = true;
    panel._hass.callApi = async () => {
        throw new Error("failed");
    };
    await panel.previewTripMerge("first", "following");
    assert.match(panel.mergeError, /Unable to merge the trips/);
    panel.mergePreview = {
        trip_id: "first", next_trip_id: "following", trip: { distance: 2 },
    };
    await panel.confirmTripMerge();
    assert.match(panel.mergeError, /Unable to merge the trips/);
    assert.doesNotMatch(dialog.innerHTML, /data-confirm-merge disabled/);
});

test("driver visibility is controlled by integration options, not a panel toggle", async () => {
    const { panel } = createPanelWithFakeLeaflet();
    assert.equal(panel.driverControlsEnabled, false);
    assert.doesNotMatch(panel.renderTripDetails({ id: "trip", driver: "person.alice" }), /trip-driver|driver-warning/);
    const settings = { innerHTML: "", querySelector() { return null; } };
    panel.shadowRoot.querySelector = (selector) => selector === "#driver-settings" ? settings : null;
    panel._hass = { user: { is_admin: false } };
    panel.updateDriverSettings();
    assert.doesNotMatch(settings.innerHTML, /data-driver-kind|No people/);
    panel._hass.user.is_admin = true;
    panel.updateDriverSettings();
    assert.doesNotMatch(settings.innerHTML, /data-driver-kind|type="checkbox"/);
    panel._hass.callApi = async () => ({
        enabled: true, drivers: [{ id: "person.alice", name: "Alice" }],
        defaults: {}, vehicles: ["car"],
    });
    await panel.loadDriverSettings();
    assert.match(panel.renderTripDetails({ id: "trip" }), /trip-driver/);
    assert.doesNotMatch(settings.innerHTML, /data-driver-kind="vehicle"/);
    assert.doesNotMatch(settings.innerHTML, /data-driver-kind="settings"|type="checkbox"/);
    panel._hass.callApi = async () => ({ enabled: false, drivers: [], defaults: {}, vehicles: [] });
    await panel.loadDriverSettings();
    assert.doesNotMatch(panel.renderTripDetails({ id: "trip" }), /trip-driver|driver-warning/);
    assert.doesNotMatch(settings.innerHTML, /data-driver-kind/);
});

test("driver load and save failures are visible and do not claim success", async () => {
    const { panel } = createPanelWithFakeLeaflet();
    panel._hass = { async callApi() { throw new Error("HTTP 400"); } };
    await panel.loadDriverSettings();
    assert.match(panel.driverError, /Unable to load drivers/);
    let refreshed = false;
    panel.loadTrips = async () => { refreshed = true; };
    await panel.saveDriver({ dataset: { driverKind: "vehicle", driverTarget: "car" }, value: "person.deleted" });
    assert.equal(refreshed, false);
    assert.match(panel.driverError, /Unable to save the driver/);
    assert.equal(panel.savingDriver, false);
});

test("category controls are opt-in, escaped, multi-select and preserve retired selections", () => {
    const { panel } = createPanelWithFakeLeaflet();
    const trip = { id: "trip-1", categories: ["Work", "<Retired>"] };
    assert.doesNotMatch(panel.renderTripDetails(trip), /trip-categories/);
    panel.categoryControlsEnabled = true;
    panel.categories = ["Work", 'Personal & "fun"'];
    const html = panel.renderTripDetails(trip);
    assert.match(html, /<fieldset class="trip-categories"/);
    assert.match(html, /data-category-trip="trip-1" value="Work" checked/);
    assert.match(html, /Personal &amp; &quot;fun&quot;/);
    assert.match(html, /&lt;Retired&gt; \(removed category\)/);
    assert.doesNotMatch(html, /<Retired>|data-category-definition/);
    panel.categories = [];
    assert.match(panel.renderTripDetails({ id: "new" }), /No categories defined/);
    panel.locale = "fr";
    assert.match(panel.renderTripDetails(trip), /Catégories/);
});

test("category settings load through authenticated API and update visibility", async () => {
    const { panel } = createPanelWithFakeLeaflet();
    const calls = [];
    panel._hass = { async callApi(...args) {
        calls.push(args);
        return { enabled: true, categories: ["Work"], defaults: {} };
    } };
    await panel.loadCategorySettings();
    assert.deepEqual(calls, [["GET", "ovms_trips_recorder/categories"]]);
    assert.equal(panel.categoryControlsEnabled, true);
    assert.equal(panel.categories[0], "Work");
    assert.equal(panel.categoryError, "");
});

test("category checkbox changes preserve multiple choices and use trip API", async () => {
    const { panel } = createPanelWithFakeLeaflet();
    panel.trips = [{ id: "trip /1", categories: ["Work"] }];
    const calls = [];
    panel._hass = { async callApi(...args) { calls.push(args); } };
    panel.loadTrips = async (options) => { calls.push(options); };
    await panel.saveCategories({ dataset: { categoryTrip: "trip /1" }, value: "Personal", checked: true });
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
        ["PUT", "ovms_trips_recorder/categories/trip/trip%20%2F1", { categories: ["Work", "Personal"] }],
        { refresh: true },
    ]);
    calls.length = 0;
    await panel.saveCategories({ dataset: { categoryTrip: "trip /1" }, value: "Work", checked: false });
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), { categories: [] });
    assert.equal(panel.savingCategories, false);
});

test("category failures stay visible and rejected edits do not change loaded assignments", async () => {
    const { panel } = createPanelWithFakeLeaflet();
    panel._hass = { async callApi() { throw new Error("HTTP 400"); } };
    await panel.loadCategorySettings();
    assert.match(panel.categoryError, /Unable to load categories/);
    panel.trips = [{ id: "trip", categories: ["Work"] }];
    let refreshed = false;
    panel.loadTrips = async () => { refreshed = true; };
    await panel.saveCategories({ dataset: { categoryTrip: "trip" }, value: "Invented", checked: true });
    assert.equal(panel.trips[0].categories.join(), "Work");
    assert.equal(refreshed, false);
    assert.match(panel.categoryError, /Unable to save categories/);
    assert.equal(panel.savingCategories, false);
});

test("driver and category filters send encoded parameters, combine, paginate and reset", async () => {
    const requests = [];
    const { panel, nodes } = createPaginationPanel(async (url) => {
        requests.push(new URL(url, "http://localhost").searchParams);
        return paginatedResponse([{ id: "match", driver: "person.alice", categories: ["Work & travel"] }], 2, requests.length === 1 ? 1 : null);
    });
    for (const selector of ["#driver", "#category"]) {
        nodes.set(selector, { value: "", label: {}, closest() { return this.label; } });
    }
    panel.driverControlsEnabled = true;
    panel.categoryControlsEnabled = true;
    panel.drivers = [{ id: "person.alice", name: "Alice" }];
    panel.categories = ["Work & travel"];
    nodes.get("#driver").value = "person.alice";
    nodes.get("#category").value = "Work & travel";
    panel.applyFilters();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests[0].get("driver"), "person.alice");
    assert.equal(requests[0].get("category"), "Work & travel");
    assert.equal(requests[0].get("offset"), "0");
    await panel.loadTrips({ append: true });
    assert.equal(requests[1].get("offset"), "1");
    assert.equal(requests[1].get("category"), "Work & travel");
    panel.bindEvents();
    nodes.get("#reset").listeners.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests[2].has("driver"), false);
    assert.equal(requests[2].has("category"), false);
    assert.equal(panel.filters.driver, "");
    assert.equal(panel.filters.category, "");
});

test("filter choices include all-history assignments, escape labels and honor visibility", () => {
    const { panel } = createPanelWithFakeLeaflet();
    const nodes = new Map(["#driver", "#category"].map((id) => [
        id, { value: "", label: {}, closest() { return this.label; } },
    ]));
    panel.shadowRoot.querySelector = (id) => nodes.get(id) || null;
    panel.drivers = [{ id: "person.alice", name: "<Alice>" }];
    panel.driverIds = ["person.deleted"];
    panel.categoryNames = ["Old & retired"];
    panel.categories = ["Work"];
    panel.updateTripFilterChoices();
    assert.match(nodes.get("#driver").innerHTML, /&lt;Alice&gt;/);
    assert.match(nodes.get("#driver").innerHTML, /person.deleted/);
    assert.match(nodes.get("#category").innerHTML, /Old &amp; retired/);
    assert.equal(nodes.get("#driver").label.hidden, true);
    panel.filters.driver = "person.deleted";
    panel.filters.category = "Old & retired";
    panel.updateTripFilterChoices();
    assert.equal(nodes.get("#driver").label.hidden, false);
    assert.equal(nodes.get("#category").label.hidden, false);
    assert.equal(nodes.get("#driver").value, "person.deleted");
    panel.trips = [
        { driver: "person.deleted", categories: ["Old & retired", "Work"] },
        { driver: "person.alice", categories: ["Work"] },
        {},
    ];
    panel.applyFilters(false);
    assert.equal(panel.filteredTrips.length, 1);
    assert.equal(panel.filteredTrips[0].driver, "person.deleted");
});

test("pagination defaults to 10, appends without rebuilding existing cards, and stops at the end", async () => {
    const requests = [];
    const { panel, nodes } = createPaginationPanel(async (url) => {
        const query = new URL(url, "http://localhost").searchParams;
        requests.push(query);
        const offset = Number(query.get("offset"));
        const end = Math.min(offset + Number(query.get("limit")), paginationTrips.length);
        return paginatedResponse(paginationTrips.slice(offset, end), 23, end < 23 ? end : null);
    });
    let renders = 0;
    const render = panel.render.bind(panel);
    panel.render = () => { renders++; render(); };

    await panel.loadTrips();
    assert.equal(requests[0].get("limit"), "10");
    assert.equal(requests[0].get("timezone"), "America/New_York");
    assert.equal(panel.filteredTrips.length, 10);
    assert.equal(nodes.get(".trip-count").textContent, "10 / 23 Trips");
    assert.match(nodes.get("#pagination").innerHTML, /Load more/);
    const initialRenders = renders;
    await panel.loadTrips({ append: true });
    assert.equal(renders, initialRenders);
    assert.match(nodes.get(".trips-grid").appended, /data-index="10"/);
    await panel.loadTrips({ append: true });
    assert.deepEqual(Array.from(panel.trips), paginationTrips);
    assert.equal(nodes.get(".trip-count").textContent, "23 Trips");
    assert.equal(nodes.get("#pagination").innerHTML, "");
    await panel.loadTrips({ append: true });
    assert.equal(requests.length, 3);
});

test("filter changes restart pagination with a fixed batch size", async () => {
    const requests = [];
    const { panel, nodes } = createPaginationPanel(async (url) => {
        requests.push(new URL(url, "http://localhost").searchParams);
        return paginatedResponse([], 0);
    });
    panel.render();
    assert.doesNotMatch(panel.shadowRoot.innerHTML, /id="page-size"/);
    nodes.get("#from").value = "2026-10-01";
    nodes.get("#to").value = "2026-10-31";
    nodes.get("#vehicle").value = "other";
    nodes.get(".filters").listeners.change();
    await new Promise(setImmediate);
    assert.equal(requests[0].get("limit"), "10");
    assert.equal(requests[0].get("offset"), "0");
    assert.equal(requests[0].get("vehicle"), "other");
    assert.equal(requests[0].get("from"), "2026-10-01");
    assert.equal(requests[0].get("to"), "2026-10-31");
    nodes.get("#reset").listeners.click();
    await new Promise(setImmediate);
    assert.equal(panel.pageSize, 10);
    assert.equal(requests[1].get("limit"), "10");
    assert.equal(requests[1].has("vehicle"), false);
    assert.equal(requests[1].has("from"), false);
    assert.equal(requests[1].has("to"), false);
    assert.match(nodes.get(".trips-grid").innerHTML, /No trips match/);
});

test("stale responses cannot overwrite new filter results", async () => {
    let resolveOld;
    let calls = 0;
    const { panel, nodes } = createPaginationPanel(() => {
        if (++calls === 1) return new Promise((resolve) => { resolveOld = resolve; });
        return Promise.resolve(paginatedResponse([], 0));
    });
    const old = panel.loadTrips();
    nodes.get("#vehicle").value = "other";
    panel.applyFilters();
    await new Promise(setImmediate);
    resolveOld(paginatedResponse(paginationTrips.slice(0, 10), 23, 10));
    await old;
    assert.equal(panel.trips.length, 0);
    assert.equal(panel.filters.vehicle, "other");
    assert.equal(panel.loading, false);
});

test("API-filtered dates and ordering are not reinterpreted by the browser", async () => {
    const trip = { vehicle: "car", start_time: "2026-01-01T02:00:00" };
    const { panel, nodes } = createPaginationPanel(async () => paginatedResponse([trip], 1));
    panel.filters = { from: "2025-12-31", to: "2025-12-31", vehicle: "" };
    nodes.get("#from").value = "2025-12-31";
    nodes.get("#to").value = "2025-12-31";
    panel.applyFilters = () => assert.fail("API results must not be filtered again");
    await panel.loadTrips();
    assert.deepEqual(Array.from(panel.filteredTrips), [trip]);
});

test("infinite scroll guards concurrent loads, stops on errors, retries, and disconnects", async () => {
    const observers = [];
    class Observer {
        constructor(callback, options) {
            this.callback = callback;
            this.options = options;
            observers.push(this);
        }
        observe(node) { this.node = node; }
        disconnect() { this.disconnected = true; }
    }
    let calls = 0;
    let rejectPage;
    const { panel, nodes } = createPaginationPanel(async () => {
        calls++;
        if (calls === 1) return paginatedResponse(paginationTrips.slice(0, 10), 23, 10);
        if (calls === 2) return new Promise((resolve, reject) => { rejectPage = reject; });
        return paginatedResponse(paginationTrips.slice(10, 20), 23, 20);
    }, Observer);
    await panel.loadTrips();
    const observer = observers.at(-1);
    assert.equal(observer.options.rootMargin, "300px");
    assert.equal(observer.node, nodes.get("#pagination"));
    observer.callback([{ isIntersecting: true }]);
    observer.callback([{ isIntersecting: true }]);
    assert.equal(calls, 2);
    rejectPage({ status_code: 503 });
    await new Promise(setImmediate);
    assert.equal(panel.trips.length, 10);
    assert.match(nodes.get("#pagination").innerHTML, /role="alert"/);
    observer.callback([{ isIntersecting: true }]);
    assert.equal(calls, 2);
    await nodes.get("#retry").listeners.click();
    assert.equal(panel.trips.length, 20);
    const lastObserver = observers.at(-1);
    panel.disconnectedCallback();
    assert.equal(lastObserver.disconnected, true);
    lastObserver.callback([{ isIntersecting: true }]);
    assert.equal(calls, 3);
});

test("failed initial requests and malformed pages show retry without an empty-results message", async () => {
    for (const response of [
        null,
        paginatedResponse([], 23, 10),
    ]) {
        let calls = 0;
        const { panel, nodes } = createPaginationPanel(async () => {
            if (++calls === 1) {
                if (response === null) throw { status_code: 500 };
                return response;
            }
            return paginatedResponse([], 0);
        });
        await panel.loadTrips();
        assert.match(nodes.get("#pagination").innerHTML, /Retry/);
        assert.equal(nodes.get(".trips-grid").innerHTML, "");
        await nodes.get("#retry").listeners.click();
        assert.equal(panel.loadError, false);
        assert.match(nodes.get(".trips-grid").innerHTML, /No trips match/);
    }
});

test("disconnect discards in-flight results and late event subscriptions", async () => {
    let resolveFetch, resolveSubscription;
    let unsubscribed = false;
    const { panel } = createPaginationPanel(() => new Promise((resolve) => { resolveFetch = resolve; }));
    panel._hass.connection = {
        subscribeEvents: () => new Promise((resolve) => { resolveSubscription = resolve; }),
    };
    const subscription = panel.subscribeToUpdates();
    const load = panel.loadTrips();
    panel.disconnectedCallback();
    resolveFetch(paginatedResponse(paginationTrips.slice(0, 10), 23, 10));
    resolveSubscription(() => { unsubscribed = true; });
    await Promise.all([subscription, load]);
    assert.equal(panel.trips.length, 0);
    assert.equal(panel.loading, false);
    assert.equal(panel.unsubscribeUpdates, null);
    assert.equal(unsubscribed, true);
});

test("appending a page keeps the existing Leaflet map instance", async () => {
    let calls = 0;
    const { panel, nodes } = createPaginationPanel(async () => {
        const index = calls++;
        return paginatedResponse([paginationTrips[index]], 2, index ? null : 1);
    });
    panel.pageSize = 1;
    const fakeLeaflet = createFakeLeaflet();
    panel.loadLeaflet = () => fakeLeaflet;
    const containers = [];
    panel.shadowRoot.querySelectorAll = (selector) => selector === ".trip-map-canvas" ? containers : [];
    const render = panel.render.bind(panel);
    panel.render = () => {
        render();
        containers.splice(0, containers.length, ...Array.from(
            panel.shadowRoot.innerHTML.matchAll(/data-index="(\d+)"/g),
            (match) => ({ dataset: { index: match[1] } })
        ));
    };
    nodes.get(".trips-grid").insertAdjacentHTML = (position, html) => {
        for (const match of html.matchAll(/data-index="(\d+)"/g)) {
            containers.push({ dataset: { index: match[1] } });
        }
    };
    await panel.loadTrips();
    await panel._mapRenderQueue;
    const firstContainer = containers[0];
    const firstMap = panel.maps.get(firstContainer).map;
    await panel.loadTrips({ append: true });
    await panel._mapRenderQueue;
    assert.equal(panel.maps.get(firstContainer).map, firstMap);
    assert.equal(firstMap.removed, undefined);
    assert.equal(fakeLeaflet.maps.length, 2);
});

test("live notifications refresh only the loaded window and retain stable map containers", async () => {
    let callback;
    const offsets = [];
    let dataset = paginationTrips;
    const { panel } = createPaginationPanel(async (url) => {
        const query = new URL(url, "http://localhost").searchParams;
        const offset = Number(query.get("offset"));
        offsets.push(offset);
        const end = Math.min(offset + Number(query.get("limit")), dataset.length);
        return paginatedResponse(dataset.slice(offset, end), dataset.length, end < dataset.length ? end : null);
    });
    panel._hass.connection = {
        subscribeEvents: async (listener) => { callback = listener; return () => {}; },
    };
    await panel.subscribeToUpdates();
    await panel.loadTrips();
    await panel.loadTrips({ append: true });
    let renders = 0;
    const render = panel.render.bind(panel);
    panel.render = () => { renders++; render(); };
    dataset = dataset.map((trip) => ({ ...trip, distance: 42 }));
    callback({ data: { trips: paginationTrips } });
    await new Promise(setImmediate);
    assert.equal(panel.trips.length, 20);
    assert.equal(panel.trips[0].distance, 42);
    assert.deepEqual(offsets, [0, 10, 0, 10]);
    assert.equal(renders, 0);
});

test("live notifications received during loading are coalesced into a refresh", async () => {
    let callback, resolveInitial;
    let calls = 0;
    const { panel } = createPaginationPanel(async () => {
        if (++calls === 1) return new Promise((resolve) => { resolveInitial = resolve; });
        return paginatedResponse(paginationTrips.slice(0, 10), 23, 10);
    });
    panel._hass.connection = {
        subscribeEvents: async (listener) => { callback = listener; return () => {}; },
    };
    await panel.subscribeToUpdates();
    const initial = panel.loadTrips();
    callback({});
    callback({});
    resolveInitial(paginatedResponse([], 0));
    await initial;
    await new Promise(setImmediate);
    assert.equal(calls, 2);
    assert.equal(panel.trips.length, 10);
});

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

test("renderTripDetails() affiche l'heure de chaque étape à la place de son libellé", () => {
    const customElements = createCustomElementRegistry();
    const TripsRecorderPanel = loadPanelModule({
        customElements,
        document: { createElement: () => ({}) },
        window: {},
    });
    const panel = new TripsRecorderPanel();
    panel.formatDate = (value) => `timestamp ${value}`;
    const markup = panel.renderTripDetails({
        start_time: "start",
        stop_time: "stop",
        start_road: "Start street",
        stop_road: "Arrival street",
        vehicle: "OVMS",
        distance: 12.3,
    });

    assert.ok(markup.indexOf("timestamp start") < markup.indexOf("Start street"));
    assert.ok(markup.indexOf("timestamp stop") < markup.indexOf("Arrival street"));
    assert.match(markup, /<i class="dot"><\/i>/);
    assert.match(markup, /<i class="connector"><\/i>/);
    assert.match(markup, /<i class="dot stop"><\/i>/);
    assert.doesNotMatch(markup, /<strong>(?:Departure|Arrival|Départ|Arrivée)<\/strong>/);
});

test("renderTripDetails() affiche un badge localisé uniquement pour les trajets en cours", () => {
    const { panel } = createPanelWithFakeLeaflet();
    panel.locale = "fr";
    const trip = { vehicle: "OVMS", start_time: "2026-10-16T12:00:00Z", stop_time: null };

    assert.match(panel.renderTripDetails(trip), /class="trip-status">Trajet &middot; En cours<\/span>/);
    panel.locale = "de";
    assert.match(panel.renderTripDetails(trip), /class="trip-status">Fahrt &middot; Läuft<\/span>/);
    panel.locale = "xx";
    assert.match(panel.renderTripDetails(trip), /class="trip-status">Trip &middot; Ongoing<\/span>/);
    trip.stop_time = "2026-10-16T13:00:00Z";
    assert.doesNotMatch(panel.renderTripDetails(trip), /class="trip-status"/);
});

test("updateTrips() retire le badge quand un trajet se termine sans recréer la carte", async () => {
    const { panel, fakeLeaflet } = createPanelWithFakeLeaflet();
    panel.locale = "fr";
    const container = { dataset: { index: "0" } };
    const details = { innerHTML: "" };
    const card = { querySelector: () => details };
    panel.shadowRoot.querySelectorAll = (selector) => {
        if (selector === ".trip-map-canvas") return [container];
        if (selector === ".trip") return [card];
        return [];
    };
    const trip = {
        vehicle: "OVMS", start_time: "2026-10-16T12:00:00Z", stop_time: null,
        waypoints: [{ position_lat: "48", position_long: "2" }],
    };
    panel.filteredTrips = [trip];

    panel.updateTrips([trip]);
    await panel._mapRenderQueue;
    assert.match(details.innerHTML, /class="trip-status"/);

    panel.updateTrips([{ ...trip, stop_time: "2026-10-16T13:00:00Z" }]);
    await panel._mapRenderQueue;
    assert.doesNotMatch(details.innerHTML, /class="trip-status"/);
    assert.equal(fakeLeaflet.maps.length, 1);
    assert.equal(fakeLeaflet.polylines[0].options.opacity, 1);
});

test("render() uses the Home Assistant shell and theme-aligned filters", () => {
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
    assert.match(panel.shadowRoot.innerHTML, /class="trip-count">0 Trips<\/span>/);
    assert.match(panel.shadowRoot.innerHTML, /background: var\(--card-background-color\)/);
    assert.match(panel.shadowRoot.innerHTML, /var\(--ha-card-border-radius, 12px\)/);
    assert.match(panel.shadowRoot.innerHTML, /@media \(max-width: 520px\)/);
    assert.match(panel.shadowRoot.innerHTML, /\.route > \.dot \{ grid-column: 1; justify-self: center; align-self: center;/);
    assert.doesNotMatch(panel.shadowRoot.innerHTML, /OVMS \/ Home Assistant/);
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

test("formatDate() uses the Home Assistant configured timezone", () => {
    const customElements = createCustomElementRegistry();
    const TripsRecorderPanel = loadPanelModule({
        customElements,
        document: { createElement: () => ({}) },
        window: {},
    });
    const panel = new TripsRecorderPanel();
    panel._hass = {
        locale: { language: "en" },
        config: { time_zone: "America/New_York" },
    };
    panel.locale = panel.getLocale();

    assert.equal(panel.formatDate("2026-01-01T12:00:00Z"), "Jan 1, 2026, 7:00 AM");
});

test("applyFilters() compares trip dates in the Home Assistant timezone, falling back to browser local time", () => {
    const customElements = createCustomElementRegistry();
    const TripsRecorderPanel = loadPanelModule({
        customElements,
        document: { createElement: () => ({}) },
        window: {},
    });
    const panel = new TripsRecorderPanel();
    const trip = { start_time: "2026-01-01T02:00:00Z", vehicle: "OVMS" };
    const values = { "#from": "2025-12-31", "#to": "2025-12-31", "#vehicle": "" };
    panel.shadowRoot.querySelector = (selector) => ({ value: values[selector] });
    panel.trips = [trip];
    panel._hass = { config: { time_zone: "America/New_York" } };

    panel.applyFilters(false);

    assert.deepEqual(panel.filteredTrips, [trip]);

    const localDate = new Date(trip.start_time);
    const pad = (value) => String(value).padStart(2, "0");
    values["#from"] = [
        localDate.getFullYear(),
        pad(localDate.getMonth() + 1),
        pad(localDate.getDate()),
    ].join("-");
    values["#to"] = values["#from"];
    panel._hass = { config: {} };

    panel.applyFilters(false);

    assert.deepEqual(panel.filteredTrips, [trip]);
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

test("renderLeafletMaps() affiche le tracé du trajet en cours avec une opacité réduite", async () => {
    const { panel, fakeLeaflet } = createPanelWithFakeLeaflet();
    const container = { dataset: { index: "0" } };
    panel.shadowRoot.querySelectorAll = () => [container];
    panel.filteredTrips = [
        {
            vehicle: "OVMS",
            stop_time: null,
            waypoints: [{ position_lat: "48.0", position_long: "2.0" }],
        },
    ];

    await panel.renderLeafletMaps();

    assert.equal(fakeLeaflet.polylines[0].options.opacity, 0.45);

    panel.filteredTrips[0].stop_time = "2026-09-21T10:00:00Z";
    await panel.renderLeafletMaps();

    assert.equal(fakeLeaflet.polylines[0].options.opacity, 1);
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

test("the map follows Home Assistant dark-mode changes without recreating the map", async () => {
    const { panel, fakeLeaflet } = createPanelWithFakeLeaflet();
    const container = {
        dataset: { index: "0" },
        classList: {
            toggle(name, enabled) {
                this[name] = enabled;
            },
        },
    };
    panel.shadowRoot.querySelectorAll = () => [container];
    panel.filteredTrips = [{ vehicle: "OVMS", waypoints: [] }];
    panel._hass = { themes: { darkMode: false } };
    panel.initialized = true;
    panel.locale = "en";

    await panel.renderLeafletMaps();
    assert.equal(container.classList["dark-map"], false);

    panel.hass = { themes: { darkMode: true }, locale: { language: "en" } };
    await panel._mapRenderQueue;
    assert.equal(container.classList["dark-map"], true);

    panel.hass = { themes: { darkMode: false }, locale: { language: "en" } };
    await panel._mapRenderQueue;
    assert.equal(container.classList["dark-map"], false);
    assert.equal(fakeLeaflet.maps.length, 1);
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
    });
    const panel = new TripsRecorderPanel();
    panel._hass = {
        callApi: async () => ({ trips: [], version, count: 0, has_more: false, next_offset: null }),
    };
    panel.loadDriverSettings = async () => {};
    panel.loadCategorySettings = async () => {};
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
