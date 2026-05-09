(() => {
	const fs = require("node:fs");
	const path = require("node:path");

	const VERSION = "0.1.0";
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
							pointerEvents: style.pointerEvents,
							position: style.position,
							zIndex: style.zIndex,
							opacity: style.opacity,
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

	async function inspectLeftNav() {
		const targetPage = getHarnessPage();
		const result = await targetPage.evaluate(() => {
			const nav = document.querySelector('[aria-label="Main navigation"]');
			const sidebar = nav?.closest(".MainAppSidebar, .MySidebar") || document.querySelector(".MainAppSidebar");
			const actions = Array.from(nav?.querySelectorAll('a, button, [role="link"], [role="button"]') || []);

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
						pointerEvents: style.pointerEvents,
						position: style.position,
						zIndex: style.zIndex,
						opacity: style.opacity,
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

			const localStorageKeys = [
				"app_state::sidebar::main_app_open",
				"app_state::sidebar::main_app_collapsed",
			];

			const localStorageValues = Object.fromEntries(
				localStorageKeys.map((key) => [key, localStorage.getItem(key)]),
			);

			const navActions = actions.map((action, index) => {
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

			return {
				url: location.href,
				title: document.title,
				viewport: {
					innerWidth: window.innerWidth,
					innerHeight: window.innerHeight,
					devicePixelRatio: window.devicePixelRatio,
				},
				localStorage: localStorageValues,
				sidebar: describeElement(sidebar),
				nav: describeElement(nav),
				navActions,
			};
		});

		console.log(JSON.stringify(result, null, 2));
		return result;
	}

	async function testFilesFolderCreateFlow({ cleanup = true } = {}) {
		const targetPage = getHarnessPage();
		const pagesBefore = context.pages().length;
		const qaName = `aaa-pw-qa-${Date.now().toString(36).slice(-6)}`;
		const results = [];

		function ok(name, data = {}) {
			results.push({ name, ok: true, ...data });
		}

		async function assert(condition, message) {
			if (!condition) throw new Error(message);
		}

		await targetPage.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
		await assert(targetPage.url().includes("/files"), "Expected the bound page to be on the files route");
		await assert(pagesBefore === 1, "Expected exactly one Playwriter-enabled tab before the test");
		ok("single tab before", { pages: pagesBefore, url: targetPage.url() });

		await targetPage.getByRole("button", { name: "New folder in current folder" }).click();
		const folderInput = targetPage.getByRole("textbox", { name: "Name" });
		await folderInput.waitFor({ state: "visible", timeout: 5000 });
		const folderDefault = await folderInput.inputValue();
		const folderSelection = await folderInput.evaluate((element) => ({
			start: element.selectionStart,
			end: element.selectionEnd,
			value: element.value,
		}));
		await assert(
			/^new-folder(?:-\d+)?$/.test(folderDefault),
			"Expected folder default name to be new-folder or an incremented variant",
		);
		await assert(
			folderSelection.start === 0 && folderSelection.end === folderDefault.length,
			"Expected the whole folder name to be selected",
		);
		ok("new folder modal default selection", { folderDefault, folderSelection });

		const parentFolderUrl = targetPage.url();
		await folderInput.fill(qaName);
		await targetPage.getByRole("button", { name: "Create folder" }).click();
		await targetPage
			.getByRole("button", { name: "Create folder" })
			.waitFor({ state: "detached", timeout: 10000 })
			.catch(async () => {
				await targetPage.getByRole("button", { name: "Create folder" }).waitFor({ state: "hidden", timeout: 10000 });
			});
		await targetPage.getByRole("link", { name: `Open ${qaName}` }).waitFor({ state: "visible", timeout: 15000 });
		await assert(targetPage.url() === parentFolderUrl, "Creating a folder should not navigate");
		ok("folder create did not navigate", { before: parentFolderUrl, after: targetPage.url() });

		await targetPage.getByRole("link", { name: `Open ${qaName}` }).click();
		await targetPage.waitForURL((url) => url.searchParams.get("nodeId") !== "root", { timeout: 10000 });
		const qaFolderUrl = targetPage.url();
		ok("navigated to qa folder", { qaFolderUrl });

		await targetPage.getByRole("toolbar", { name: "Folder actions" }).waitFor({ state: "visible", timeout: 10000 });
		await targetPage.getByRole("button", { name: "New file in current folder" }).waitFor({
			state: "visible",
			timeout: 10000,
		});
		await targetPage.getByRole("button", { name: "New folder in current folder" }).waitFor({
			state: "visible",
			timeout: 10000,
		});
		ok("empty folder toolbar is accessible", {
			toolbarActions: ["New file in current folder", "New folder in current folder"],
		});

		await targetPage.getByRole("button", { name: "New file in current folder" }).click();
		const fileInput = targetPage.getByRole("textbox", { name: "Name" });
		await fileInput.waitFor({ state: "visible", timeout: 5000 });
		const fileDefault = await fileInput.inputValue();
		const fileSelection = await fileInput.evaluate((element) => ({
			start: element.selectionStart,
			end: element.selectionEnd,
			value: element.value,
		}));
		await assert(
			/^new-file(?:-\d+)?\.md$/.test(fileDefault),
			"Expected file default name to be new-file.md or an incremented variant",
		);
		await assert(
			fileSelection.start === 0 && fileSelection.end === fileDefault.length - ".md".length,
			"Expected only the file basename to be selected",
		);
		ok("new file modal default selection", { fileDefault, fileSelection });

		const deepFilePath = "deep/path/example.md";
		await fileInput.fill(deepFilePath);
		await targetPage.getByRole("button", { name: "Create file" }).click();
		await targetPage
			.getByRole("button", { name: "Create file" })
			.waitFor({ state: "detached", timeout: 10000 })
			.catch(async () => {
				await targetPage.getByRole("button", { name: "Create file" }).waitFor({ state: "hidden", timeout: 10000 });
			});
		await targetPage.getByRole("link", { name: "Open deep" }).waitFor({ state: "visible", timeout: 15000 });
		await assert(targetPage.url() === qaFolderUrl, "Creating a deep file should not navigate");
		ok("deep file create did not navigate and created top folder row", {
			before: qaFolderUrl,
			after: targetPage.url(),
			row: "deep",
		});

		await targetPage.getByRole("button", { name: "New file in current folder" }).click();
		const duplicateFileInput = targetPage.getByRole("textbox", { name: "Name" });
		await duplicateFileInput.waitFor({ state: "visible", timeout: 5000 });
		await duplicateFileInput.fill(deepFilePath);
		await targetPage.getByText("This file already exists.").waitFor({ state: "visible", timeout: 5000 });
		const createFileDisabled = await targetPage.getByRole("button", { name: "Create file" }).isDisabled();
		await assert(createFileDisabled, "Expected duplicate file submit to be disabled");
		ok("duplicate deep file validation", { message: "This file already exists.", createFileDisabled });
		await targetPage.getByRole("button", { name: "Cancel" }).click();

		await targetPage.getByRole("button", { name: "New folder in current folder" }).click();
		const duplicateFolderInput = targetPage.getByRole("textbox", { name: "Name" });
		await duplicateFolderInput.waitFor({ state: "visible", timeout: 5000 });
		await duplicateFolderInput.fill("deep/path");
		await targetPage.getByText("This folder already exists.").waitFor({ state: "visible", timeout: 5000 });
		const createFolderDisabled = await targetPage.getByRole("button", { name: "Create folder" }).isDisabled();
		await assert(createFolderDisabled, "Expected duplicate folder submit to be disabled");
		ok("duplicate deep folder validation", { message: "This folder already exists.", createFolderDisabled });
		await targetPage.getByRole("button", { name: "Cancel" }).click();

		if (cleanup) {
			await targetPage.goto(parentFolderUrl, { waitUntil: "domcontentloaded" });
			await targetPage
				.locator(".FileNodeViewFolderExplorer")
				.getByRole("button", { name: `More actions for ${qaName}` })
				.click();
			await targetPage.getByRole("menuitem", { name: "Archive" }).click();
			await targetPage.getByRole("link", { name: `Open ${qaName}` }).waitFor({ state: "detached", timeout: 10000 });
			ok("cleanup archived qa folder", { qaName });
		}

		const pagesAfter = context.pages().length;
		await assert(pagesAfter === pagesBefore, "The test opened a new tab");
		ok("single tab after", { pages: pagesAfter });

		const result = { qaName, cleanup, results };
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
		...(state.appPlaywriterHarness || state.t3ChatHarness || {}),
		version: VERSION,
		page: state.appPlaywriterHarness?.page || state.t3ChatHarness?.page || state.page || page,
		boundUrl: state.appPlaywriterHarness?.boundUrl || state.t3ChatHarness?.boundUrl,
		observations: state.appPlaywriterHarness?.observations || state.t3ChatHarness?.observations || [],
		tabs,
		bindOpenTab,
		observe,
		latestLogs,
		hitTest,
		inspectLeftNav,
		testFilesFolderCreateFlow,
		appendMemory,
	};

	state.t3ChatHarness = state.appPlaywriterHarness;

	console.log(`Installed state.appPlaywriterHarness ${VERSION}`);
})();
