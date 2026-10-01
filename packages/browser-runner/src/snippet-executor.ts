import { CHILD_BUNDLE_JS } from "./child-bundle.gen";

// Snippet harness
//
// The executor resolves the one page and runs the agent code with
// `(page, frame, expect, emitFile, state)`. Cloud web mode and the shared tab use the page's main
// frame. Cloud file mode uses the inner preview frame. Console and page errors are collected
// separately from tool output. File bytes the snippet emits cross RPC directly, and the host checks
// their count and total size. The app owns Files path and MIME rules. Screenshots travel the other
// way: the trusted bridge checks a provider screenshot reply before the child receives it.
//
// Both the cloud runner and the shared-tab runner load this module. Keep it free of imports from
// `index.ts` and `playwriter-session.ts`: `index.ts` imports the shared-tab session, so a link back
// would make a module cycle.

export const snippet_executor_LIMITS = {
	files: 8,
	fileBytes: 8_388_608,
	filePathChars: 1024,
	fileContentTypeChars: 255,
	consoleEntries: 50,
	consoleBytes: 4096,
	logLines: 100,
	logBytes: 16_384,
	stateBytes: 262_144,
	stateWarnings: 20,
};

export const SNIPPET_EXECUTOR_REVISION = "snippet-2026-10-01-v1";
export const SNIPPET_EXECUTOR_MAIN_MODULE = "executor.js";
const BUNDLE_MODULE = "pw.js";

/**
 * Stop the snippet this long before the command deadline. The host still has to drain the bridge
 * and check the page before the deadline, or the whole session is closed.
 */
export const SNIPPET_EXECUTOR_SOFT_MARGIN_MS = 3000;

