import { checkFrontendVersion } from "./frontend-version.js";
import {
    escapeHtml,
    renderError,
    renderMap,
    renderPanel,
    renderShellFromHtml,
    renderTripDetails,
    renderTrips,
} from "./panel-view.js";
import { TRANSLATIONS } from "./translations.js";

// Leaflet is loaded lazily (and only once) instead of via a static import so
// that merely parsing/evaluating this bundle never runs Leaflet's browser
// feature-detection code (which needs a full DOM/window/navigator). The
// dynamic import is still resolved from the single bundled file produced by
// Vite (see vite.config.mjs), it never triggers a separate network request.
let leafletModulePromise;
function loadLeafletModule() {
    if (!leafletModulePromise) {
        leafletModulePromise = import("leaflet").then((module) => module.default ?? module);
    }
    return leafletModulePromise;
}

const PANEL_API = "/api/ovms_trips_recorder/trips";
const TRIP_UPDATED_EVENT = "ovms_trips_recorder_updated";

class TripsRecorderPanel extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        this.trips = [];
        this.vehicles = [];
        this.filteredTrips = [];
        this.filters = { from: "", to: "", vehicle: "" };
        this.unsubscribeUpdates = null;
        this.loading = false;
        this._narrow = null;
        this.maps = new Map();
    }

    set hass(value) {
        this._hass = value;
        const locale = this.getLocale();
        if (this.initialized && locale !== this.locale) {
            this.locale = locale;
            this.render();
        }
        if (!this.initialized) {
            this.locale = locale;
            this.initialized = true;
            this.render();
            this.loadTrips();
            this.subscribeToUpdates();
        }
    }

    set narrow(value) {
        const nextValue = value == null ? null : Boolean(value);
        if (this._narrow === nextValue) return;
        this._narrow = nextValue;
        if (this.initialized) this.render();
    }

    get narrow() {
        if (typeof this._narrow === "boolean") return this._narrow;
        if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
            return window.matchMedia("(max-width: 870px)").matches;
        }
        return this._hass?.dockedSidebar === "always_hidden";
    }

    disconnectedCallback() {
        if (this.unsubscribeUpdates) {
            this.unsubscribeUpdates();
            this.unsubscribeUpdates = null;
        }
        this.destroyLeafletMaps();
    }

    async subscribeToUpdates() {
        if (!this._hass?.connection?.subscribeEvents || this.unsubscribeUpdates) return;
        this.unsubscribeUpdates = await this._hass.connection.subscribeEvents(
            (event) => {
                if (event?.data?.trips) {
                    this.updateTrips(event.data.trips);
                } else {
                    this.loadTrips();
                }
            },
            TRIP_UPDATED_EVENT,
        );
    }

    // Leaflet (and its stylesheet) is bundled directly into panel.js by Vite,
    // so the map is always available locally instead of depending on Home
    // Assistant's internal, undocumented ha-map/loadCardHelpers() APIs.
    loadLeaflet() {
        return loadLeafletModule();
    }

    getTileUrl() {
        return "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
    }

    getTileAttribution() {
        return '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    }

    getEndpointMarkerStyle(color) {
        return { radius: 7, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 };
    }

    connectedCallback() {
        this.render();
        if (this.initialized) this.subscribeToUpdates();
    }

    async loadTrips() {
        if (this.loading) return;
        this.loading = true;
        try {
            const response = await fetch(PANEL_API);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (await checkFrontendVersion(data.version)) return;
            this.vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
            this.updateTrips(data.trips || []);
        } catch (error) {
            this.renderError(this.t("loadingTrips"));
        } finally {
            this.loading = false;
        }
    }

    updateTrips(trips) {
        const previousTrips = this.filteredTrips;
        this.trips = [...trips].sort(
            (left, right) => new Date(right.start_time) - new Date(left.start_time)
        );
        this.applyFilters(false);
        if (this.hasSameTripOrder(previousTrips, this.filteredTrips)) {
            this.updateTripDetails();
            this.renderLeafletMaps();
        } else {
            this.render();
        }
    }

    hasSameTripOrder(left, right) {
        return left.length === right.length && left.every((trip, index) => (
            trip.vehicle === right[index].vehicle &&
            trip.start_time === right[index].start_time
        ));
    }

    updateTripDetails() {
        this.shadowRoot.querySelectorAll(".trip").forEach((card, index) => {
            const details = card.querySelector(".trip-details");
            const trip = this.filteredTrips[index];
            if (details && trip) details.innerHTML = this.renderTripDetails(trip);
        });
    }

    applyFilters(render = true) {
        this.filters = {
            from: this.shadowRoot.querySelector("#from")?.value || "",
            to: this.shadowRoot.querySelector("#to")?.value || "",
            vehicle: this.shadowRoot.querySelector("#vehicle")?.value || "",
        };
        const { from, to, vehicle } = this.filters;
        const dateFormatter = from || to
            ? new Intl.DateTimeFormat("en-CA", {
                timeZone: this._hass?.config?.time_zone || undefined,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
            })
            : null;
        this.filteredTrips = this.trips.filter((trip) => {
            const start = new Date(trip.start_time);
            const tripDate = dateFormatter ? this.getCalendarDate(start, dateFormatter) : "";
            return (
                (!from || (tripDate && tripDate >= from)) &&
                (!to || (tripDate && tripDate <= to)) &&
                (!vehicle || trip.vehicle === vehicle)
            );
        });
        if (render) this.render();
    }

    getCalendarDate(date, formatter) {
        if (Number.isNaN(date.getTime())) return "";
        const parts = formatter.formatToParts(date);
        const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
        return `${values.year}-${values.month}-${values.day}`;
    }

    formatDate(value) {
        return value
            ? new Date(value).toLocaleString(this.locale, {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: this._hass?.config?.time_zone || undefined,
            })
            : this.t("ongoing");
    }

    getLocale() {
        return this._hass?.locale?.language || this._hass?.language || "en";
    }

    t(key) {
        const language = this.locale || this.getLocale();
        const translations = TRANSLATIONS[language]
            || TRANSLATIONS[language.split("-")[0]]
            || TRANSLATIONS.en;
        return translations[key] || TRANSLATIONS.en[key] || key;
    }

    formatAddress(trip, prefix) {
        const fields = [
            `${prefix}_road`,
            `${prefix}_house_number`,
            `${prefix}_postcode`,
            `${prefix}_village`,
            `${prefix}_country`,
        ];
        const result = fields
            .map((field) => trip[field])
            .filter((value) => value && value !== "-1")
            .join(", ");
        return result || this.t("gpsPosition");
    }

    render() {
        renderPanel(this);
    }

    renderTrips(startIndex = 0) {
        return renderTrips(this, startIndex);
    }

    renderTripDetails(trip) {
        return renderTripDetails(this, trip);
    }

    renderMap(index) {
        return renderMap(index);
    }

    bindEvents() {
        this.shadowRoot.querySelector(".filters")?.addEventListener("change", () => this.applyFilters());
        this.shadowRoot.querySelector("#reset")?.addEventListener("click", () => {
            this.shadowRoot.querySelector(".filters").reset();
            this.filters = { from: "", to: "", vehicle: "" };
            this.applyFilters();
        });
        this.renderLeafletMaps();
    }

    renderLeafletMaps() {
        return this.queueMapTask(() => this.renderLeafletMapsNow());
    }

    // Both renderLeafletMapsNow() (creating/updating maps) and
    // destroyLeafletMaps() (tearing them down, e.g. from render()/disconnectedCallback())
    // are asynchronous/queued through here so that a destroy triggered by a
    // fresh render() can never race with and prematurely remove maps that a
    // still in-flight render is in the middle of creating.
    queueMapTask(task) {
        this._mapRenderQueue = (this._mapRenderQueue || Promise.resolve())
            .catch(() => { })
            .then(task)
            .catch((error) => {
                console?.error?.("Failed to update trip maps", error);
            });
        return this._mapRenderQueue;
    }

    async renderLeafletMapsNow() {
        const containers = this.shadowRoot.querySelectorAll(".trip-map-canvas");
        if (!containers.length) return;
        const Leaflet = await this.loadLeaflet();
        if (!Leaflet) return;
        containers.forEach((container) => {
            const index = Number(container.dataset.index);
            const trip = this.filteredTrips[index];
            if (!trip) return;
            const points = (trip.waypoints || [])
                .map((point) => [Number(point.position_lat), Number(point.position_long)])
                .filter(([latitude, longitude]) => Number.isFinite(latitude) && Number.isFinite(longitude));
            const pathStyle = {
                color: "#03a9f4",
                weight: 4,
                opacity: trip.stop_time ? 1 : 0.45,
            };
            let entry = this.maps.get(container);
            if (!entry) {
                const map = Leaflet.map(container, { attributionControl: true, zoomControl: true, scrollWheelZoom: false });
                Leaflet.tileLayer(this.getTileUrl(), {
                    attribution: this.getTileAttribution(),
                    maxZoom: 19,
                }).addTo(map);
                const path = Leaflet.polyline(points, pathStyle).addTo(map);
                entry = { map, path, startMarker: null, endMarker: null, points };
                this.maps.set(container, entry);
                this.observeMapResize(container, entry);
            } else {
                entry.path.setLatLngs(points);
                entry.path.setStyle(pathStyle);
                entry.points = points;
            }
            if (points.length) {
                if (entry.startMarker) entry.startMarker.setLatLng(points[0]);
                else entry.startMarker = Leaflet.circleMarker(points[0], this.getEndpointMarkerStyle("#2196f3")).addTo(entry.map);
                if (entry.endMarker) entry.endMarker.setLatLng(points[points.length - 1]);
                else entry.endMarker = Leaflet.circleMarker(points[points.length - 1], this.getEndpointMarkerStyle("#ff9800")).addTo(entry.map);
            }
            this.fitMapToPoints(entry.map, points);
        });
    }

    fitMapToPoints(map, points) {
        if (!points.length) return;
        if (points.length === 1) {
            map.setView(points[0], 15);
            return;
        }
        map.fitBounds(points, { padding: [16, 16] });
    }

    observeMapResize(container, entry) {
        if (typeof ResizeObserver !== "function") return;
        const observer = new ResizeObserver(([size]) => {
            if (!size.contentRect.width || !size.contentRect.height) return;
            entry.map.invalidateSize();
            this.fitMapToPoints(entry.map, entry.points);
        });
        observer.observe(container);
        entry.resizeObserver = observer;
    }

    destroyLeafletMaps() {
        return this.queueMapTask(() => this.destroyLeafletMapsNow());
    }

    destroyLeafletMapsNow() {
        this.maps.forEach((entry) => {
            entry.resizeObserver?.disconnect();
            entry.map.remove();
        });
        this.maps = new Map();
    }

    renderShellFromHtml(content) {
        return renderShellFromHtml(this, content);
    }

    renderError(message) {
        renderError(this, message);
    }

    escape(value) {
        return escapeHtml(value);
    }
}

customElements.define("trips-recorder-panel", TripsRecorderPanel);
