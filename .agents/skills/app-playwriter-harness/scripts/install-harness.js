(() => {
	const fs = require("node:fs");
	const path = require("node:path");

	const VERSION = "0.2.1";
	const SKILL_DIR = ".agents/skills/app-playwriter-harness";
	const MEMORY_FILES = new Set([
		"app-map.md",
		"files.md",
		"known-hazards.md",
		"snippets.md",
	]);

	function getHarnessPage() {
		return state.appPlaywriterHarness?.page || state.page || page;
	}

	async function tabs() {
		const browserTabs = context.pages();
		const rows = [];

		for (let index = 0; index < browserTabs.length; index += 1) {
			const browserPage = browserTabs[index];
			let title = "";

			try {
				title = await browserPage.title();
			} catch (error) {
				title = `[title unavailable: ${error?.message || String(error)}]`;
			}

			rows.push({
				index,
				url: browserPage.url(),
				title,
				isStatePage: browserPage === state.page,
				isHarnessPage: browserPage === state.appPlaywriterHarness?.page,
			});
		}

		console.log(JSON.stringify(rows, null, 2));
		return rows;
	}

	async function bindOpenTab({ urlIncludes, exactUrl } = {}) {
		const browserTabs = context.pages();
		const match = browserTabs.find((browserPage) => {
			const url = browserPage.url();
			if (exactUrl) return url === exactUrl;
			if (urlIncludes) return url.includes(urlIncludes);
			return url !== "about:blank";
		});

		if (!match) {
			const available = browserTabs.map((browserPage, index) => ({
				index,
				url: browserPage.url(),
			}));
			console.log("No matching Playwriter-enabled tab found.");
			console.log(JSON.stringify(available, null, 2));
			throw new Error("No matching Playwriter-enabled tab found");
		}

		state.page = match;
		state.appPlaywriterHarness.page = match;
		state.appPlaywriterHarness.boundUrl = match.url();

		await match.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);

		const title = await match.title().catch(() => "");
		const result = { url: match.url(), title };
		console.log(JSON.stringify(result, null, 2));
		return result;
	}

	async function observe({ label = "observation", search, locator } = {}) {
		const targetPage = getHarnessPage();
		const result = {
			label,
			url: targetPage.url(),
			title: await targetPage.title().catch(() => ""),
			observedAt: new Date().toISOString(),
		};

		let content;
		if (locator) {
			content = await getCleanHTML({
				locator: targetPage.locator(locator).first(),
				showDiffSinceLastCall: false,
			});
		} else {
			content = await snapshot({
				page: targetPage,
				search,
				showDiffSinceLastCall: search ? false : false,
			});
		}

		state.appPlaywriterHarness.observations.push({
			...result,
			search: search ? String(search) : undefined,
			locator,
			content: String(content).slice(0, 2000),
		});

		console.log(JSON.stringify(result, null, 2));
		console.log(content);
		return { ...result, content };
	}

	async function latestLogs({ search = /error|warn|fail/i, count = 30 } = {}) {
		const targetPage = getHarnessPage();
		const logs = await getLatestLogs({ page: targetPage, search, count });
		console.log(logs);
		return logs;
	}

	async function hitTest({ x, y }) {
		const targetPage = getHarnessPage();
		const result = await targetPage.evaluate(
			({ x, y }) => {
				const top = document.elementFromPoint(x, y);
				const hit = {
					point: { x, y },
					top: describeElement(top),
					path: describePath(top),
					viewport: {
						innerWidth: window.innerWidth,
						innerHeight: window.innerHeight,
						devicePixelRatio: window.devicePixelRatio,
					},
					scroll: {
						x: Math.round(window.scrollX),
						y: Math.round(window.scrollY),
					},
				};

				function describeElement(element) {
					if (!element) return null;

					const style = window.getComputedStyle(element);
					const rect = element.getBoundingClientRect();
					const label =
						element.getAttribute("aria-label") ||
						element.getAttribute("title") ||
						element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ||
						"";

					return {
						tag: element.tagName.toLowerCase(),
						id: element.id || null,
						className: typeof element.className === "string" ? element.className : "",
						role: element.getAttribute("role"),
						ariaLabel: element.getAttribute("aria-label"),
						href: element.getAttribute("href"),
						label,
						rect: {
							x: Math.round(rect.x),
							y: Math.round(rect.y),
							width: Math.round(rect.width),
							height: Math.round(rect.height),
						},
						style: {
							display: style.display,
							visibility: style.visibility,
							overflowX: style.overflowX,
							overflowY: style.overflowY,
							pointerEvents: style.pointerEvents,
							position: style.position,
							zIndex: style.zIndex,
							opacity: style.opacity,
						},
						scroll: {
							left: Math.round(element.scrollLeft),
							top: Math.round(element.scrollTop),
							width: element.scrollWidth,
							height: element.scrollHeight,
							clientWidth: element.clientWidth,
							clientHeight: element.clientHeight,
							canScrollX: element.scrollWidth > element.clientWidth,
							canScrollY: element.scrollHeight > element.clientHeight,
						},
						inert: element.inert === true || element.hasAttribute("inert"),
						ariaHidden: element.getAttribute("aria-hidden"),
					};
				}

				function describePath(element) {
					const path = [];
					let current = element;

					while (current && path.length < 8) {
						path.push(describeElement(current));
						const root = current.getRootNode?.();
						current = current.parentElement || root?.host || null;
					}

					return path;
				}

				return hit;
			},
			{ x, y },
		);

		console.log(JSON.stringify(result, null, 2));
		return result;
	}

	async function inspectElement({
		selector,
		attribute,
		actionSelector,
		computedStyles = [],
		hitTargets = [],
		localStorageKeys = [],
	} = {}) {
		if (!selector) {
			throw new Error("inspectElement requires selector");
		}

		const targetPage = getHarnessPage();
		await targetPage.waitForSelector(selector, { state: "attached", timeout: 15000 });

		const result = await targetPage.evaluate(
			({ selector, attribute, actionSelector, computedStyles, hitTargets, localStorageKeys }) => {
				const candidates = Array.from(document.querySelectorAll(selector));
				const root = attribute
					? candidates.find((element) => element.getAttribute(attribute.name) === attribute.value)
					: candidates[0];

				if (!root) {
					throw new Error(`Could not find element: ${selector}`);
				}

				function describeElement(element) {
					if (!element) return null;

					const style = window.getComputedStyle(element);
					const rect = element.getBoundingClientRect();
					const label =
						element.getAttribute("aria-label") ||
						element.getAttribute("title") ||
						element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ||
						"";

					return {
						tag: element.tagName.toLowerCase(),
						id: element.id || null,
						className: typeof element.className === "string" ? element.className : "",
						role: element.getAttribute("role"),
						ariaLabel: element.getAttribute("aria-label"),
						href: element.getAttribute("href"),
						label,
						rect: {
							x: Math.round(rect.x),
							y: Math.round(rect.y),
							width: Math.round(rect.width),
							height: Math.round(rect.height),
						},
						style: {
							display: style.display,
							visibility: style.visibility,
							overflowX: style.overflowX,
							overflowY: style.overflowY,
							pointerEvents: style.pointerEvents,
							position: style.position,
							zIndex: style.zIndex,
							opacity: style.opacity,
						},
						scroll: {
							left: Math.round(element.scrollLeft),
							top: Math.round(element.scrollTop),
							width: element.scrollWidth,
							height: element.scrollHeight,
							clientWidth: element.clientWidth,
							clientHeight: element.clientHeight,
							canScrollX: element.scrollWidth > element.clientWidth,
							canScrollY: element.scrollHeight > element.clientHeight,
						},
						inert: element.inert === true || element.hasAttribute("inert"),
						ariaHidden: element.getAttribute("aria-hidden"),
					};
				}

				function describePath(element) {
					const path = [];
					let current = element;

					while (current && path.length < 8) {
						path.push(describeElement(current));
						const root = current.getRootNode?.();
						current = current.parentElement || root?.host || null;
					}

					return path;
				}

				function centerOf(rect) {
					return {
						x: Math.round(rect.x + rect.width / 2),
						y: Math.round(rect.y + rect.height / 2),
					};
				}

				const actions = actionSelector ? Array.from(root.querySelectorAll(actionSelector)) : [];
				const actionResults = actions.map((action, index) => {
					const rect = action.getBoundingClientRect();
					const center = centerOf(rect);
					const top = document.elementFromPoint(center.x, center.y);
					const hitInsideAction = top === action || action.contains(top);

					return {
						index,
						action: describeElement(action),
						center,
						topAtCenter: describeElement(top),
						topPathAtCenter: describePath(top),
						hitInsideAction,
					};
				});

				const computedStyleResults = computedStyles.map(({ name, selector: styleSelector, properties }) => {
					const element = styleSelector ? root.querySelector(styleSelector) : root;
					const style = element ? getComputedStyle(element) : null;

					return {
						name,
						selector: styleSelector || null,
						element: describeElement(element),
						style: style
							? Object.fromEntries((properties || []).map((property) => [property, style[property]]))
							: null,
					};
				});

				const hitTargetResults = hitTargets.map(({ name, selector: hitSelector }) => {
					const element = hitSelector ? root.querySelector(hitSelector) : root;
					if (!element) {
						return { name, selector: hitSelector || null, element: null, center: null, topAtCenter: null };
					}

					const center = centerOf(element.getBoundingClientRect());
					const top = document.elementFromPoint(center.x, center.y);

					return {
						name,
						selector: hitSelector || null,
						element: describeElement(element),
						center,
						topAtCenter: describeElement(top),
						topPathAtCenter: describePath(top),
						hitInsideElement: top === element || element.contains(top),
					};
				});

				const localStorageValues = Object.fromEntries(
					(localStorageKeys || []).map((key) => [key, localStorage.getItem(key)]),
				);

				return {
					url: location.href,
					title: document.title,
					selector,
					attribute,
					viewport: {
						innerWidth: window.innerWidth,
						innerHeight: window.innerHeight,
						devicePixelRatio: window.devicePixelRatio,
					},
					localStorage: localStorageValues,
					element: describeElement(root),
					actions: actionResults,
					computedStyles: computedStyleResults,
					hitTargets: hitTargetResults,
				};
			},
			{ selector, attribute, actionSelector, computedStyles, hitTargets, localStorageKeys },
		);

		console.log(JSON.stringify(result, null, 2));
		return result;
	}

	function appendMemory({ file = "known-hazards.md", title, body }) {
		const normalizedFile = String(file).replace(/^references[\\/]/, "");
		if (!MEMORY_FILES.has(normalizedFile)) {
			throw new Error(`Unsupported memory file: ${file}`);
		}

		if (!title || !body) {
			throw new Error("appendMemory requires title and body");
		}

		const bodyText = String(body).trim();
		if (/(authorization|bearer\s+[a-z0-9._-]+|cookie|password|secret|token)/i.test(bodyText)) {
			throw new Error("Memory body looks like it may contain a secret; summarize without sensitive values");
		}

		const targetPath = path.join(SKILL_DIR, "references", normalizedFile);
		const entry = `\n\n## ${String(title).trim()}\n\n${bodyText}\n`;
		fs.appendFileSync(targetPath, entry, "utf8");
		console.log(`Appended memory to ${targetPath}`);
		return { file: targetPath, title: String(title).trim() };
	}

	state.appPlaywriterHarness = {
		version: VERSION,
		page: state.appPlaywriterHarness?.page || state.t3ChatHarness?.page || state.page || page,
		boundUrl: state.appPlaywriterHarness?.boundUrl || state.t3ChatHarness?.boundUrl,
		observations: state.appPlaywriterHarness?.observations || state.t3ChatHarness?.observations || [],
		tabs,
		bindOpenTab,
		observe,
		latestLogs,
		hitTest,
		inspectElement,
		appendMemory,
	};

	state.t3ChatHarness = state.appPlaywriterHarness;

	console.log(`Installed state.appPlaywriterHarness ${VERSION}`);
})();
