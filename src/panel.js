import { checkFrontendVersion } from "./frontend-version.js";
import {
    escapeHtml,
    renderCount,
    renderError,
    renderMap,
    renderPagination,
    renderPanel,
    renderShellFromHtml,
    renderTripDetails,
    renderTrips,
    renderDriverSettings,
    renderTripMergeDialog,
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

const PANEL_API = "ovms_trips_recorder/trips";
const TRIP_UPDATED_EVENT = "ovms_trips_recorder_updated";

class TripsRecorderPanel extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        this.shadowRoot.addEventListener?.("change", (event) => {
            const field = event.target;
            if (field.matches?.("[data-driver-kind]")) this.saveDriver(field);
            if (field.matches?.("[data-category-trip]")) this.saveCategories(field);
        });
        this.shadowRoot.addEventListener?.("click", (event) => {
            const button = event.target.closest?.("[data-delete-trip]");
            if (button) this.deleteTrip(button.dataset.deleteTrip);
            const mergeButton = event.target.closest?.("[data-merge-trip]");
            if (mergeButton) this.previewTripMerge(
                mergeButton.dataset.mergeTrip,
                mergeButton.dataset.mergeNext,
            );
            if (event.target.closest?.("[data-confirm-merge]")) this.confirmTripMerge();
            if (event.target.closest?.("[data-cancel-merge]")) this.cancelTripMerge();
        });
        this.trips = [];
        this.drivers = [];
        this.driverControlsEnabled = false;
        this.userDriverId = null;
        this.driverError = "";
        this.savingDriver = false;
        this.deleteError = "";
        this.deletingTripId = null;
        this.mergingTripId = null;
        this.mergePreview = null;
        this.mergeError = "";
        this.categories = [];
        this.categoryControlsEnabled = false;
        this.categoryError = "";
        this.savingCategories = false;
        this.vehicles = [];
        this.filteredTrips = [];
        this.filters = { from: "", to: "", vehicle: "", driver: "", category: "" };
        this.driverIds = [];
        this.categoryNames = [];
        this.unsubscribeUpdates = null;
        this.loading = false;
        this._narrow = null;
        this.maps = new Map();
        this.pageSize = 10;
        this.total = 0;
        this.hasMore = false;
        this.nextOffset = 0;
        this.requestGeneration = 0;
        this.pendingRefresh = false;
        this.loadError = false;
    }

    set hass(value) {
        const wasDarkMode = Boolean(this._hass?.themes?.darkMode);
        this._hass = value;
        const locale = this.getLocale();
        if (this.initialized && locale !== this.locale) {
            this.locale = locale;
            this.render();
        }
        if (this.initialized && wasDarkMode !== Boolean(value?.themes?.darkMode)) {
            this.updateMapTheme();
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
        this.requestGeneration++;
        this.subscriptionGeneration = (this.subscriptionGeneration || 0) + 1;
        this.loading = false;
        this.pendingRefresh = false;
        this.paginationObserver?.disconnect();
        this.paginationObserver = null;
        if (this.unsubscribeUpdates) {
            this.unsubscribeUpdates();
            this.unsubscribeUpdates = null;
        }
        this.destroyLeafletMaps();
    }

    async subscribeToUpdates() {
        if (!this._hass?.connection?.subscribeEvents || this.unsubscribeUpdates) return;
        const generation = this.subscriptionGeneration = (this.subscriptionGeneration || 0) + 1;
        const unsubscribe = await this._hass.connection.subscribeEvents(
            () => {
                if (generation !== this.subscriptionGeneration) return;
                if (this.loading) this.pendingRefresh = true;
                else this.loadTrips({ refresh: true });
            },
            TRIP_UPDATED_EVENT,
        );
        if (generation === this.subscriptionGeneration) this.unsubscribeUpdates = unsubscribe;
        else unsubscribe();
    }

    // Leaflet (and its stylesheet) is bundled directly into panel.js by Vite,
    // so the map is always available locally instead of depending on Home
    // Assistant's internal, undocumented ha-map/loadCardHelpers() APIs.
    loadLeaflet() {
        return loadLeafletModule();
    }

    getTileUrl() {
        return "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    }

    getTileAttribution() {
        return '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    }

    getEndpointMarkerStyle(color) {
        return { radius: 7, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 };
    }

    connectedCallback() {
        this.render();
        if (this.initialized) {
            this.subscribeToUpdates();
            this.loadTrips({ refresh: true });
        }
    }

    async loadTrips({ append = false, refresh = false } = {}) {
        if (append && (this.loading || !this.hasMore)) return;
        const generation = append ? this.requestGeneration : ++this.requestGeneration;
        const target = refresh ? Math.max(this.pageSize, this.trips.length) : this.pageSize;
        if (!append && !refresh) {
            this.pendingRefresh = false;
            this.trips = [];
            this.filteredTrips = [];
            this.total = 0;
            this.hasMore = false;
            this.nextOffset = 0;
        }
        this.loading = true;
        this.loadError = false;
        if (!append && !refresh) this.render();
        else this.updatePagination();
        try {
            let offset = append ? this.nextOffset : 0;
            const trips = append ? [...this.trips] : [];
            let data;
            do {
                const limit = Math.min(this.pageSize, append ? this.pageSize : target - trips.length);
                const parameters = new URLSearchParams({
                    limit: String(limit),
                    offset: String(offset),
                    timezone: this._hass?.config?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
                for (const [key, value] of Object.entries(this.filters)) {
                    if (value) parameters.set(key, value);
                }
                data = await this._hass.callApi("GET", `${PANEL_API}?${parameters}`);
                if (generation !== this.requestGeneration) return;
                if (await checkFrontendVersion(data.version)) return;
                if (generation !== this.requestGeneration) return;
                if (!Array.isArray(data.trips) || data.trips.length > limit ||
                    !Number.isInteger(data.count) || data.count < 0 ||
                    typeof data.has_more !== "boolean" ||
                    (data.has_more && (!data.trips.length || data.next_offset !== offset + data.trips.length))) {
                    throw new Error("Invalid paginated trips response");
                }
                trips.push(...data.trips);
                offset = data.next_offset;
            } while (!append && data.has_more && trips.length < target);
            this.total = data.count;
            this.hasMore = data.has_more;
            this.nextOffset = data.next_offset;
            this.vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
            this.driverIds = Array.isArray(data.driver_ids) ? data.driver_ids : [];
            this.categoryNames = Array.isArray(data.category_names) ? data.category_names : [];
            await Promise.all([this.loadDriverSettings(), this.loadCategorySettings()]);
            if (generation !== this.requestGeneration) return;
            this.updateTrips(trips, { prefiltered: true });
        } catch (error) {
            if (generation !== this.requestGeneration) return;
            console.error("Failed to load trips", error);
            this.loadError = true;
            this.failedRequest = { append, refresh };
        } finally {
            if (generation === this.requestGeneration) {
                this.loading = false;
                this.updatePagination();
                const refreshPending = this.pendingRefresh;
                this.pendingRefresh = false;
                if (refreshPending && !this.loadError) this.loadTrips({ refresh: true });
            }
        }
    }

    async loadDriverSettings() {
        if (!this._hass?.callApi) return;
        try {
            const data = await this._hass.callApi("GET", "ovms_trips_recorder/drivers");
            if (!Array.isArray(data.drivers) || !Array.isArray(data.vehicles) ||
                !data.defaults || typeof data.defaults !== "object" ||
                typeof data.enabled !== "boolean" ||
                (data.user_driver_id != null && typeof data.user_driver_id !== "string")) {
                throw new Error("Invalid driver settings response");
            }
            this.drivers = data.drivers;
            this.driverControlsEnabled = data.enabled;
            this.userDriverId = data.user_driver_id || null;
            this.driverError = "";
        } catch (error) {
            console.error("Failed to load drivers", error);
            this.userDriverId = null;
            this.driverError = this.t("driverLoadError");
        }
        this.updateDriverSettings();
    }

    updateDriverSettings() {
        const settings = this.shadowRoot.querySelector("#driver-settings");
        if (settings) settings.innerHTML = renderDriverSettings(this);
    }

    async loadCategorySettings() {
        if (!this._hass?.callApi) return;
        try {
            const data = await this._hass.callApi("GET", "ovms_trips_recorder/categories");
            if (typeof data.enabled !== "boolean" || !Array.isArray(data.categories) ||
                !data.categories.every((category) => typeof category === "string")) {
                throw new Error("Invalid category settings response");
            }
            this.categories = data.categories;
            this.categoryControlsEnabled = data.enabled;
            this.categoryError = "";
        } catch (error) {
            console.error("Failed to load categories", error);
            this.categoryError = this.t("categoryLoadError");
        }
        this.updateDriverSettings();
    }

    async saveCategories(field) {
        if (this.savingCategories) return;
        const trip = this.trips.find((item) => item.id === field.dataset.categoryTrip);
        if (!trip) {
            console.error("Cannot categorize a trip that is no longer loaded");
            this.categoryError = this.t("categorySaveError");
            this.updateDriverSettings();
            return;
        }
        const selected = new Set(trip.categories || []);
        if (field.checked) selected.add(field.value);
        else selected.delete(field.value);
        this.savingCategories = true;
        this.shadowRoot.querySelectorAll("[data-category-trip]").forEach((input) => {
            input.disabled = true;
        });
        try {
            await this._hass.callApi(
                "PUT",
                `ovms_trips_recorder/categories/trip/${encodeURIComponent(trip.id)}`,
                { categories: [...selected] },
            );
            this.categoryError = "";
            await this.loadTrips({ refresh: true });
        } catch (error) {
            console.error("Failed to save trip categories", error);
            this.categoryError = this.t("categorySaveError");
        } finally {
            this.savingCategories = false;
            this.updateTripDetails();
            this.updateDriverSettings();
        }
    }

    driverOptions(selected) {
        const missing = selected && !this.drivers.some((driver) => driver.id === selected);
        return `<option value="" disabled ${!selected ? "selected" : ""}>${this.escape(this.t("driverNotSet"))}</option>` +
            (missing ? `<option value="${this.escape(selected)}" selected disabled>${this.escape(selected)} (${this.escape(this.t("driverUnavailable"))})</option>` : "") +
            this.drivers.map((driver) => `<option value="${this.escape(driver.id)}" ${driver.id === selected ? "selected" : ""}>${this.escape(driver.name)}</option>`).join("");
    }

    canMergeTrip(trip) {
        return Boolean(this._hass?.user?.is_admin);
    }

    async saveDriver(field) {
        if (this.savingDriver) return;
        const kind = field.dataset.driverKind;
        const target = field.dataset.driverTarget;
        const driver = field.value;
        this.savingDriver = true;
        field.disabled = true;
        this.shadowRoot.querySelectorAll("[data-driver-kind]").forEach((select) => {
            select.disabled = true;
        });
        try {
            await this._hass.callApi(
                "PUT",
                `ovms_trips_recorder/drivers/${kind}/${encodeURIComponent(target)}`,
                { driver },
            );
            this.driverError = "";
            await this.loadTrips({ refresh: true });
        } catch (error) {
            console.error("Failed to save driver", error);
            this.driverError = this.t("driverSaveError");
        } finally {
            this.savingDriver = false;
            this.updateTripDetails();
            this.updateDriverSettings();
        }
    }

    async deleteTrip(tripId) {
        if (!this._hass?.user?.is_admin || !tripId || this.deletingTripId) return;
        if (typeof window.confirm === "function" && !window.confirm(this.t("confirmDeleteTrip"))) return;
        this.deletingTripId = tripId;
        this.deleteError = "";
        this.updateTripDetails();
        try {
            await this._hass.callApi(
                "DELETE",
                `ovms_trips_recorder/trips/${encodeURIComponent(tripId)}`,
            );
            await this.loadTrips({ refresh: true });
        } catch (error) {
            console.error("Failed to delete trip", error);
            this.deleteError = this.t("deleteTripError");
        } finally {
            this.deletingTripId = null;
            this.updateTripDetails();
            this.updateDriverSettings();
        }
    }

    async previewTripMerge(tripId, nextTripId) {
        if (!this._hass?.user?.is_admin || !tripId || !nextTripId || this.mergingTripId) return;
        this.mergingTripId = tripId;
        this.mergeError = "";
        this.updateTripDetails();
        try {
            const preview = await this._hass.callApi(
                "GET",
                `ovms_trips_recorder/trips/${encodeURIComponent(tripId)}/merge-preview`,
            );
            if (preview?.trip_id !== tripId || preview?.next_trip_id !== nextTripId ||
                !preview.trip || !Number.isFinite(Number(preview.trip.distance))) {
                throw new Error("Invalid merge preview response");
            }
            this.mergePreview = preview;
            this.updateTripMergeDialog(true);
        } catch (error) {
            console.error("Failed to preview trip merge", error);
            this.mergeError = this.t("mergeTripError");
            this.updateDriverSettings();
        } finally {
            this.mergingTripId = null;
            this.updateTripDetails();
        }
    }

    async confirmTripMerge() {
        if (!this._hass?.user?.is_admin || !this.mergePreview || this.mergingTripId) return;
        const { trip_id: tripId, next_trip_id: nextTripId } = this.mergePreview;
        this.mergingTripId = tripId;
        this.mergeError = "";
        this.updateTripMergeDialog(false);
        this.updateTripDetails();
        try {
            await this._hass.callApi(
                "POST",
                `ovms_trips_recorder/trips/${encodeURIComponent(tripId)}/merge`,
                { next_trip_id: nextTripId },
            );
            this.cancelTripMerge();
            await this.loadTrips({ refresh: true });
        } catch (error) {
            console.error("Failed to merge trips", error);
            this.mergeError = this.t("mergeTripError");
            this.updateTripMergeDialog(true);
        } finally {
            this.mergingTripId = null;
            if (this.mergePreview) this.updateTripMergeDialog(true);
            this.updateTripDetails();
        }
    }

    cancelTripMerge() {
        this.mergePreview = null;
        this.mergeError = "";
        const dialog = this.shadowRoot.querySelector("#trip-merge-dialog");
        if (dialog?.open) dialog.close();
        if (dialog) dialog.innerHTML = "";
        this.updateTripDetails();
    }

    updateTripMergeDialog(open) {
        const dialog = this.shadowRoot.querySelector("#trip-merge-dialog");
        if (!dialog) return;
        dialog.innerHTML = renderTripMergeDialog(this);
        if (open && !dialog.open) dialog.showModal?.();
    }

    updateTrips(trips, { prefiltered = false } = {}) {
        const previousTrips = this.filteredTrips;
        this.trips = [...trips];
        if (prefiltered) this.filteredTrips = this.trips;
        else {
            this.trips.sort(
                (left, right) => new Date(right.start_time) - new Date(left.start_time)
            );
            this.applyFilters(false);
        }
        if (this.hasSameTripOrder(previousTrips, this.filteredTrips)) {
            this.updateTripDetails();
            this.renderLeafletMaps();
        } else if (previousTrips.length && this.hasSameTripOrder(
            previousTrips, this.filteredTrips.slice(0, previousTrips.length)
        ) && this.shadowRoot.querySelector(".trips-grid")) {
            this.shadowRoot.querySelector(".trips-grid").insertAdjacentHTML(
                "beforeend", this.renderTrips(previousTrips.length)
            );
            this.updateTripDetails();
            this.renderLeafletMaps();
        } else {
            this.render();
        }
        this.updatePagination();
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
            from: this.shadowRoot.querySelector("#from")?.value ?? this.filters.from,
            to: this.shadowRoot.querySelector("#to")?.value ?? this.filters.to,
            vehicle: this.shadowRoot.querySelector("#vehicle")?.value ?? this.filters.vehicle,
            driver: this.shadowRoot.querySelector("#driver")?.value ?? this.filters.driver,
            category: this.shadowRoot.querySelector("#category")?.value ?? this.filters.category,
        };
        if (render) {
            this.loadTrips();
            return;
        }
        const { from, to, vehicle, driver, category } = this.filters;
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
                (!vehicle || trip.vehicle === vehicle) &&
                (!driver || trip.driver === driver) &&
                (!category || (trip.categories || []).includes(category))
            );
        });
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
        this.shadowRoot.querySelector(".filters")?.addEventListener("submit", (event) => event.preventDefault());
        this.shadowRoot.querySelector("#trip-merge-dialog")?.addEventListener("cancel", (event) => {
            event.preventDefault();
            this.cancelTripMerge();
        });
        this.shadowRoot.querySelector(".filters")?.addEventListener("change", () => {
            this.applyFilters();
        });
        this.shadowRoot.querySelector("#reset")?.addEventListener("click", () => {
            this.shadowRoot.querySelector(".filters").reset();
            this.filters = { from: "", to: "", vehicle: "", driver: "", category: "" };
            this.applyFilters();
        });
        this.updatePagination();
        this.renderLeafletMaps();
    }

    renderCount() {
        return renderCount(this);
    }

    renderPagination() {
        return renderPagination(this);
    }

    updatePagination() {
        this.paginationObserver?.disconnect();
        this.paginationObserver = null;
        const footer = this.shadowRoot.querySelector("#pagination");
        if (!footer) return;
        this.updateTripFilterChoices();
        footer.innerHTML = this.renderPagination();
        footer.setAttribute("aria-busy", String(this.loading));
        const count = this.shadowRoot.querySelector(".trip-count");
        if (count) count.textContent = this.renderCount();
        const grid = this.shadowRoot.querySelector(".trips-grid");
        if (grid && !this.filteredTrips.length) grid.innerHTML = this.renderTrips();
        const vehicleField = this.shadowRoot.querySelector("#vehicle");
        if (vehicleField) {
            const vehicles = [...new Set([...this.vehicles, ...this.trips.map((trip) => trip.vehicle).filter(Boolean)])].sort();
            vehicleField.innerHTML = `<option value="">${this.t("allVehicles")}</option>${vehicles.map((vehicle) => `<option value="${this.escape(vehicle)}">${this.escape(vehicle)}</option>`).join("")}`;
            vehicleField.value = this.filters.vehicle;
        }
        this.shadowRoot.querySelector("#retry")?.addEventListener("click", () => this.loadTrips(this.failedRequest));
        this.shadowRoot.querySelector("#load-more")?.addEventListener("click", () => this.loadTrips({ append: true }));
        if (!this.loading && !this.loadError && this.hasMore && typeof IntersectionObserver === "function") {
            const observer = new IntersectionObserver((entries) => {
                if (this.paginationObserver === observer && entries.some((entry) => entry.isIntersecting) && !this.loadError) {
                    this.loadTrips({ append: true });
                }
            }, { rootMargin: "300px" });
            this.paginationObserver = observer;
            observer.observe(footer);
        }
    }

    updateTripFilterChoices() {
        const driver = this.shadowRoot.querySelector("#driver");
        const category = this.shadowRoot.querySelector("#category");
        if (driver) {
            const ids = [...new Set([
                ...this.drivers.map((person) => person.id), ...this.driverIds,
                ...this.trips.map((trip) => trip.driver).filter(Boolean),
                ...(this.filters.driver ? [this.filters.driver] : []),
            ])].sort();
            const names = new Map(this.drivers.map((person) => [person.id, person.name]));
            driver.innerHTML = `<option value="">${this.escape(this.t("allDrivers"))}</option>` +
                ids.map((id) => `<option value="${this.escape(id)}">${this.escape(names.get(id) || id)}</option>`).join("");
            driver.value = this.filters.driver || "";
            driver.closest("label").hidden = !this.driverControlsEnabled && !this.filters.driver;
        }
        if (category) {
            const names = [...new Set([
                ...this.categories, ...this.categoryNames,
                ...this.trips.flatMap((trip) => trip.categories || []),
                ...(this.filters.category ? [this.filters.category] : []),
            ])].sort();
            category.innerHTML = `<option value="">${this.escape(this.t("allCategories"))}</option>` +
                names.map((name) => `<option value="${this.escape(name)}">${this.escape(name)}</option>`).join("");
            category.value = this.filters.category || "";
            category.closest("label").hidden = !this.categoryControlsEnabled && !this.filters.category;
        }
    }

    renderLeafletMaps() {
        return this.queueMapTask(() => this.renderLeafletMapsNow());
    }

    updateMapTheme() {
        return this.queueMapTask(() => {
            const darkMode = Boolean(this._hass?.themes?.darkMode);
            for (const entry of this.maps.values()) {
                entry.container.classList?.toggle("dark-map", darkMode);
            }
        });
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
                container.classList?.toggle("dark-map", Boolean(this._hass?.themes?.darkMode));
                Leaflet.tileLayer(this.getTileUrl(), {
                    attribution: this.getTileAttribution(),
                    maxZoom: 19,
                }).addTo(map);
                const path = Leaflet.polyline(points, pathStyle).addTo(map);
                entry = { map, path, startMarker: null, endMarker: null, points, container };
                this.maps.set(container, entry);
                this.observeMapResize(container, entry);
            } else {
                container.classList?.toggle("dark-map", Boolean(this._hass?.themes?.darkMode));
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
