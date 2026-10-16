import { describe, expect, it } from "bun:test";
import { sanitizeText, sanitizeTextDeep } from "@oh-my-pi/pi-utils/sanitize-text";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

describe("sanitizeText", () => {
	it("strips ANSI CSI and removes C0/C1 control chars while keeping tab + LF", () => {
		const input = "\x1b[31mred\x1b[0m\ra\u0000b\tline\ncarriage\r\u0001\u0085";
		expect(sanitizeText(input)).toBe("redab\tline\ncarriage");
	});

	it("drops lone surrogates and preserves valid surrogate pairs", () => {
		expect(sanitizeText(`a\ud800b\udc00c`)).toBe("abc");
		const validPair = "a\u{1f600}b";
		expect(sanitizeText(validPair)).toBe(validPair);
	});

	it("drops replacement characters on malformed input", () => {
		expect(sanitizeText("a\ud800�b")).toBe("ab");
	});

	it("preserves replacement characters on well-formed input", () => {
		expect(sanitizeText("a�b")).toBe("a�b");
	});

	it("preserves valid surrogate pairs while stripping controls", () => {
		const validPair = "\u{1f600}";
		expect(sanitizeText(`a${validPair}\u0000b`)).toBe(`a${validPair}b`);
	});

	it("strips OSC sequences terminated by BEL", () => {
		expect(sanitizeText("\x1b]0;title\x07hello")).toBe("hello");
	});

	it("strips OSC sequences terminated by ST (ESC \\)", () => {
		expect(sanitizeText("\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\!")).toBe("link!");
	});

	it("returns the original string instance when no changes are needed", () => {
		const clean = "plain ascii\twith\ttabs\nand newlines";
		expect(sanitizeText(clean)).toBe(clean);
	});

	it("strips DCS sequences terminated by ST", () => {
		expect(sanitizeText("before\x1bPpayload\x1b\\after")).toBe("beforeafter");
	});

	it("handles single-byte ESC finals (e.g. ESC c reset)", () => {
		expect(sanitizeText("a\x1bcb")).toBe("ab");
	});

	it("strips DEL and normalizes lone CR", () => {
		expect(sanitizeText("a\x7fb\rc")).toBe("abc");
	});
});

describe("sanitizeTextDeep", () => {
	it("sanitizes nested strings into copies and leaves the input and clean branches untouched", () => {
		const clean = { path: "src/a.ts", lines: [1, 2] };
		const input = { clean, display: { text: "needle \x1b[?1049h" }, rows: ["ok", "\x1b]52;c;cHduZWQ=\x07x"] };
		const output = sanitizeTextDeep(input);
		expect(output).toEqual({ clean, display: { text: "needle " }, rows: ["ok", "x"] });
		expect(input.display.text).toBe("needle \x1b[?1049h");
		expect(input.rows[1]).toBe("\x1b]52;c;cHduZWQ=\x07x");
		expect(isRecord(output) && output.clean).toBe(clean);
	});

	it("returns the same reference when nothing needs sanitizing", () => {
		const input = { a: ["x", { b: "y" }], n: 1, missing: undefined };
		expect(sanitizeTextDeep(input)).toBe(input);
	});

	it("terminates on cyclic values", () => {
		const input: Record<string, unknown> = { text: "a\x1b[2Jb" };
		input.self = input;
		const output = sanitizeTextDeep(input);
		expect(isRecord(output) && output.text).toBe("ab");
		expect(isRecord(output) && output.self).toBe(input);
	});
});
