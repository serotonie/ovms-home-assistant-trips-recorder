import leafletCss from "leaflet/dist/leaflet.css?inline";

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
const VERSION_STORAGE_KEY = "ovms_trips_recorder_frontend_version";
const TRIP_UPDATED_EVENT = "ovms_trips_recorder_updated";

const TRANSLATIONS = {
    en: { trips: "Trips", trip: "Trip", tripsPlural: "Trips", from: "From", to: "To", vehicle: "Vehicle", allVehicles: "All vehicles", reset: "Reset", noTrips: "No trips match these criteria.", loadingTrips: "Unable to load trips.", ongoing: "Ongoing", gpsPosition: "GPS position recorded", start: "Departure", arrival: "Arrival" },
    fr: { trips: "Trajets", trip: "Trajet", tripsPlural: "Trajets", from: "Du", to: "Au", vehicle: "Véhicule", allVehicles: "Tous les véhicules", reset: "Réinitialiser", noTrips: "Aucun trajet pour ces critères.", loadingTrips: "Impossible de charger les trajets.", ongoing: "En cours", gpsPosition: "Position GPS enregistrée", start: "Départ", arrival: "Arrivée" },
    de: { trips: "Fahrten", trip: "Fahrt", tripsPlural: "Fahrten", from: "Von", to: "Bis", vehicle: "Fahrzeug", allVehicles: "Alle Fahrzeuge", reset: "Zurücksetzen", noTrips: "Keine Fahrten für diese Kriterien.", loadingTrips: "Fahrten konnten nicht geladen werden.", ongoing: "Läuft", gpsPosition: "GPS-Position aufgezeichnet", start: "Abfahrt", arrival: "Ankunft" },
    es: { trips: "Viajes", trip: "Viaje", tripsPlural: "Viajes", from: "Desde", to: "Hasta", vehicle: "Vehículo", allVehicles: "Todos los vehículos", reset: "Restablecer", noTrips: "No hay viajes para estos criterios.", loadingTrips: "No se han podido cargar los viajes.", ongoing: "En curso", gpsPosition: "Posición GPS registrada", start: "Salida", arrival: "Llegada" },
    it: { trips: "Viaggi", trip: "Viaggio", tripsPlural: "Viaggi", from: "Da", to: "A", vehicle: "Veicolo", allVehicles: "Tutti i veicoli", reset: "Reimposta", noTrips: "Nessun viaggio per questi criteri.", loadingTrips: "Impossibile caricare i viaggi.", ongoing: "In corso", gpsPosition: "Posizione GPS registrata", start: "Partenza", arrival: "Arrivo" },
    nl: { trips: "Ritten", trip: "Rit", tripsPlural: "Ritten", from: "Van", to: "Tot", vehicle: "Voertuig", allVehicles: "Alle voertuigen", reset: "Resetten", noTrips: "Geen ritten voor deze criteria.", loadingTrips: "Ritten konden niet worden geladen.", ongoing: "Bezig", gpsPosition: "GPS-positie geregistreerd", start: "Vertrek", arrival: "Aankomst" },
    pt: { trips: "Viagens", trip: "Viagem", tripsPlural: "Viagens", from: "De", to: "Até", vehicle: "Veículo", allVehicles: "Todos os veículos", reset: "Repor", noTrips: "Não existem viagens para estes critérios.", loadingTrips: "Não foi possível carregar as viagens.", ongoing: "Em curso", gpsPosition: "Posição GPS registada", start: "Partida", arrival: "Chegada" },
    "pt-BR": { trips: "Viagens", trip: "Viagem", tripsPlural: "Viagens", from: "De", to: "Até", vehicle: "Veículo", allVehicles: "Todos os veículos", reset: "Redefinir", noTrips: "Nenhuma viagem corresponde a estes critérios.", loadingTrips: "Não foi possível carregar as viagens.", ongoing: "Em andamento", gpsPosition: "Posição GPS registrada", start: "Partida", arrival: "Chegada" },
    pl: { trips: "Przejazdy", trip: "Przejazd", tripsPlural: "Przejazdy", from: "Od", to: "Do", vehicle: "Pojazd", allVehicles: "Wszystkie pojazdy", reset: "Resetuj", noTrips: "Brak przejazdów dla tych kryteriów.", loadingTrips: "Nie można załadować przejazdów.", ongoing: "W toku", gpsPosition: "Zarejestrowana pozycja GPS", start: "Odjazd", arrival: "Przyjazd" },
    ru: { trips: "Поездки", trip: "Поездка", tripsPlural: "Поездки", from: "С", to: "По", vehicle: "Автомобиль", allVehicles: "Все автомобили", reset: "Сбросить", noTrips: "Нет поездок по этим критериям.", loadingTrips: "Не удалось загрузить поездки.", ongoing: "В процессе", gpsPosition: "Позиция GPS записана", start: "Отправление", arrival: "Прибытие" },
    sv: { trips: "Resor", trip: "Resa", tripsPlural: "Resor", from: "Från", to: "Till", vehicle: "Fordon", allVehicles: "Alla fordon", reset: "Återställ", noTrips: "Inga resor matchar dessa kriterier.", loadingTrips: "Det gick inte att läsa in resor.", ongoing: "Pågår", gpsPosition: "GPS-position registrerad", start: "Avfärd", arrival: "Ankomst" },
    da: { trips: "Ture", trip: "Tur", tripsPlural: "Ture", from: "Fra", to: "Til", vehicle: "Køretøj", allVehicles: "Alle køretøjer", reset: "Nulstil", noTrips: "Ingen ture matcher disse kriterier.", loadingTrips: "Ture kunne ikke indlæses.", ongoing: "I gang", gpsPosition: "GPS-position registreret", start: "Afgang", arrival: "Ankomst" },
    no: { trips: "Turer", trip: "Tur", tripsPlural: "Turer", from: "Fra", to: "Til", vehicle: "Kjøretøy", allVehicles: "Alle kjøretøy", reset: "Tilbakestill", noTrips: "Ingen turer samsvarer med disse kriteriene.", loadingTrips: "Kunne ikke laste inn turer.", ongoing: "Pågår", gpsPosition: "GPS-posisjon registrert", start: "Avreise", arrival: "Ankomst" },
    fi: { trips: "Matkat", trip: "Matka", tripsPlural: "Matkat", from: "Alkaen", to: "Asti", vehicle: "Ajoneuvo", allVehicles: "Kaikki ajoneuvot", reset: "Nollaa", noTrips: "Näillä ehdoilla ei löytynyt matkoja.", loadingTrips: "Matkoja ei voitu ladata.", ongoing: "Käynnissä", gpsPosition: "GPS-sijainti tallennettu", start: "Lähtö", arrival: "Saapuminen" },
    cs: { trips: "Cesty", trip: "Cesta", tripsPlural: "Cesty", from: "Od", to: "Do", vehicle: "Vozidlo", allVehicles: "Všechna vozidla", reset: "Resetovat", noTrips: "Žádné cesty neodpovídají kritériím.", loadingTrips: "Cesty se nepodařilo načíst.", ongoing: "Probíhá", gpsPosition: "Pozice GPS zaznamenána", start: "Odjezd", arrival: "Příjezd" },
    tr: { trips: "Sürüşler", trip: "Sürüş", tripsPlural: "Sürüşler", from: "Başlangıç", to: "Bitiş", vehicle: "Araç", allVehicles: "Tüm araçlar", reset: "Sıfırla", noTrips: "Bu ölçütlere uyan sürüş yok.", loadingTrips: "Sürüşler yüklenemedi.", ongoing: "Devam ediyor", gpsPosition: "GPS konumu kaydedildi", start: "Kalkış", arrival: "Varış" },
    uk: { trips: "Поїздки", trip: "Поїздка", tripsPlural: "Поїздки", from: "Від", to: "До", vehicle: "Автомобіль", allVehicles: "Усі автомобілі", reset: "Скинути", noTrips: "Поїздок за цими критеріями немає.", loadingTrips: "Не вдалося завантажити поїздки.", ongoing: "Триває", gpsPosition: "Позицію GPS записано", start: "Відправлення", arrival: "Прибуття" },
    ja: { trips: "走行履歴", trip: "走行", tripsPlural: "走行履歴", from: "開始日", to: "終了日", vehicle: "車両", allVehicles: "すべての車両", reset: "リセット", noTrips: "条件に一致する走行はありません。", loadingTrips: "走行履歴を読み込めませんでした。", ongoing: "進行中", gpsPosition: "GPS位置を記録しました", start: "出発", arrival: "到着" },
    "zh-Hans": { trips: "行程", trip: "行程", tripsPlural: "行程", from: "开始", to: "结束", vehicle: "车辆", allVehicles: "所有车辆", reset: "重置", noTrips: "没有符合这些条件的行程。", loadingTrips: "无法加载行程。", ongoing: "进行中", gpsPosition: "已记录 GPS 位置", start: "出发", arrival: "到达" },
    "zh-Hant": { trips: "行程", trip: "行程", tripsPlural: "行程", from: "開始", to: "結束", vehicle: "車輛", allVehicles: "所有車輛", reset: "重設", noTrips: "沒有符合這些條件的行程。", loadingTrips: "無法載入行程。", ongoing: "進行中", gpsPosition: "已記錄 GPS 位置", start: "出發", arrival: "抵達" },
    ko: { trips: "주행 기록", trip: "주행", tripsPlural: "주행 기록", from: "시작", to: "종료", vehicle: "차량", allVehicles: "모든 차량", reset: "초기화", noTrips: "조건에 맞는 주행이 없습니다.", loadingTrips: "주행 기록을 불러올 수 없습니다.", ongoing: "진행 중", gpsPosition: "GPS 위치가 기록되었습니다", start: "출발", arrival: "도착" },
};

