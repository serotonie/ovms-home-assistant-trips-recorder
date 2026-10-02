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
    const messagesPath = path.join(directory, "messages");
    fs.mkdirSync(binDirectory);
    fs.writeFileSync(
        path.join(binDirectory, "mosquitto_pub"),
        "#!/bin/sh\ntopic=\nmessage=\nwhile [ \"$#\" -gt 0 ]; do\n  case \"$1\" in\n    -t) shift; topic=$1 ;;\n    -m) shift; message=$1 ;;\n  esac\n  shift\ndone\nprintf '%s|%s\\n' \"$topic\" \"$message\" >> \"$MESSAGE_CAPTURE\"\n"
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
            MESSAGE_CAPTURE: messagesPath,
            OVMS_TOPIC_STRUCTURE: topicStructure,
            OVMS_TRIP_COUNT: "1",
            OVMS_TRIP_PAUSE: "0",
            OVMS_VEHICLE_ID: "car-1",
            OVMS_TOPIC_USERNAME: "demo",
        },
    });
    const messages = fs.readFileSync(messagesPath, "utf8").trim().split("\n");
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr);
    return messages;
}

test("le simulateur publie sur chaque structure OVMS prise en charge", () => {
    const structures = {
        "{prefix}/{mqtt_username}/{vehicle_id}": "ovms/demo/car-1",
        "{prefix}/client/{vehicle_id}": "ovms/client/car-1",
        "{prefix}/{vehicle_id}": "ovms/car-1",
        "garage/{vehicle_id}/telemetry": "garage/car-1/telemetry",
    };

    for (const [structure, base] of Object.entries(structures)) {
        const messages = runSimulator(structure);
        assert.ok(messages.length > 0, `aucun topic publié pour ${structure}`);
        assert.ok(messages.every((message) => message.startsWith(`${base}/`)));
        assert.ok(messages.includes(`${base}/event/vehicle/on|vehicle.on`));
        assert.ok(messages.includes(`${base}/event/vehicle/off|vehicle.off`));
        assert.ok(messages.includes(`${base}/metric/v/e/on|yes`));
        assert.ok(messages.includes(`${base}/metric/v/e/on|no`));
    }
});