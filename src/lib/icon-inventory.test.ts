import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	getHeadIconLinks,
	getManifestIcons,
	ICON_INVENTORY,
} from "./icon-inventory";

const publicDir = path.resolve(import.meta.dirname, "../../public");
const manifestPath = path.join(publicDir, "manifest.json");

describe("ICON_INVENTORY", () => {
	it("every entry resolves to a real file in public/", () => {
		for (const entry of ICON_INVENTORY) {
			const filePath = path.join(publicDir, entry.file);
			expect(
				existsSync(filePath),
				`${entry.file} is listed in ICON_INVENTORY but missing from public/`,
			).toBe(true);
		}
	});

	it("has no duplicate filenames", () => {
		const files = ICON_INVENTORY.map((entry) => entry.file);
		expect(new Set(files).size).toBe(files.length);
	});
});

describe("getHeadIconLinks", () => {
	it("emits a link for every inHead entry, in inventory order", () => {
		const links = getHeadIconLinks();
		const expectedFiles = ICON_INVENTORY.filter((e) => e.inHead).map(
			(e) => e.file,
		);

		expect(links.map((l) => l.href)).toEqual(expectedFiles.map((f) => `/${f}`));
	});
});

describe("public/manifest.json agrees with ICON_INVENTORY", () => {
	it("is valid JSON whose icons array matches the derived manifest icons", async () => {
		const raw = await readFile(manifestPath, "utf-8");
		const manifest = JSON.parse(raw) as { icons: unknown };

		expect(manifest.icons).toEqual(getManifestIcons());
	});
});
