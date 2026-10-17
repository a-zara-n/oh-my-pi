import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import * as lifetime from "../internal/model-request-journal-binding-lifetime";

const moduleName = "model-request-journal-binding-lifetime";
const packageName = "@oh-my-pi/pi-utils";

test("public composition resolves and the actual private lifetime remains available to relative consumers", () => {
	const packageRoot = path.resolve(import.meta.dir, "..");
	expect(realpathSync(Bun.resolveSync(`${packageName}/model-request-journal-composition`, import.meta.dir))).toBe(
		realpathSync(path.join(packageRoot, "src/model-request-journal-composition.ts")),
	);
	expect(realpathSync(Bun.resolveSync(`../internal/${moduleName}`, import.meta.dir))).toBe(
		realpathSync(path.join(packageRoot, "internal", `${moduleName}.ts`)),
	);
	expect(Object.keys(lifetime).sort()).toEqual([
		"beginClosingBindingLifetime",
		"connectBindingWorkAuth",
		"finishBindingLifetime",
		"initializeBindingLifetime",
		"joinBindingOuterWorkDrains",
		"joinBindingPrincipalDrains",
		"registerBindingPrincipal",
		"registerJournalOuterWork",
		"settleJournalOuterWork",
	]);
	for (const operation of Object.values(lifetime)) expect(typeof operation).toBe("function");
});

for (const prefix of [
	"internal/",
	"%69nternal/",
	"internal%2f",
	"internal%5c",
	"../internal/",
	"%2e%2e/internal/",
	".%2e/internal/",
	"%2e./internal/",
	"%2e%2e%2finternal%2f",
	"%252e%252e/internal/",
	"internal/%2e%2e/%2e%2e/internal/",
]) {
	for (const name of [moduleName, `%6d${moduleName.slice(1)}`]) {
		for (const extension of ["", ".js", ".ts"]) {
			const specifier = `${packageName}/${prefix}${name}${extension}`;
			test(`package exports cannot resolve private lifetime: ${specifier}`, () => {
				expect(() => Bun.resolveSync(specifier, import.meta.dir)).toThrow();
			});
		}
	}
}
