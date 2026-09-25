const PANEL_API = "/api/trips_recorder/trips";
const TRIP_UPDATED_EVENT = "trips_recorder_updated";

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
    }

    set hass(value) {
        this._hass = value;
        if (!this.initialized) {
            this.initialized = true;
            this.render();
            this.loadTrips();
            this.subscribeToUpdates();
            this.ensureMapDefined().then(() => this.render());
        }
    }

    disconnectedCallback() {
        if (this.unsubscribeUpdates) {
            this.unsubscribeUpdates();
            this.unsubscribeUpdates = null;
        }
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

    async ensureMapDefined() {
        // ha-map is lazy-loaded by the HA frontend itself (no CDN, no bundled
        // Leaflet of our own); loadCardHelpers() forces that chunk to load.
        // That helper is only attached once the Lovelace panel module has
        // been loaded, so force-load that module first instead of relying on
        // the user visiting a dashboard.
        if (customElements.get("ha-map")) return;
        await this.forceLoadLovelacePanel();
        const helpers = await this.waitForCardHelpers();
        if (!helpers) return;
        try {
            helpers.createCardElement({ type: "map", entities: [] });
            await customElements.whenDefined("ha-map");
        } catch (error) {
            // ha-map stays unavailable; renderMap() falls back to a message.
        }
    }

    hideNativePathMarkers(map) {
        const root = map.shadowRoot;
        if (!root || root.querySelector("#trips-recorder-path-markers")) return;
        const style = document.createElement("style");
        style.id = "trips-recorder-path-markers";
        style.textContent = ".leaflet-overlay-pane path.leaflet-interactive[fill]:not([fill='none']) { display: none !important; }";
        root.appendChild(style);
    }

    async forceLoadLovelacePanel() {
        // Uses the same private partial-panel-resolver route loader that
        // Home Assistant itself uses to lazy-load panels, so that
        // window.loadCardHelpers becomes available without navigating to a
        // dashboard first. Best-effort: silently ignored if it ever breaks.
        try {
            await customElements.whenDefined("partial-panel-resolver");
            const resolver = document.createElement("partial-panel-resolver");
            const routes = resolver._getRoutes([
                { component_name: "lovelace", url_path: "trips-recorder-map-preload" },
            ]);
            await routes?.routes?.["trips-recorder-map-preload"]?.load?.();
        } catch (error) {
            // Fall back to waitForCardHelpers() polling below.
        }
    }

    waitForCardHelpers(timeoutMs = 8000, intervalMs = 300) {
        return new Promise((resolve) => {
            const deadline = Date.now() + timeoutMs;
            const check = () => {
                if (typeof window.loadCardHelpers === "function") {
                    window.loadCardHelpers().then(resolve).catch(() => resolve(null));
                    return;
                }
                if (Date.now() >= deadline) {
                    resolve(null);
                    return;
                }
                setTimeout(check, intervalMs);
            };
            check();
        });
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
            this.vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
            this.updateTrips(data.trips || []);
        } catch (error) {
            this.renderError("Impossible de charger les trajets.");
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
            this.renderNativeMaps();
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
        const fromDate = from ? new Date(`${from}T00:00:00`) : null;
        const toDate = to ? new Date(`${to}T23:59:59`) : null;
        this.filteredTrips = this.trips.filter((trip) => {
            const start = new Date(trip.start_time);
            return (
                (!fromDate || start >= fromDate) &&
                (!toDate || start <= toDate) &&
                (!vehicle || trip.vehicle === vehicle)
            );
        });
        if (render) this.render();
    }

    formatDate(value) {
        return value
            ? new Date(value).toLocaleString("fr-FR", {
                dateStyle: "medium",
                timeStyle: "short",
            })
            : "En cours";
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
        return result || "Position GPS enregistrée";
    }

    render() {
        if (!this.shadowRoot) return;
        const vehicles = [...new Set([
            ...this.vehicles,
            ...this.trips.map((trip) => trip.vehicle).filter(Boolean),
        ])].sort();
        this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; height: 100%; color: var(--primary-text-color); }
        main { padding: var(--ha-space-4, 24px); max-width: 1440px; margin: auto; }
        header { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin-bottom: var(--ha-space-4, 24px); }
        h1 { margin: 4px 0 0; font-size: 32px; letter-spacing: -0.03em; }
        .eyebrow { color: var(--primary-color); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
        .muted { color: var(--secondary-text-color); }
        .filters { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin-bottom: 18px; }
        label { display: grid; gap: 5px; color: var(--secondary-text-color); font-size: 12px; font-weight: 700; }
        input, select { min-height: 40px; padding: 8px 10px; color: var(--primary-text-color); background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: var(--ha-border-radius-sm, 4px); font: inherit; }
        .trips-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 18px; }
        ha-card { overflow: hidden; }
        .trip { display: grid; min-width: 0; }
        .trip-map { height: 260px; background: var(--secondary-background-color); }
        ha-map { display: block; width: 100%; height: 100%; }
        .trip-details { padding: 16px; }
        .trip-head, .trip-foot { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
        .trip-title { font-weight: 700; }
        .vehicle { color: var(--primary-color); font-size: 12px; font-weight: 700; }
        .route { display: grid; grid-template-columns: 14px 1fr; gap: 9px; margin-top: 14px; }
        .route-line { display: grid; grid-template-rows: 9px 1fr 9px; justify-items: center; }
        .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--primary-color); }
        .dot.stop { background: var(--accent-color); }
        .connector { width: 1px; background: var(--divider-color); }
        .address { min-height: 38px; color: var(--secondary-text-color); font-size: 12px; line-height: 1.45; }
        .trip-foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--divider-color); color: var(--secondary-text-color); font-size: 12px; }
        .distance { color: var(--primary-text-color); font-size: 18px; font-weight: 700; }
        .empty { padding: 32px 18px; color: var(--secondary-text-color); text-align: center; }
        @media (max-width: 850px) { main { padding: var(--ha-space-3, 16px); } header { display: block; } .trips-grid { grid-template-columns: 1fr; } }
      </style>
      <main>
        <header><div><div class="eyebrow">OVMS / Home Assistant</div><h1>Trips</h1></div><div class="muted">${this.filteredTrips.length} trajet${this.filteredTrips.length === 1 ? "" : "s"}</div></header>
        <form class="filters">
          <label>Du <input id="from" type="date"></label>
          <label>Au <input id="to" type="date"></label>
          <label>Véhicule <select id="vehicle"><option value="">Tous les véhicules</option>${vehicles.map((vehicle) => `<option value="${this.escape(vehicle)}">${this.escape(vehicle)}</option>`).join("")}</select></label>
          <ha-button id="reset" appearance="outlined">Réinitialiser</ha-button>
        </form>
                <div class="trips-grid">${this.renderTrips()}</div>
      </main>`;
        this.shadowRoot.querySelector("#from").value = this.filters.from;
        this.shadowRoot.querySelector("#to").value = this.filters.to;
        this.shadowRoot.querySelector("#vehicle").value = this.filters.vehicle;
        this.bindEvents();
    }

    renderTrips() {
        if (!this.filteredTrips.length) return '<div class="empty">Aucun trajet pour ces critères.</div>';
        return this.filteredTrips
            .map(
                (trip, index) => `
                    <ha-card class="trip">
                        <div class="trip-map">${this.renderMap(index)}</div>
                        <div class="trip-details">${this.renderTripDetails(trip)}
                        </div>
                    </ha-card>`
            )
            .join("");
    }

    renderTripDetails(trip) {
        return `
            <div class="trip-head"><span class="trip-title">${this.escape(this.formatDate(trip.start_time))}</span><span class="vehicle">${this.escape(trip.vehicle || "Véhicule")}</span></div>
            <div class="route"><div class="route-line"><i class="dot"></i><i class="connector"></i><i class="dot stop"></i></div><div><div class="address"><strong>Départ</strong><br>${this.escape(this.formatAddress(trip, "start"))}</div><div class="address"><strong>Arrivée</strong><br>${this.escape(this.formatAddress(trip, "stop"))}</div></div></div>
            <div class="trip-foot"><span>${this.escape(this.formatDate(trip.stop_time))}</span><span class="distance">${Number(trip.distance || 0).toFixed(1)} km</span></div>
                `;
    }

    renderMap(index) {
        if (!customElements.get("ha-map")) return '<div class="empty">Chargement de la carte...</div>';
        return `<ha-map class="native-map" data-index="${index}"></ha-map>`;
    }

    bindEvents() {
        this.shadowRoot.querySelector(".filters")?.addEventListener("change", () => this.applyFilters());
        this.shadowRoot.querySelector("#reset")?.addEventListener("click", () => {
            this.shadowRoot.querySelector(".filters").reset();
            this.filters = { from: "", to: "", vehicle: "" };
            this.applyFilters();
        });
        this.renderNativeMaps();
    }

    renderNativeMaps() {
        this.shadowRoot.querySelectorAll(".native-map").forEach((map) => {
            const trip = this.filteredTrips[Number(map.dataset.index)];
            if (!trip) return;
            const points = (trip.waypoints || [])
                .map((point) => [Number(point.position_lat), Number(point.position_long)])
                .filter(([latitude, longitude]) => Number.isFinite(latitude) && Number.isFinite(longitude));
            map.editableLocations = [];
            map.autoFit = true;
            const fitTrip = () => {
                if (!points.length) return;
                const latitude = (Math.min(...points.map((point) => point[0])) + Math.max(...points.map((point) => point[0]))) / 2;
                const longitude = (Math.min(...points.map((point) => point[1])) + Math.max(...points.map((point) => point[1]))) / 2;
                if (typeof map.fitBounds === "function") {
                    map.fitBounds(points);
                    map.setView?.([latitude, longitude]);
                } else {
                    map.setView?.([latitude, longitude], 13);
                }
                this.hideNativePathMarkers(map);
                this.showNativeEndpointMarkers(map);
            };
            const fitWhenReady = (attempts = 120) => {
                if (map._engine || attempts === 0) {
                    fitTrip();
                    return;
                }
                const schedule = typeof requestAnimationFrame === "function"
                    ? requestAnimationFrame
                    : (callback) => setTimeout(callback, 0);
                schedule(() => {
                    fitWhenReady(attempts - 1);
                });
            };
            if (typeof ResizeObserver === "function") {
                const sizeObserver = new ResizeObserver(([entry]) => {
                    if (!entry.contentRect.width || !entry.contentRect.height) return;
                    sizeObserver.disconnect();
                    fitWhenReady();
                });
                sizeObserver.observe(map);
            }
            map.addEventListener?.("editing-available-changed", fitWhenReady, { once: true });
            map.hass = this._hass;
            if (this._hass?.connection) {
                map._connection = { connection: this._hass.connection };
            }
            map.paths = [{
                name: trip.vehicle || "Trajet",
                color: "#03a9f4",
                fullDatetime: true,
                points: (trip.waypoints || [])
                    .map((point) => ({
                        point: [Number(point.position_lat), Number(point.position_long)],
                        timestamp: new Date(point.timestamp),
                    }))
                    .filter((point) => point.point.every(Number.isFinite)),
            }];
            if (map.updateComplete) {
                map.updateComplete.then(fitWhenReady);
            } else {
                fitWhenReady();
            }
        });
    }

    showNativeEndpointMarkers(map) {
        const root = map.shadowRoot;
        if (!root) return;
        const applyColors = () => {
            const markers = root.querySelectorAll(
                ".leaflet-overlay-pane path.leaflet-interactive[fill]:not([fill='none'])"
            );
            if (markers.length < 2) return false;
            markers[0].style.cssText = "display:block !important;stroke:#2196f3 !important;fill:#2196f3 !important;";
            markers[markers.length - 1].style.cssText = "display:block !important;stroke:#ff9800 !important;fill:#ff9800 !important;";
            return true;
        };
        if (applyColors() || typeof MutationObserver !== "function") return;
        map._tripMarkerObserver?.disconnect();
        map._tripMarkerObserver = new MutationObserver(() => {
            if (applyColors()) map._tripMarkerObserver.disconnect();
        });
        map._tripMarkerObserver.observe(root, { childList: true, subtree: true });
    }

    createEndpointMarker(color) {
        const marker = document.createElement("span");
        marker.style.cssText = `display:block;width:14px;height:14px;box-sizing:border-box;border:2px solid #fff;border-radius:50%;background:${color};box-shadow:0 1px 3px rgba(0,0,0,.45);`;
        return marker;
    }

    renderError(message) {
        this.filteredTrips = [];
        if (this.shadowRoot) this.shadowRoot.innerHTML = `<main><ha-card><div class="empty">${this.escape(message)}</div></ha-card></main>`;
    }

    escape(value) {
        return String(value ?? "").replace(/[&<>"']/g, (character) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
        })[character]);
    }
}

customElements.define("trips-recorder-panel", TripsRecorderPanel);

if (typeof module !== "undefined" && module.exports) {
    module.exports = { TripsRecorderPanel };
}