async function checkFrontendVersion(version) {
    if (!version) return false;
    try {
        const known = window.localStorage.getItem(VERSION_STORAGE_KEY);
        window.localStorage.setItem(VERSION_STORAGE_KEY, version);
        if (known === null || known === version) return false;
        if (window.caches) {
            const keys = await window.caches.keys();
            await Promise.all(keys.map((key) => window.caches.delete(key)));
        }
        window.location.reload();
        return true;
    } catch (error) {
        return false;
    }
}

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
            ? new Date(value).toLocaleString(this.locale, {
                dateStyle: "medium",
                timeStyle: "short",
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
        if (!this.shadowRoot) return;
        this.destroyLeafletMaps();
        const vehicles = [...new Set([
            ...this.vehicles,
            ...this.trips.map((trip) => trip.vehicle).filter(Boolean),
        ])].sort();
        this.shadowRoot.innerHTML = this.renderShellFromHtml(`
      <style>
        ${leafletCss}
        :host { display: block; height: 100%; color: var(--primary-text-color); }
        .panel-content { min-height: 100%; }
        main { box-sizing: border-box; padding: var(--ha-space-4, 24px); max-width: 1440px; margin: auto; }
        .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
        .summary { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: var(--ha-space-4, 24px); }
        .eyebrow { color: var(--primary-color); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
        .muted { color: var(--secondary-text-color); }
        .filters { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin-bottom: 18px; }
        label { display: grid; gap: 5px; color: var(--secondary-text-color); font-size: 12px; font-weight: 700; }
        input, select { min-height: 40px; padding: 8px 10px; color: var(--primary-text-color); background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: var(--ha-border-radius-sm, 4px); font: inherit; }
        .trips-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 18px; }
        ha-card { overflow: hidden; }
        .trip { display: grid; min-width: 0; }
        .trip-map { height: 260px; background: var(--secondary-background-color); }
        .trip-map-canvas { display: block; width: 100%; height: 100%; }
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
        @media (max-width: 850px) { main { padding: var(--ha-space-3, 16px); } .summary { display: block; } .trips-grid { grid-template-columns: 1fr; } }
      </style>
      <main>
                <h1 class="visually-hidden">${this.t("trips")}</h1>
                <div class="summary"><div class="eyebrow">OVMS / Home Assistant</div><div class="muted">${this.filteredTrips.length} ${this.filteredTrips.length === 1 ? this.t("trip") : this.t("tripsPlural")}</div></div>
        <form class="filters">
                    <label>${this.t("from")} <input id="from" type="date"></label>
                    <label>${this.t("to")} <input id="to" type="date"></label>
                    <label>${this.t("vehicle")} <select id="vehicle"><option value="">${this.t("allVehicles")}</option>${vehicles.map((vehicle) => `<option value="${this.escape(vehicle)}">${this.escape(vehicle)}</option>`).join("")}</select></label>
                    <ha-button id="reset" appearance="outlined">${this.t("reset")}</ha-button>
        </form>
                <div class="trips-grid">${this.renderTrips()}</div>
      </main>`);
        const fromField = this.shadowRoot.querySelector("#from");
        const toField = this.shadowRoot.querySelector("#to");
        const vehicleField = this.shadowRoot.querySelector("#vehicle");
        if (fromField) fromField.value = this.filters.from;
        if (toField) toField.value = this.filters.to;
        if (vehicleField) vehicleField.value = this.filters.vehicle;
        this.bindEvents();
    }

    renderTrips() {
        if (!this.filteredTrips.length) return `<div class="empty">${this.escape(this.t("noTrips"))}</div>`;
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
            <div class="trip-head"><span class="trip-title">${this.escape(this.formatDate(trip.start_time))}</span><span class="vehicle">${this.escape(trip.vehicle || this.t("vehicle"))}</span></div>
            <div class="route"><div class="route-line"><i class="dot"></i><i class="connector"></i><i class="dot stop"></i></div><div><div class="address"><strong>${this.t("start")}</strong><br>${this.escape(this.formatAddress(trip, "start"))}</div><div class="address"><strong>${this.t("arrival")}</strong><br>${this.escape(this.formatAddress(trip, "stop"))}</div></div></div>
            <div class="trip-foot"><span>${this.escape(this.formatDate(trip.stop_time))}</span><span class="distance">${Number(trip.distance || 0).toFixed(1)} km</span></div>
                `;
    }

    renderMap(index) {
        return `<div class="trip-map-canvas" data-index="${index}"></div>`;
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
            let entry = this.maps.get(container);
            if (!entry) {
                const map = Leaflet.map(container, { attributionControl: true, zoomControl: true, scrollWheelZoom: false });
                Leaflet.tileLayer(this.getTileUrl(), {
                    attribution: this.getTileAttribution(),
                    maxZoom: 19,
                }).addTo(map);
                const path = Leaflet.polyline(points, { color: "#03a9f4", weight: 4 }).addTo(map);
                entry = { map, path, startMarker: null, endMarker: null, points };
                this.maps.set(container, entry);
                this.observeMapResize(container, entry);
            } else {
                entry.path.setLatLngs(points);
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
        const menuLabel = this._hass?.localize?.("ui.sidebar.sidebar_toggle") || "Menu";
        return `<ha-top-app-bar-fixed has-scrolling-content ${this.narrow ? "narrow" : ""}><ha-menu-button slot="navigationIcon" aria-label="${this.escape(menuLabel)}"></ha-menu-button><span slot="title">${this.escape(this.t("trips"))}</span><div class="panel-content">${content}</div></ha-top-app-bar-fixed>`;
    }

    renderError(message) {
        this.filteredTrips = [];
        this.destroyLeafletMaps();
        if (this.shadowRoot) this.shadowRoot.innerHTML = this.renderShellFromHtml(`<main><ha-card><div class="empty">${this.escape(message)}</div></ha-card></main>`);
    }

    escape(value) {
        return String(value ?? "").replace(/[&<>"']/g, (character) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
        })[character]);
    }
}

customElements.define("trips-recorder-panel", TripsRecorderPanel);