const EXECUTOR_PREFIX = `import { WorkerEntrypoint } from "cloudflare:workers";
import { connect, expect } from "./${BUNDLE_MODULE}";

export default class SnippetExecutor extends WorkerEntrypoint {
  revision() {
    return "${SNIPPET_EXECUTOR_REVISION}";
  }
  async evaluate(input) {
    // Start the time budget before connect and the frame waits, so slow setup cannot push the
    // snippet past the host deadline.
    var softDeadline = Date.now() + (typeof input?.budgetMs === "number" && input.budgetMs > 0 ? input.budgetMs : 0);
    if (!input || typeof input.endpointId !== "string" || !input.endpointId) {
      throw new Error("Missing browser endpoint.");
    }
    if (input.mode !== "file" && input.mode !== "web" && input.mode !== "shared") {
      throw new Error("Missing session mode.");
    }
    if (input.mode === "file" && (typeof input.runtimeOrigin !== "string" || !input.runtimeOrigin)) {
      throw new Error("Missing runtime origin.");
    }
    if (input.mode !== "shared" && (!input.viewport || typeof input.viewport.width !== "number" || typeof input.viewport.height !== "number")) {
      throw new Error("Missing viewport.");
    }
    var files = [];
    var fileBytes = 0;
    var filesOpen = true;
    var timer;
    var consoleEntries = [];
    var pageErrors = [];
    var consoleBytes = 0;
    var textEncoder = new TextEncoder();
    function utf8Prefix(text, maxBytes) {
      return text.slice(0, textEncoder.encodeInto(text, new Uint8Array(maxBytes)).read);
    }
    function pushBounded(list, line) {
      if (list.length >= ${snippet_executor_LIMITS.consoleEntries}) return;
      var room = ${snippet_executor_LIMITS.consoleBytes} - consoleBytes;
      if (room <= 0) return;
      var text = utf8Prefix(String(line), room);
      consoleBytes += textEncoder.encode(text).length;
      list.push(text);
    }
    var logs = [];
    var logBytes = 0;
    var logsTruncated = false;
    function pushLog(line) {
      if (logsTruncated) return;
      if (logs.length >= ${snippet_executor_LIMITS.logLines}) { logsTruncated = true; return; }
      var text = String(line);
      if (logBytes + textEncoder.encode(text).length > ${snippet_executor_LIMITS.logBytes}) {
        text = utf8Prefix(text, Math.max(0, ${snippet_executor_LIMITS.logBytes} - logBytes));
        logsTruncated = true;
      }
      logBytes += textEncoder.encode(text).length;
      logs.push(text);
    }
    console.log = function () { pushLog(Array.prototype.map.call(arguments, String).join(" ")); };
    console.info = console.log;
    console.debug = console.log;
    console.warn = function () { pushLog("[warn] " + Array.prototype.map.call(arguments, String).join(" ")); };
    console.error = function () { pushLog("[error] " + Array.prototype.map.call(arguments, String).join(" ")); };
    function emitFile(file) {
      if (input.mode === "shared") throw new Error("Saving files from the shared tab is not available yet.");
      if (!filesOpen) throw new Error("Execution has already finished");
      if (!file || typeof file !== "object" || typeof file.path !== "string" ||
          file.path.length < 1 || file.path.length > ${snippet_executor_LIMITS.filePathChars}) {
        throw new TypeError("emitFile requires a path of 1-${snippet_executor_LIMITS.filePathChars} characters");
      }
      if (file.workspace !== "current" && file.workspace !== "personal") {
        throw new TypeError("emitFile workspace must be current or personal");
      }
      if (file.contentType !== undefined && (typeof file.contentType !== "string" ||
          file.contentType.length < 1 || file.contentType.length > ${snippet_executor_LIMITS.fileContentTypeChars})) {
        throw new TypeError("emitFile contentType must be 1-${snippet_executor_LIMITS.fileContentTypeChars} characters");
      }
      if (!(file.bytes instanceof Uint8Array) && !(file.bytes instanceof ArrayBuffer)) {
        throw new TypeError("emitFile bytes must be a Uint8Array or ArrayBuffer");
      }
      if (files.length >= ${snippet_executor_LIMITS.files} || fileBytes + file.bytes.byteLength > ${snippet_executor_LIMITS.fileBytes}) {
        throw new Error("File output limit exceeded");
      }
      // Copy now, including only the selected typed-array range.
      var bytes = new Uint8Array(file.bytes instanceof ArrayBuffer ? new Uint8Array(file.bytes) : file.bytes);
      fileBytes += bytes.byteLength;
      files.push({ workspace: file.workspace, path: file.path, ...(file.contentType === undefined ? {} : { contentType: file.contentType }), bytes });
    }
    // Every call is a new isolate, so only plain JSON data can last until the next call.
    var state = {};
    try {
      var savedState = typeof input.state === "string" ? JSON.parse(input.state) : null;
      if (savedState && typeof savedState === "object" && !Array.isArray(savedState)) state = savedState;
    } catch (e) {}
    function saveState() {
      var warnings = [];
      var seen = [];
      function drop(path) {
        if (warnings.length < ${snippet_executor_LIMITS.stateWarnings}) {
          warnings.push(path.slice(0, 200) + " was not saved. Only plain JSON data lasts between calls; use the page global for the page.");
        }
      }
      // Check the original value, not its toJSON() result: Playwright objects have toJSON().
      function copy(value, path) {
        if (value === null || typeof value === "string" || typeof value === "boolean") return value;
        if (typeof value === "number" && Number.isFinite(value)) return value;
        try {
          if (typeof value === "object" && seen.length < 64 && seen.indexOf(value) < 0) {
            var proto = Object.getPrototypeOf(value);
            if (Array.isArray(value)) {
              seen.push(value);
              var list = [];
              for (var i = 0; i < value.length; i++) {
                var item = copy(value[i], path + "[" + i + "]");
                list.push(item === undefined ? null : item);
              }
              seen.pop();
              return list;
            }
            if (proto === Object.prototype || proto === null) {
              seen.push(value);
              var out = {};
              for (var key of Object.keys(value)) {
                var field = copy(value[key], path + "." + key);
                if (field !== undefined) out[key] = field;
              }
              seen.pop();
              return out;
            }
          }
        } catch (e) {}
        drop(path);
        return undefined;
      }
      var json = null;
      try {
        var plain = copy(state, "state");
        json = JSON.stringify(plain && typeof plain === "object" && !Array.isArray(plain) ? plain : {});
      } catch (e) {
        warnings.push("state was not saved because it could not be read.");
      }
      if (json !== null && textEncoder.encode(json).length > ${snippet_executor_LIMITS.stateBytes}) {
        json = null;
        warnings.push("state was not saved because it is larger than ${snippet_executor_LIMITS.stateBytes} bytes. The previous state is kept.");
      }
      return { stateJson: json, stateWarnings: warnings };
    }
    function readViewport() {
      try {
        var size = page.viewportSize();
        if (size && typeof size.width === "number" && typeof size.height === "number") {
          return { width: size.width, height: size.height };
        }
      } catch (e) {}
      return null;
    }
    var browser;
    try {
      // The gate resolves this endpoint id through the trusted command bridge.
      var endpoint = "http://fake.host/v1/devtools/browser/" + input.endpointId + "?persistent=true&browser_binding=BROWSER";
      browser = await connect(endpoint);
      var contexts = browser.contexts();
      if (contexts.length !== 1) throw new Error("Unexpected browser contexts: " + contexts.length);
      var pages = contexts[0].pages();
      if (pages.length !== 1) throw new Error("Unexpected browser pages: " + pages.length);
      var page = pages[0];
      page.on("console", function (message) {
        try { pushBounded(consoleEntries, message.type() + ": " + message.text().slice(0, 500)); } catch (e) {}
      });
      page.on("pageerror", function (error) {
        try { pushBounded(pageErrors, String((error && error.message) || error).slice(0, 500)); } catch (e) {}
      });
      var runtimeOrigin = input.runtimeOrigin;
      function findOuter() {
        return page.mainFrame().childFrames().find(function (candidate) {
          try { return new URL(candidate.url()).origin === runtimeOrigin; } catch (e) { return false; }
        }) || null;
      }
      // Child frames attach after the fresh connection; poll briefly instead
      // of reading the tree once.
      async function waitForFrame(find, timeoutMs, label) {
        var deadline = Date.now() + timeoutMs;
        while (true) {
          var found = find();
          if (found) return found;
          if (Date.now() >= deadline) {
            var kids = [];
            try {
              kids = page.mainFrame().childFrames().map(function (candidate) {
                try { return candidate.name() + "|" + candidate.url(); } catch (e) { return "<unreadable>"; }
              });
            } catch (e) {}
            var mainUrl = "";
            try { mainUrl = page.mainFrame().url(); } catch (e) {}
            var domIframes = "?";
            try { domIframes = String(await page.evaluate("document.querySelectorAll('iframe').length")); } catch (e) {}
            throw new Error(label + " main=" + mainUrl + " kids=" + JSON.stringify(kids) + " domIframes=" + domIframes);
          }
          await new Promise(function (resolve) { setTimeout(resolve, 100); });
        }
      }
      var frame;
      if (input.mode !== "file") {
        frame = page.mainFrame();
      } else {
        var outer = await waitForFrame(findOuter, 10000, "Preview frame not found.");
        frame = await waitForFrame(function () {
          var kids = outer.childFrames();
          return kids.length === 1 ? kids[0] : null;
        }, 10000, "Preview content not ready.");
      }
      // The viewport is per-connection server-side: re-apply the session size
      // on every fresh connection before user code runs. The shared tab keeps the user's own size.
      if (input.mode !== "shared") {
        await page.setViewportSize({ width: input.viewport.width, height: input.viewport.height });
      }
      if (Date.now() >= softDeadline) {
        var late = new Error("Execution timed out");
        late.name = "TimeoutError";
        throw late;
      }
      var __result = await Promise.race([
        // A regular function called with undefined receiver: user code must
        // not inherit the entrypoint this value (which exposes the loader env).
        (async function __snippet(page, frame, expect, emitFile, state) {
`;

