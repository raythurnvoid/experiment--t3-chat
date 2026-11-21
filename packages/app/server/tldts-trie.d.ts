// tldts ships no types next to its internal rule trie file, so point that file at the trie types tldts
// does ship. Only the wildcard origin check in `convex/plugins.ts` imports it. package.json pins tldts to
// one exact version, so this path cannot move under us.
declare module "tldts/dist/es6/src/data/trie.js" {
	export * from "tldts/dist/types/src/data/trie";
}
