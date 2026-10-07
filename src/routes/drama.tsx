import { createFileRoute, redirect } from "@tanstack/react-router";

// The section's former address. Links to it land on Process Watch.
export const Route = createFileRoute("/drama")({
	beforeLoad: () => {
		throw redirect({ to: "/process", statusCode: 301 });
	},
});