const EXECUTOR_SUFFIX = `
        }).call(undefined, page, frame, expect, emitFile, state),
        new Promise(function (_, reject) {
          timer = setTimeout(function () {
            var error = new Error("Execution timed out");
            error.name = "TimeoutError";
            reject(error);
          }, Math.max(0, softDeadline - Date.now()));
        }),
      ]);
      filesOpen = false;
      // The model often sends a whole function instead of its body. That code only defines the
      // function, so nothing runs. Say so instead of reporting an empty success.
      if (typeof __result === "function" || (__result === undefined && __SNIPPET_IS_FUNCTION__)) {
        return { ok: false, error: { name: "TypeError", message: "Your code returned a function. Write the function body only, do not wrap it in a function." }, consoleEntries: consoleEntries, pageErrors: pageErrors, logs: logs, logsTruncated: logsTruncated, ...saveState() };
      }
      var __resultJson;
      try {
        __resultJson = __result === undefined ? "null" : JSON.stringify(__result);
      } catch (e) {
        return { ok: false, error: { name: "TypeError", message: "Result is not JSON-serializable" }, consoleEntries: consoleEntries, pageErrors: pageErrors, logs: logs, logsTruncated: logsTruncated, ...saveState() };
      }
      if (typeof __resultJson !== "string") __resultJson = "null";
      return { ok: true, resultJson: __resultJson, files: files, viewport: readViewport(), popups: { blocked: 0, urls: [] }, consoleEntries: consoleEntries, pageErrors: pageErrors, logs: logs, logsTruncated: logsTruncated, ...saveState() };
    } catch (err) {
      var __name = err && err.name ? String(err.name) : "Error";
      var __message = err && err.message ? String(err.message) : String(err);
      // The soft limit only stops waiting. The host revokes the bridge, so the snippet cannot act
      // after this point even if it is still running.
      var __timedOut = __name === "TimeoutError" && __message === "Execution timed out";
      return { ok: false, ...(__timedOut ? { timedOut: true } : {}), error: { name: __name, message: __message }, viewport: readViewport(), popups: { blocked: 0, urls: [] }, consoleEntries: consoleEntries, pageErrors: pageErrors, logs: logs, logsTruncated: logsTruncated, ...saveState() };
    } finally {
      filesOpen = false;
      clearTimeout(timer);
      try { if (browser) await browser.close(); } catch (e) {}
    }
  }
}
`;

