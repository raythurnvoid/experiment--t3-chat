import type { AuthConfig } from "convex/server";

if (!process.env.CLERK_FRONTEND_API_URL) {
	throw new Error("CLERK_FRONTEND_API_URL is not set in Convex env");
}

if (!process.env.VITE_CONVEX_HTTP_URL) {
	throw new Error("VITE_CONVEX_HTTP_URL is not set in Convex env");
}

export default {
	providers: [
		{
			domain: process.env.CLERK_FRONTEND_API_URL,
			applicationID: "convex",
		},
		{
			type: "customJwt",
			issuer: process.env.VITE_CONVEX_HTTP_URL,
			jwks: `${process.env.VITE_CONVEX_HTTP_URL}/.well-known/jwks.json`,
			algorithm: "ES256",
			applicationID: "convex",
		},
	],
} satisfies AuthConfig;
