import leafletCss from "leaflet/dist/leaflet.css?inline";

export function renderPanel(panel) {
    if (!panel.shadowRoot) return;
    panel.paginationObserver?.disconnect();
    panel.destroyLeafletMaps();
    const vehicles = [...new Set([
        ...panel.vehicles,
        ...panel.trips.map((trip) => trip.vehicle).filter(Boolean),
    ])].sort();
    panel.shadowRoot.innerHTML = renderShellFromHtml(panel, `
      <style>
        ${leafletCss}
        :host { display: block; height: 100%; color: var(--primary-text-color); }
        .panel-content { min-height: 100%; }
        main { box-sizing: border-box; padding: var(--ha-space-4, 24px); max-width: 1440px; margin: auto; }
        .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
        .summary { display: flex; justify-content: flex-end; align-items: center; margin-bottom: 12px; }
        .trip-count { display: inline-flex; align-items: center; min-height: 32px; padding: 0 12px; border-radius: 16px; color: var(--secondary-text-color); background: var(--secondary-background-color); font-size: var(--ha-font-size-s, 14px); font-variant-numeric: tabular-nums; }
        .filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); align-items: end; gap: 12px; margin-bottom: 24px; padding: 16px; background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: var(--ha-card-border-radius, 12px); box-shadow: var(--ha-card-box-shadow, none); }
        .filters label[hidden] { display: none; }
        label { display: grid; gap: 8px; color: var(--secondary-text-color); font-size: var(--ha-font-size-s, 14px); font-weight: 500; }
        input, select { box-sizing: border-box; width: 100%; min-height: 40px; padding: 8px 12px; color: var(--primary-text-color); background: var(--input-fill-color, var(--card-background-color)); border: 1px solid var(--input-stroke-color, var(--divider-color)); border-radius: var(--ha-border-radius-md, 8px); font: inherit; transition: border-color 120ms ease, box-shadow 120ms ease; }
        input:focus-visible, select:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
        .filters ha-button { align-self: end; }
        .trips-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
        ha-card { overflow: hidden; }
        .trip { display: grid; grid-template-rows: auto 1fr; min-width: 0; height: 100%; }
        .trip-map { height: 240px; background: var(--secondary-background-color); border-bottom: 1px solid var(--divider-color); }
        .trip-map-canvas { display: block; width: 100%; height: 100%; }
        .trip-details { display: flex; flex-direction: column; padding: 16px; }
        .trip-head, .trip-foot { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
        .trip-head { align-items: flex-start; flex-wrap: wrap; }
        .vehicle { flex: 0 0 auto; padding: 4px 10px; border-radius: 999px; color: var(--primary-text-color); background: var(--secondary-background-color); font-size: var(--ha-font-size-xs, 12px); font-weight: 500; }
        .trip-status { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--primary-color); border-radius: 999px; color: var(--primary-text-color); font-size: var(--ha-font-size-xs, 12px); font-weight: 500; }
        .trip-status::before { content: ""; width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--primary-color); }
        .route { display: grid; grid-template-columns: 14px minmax(0, 1fr); grid-template-rows: auto minmax(14px, auto) auto; column-gap: 9px; margin-top: 14px; }
        .route > .dot { grid-column: 1; justify-self: center; align-self: center; z-index: 1; }
        .route > .address { grid-column: 2; }
        .route > .dot:first-child, .route > .address:nth-child(2) { grid-row: 1; }
        .route > .connector { grid-column: 1; grid-row: 2; justify-self: center; width: 1px; margin-block: -4px; background: var(--divider-color); }
        .route > .dot.stop, .route > .address:last-child { grid-row: 3; }
        .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--primary-color); }
        .dot.stop { background: var(--accent-color); }
        .address { display: grid; gap: 4px; min-width: 0; color: var(--secondary-text-color); font-size: var(--ha-font-size-s, 14px); line-height: 1.45; }
        .address strong { color: var(--primary-text-color); font-weight: 500; font-variant-numeric: tabular-nums; }
        .trip-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: auto; padding-top: 12px; border-top: 1px solid var(--divider-color); color: var(--secondary-text-color); font-size: var(--ha-font-size-s, 14px); }
        .distance { color: var(--primary-text-color); font-size: var(--ha-font-size-l, 20px); font-weight: 600; }
        .empty { padding: 48px 18px; color: var(--secondary-text-color); text-align: center; }
        .pagination { display: grid; justify-items: center; gap: 12px; padding: 24px; }
        .pagination-error { color: var(--error-color); }
        .driver-settings { margin-bottom: 24px; }
        .trip-driver { margin-block: 12px; }
        .trip-categories { margin: 12px 0; padding: 12px; border: 1px solid var(--divider-color); border-radius: 8px; }
        .category-choice { display: flex; align-items: center; gap: 8px; margin-block: 8px; }
        .category-choice input { width: auto; min-height: auto; }
        .driver-warning { color: var(--error-color); }
        #trip-merge-dialog { max-width: min(560px, calc(100vw - 48px)); color: var(--primary-text-color); background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: var(--ha-card-border-radius, 12px); }
        #trip-merge-dialog::backdrop { background: rgb(0 0 0 / 45%); }
        .merge-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
        .merge-error { color: var(--error-color); }
        @media (max-width: 850px) { main { padding: var(--ha-space-3, 16px); } .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); } .trips-grid { grid-template-columns: 1fr; } }
        @media (max-width: 520px) { .filters { grid-template-columns: 1fr; } }
      </style>
      <main>
                <h1 class="visually-hidden">${panel.t("trips")}</h1>
                <div class="summary"><span class="trip-count">${panel.renderCount()}</span></div>
        <form class="filters">
                    <label>${panel.t("from")} <input id="from" type="date"></label>
                    <label>${panel.t("to")} <input id="to" type="date"></label>
                    <label>${panel.t("vehicle")} <select id="vehicle"><option value="">${panel.t("allVehicles")}</option>${vehicles.map((vehicle) => `<option value="${panel.escape(vehicle)}">${panel.escape(vehicle)}</option>`).join("")}</select></label>
                    <label ${!panel.driverControlsEnabled && !panel.filters.driver ? "hidden" : ""}>${panel.t("driver")} <select id="driver"></select></label>
                    <label ${!panel.categoryControlsEnabled && !panel.filters.category ? "hidden" : ""}>${panel.t("category")} <select id="category"></select></label>
                    <ha-button id="reset" appearance="outlined">${panel.t("reset")}</ha-button>
        </form>
                <section id="driver-settings" class="driver-settings" aria-live="polite">${renderDriverSettings(panel)}</section>
                <div class="trips-grid">${panel.renderTrips()}</div>
                <div id="pagination" class="pagination" aria-live="polite" aria-busy="${panel.loading}">${panel.renderPagination()}</div>
      </main><dialog id="trip-merge-dialog" aria-labelledby="trip-merge-title"></dialog>`);
    const fromField = panel.shadowRoot.querySelector("#from");
    const toField = panel.shadowRoot.querySelector("#to");
    const vehicleField = panel.shadowRoot.querySelector("#vehicle");
    if (fromField) fromField.value = panel.filters.from;
    if (toField) toField.value = panel.filters.to;
    if (vehicleField) vehicleField.value = panel.filters.vehicle;
    panel.bindEvents();
}

