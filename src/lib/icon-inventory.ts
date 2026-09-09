/**
 * Single source of truth for the site's shipped icon files.
 *
 * This list feeds both the document `<head>` icon links (`src/routes/__root.tsx`)
 * and — via a test that reads `public/manifest.json` off disk — the web app
 * manifest's `icons` array. Add or rename an icon here and both consumers stay
 * in sync; `icon-inventory.test.ts` fails loudly if `public/manifest.json` or
 * the files themselves drift out of step with this list.
 *
 * `public/manifest.json` itself must stay a static file (it's served as-is at
 * `/manifest.json` and must remain valid JSON on its own), so it is not
 * generated from this file — it is checked against it instead.
 */

export interface IconEntry {
	/** Filename inside `public/`, no leading slash. */
	file: string;
	type: string;
	sizes: string;
	purpose?: "any" | "maskable";
	/** Whether this icon gets a `<link>` tag in the document head. */
	inHead: boolean;
	/** `rel` attribute to use when `inHead` is true. */
	headRel?: "icon" | "apple-touch-icon";
	/** Whether this icon appears in the web app manifest's `icons` array. */
	inManifest: boolean;
}

export const ICON_INVENTORY: readonly IconEntry[] = [
	{
		file: "favicon.ico",
		type: "image/x-icon",
		sizes: "48x48 32x32 16x16",
		inHead: true,
		headRel: "icon",
		inManifest: true,
	},
	{
		file: "favicon.svg",
		type: "image/svg+xml",
		sizes: "any",
		purpose: "any",
		inHead: true,
		headRel: "icon",
		inManifest: true,
	},
	{
		file: "apple-touch-icon.png",
		type: "image/png",
		sizes: "180x180",
		inHead: true,
		headRel: "apple-touch-icon",
		inManifest: false,
	},
	{
		file: "icon-192.png",
		type: "image/png",
		sizes: "192x192",
		inHead: false,
		inManifest: true,
	},
	{
		file: "icon-512.png",
		type: "image/png",
		sizes: "512x512",
		inHead: false,
		inManifest: true,
	},
	{
		file: "icon-maskable-512.png",
		type: "image/png",
		sizes: "512x512",
		purpose: "maskable",
		inHead: false,
		inManifest: true,
	},
] as const;

export interface HeadIconLink {
	rel: "icon" | "apple-touch-icon";
	href: string;
	type: string;
	sizes: string;
}

/** Builds the `<head>` icon link descriptors consumed by `__root.tsx`. */
export function getHeadIconLinks(): HeadIconLink[] {
	return ICON_INVENTORY.filter((entry) => entry.inHead).map((entry) => {
		if (!entry.headRel) {
			throw new Error(
				`Icon "${entry.file}" is marked inHead but has no headRel`,
			);
		}
		return {
			rel: entry.headRel,
			href: `/${entry.file}`,
			type: entry.type,
			sizes: entry.sizes,
		};
	});
}

export interface ManifestIcon {
	src: string;
	type: string;
	sizes: string;
	purpose?: "any" | "maskable";
}

/** Builds the manifest `icons` array this inventory expects `public/manifest.json` to contain. */
export function getManifestIcons(): ManifestIcon[] {
	return ICON_INVENTORY.filter((entry) => entry.inManifest).map((entry) => {
		const icon: ManifestIcon = {
			src: entry.file,
			type: entry.type,
			sizes: entry.sizes,
		};
		if (entry.purpose) {
			icon.purpose = entry.purpose;
		}
		return icon;
	});
}
