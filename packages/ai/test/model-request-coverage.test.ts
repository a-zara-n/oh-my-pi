import { describe, expect, test } from "bun:test";
import { buildModelRequestCoverage, MODEL_REQUEST_SITES } from "@oh-my-pi/pi-ai/model-request-coverage";
import {
	getModelRequestGateInfo,
	type ModelRequestCoverageSite,
	verifyModelRequestContext,
} from "@oh-my-pi/pi-ai/model-request-gate";
import { installFixtureGate } from "./helpers/model-request-gate-fixture";

function site(id: string, status: ModelRequestCoverageSite["status"]): ModelRequestCoverageSite {
	return {
		id,
		location: `packages/ai/src/${id}.ts`,
		status,
		contextPropagation: "inherited",
		reason: status === "uncovered" ? "no hook" : "",
	};
}

describe("coverage.complete is what a consumer of the inventory is allowed to rely on", () => {
	test("is true only when the context self-check passed and no site is uncovered", () => {
		const covered = [site("a", "gated"), site("b", "context-inherited")];

		expect(buildModelRequestCoverage("passed", covered).complete).toBe(true);
		expect(buildModelRequestCoverage("passed", [...covered, site("c", "uncovered")]).complete).toBe(false);
		expect(buildModelRequestCoverage("pending", covered).complete).toBe(false);
		expect(buildModelRequestCoverage("failed", covered).complete).toBe(false);
	});

	test("the inventory version is stable for one table and changes when a site's status changes", () => {
		const before = [site("a", "uncovered"), site("b", "gated")];
		const after = [site("a", "gated"), site("b", "gated")];

		const first = buildModelRequestCoverage("passed", before).inventoryVersion;
		expect(buildModelRequestCoverage("passed", before).inventoryVersion).toBe(first);
		expect(buildModelRequestCoverage("passed", after).inventoryVersion).not.toBe(first);
	});
});

describe("the shipped inventory cannot report an unproven path as covered", () => {
	test("a site whose context is not carried or unverified is uncovered, and every uncovered site says why", () => {
		for (const entry of MODEL_REQUEST_SITES) {
			if (entry.contextPropagation === "not-carried" || entry.contextPropagation === "unverified") {
				expect([entry.id, entry.status]).toEqual([entry.id, "uncovered"]);
			}
			if (entry.status === "uncovered") expect([entry.id, entry.reason.length > 0]).toEqual([entry.id, true]);
		}
	});

	test("site ids are unique, so a status can be attributed to exactly one path", () => {
		const ids = MODEL_REQUEST_SITES.map(entry => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("the shipped inventory after the per-attempt hook", () => {
	const statusOf = (id: string) => MODEL_REQUEST_SITES.find(entry => entry.id === id)?.status;

	test("sites verified by a fake send through the hook are context-inherited", () => {
		const verified = ["S-01", "S-02", "S-03", "S-04", "S-07", "S-08", "S-09", "S-10", "S-11", "S-12", "S-13", "S-15", "S-16", "S-18", "S-20"];
		expect(verified.map(id => [id, statusOf(id)])).toEqual(verified.map(id => [id, "context-inherited"]));
	});

	test("sites that only some of their paths have verified, and the direct-provider paths, stay uncovered, so complete stays false", () => {
		const unproven = ["S-05", "S-06", "S-14", "S-17", "S-19", "S-27", "S-28", "S-30", "S-31", "S-32", "S-33", "S-34", "S-35"];
		expect(unproven.map(id => [id, statusOf(id)])).toEqual(unproven.map(id => [id, "uncovered"]));
		expect(buildModelRequestCoverage("passed").complete).toBe(false);
	});
});

describe("getModelRequestGateInfo", () => {
	test("reports the latched registration and the verified context mechanism through the public API", async () => {
		installFixtureGate();

		expect(await verifyModelRequestContext()).toBe(true);

		const info = getModelRequestGateInfo();
		expect([info.apiVersion, info.registered, info.coverage.contextCheck]).toEqual([1, true, "passed"]);
	});
});
