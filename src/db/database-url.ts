// Single source of truth for resolving the database URL environment
// variable. DATABASE_URL is canonical across the web app, the seed script,
// drizzle-kit, and the pipeline; TURSO_DATABASE_URL is accepted as a legacy
// alias so an existing deployment keeps working while it is migrated.
//
// An empty string counts as unset. `.env.example` ships the literal line
// `DATABASE_URL=`, which dotenv parses as `""` — a developer who copies the
// template and leaves that line blank must get the same fallback behavior
// as someone who omits the variable entirely, not a URL_INVALID error from
// the libsql client.
export function resolveDatabaseUrl(): string | undefined {
	const primary = process.env.DATABASE_URL;
	if (primary) return primary;

	const alias = process.env.TURSO_DATABASE_URL;
	if (alias) return alias;

	return undefined;
}
