/** A person who holds or held a role with a body. */
export interface Official {
	/** As the records spell it. */
	readonly name: string;
	/** Other forms the records use, such as "Mike Farmer" or "Councilman Oldham". */
	readonly variants: readonly string[];
	/** "Town Council member", "Town Manager". */
	readonly role: string;
	/** ISO dates; `to` is null while they serve. */
	readonly served: { readonly from: string; readonly to: string | null };
}