export function renderTrips(panel, startIndex = 0) {
    if (!panel.filteredTrips.length) {
        return panel.loading || panel.loadError ? "" : `<div class="empty">${panel.escape(panel.t("noTrips"))}</div>`;
    }
    return panel.filteredTrips
        .slice(startIndex)
        .map(
            (trip, index) => `
                    <ha-card class="trip">
                        <div class="trip-map">${panel.renderMap(index + startIndex)}</div>
                        <div class="trip-details">${panel.renderTripDetails(trip)}
                        </div>
                    </ha-card>`
        )
        .join("");
}

export function renderTripDetails(panel, trip) {
    return `
            <div class="trip-head"><span class="vehicle">${panel.escape(trip.vehicle || panel.t("vehicle"))}</span>${!trip.stop_time ? `<span class="trip-status">${panel.escape(panel.t("trip"))} &middot; ${panel.escape(panel.t("ongoing"))}</span>` : ""}</div>
            ${panel.driverControlsEnabled ? `<label class="trip-driver">${panel.escape(panel.t("driver"))}
                <select data-driver-kind="trip" data-driver-target="${panel.escape(trip.id || "")}" ${!trip.id || !panel.drivers.length || panel.savingDriver ? "disabled" : ""}>${panel.driverOptions(trip.driver)}</select>
            </label>
            ${!trip.driver ? `<span class="driver-warning">${panel.escape(panel.t("driverNotSet"))}</span>` : ""}` : ""}
            ${renderTripCategories(panel, trip)}
            <div class="route">
                <i class="dot"></i><div class="address"><strong>${panel.escape(panel.formatDate(trip.start_time))}</strong><span>${panel.escape(panel.formatAddress(trip, "start"))}</span></div>
                <i class="connector"></i>
                <i class="dot stop"></i><div class="address"><strong>${panel.escape(panel.formatDate(trip.stop_time))}</strong><span>${panel.escape(panel.formatAddress(trip, "stop"))}</span></div>
            </div>
            <div class="trip-foot"><span class="distance">${Number(trip.distance || 0).toFixed(1)} km</span>${trip.id ? `${panel.canMergeTrip(trip) && trip.merge_next_id && trip.stop_time ? `<ha-button data-merge-trip="${panel.escape(trip.id)}" data-merge-next="${panel.escape(trip.merge_next_id)}" appearance="outlined" ${panel.mergingTripId === trip.id ? "disabled" : ""}>${panel.escape(panel.t("mergeTrip"))}</ha-button>` : ""}${panel._hass?.user?.is_admin ? `<ha-button class="trip-delete" data-delete-trip="${panel.escape(trip.id)}" appearance="outlined" ${panel.deletingTripId === trip.id ? "disabled" : ""}>${panel.escape(panel.t("deleteTrip"))}</ha-button>` : ""}` : ""}</div>
                `;
}

