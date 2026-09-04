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
		{
			// Plugin-session JWTs for plugin UI iframes. Same signing key and JWKS as the anonymous
			// provider; the path-suffixed issuer is what tells the identities apart, because `aud` is
			// never exposed to app code.
			//
			// server-utils.ts classifies identities by issuer and treats every issuer it does not know
			// as Clerk — when you add a provider here, extend that classifier first or its tokens could
			// be accepted as signed-in members.
			type: "customJwt",
			issuer: `${process.env.VITE_CONVEX_HTTP_URL}/plugins-ui`,
			jwks: `${process.env.VITE_CONVEX_HTTP_URL}/.well-known/jwks.json`,
			algorithm: "ES256",
			applicationID: "convex",
		},
	],
} satisfies AuthConfig;
