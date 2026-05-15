import { strict as assert } from "node:assert";
import { test } from "node:test";
import { calculateDistance, formatAltitude, formatSpeed } from "../src/utils.ts";

test("calculateDistance", () => {
    // Distance between NY and LA is roughly 3936 km
    const ny = { lat: 40.7128, lon: -74.0060 };
    const la = { lat: 34.0522, lon: -118.2437 };

    const distance = calculateDistance(ny.lat, ny.lon, la.lat, la.lon);
    // It returns string, let's parse or check content
    // Expect ~3,935.7km (formatted with locale commas)
    assert.match(distance, /3[,\d]\d{3}\.\dkm/);

    // Distance between two close points
    // 1 degree latitude is approx 111km
    const p1 = { lat: 40, lon: 0 };
    const p2 = { lat: 40.001, lon: 0 }; // 0.001 deg is approx 111m

    const closeDistance = calculateDistance(p1.lat, p1.lon, p2.lat, p2.lon);
    assert.match(closeDistance, /\d+m/);
    assert.ok(closeDistance.endsWith("m"));

    // Exact same point
    const zero = calculateDistance(40, 0, 40, 0);
    assert.equal(zero, "0m");
});

test("calculateDistance imperial", () => {
    const ny = { lat: 40.7128, lon: -74.0060 };
    const la = { lat: 34.0522, lon: -118.2437 };

    // NY to LA is ~2446 miles (formatted with locale commas)
    const distance = calculateDistance(ny.lat, ny.lon, la.lat, la.lon, true);
    assert.match(distance, /2[,\d]\d{3}\.\dmi/);

    // ~0.15km apart → ~492ft, should show feet not miles
    const p1 = { lat: 40, lon: 0 };
    const p2 = { lat: 40.00135, lon: 0 }; // ~0.15km
    const feetDistance = calculateDistance(p1.lat, p1.lon, p2.lat, p2.lon, true);
    assert.ok(feetDistance.endsWith("ft"), `expected feet, got ${feetDistance}`);
    assert.match(feetDistance, /^\d+ft$/); // e.g. "492ft", not "0.1mi"

    // ~1km apart → ~0.6mi, should show miles not feet
    const p3 = { lat: 40, lon: 0 };
    const p4 = { lat: 40.009, lon: 0 }; // ~1km
    const milesDistance = calculateDistance(p3.lat, p3.lon, p4.lat, p4.lon, true);
    assert.ok(milesDistance.endsWith("mi"), `expected miles, got ${milesDistance}`);
});

test("formatAltitude", () => {
    assert.equal(formatAltitude(500), "500m up");
    assert.equal(formatAltitude(1500), "1.5km up");

    // Imperial
    assert.ok(formatAltitude(500, true).endsWith("ft up"));
    assert.ok(formatAltitude(5000, true).endsWith("mi up"));
});

test("formatSpeed", () => {
    assert.equal(formatSpeed(10), "36km/h");       // 10 m/s = 36 km/h
    assert.equal(formatSpeed(10, true), "22mph");  // 10 m/s ≈ 22.37 mph
});