export function renderTripCategories(panel, trip) {
    if (!panel.categoryControlsEnabled) return "";
    const selected = trip.categories || [];
    const choices = [...new Set([...panel.categories, ...selected])];
    return `<fieldset class="trip-categories" ${!trip.id || panel.savingCategories ? "disabled" : ""}>
        <legend>${panel.escape(panel.t("categories"))}</legend>
        ${!choices.length ? `<span>${panel.escape(panel.t("noCategories"))}</span>` : choices.map((category) =>
        `<label class="category-choice"><input type="checkbox" data-category-trip="${panel.escape(trip.id || "")}" value="${panel.escape(category)}" ${selected.includes(category) ? "checked" : ""}>
            <span>${panel.escape(category)}${!panel.categories.includes(category) ? ` (${panel.escape(panel.t("categoryRetired"))})` : ""}</span>
        </label>`).join("")}
    </fieldset>`;
}

export function renderDriverSettings(panel) {
    return `${panel.driverError ? `<p class="driver-warning" role="alert">${panel.escape(panel.driverError)}</p>` : ""}
        ${panel.categoryError ? `<p class="driver-warning" role="alert">${panel.escape(panel.categoryError)}</p>` : ""}
        ${panel.deleteError ? `<p class="driver-warning" role="alert">${panel.escape(panel.deleteError)}</p>` : ""}
        ${panel.mergeError ? `<p class="driver-warning" role="alert">${panel.escape(panel.mergeError)}</p>` : ""}
        ${panel.driverControlsEnabled && !panel.drivers.length ? `<p>${panel.escape(panel.t("noDrivers"))}</p>` : ""}`;
}

export function renderTripMergeDialog(panel) {
    const trip = panel.mergePreview?.trip;
    if (!trip) return "";
    return `<h2 id="trip-merge-title">${panel.escape(panel.t("mergeTrip"))}</h2>
        <p>${panel.escape(panel.t("mergePreview"))}</p>
        <p><strong>${panel.escape(panel.t("vehicle"))}:</strong> ${panel.escape(trip.vehicle || "")}</p>
        <p><strong>${panel.escape(panel.t("from"))}:</strong> ${panel.escape(panel.formatDate(trip.start_time))} · ${panel.escape(panel.formatAddress(trip, "start"))}</p>
        <p><strong>${panel.escape(panel.t("to"))}:</strong> ${panel.escape(panel.formatDate(trip.stop_time))} · ${panel.escape(panel.formatAddress(trip, "stop"))}</p>
        <p><strong>${panel.escape(panel.t("distance"))}:</strong> ${Number(trip.distance || 0).toFixed(1)} km</p>
        ${panel.mergeError ? `<p class="merge-error" role="alert">${panel.escape(panel.mergeError)}</p>` : ""}
        <div class="merge-actions">
            <ha-button data-cancel-merge appearance="outlined">${panel.escape(panel.t("cancel"))}</ha-button>
            <ha-button data-confirm-merge ${panel.mergingTripId ? "disabled" : ""}>${panel.escape(panel.t("confirmMerge"))}</ha-button>
        </div>`;
}

export function renderMap(index) {
    return `<div class="trip-map-canvas" data-index="${index}"></div>`;
}

export function renderCount(panel) {
    const count = panel.total || panel.filteredTrips.length;
    const prefix = panel.hasMore ? `${panel.filteredTrips.length} / ` : "";
    return `${prefix}${count} ${count === 1 ? panel.t("trip") : panel.t("tripsPlural")}`;
}

export function renderPagination(panel) {
    if (panel.loading) return `<span role="status">${panel.escape(panel.t("loading"))}</span>`;
    if (panel.loadError) return `<span class="pagination-error" role="alert">${panel.escape(panel.t("loadingTrips"))}</span><ha-button id="retry">${panel.escape(panel.t("retry"))}</ha-button>`;
    if (panel.hasMore) return `<ha-button id="load-more" appearance="outlined">${panel.escape(panel.t("loadMore"))}</ha-button>`;
    return "";
}

export function renderShellFromHtml(panel, content) {
    const menuLabel = panel._hass?.localize?.("ui.sidebar.sidebar_toggle") || "Menu";
    return `<ha-top-app-bar-fixed has-scrolling-content ${panel.narrow ? "narrow" : ""}><ha-menu-button slot="navigationIcon" aria-label="${panel.escape(menuLabel)}"></ha-menu-button><span slot="title">${panel.escape(panel.t("trips"))}</span><div class="panel-content">${content}</div></ha-top-app-bar-fixed>`;
}

export function renderError(panel, message) {
    panel.filteredTrips = [];
    panel.destroyLeafletMaps();
    if (panel.shadowRoot) {
        panel.shadowRoot.innerHTML = renderShellFromHtml(
            panel,
            `<main><ha-card><div class="empty">${panel.escape(message)}</div></ha-card></main>`
        );
    }
}

export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
    })[character]);
}
