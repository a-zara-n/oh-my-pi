import type { WorkPoolYieldItem } from "@oh-my-pi/pi-utils/session-entries";
export type { WorkPoolYieldItem } from "@oh-my-pi/pi-utils/session-entries";

/** Build the per-batch output schema used to assemble one yield per item. */
export function buildWorkPoolOutputSchema(items: WorkPoolYieldItem[]): Record<string, unknown> {
	return {
		type: "object",
		properties: Object.fromEntries(items.map(item => [item.id, {}])),
		required: items.map(item => item.id),
		additionalProperties: false,
	};
}
