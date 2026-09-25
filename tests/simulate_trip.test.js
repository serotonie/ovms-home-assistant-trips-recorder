"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SIMULATOR = path.join(ROOT, "dev", "simulate_trip.sh");

function runSimulator(topicStructure) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ovms-simulator-"));
    const binDirectory = path.join(directory, "bin");
    const topicsPath = path.join(directory, "topics");
    fs.mkdirSync(binDirectory);
    fs.writeFileSync(
        path.join(binDirectory, "mosquitto_pub"),
        "#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"-t\" ]; then\n    shift\n    printf '%s\\n' \"$1\" >> \"$TOPIC_CAPTURE\"\n  fi\n  shift\ndone\n"
    );
    fs.writeFileSync(path.join(binDirectory, "sleep"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(binDirectory, "mosquitto_pub"), 0o755);
    fs.chmodSync(path.join(binDirectory, "sleep"), 0o755);

    const result = spawnSync("sh", [SIMULATOR], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
            ...process.env,
            PATH: `${binDirectory}:${process.env.PATH}`,
            TOPIC_CAPTURE: topicsPath,
            OVMS_TOPIC_STRUCTURE: topicStructure,
            OVMS_TRIP_COUNT: "1",
            OVMS_TRIP_PAUSE: "0",
            OVMS_VEHICLE_ID: "car-1",
            OVMS_TOPIC_USERNAME: "demo",
        },
    });
    const topics = fs.readFileSync(topicsPath, "utf8").trim().split("\n");
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr);
    return topics;
}

test("le simulateur publie sur chaque structure OVMS prise en charge", () => {
    const structures = {
        "{prefix}/{mqtt_username}/{vehicle_id}": "ovms/demo/car-1",
        "{prefix}/client/{vehicle_id}": "ovms/client/car-1",
        "{prefix}/{vehicle_id}": "ovms/car-1",
        "garage/{vehicle_id}/telemetry": "garage/car-1/telemetry",
    };

    for (const [structure, base] of Object.entries(structures)) {
        const topics = runSimulator(structure);
        assert.ok(topics.length > 0, `aucun topic publié pour ${structure}`);
        assert.ok(topics.every((topic) => topic.startsWith(`${base}/`)));
        assert.ok(topics.includes(`${base}/event/vehicle/on`));
        assert.ok(topics.includes(`${base}/event/vehicle/off`));
    }
});