/**
 * True when the snippet is one function and nothing else, like `async ({ page }) => { ... }`.
 * Such code only defines the function, so it never runs. A named function that the code uses
 * again (a helper it calls) is fine.
 */
function snippet_is_function(code: string) {
	// Skip leading blank lines and comments.
	const start = code.replace(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u, "");
	if (/^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/u.test(start)) return true;
	const name = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/u.exec(start)?.[1];
	return name !== undefined && start.split(/[^\w$]+/u).filter((word) => word === name).length === 1;
}

export function build_executor_module(user_code: string): string {
	return (
		EXECUTOR_PREFIX +
		user_code +
		EXECUTOR_SUFFIX.replace("__SNIPPET_IS_FUNCTION__", String(snippet_is_function(user_code)))
	);
}

/**
 * Shorten an error message before it leaves the runner. Drop URL query and fragment: page URLs can
 * carry tokens, and this text reaches Convex.
 */
export function snippet_executor_cap_message(message: string): string {
	const text = message.replace(/(https?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/giu, "$1");
	return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

/**
 * Check the `state` JSON a snippet returned. The isolate is not trusted, so check the size before
 * parsing and accept only a plain JSON object. Returns null when nothing may be saved.
 */
export function snippet_executor_check_state(value: unknown) {
	if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > snippet_executor_LIMITS.stateBytes)
		return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? value : null;
	} catch {
		return null;
	}
}

/**
 * Check the `state` warnings a snippet returned. They are shown to the model, so keep them short.
 */
export function snippet_executor_check_state_warnings(value: unknown) {
	return Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === "string")
				.slice(0, snippet_executor_LIMITS.stateWarnings)
				.map((item) => item.slice(0, 400))
		: [];
}

/**
 * The Worker Loader modules for one snippet run.
 */
export function snippet_executor_modules(user_code: string) {
	return { [SNIPPET_EXECUTOR_MAIN_MODULE]: build_executor_module(user_code), [BUNDLE_MODULE]: CHILD_BUNDLE_JS };
}
