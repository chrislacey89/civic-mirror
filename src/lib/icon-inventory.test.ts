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
	it("emits the exact head link descriptors — rel, href, type and sizes — for the current icon set", () => {
		// Expected values are independently stated here, not derived from
		// ICON_INVENTORY or getHeadIconLinks() itself: if either drifts (a
		// swapped `rel`, a corrupted `type`/`sizes`), this must go red.
		expect(getHeadIconLinks()).toEqual([
			{
				rel: "icon",
				href: "/favicon.ico",
				type: "image/x-icon",
				sizes: "48x48 32x32 16x16",
			},
			{
				rel: "icon",
				href: "/favicon.svg",
				type: "image/svg+xml",
				sizes: "any",
			},
			{
				rel: "apple-touch-icon",
				href: "/apple-touch-icon.png",
				type: "image/png",
				sizes: "180x180",
			},
		]);
	});
});

describe("public/manifest.json agrees with ICON_INVENTORY", () => {
	it("is valid JSON whose icons array matches the derived manifest icons", async () => {
		const raw = await readFile(manifestPath, "utf-8");
		const manifest = JSON.parse(raw) as { icons: unknown };

		expect(manifest.icons).toEqual(getManifestIcons());
	});
});
