const VERSION_STORAGE_KEY = "ovms_trips_recorder_frontend_version";

export async function checkFrontendVersion(version) {
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
