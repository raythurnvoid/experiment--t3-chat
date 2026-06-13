const fs = require("node:fs");
const code = fs.readFileSync(".agents/skills/app-playwriter-harness/scripts/install-harness.js", "utf8");
await eval(code);
console.log("harness installed:", typeof state.appPlaywriterHarness);
