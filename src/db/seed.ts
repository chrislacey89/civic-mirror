import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/libsql";
import { resolveDatabaseUrl } from "./database-url.ts";
import { governingBodies } from "./schema.ts";

config({ path: [".env.local", ".env"] });

/**
 * Seed script for all governing bodies that Civic Mirror tracks.
 *
 * Idempotent — uses `onConflictDoNothing` on the unique `slug` column,
 * so running this multiple times is safe and won't create duplicates.
 *
 * Three tiers of government are represented:
 * - **town**: Ellettsville boards and commissions (source: eGov document center)
 * - **county**: Monroe County bodies (source: TBD)
 * - **school**: Richland-Bean Blossom school board (source: Finalsite)
 */
const GOVERNING_BODIES = [
	{
		name: "Ellettsville Town Council",
		slug: "ellettsville-town-council",
		type: "town",
		egovSearchType: "12", // Minutes
		youtubePlaylistId: null,
	},
	{
		name: "Plan Commission",
		slug: "plan-commission",
		type: "town",
		egovSearchType: "12",
		youtubePlaylistId: null,
	},
	{
		name: "Parks & Recreation Board",
		slug: "parks-rec-board",
		type: "town",
		egovSearchType: "12",
		youtubePlaylistId: null,
	},
	{
		name: "Board of Zoning Appeals",
		slug: "board-of-zoning-appeals",
		type: "town",
		egovSearchType: "12",
		youtubePlaylistId: null,
	},
	{
		name: "Redevelopment Commission",
		slug: "redevelopment-commission",
		type: "town",
		egovSearchType: "12",
		youtubePlaylistId: null,
	},
	{
		name: "Monroe County Commissioners",
		slug: "monroe-county-commissioners",
		type: "county",
		egovSearchType: null,
		youtubePlaylistId: null,
	},
	{
		name: "Monroe County Council",
		slug: "monroe-county-council",
		type: "county",
		egovSearchType: null,
		youtubePlaylistId: null,
	},
	{
		name: "Richland-Bean Blossom School Board",
		slug: "rbb-school-board",
		type: "school",
		egovSearchType: null,
		finalsiteUrl: "https://www.rbbschools.net/school-board",
		youtubePlaylistId: null,
	},
] as const;

// Same resolution rule as src/db/index.ts: DATABASE_URL is canonical,
// TURSO_DATABASE_URL is a legacy alias. No production guard — this script is
// run by an operator against an explicitly chosen database.
const client = createClient({
	url: resolveDatabaseUrl() ?? "file:dev.db",
	authToken: process.env.TURSO_AUTH_TOKEN,
});
const db = drizzle(client);

async function seed() {
	for (const body of GOVERNING_BODIES) {
		await db
			.insert(governingBodies)
			.values(body)
			.onConflictDoNothing({ target: governingBodies.slug })
			.run();
	}

	console.log(`Seeded ${GOVERNING_BODIES.length} governing bodies.`);
}

seed();
