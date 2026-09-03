(() => {
	const VERSION = "0.6.5";
	const SKILL_DIR = ".agents/skills/app-playwriter-harness";
	/** Somewhere harmless to move the pointer from, so the next move has a non-zero screen delta. */
	const HOVERCARD_PARK_POINT = { x: 900, y: 500 };
	const MEMORY_FILES = new Set([
		"agent-panel.md",
		"app-map.md",
		"files.md",
		"known-hazards.md",
		"snippets.md",
	]);

	function getHarnessPage() {
		const pinned = state.appPlaywriterHarness?.page;

		// `bindOpenTab` sets both, so a disagreement means something else moved `state.page` — usually a
		// fresh `context.newPage()`. The pinned tab still wins, since surviving that is the point of
		// pinning, but saying so out loud stops a whole session from observing the wrong tab in silence.
		if (pinned && state.page && state.page !== pinned && !pinned.isClosed?.() && !state.page.isClosed?.()) {
			console.log(
				`[harness] state.page (${state.page.url()}) is not the bound tab (${pinned.url()}); using the bound tab. Call bindOpenTab to move.`,
			);
		}

		return [pinned, state.page, page].find((candidate) => candidate && !candidate.isClosed?.()) || page;
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
				showDiffSinceLastCall: false,
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

	async function latestLogs({ search = /error|warn|fail/i, count = 30, sinceLastCall = true } = {}) {
		const targetPage = getHarnessPage();
		const logs = await getLatestLogs({ page: targetPage, search, count, sinceLastCall });
		console.log(logs);
		return logs;
	}

	async function authSummary() {
		const targetPage = getHarnessPage();
		const result = await targetPage.evaluate(async () => {
			const clerk = window.Clerk;
			let hasToken = false;
			if (clerk?.session?.getToken) {
				const token = await clerk.session.getToken({ template: "convex" }).catch(() => null);
				hasToken = Boolean(token);
			}

			return {
				hasClerk: Boolean(clerk),
				hasSession: Boolean(clerk?.session),
				hasToken,
				hasAnonymousUserId: localStorage.getItem("app::auth::anonymous_token_user_id") !== null,
				hasAnonymousToken: localStorage.getItem("app::auth::anonymous_token") !== null,
			};
		});

		console.log(JSON.stringify(result, null, 2));
		return result;
	}

	async function waitForUrlIncludes({ urlIncludes, timeout = 10000 } = {}) {
		if (!urlIncludes) {
			throw new Error("waitForUrlIncludes requires urlIncludes");
		}

		const targetPage = getHarnessPage();
		await targetPage.waitForURL((url) => url.href.includes(urlIncludes), { timeout });
		const result = { url: targetPage.url(), matched: urlIncludes };
		console.log(JSON.stringify(result, null, 2));
		return result;
	}

	async function observeRoute({ label = "route", search } = {}) {
		const targetPage = getHarnessPage();
		const content = await snapshot({
			page: targetPage,
			search,
			showDiffSinceLastCall: false,
		});
		const logs = await getLatestLogs({ page: targetPage, count: 50, sinceLastCall: true });
		const result = {
			label,
			url: targetPage.url(),
			title: await targetPage.title().catch(() => ""),
			observedAt: new Date().toISOString(),
			logs,
			content: String(content).slice(0, 2000),
		};
		console.log(JSON.stringify(
			{
				label: result.label,
				url: result.url,
				title: result.title,
				observedAt: result.observedAt,
				logCount: logs.length,
			},
			null,
			2,
		));
		console.log(content);
		return result;
	}

	/**
	 * Opens an Ariakit hovercard (`MyHovercardAction`) and reports whether its card became visible.
	 *
	 * Parks the pointer before hovering. Ariakit only opens the card while its global `mouseMoving`
	 * flag is set, and that flag comes from `event.movementX || event.screenX - previousScreenX`.
	 * CDP mouse events always report `movementX: 0`, so a move to the coordinates the pointer already
	 * occupies reads as no movement and the card stays shut. Moving from elsewhere guarantees a
	 * non-zero delta. `mousedown`, `mouseup`, `keydown` and `scroll` reset the flag, so hovering
	 * straight after typing needs the same treatment.
	 *
	 * Pass `card` to wait for the portalled content. Scope follow-up clicks to that selector: the same
	 * action is often rendered a second time outside the portal inside a `hidden` container, and a
	 * bare `.first()` picks the hidden copy.
	 */
	async function hoverCard({ anchor, card, timeout = 5000 } = {}) {
		if (!anchor) {
			throw new Error("hoverCard requires anchor");
		}

		const targetPage = getHarnessPage();
		const anchorLocator = targetPage.locator(anchor).first();
		await anchorLocator.waitFor({ state: "visible", timeout });

		await targetPage.mouse.move(HOVERCARD_PARK_POINT.x, HOVERCARD_PARK_POINT.y);
		await anchorLocator.hover({ timeout });

		let cardVisible = null;
		if (card) {
			cardVisible = await targetPage
				.locator(card)
				.first()
				.waitFor({ state: "visible", timeout })
				.then(() => true)
				.catch(() => false);
		}

		const result = { anchor, card: card || null, cardVisible };
		console.log(JSON.stringify(result, null, 2));
		return result;
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

	// Pass `frame` to screen inside an iframe. A cross-origin frame runs in its own process, so an
	// audit evaluated on the top page sees nothing inside it and reports a clean route that was never
	// looked at. A Playwright Frame takes the same `waitForSelector` and `evaluate` calls as a Page,
	// so it can stand in for the page unchanged.
	async function auditAccessibility({ selector = "body", minTargetSize = 24, frame = null } = {}) {
		const target = frame ?? getHarnessPage();
		await target.waitForSelector(selector, { state: "attached", timeout: 15000 });

		const result = await target.evaluate(
			({ selector, minTargetSize }) => {
				const root = document.querySelector(selector);
				if (!root) {
					throw new Error(`Could not find element: ${selector}`);
				}

				// Roles that never take their accessible name from their own text. A combobox showing the
				// option it currently holds looks named in the DOM, yet reaches a screen reader with no
				// name at all, so the text fallback below has to stop short of them.
				const NAME_FROM_CONTENT_FORBIDDEN = new Set([
					"combobox",
					"listbox",
					"textbox",
					"searchbox",
					"spinbutton",
					"slider",
					"progressbar",
				]);

				function accessibleName(element) {
					const ariaLabel = element.getAttribute("aria-label");
					if (ariaLabel?.trim()) return ariaLabel.trim();
					const labelledBy = element.getAttribute("aria-labelledby");
					if (labelledBy) {
						const text = labelledBy
							.split(/\s+/)
							.map((id) => document.getElementById(id)?.textContent?.trim() || "")
							.join(" ")
							.trim();
						if (text) return text;
					}
					if (element.labels?.length) {
						const text = Array.from(element.labels)
							.map((label) => label.textContent?.trim() || "")
							.join(" ")
							.trim();
						if (text) return text;
					}
					const title = element.getAttribute("title");
					if (title?.trim()) return title.trim();
					if (NAME_FROM_CONTENT_FORBIDDEN.has(element.getAttribute("role"))) return "";
					return element.textContent?.trim().replace(/\s+/g, " ") || "";
				}

				function describeControl(element) {
					return {
						tag: element.tagName.toLowerCase(),
						id: element.id || null,
						className: typeof element.className === "string" ? element.className.slice(0, 120) : "",
						role: element.getAttribute("role"),
						name: accessibleName(element).slice(0, 80),
						placeholder: element.getAttribute("placeholder"),
					};
				}

				function isVisible(element) {
					// Check ancestors too. A control inside a closed <details> element can still have
					// a non-zero rectangle, which would create false hit-target findings below.
					if (typeof element.checkVisibility === "function" && !element.checkVisibility()) return false;
					const style = getComputedStyle(element);
					if (style.display === "none" || style.visibility === "hidden") return false;
					const rect = element.getBoundingClientRect();
					return rect.width > 0 && rect.height > 0;
				}

				const INTERACTIVE_ROLES = new Set(["button", "link", "menuitem", "tab", "checkbox", "radio"]);

				// An element that matched only through [tabindex] and holds a negative value is a
				// programmatic focus target (tooltip anchor, scroll container), not a control any
				// assistive tech announces. Auditing those as controls flooded `unlabeled` with one
				// false positive per sidebar row (harness 0.6.2).
				function isAuditableControl(element) {
					const tag = element.tagName.toLowerCase();
					if (tag === "button" || tag === "select" || tag === "textarea") return true;
					if (tag === "a" && element.hasAttribute("href")) return true;
					if (tag === "input") return true;
					if (INTERACTIVE_ROLES.has(element.getAttribute("role"))) return true;
					return element.tabIndex >= 0;
				}

				const controls = Array.from(
					root.querySelectorAll(
						"button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=radio], [tabindex]",
					),
				).filter(
					(element) =>
						isAuditableControl(element) && isVisible(element) && !element.closest("[aria-hidden=true], [inert]"),
				);

				const unlabeled = [];
				const blockedHitTargets = [];
				const smallTargets = [];
				const negativeTabIndex = [];

				for (const element of controls) {
					const described = describeControl(element);
					const rect = element.getBoundingClientRect();

					if (!accessibleName(element)) {
						unlabeled.push(described);
					}

					if (rect.width < minTargetSize || rect.height < minTargetSize) {
						smallTargets.push({ ...described, width: Math.round(rect.width), height: Math.round(rect.height) });
					}

					const inViewport =
						rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
					if (inViewport) {
						// Sample the corners as well as the centre. Testing only the centre missed every control
						// whose EDGE was covered while its middle stayed clear, and Playwright still refuses that
						// click. Run against the room at 600x400 with a live pointer-target defect on screen, the
						// centre-only test answered `blockedHitTargets: []` — a clean pass at the exact moment the
						// browser was blocking the click.
						// `topAtCenter` keeps its old meaning: the element covering the centre, or null when only
						// an edge is covered. Read `blockedPoints` to tell a fully covered control from a partly
						// covered one.
						const inset = Math.min(3, rect.width / 2, rect.height / 2);
						const samples = [
							{ point: "center", x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
							{ point: "top-left", x: rect.x + inset, y: rect.y + inset },
							{ point: "top-right", x: rect.right - inset, y: rect.y + inset },
							{ point: "bottom-left", x: rect.x + inset, y: rect.bottom - inset },
							{ point: "bottom-right", x: rect.right - inset, y: rect.bottom - inset },
						];
						const blockedPoints = [];
						let topAtCenter = null;
						for (const sample of samples) {
							// A sample outside the window has no element under it, and elementFromPoint answers
							// null there. That is a control scrolled or clipped out of view, not a covered one,
							// so skip the point instead of counting it as blocked.
							if (sample.x < 0 || sample.y < 0 || sample.x >= window.innerWidth || sample.y >= window.innerHeight) {
								continue;
							}
							const top = document.elementFromPoint(sample.x, sample.y);
							if (!top || top === element || element.contains(top) || top.contains(element)) {
								continue;
							}
							const describedTop = describeControl(top);
							if (sample.point === "center") {
								topAtCenter = describedTop;
							}
							blockedPoints.push({ point: sample.point, top: describedTop });
						}
						if (blockedPoints.length > 0) {
							blockedHitTargets.push({ ...described, topAtCenter, blockedPoints });
						}
					}

					// Inside a composite widget (tree, menu, listbox, ...) a negative tabindex on every
					// non-active item IS the correct roving-tabindex pattern, so reporting those items
					// buried the review list under hundreds of correct rows.
					const inRovingComposite = element.closest(
						"[role=tree], [role=menu], [role=menubar], [role=listbox], [role=tablist], [role=grid], [role=radiogroup]",
					);
					if (
						element.tabIndex < 0 &&
						!element.disabled &&
						element.getAttribute("aria-hidden") !== "true" &&
						!inRovingComposite
					) {
						negativeTabIndex.push(described);
					}
				}

				return {
					url: location.href,
					selector,
					controlCount: controls.length,
					unlabeled,
					blockedHitTargets,
					smallTargets,
					negativeTabIndex,
				};
			},
			{ selector, minTargetSize },
		);

		console.log(JSON.stringify(result, null, 2));
		return result;
	}

	function proposeMemory({ file = "known-hazards.md", title, body }) {
		const normalizedFile = String(file).replace(/^references[\\/]/, "");
		if (!MEMORY_FILES.has(normalizedFile)) {
			throw new Error(`Unsupported memory file: ${file}`);
		}

		if (!title || !body) {
			throw new Error("proposeMemory requires title and body");
		}

		const bodyText = String(body).trim();
		if (/(authorization|bearer\s+[a-z0-9._-]+|cookie|password|secret|token)/i.test(bodyText)) {
			throw new Error("Memory body looks like it may contain a secret; summarize without sensitive values");
		}

		const filePath = `${SKILL_DIR}/references/${normalizedFile}`;
		const entry = `## ${String(title).trim()}\n\n${bodyText}`;
		const result = { file: filePath, entry };
		console.log(JSON.stringify(result, null, 2));
		return result;
	}

	state.appPlaywriterHarness = {
		version: VERSION,
		// Do NOT fall back to the shared `page` here. Installing the harness before you open your
		// own tab would pin whatever tab happened to be in front — usually the user's — and every
		// later observation would silently read that tab instead of yours. With no fallback,
		// `getHarnessPage` resolves `state.page` at call time and follows the tab you actually made.
		// `bindOpenTab` still pins on purpose when you want pinning.
		page: state.appPlaywriterHarness?.page || state.t3ChatHarness?.page || state.page || null,
		boundUrl: state.appPlaywriterHarness?.boundUrl || state.t3ChatHarness?.boundUrl,
		observations: state.appPlaywriterHarness?.observations || state.t3ChatHarness?.observations || [],
		tabs,
		bindOpenTab,
		observe,
		latestLogs,
		authSummary,
		waitForUrlIncludes,
		observeRoute,
		hoverCard,
		hitTest,
		inspectElement,
		auditAccessibility,
		proposeMemory,
	};

	state.t3ChatHarness = state.appPlaywriterHarness;

	console.log(`Installed state.appPlaywriterHarness ${VERSION}`);
})();
