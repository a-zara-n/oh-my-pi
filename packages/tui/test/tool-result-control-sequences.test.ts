import { beforeAll, describe, expect, it, vi } from "bun:test";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

/**
 * Tool `details` carry raw file text (grep/read `displayContent`) straight to
 * renderers, both live and when a resumed session replays the transcript. File
 * bytes such as `ESC[?1049h ESC[?1003h` must never reach the terminal as live
 * sequences, or a grep over captured terminal fixtures leaves the pane stuck in
 * the alternate screen with mouse reporting on (#15963).
 */

const FILE_ESCAPES = "\x1b[?1049h\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const LINE = `needle ${FILE_ESCAPES}`;

/** DEC private mode toggles: the file's payload; renderer styling never emits these. */
function privateModeSequences(text: string): string[] {
	return text.match(/\x1b\[\?[\d;]*[hl]/g) ?? [];
}

describe("tool result details with raw control sequences", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("grep match previews render the file text without its escape sequences", () => {
		const component = new ToolExecutionComponent(
			"grep",
			{ pattern: "needle" },
			{ useBuiltInRenderer: true },
			undefined,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn(), resetDisplay: vi.fn() },
			"/repo",
		);
		const details = {
			matchCount: 1,
			fileCount: 1,
			displayContent: ["# fixture.txt", `*1│${LINE}`].join("\n"),
		};
		component.updateResult({ content: [{ type: "text", text: "*1|needle" }], details }, false);

		for (const expanded of [false, true]) {
			component.setExpanded(expanded);
			const rendered = component.render(120).join("\n");
			expect(rendered).toContain("needle");
			expect(privateModeSequences(rendered)).toEqual([]);
		}
		// The caller's result is left intact for persistence and the model.
		expect(details.displayContent).toContain(FILE_ESCAPES);
	});

	it("grouped read previews render the file text without its escape sequences", () => {
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		group.updateArgs({ path: "fixture.txt" }, "a");
		group.updateResult(
			{ content: [{ type: "text", text: "needle" }], details: { displayContent: { text: LINE, startLine: 1 } } },
			false,
			"a",
		);
		group.setExpanded(true);

		const rendered = group.render(120).join("\n");
		expect(rendered).toContain("needle");
		expect(privateModeSequences(rendered)).toEqual([]);
	});
});
