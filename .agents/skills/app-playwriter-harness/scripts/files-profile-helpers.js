// Reusable Files timing helpers stored on state.qa.filesProfile.
// Load this file with Playwriter -f, then call install({ page, outputPath }).
// The output must be in an existing <project>-+personal/+ai/<run>/ folder.
// Arm with safe caseId/scenario labels, eventType, startSelector, and doneExpression.
// Use mainFunction to scope refused replies; the default scope is files_* functions.
// Only allowUntrustedChange with eventType="change" admits the browser File fallback.
// Native events start the clock. The caller must check exact completion and restore state.
// validSetup checks timing conditions. It does not prove the final saved state.
// CDP sizes are UTF-8 message bytes, not compressed wire bytes. Frame callbacks are not paint.
// Long tasks do not identify CPU functions. Server time-window matches stay inferred.
state.qa = state.qa ?? {};
state.qa.filesProfile = state.qa.filesProfile ?? (() => {
	const fs = require("node:fs");
	const path = require("node:path");
	let run = null;

	function checkOutputPath(outputPath) {
		if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
			throw new Error("Files profile output needs an absolute path");
		}
		const absolute = path.resolve(outputPath);
		const parent = fs.realpathSync(path.dirname(absolute));
		const parts = parent.replaceAll("\\", "/").split("/");
		const personal = parts.findIndex((part, index) => part.endsWith("-+personal") && parts[index + 1] === "+ai");
		if (personal < 0 || !parts[personal + 2] || !fs.statSync(parent).isDirectory()) {
			throw new Error("Files profile output must be inside an existing personal +ai run folder");
		}
		if (fs.existsSync(absolute) && (fs.lstatSync(absolute).isSymbolicLink() || !fs.statSync(absolute).isFile())) {
			throw new Error("Files profile output must be a regular file");
		}
		return path.join(parent, path.basename(absolute));
	}

	return {
		async install({ page, outputPath }) {
			if (run) throw new Error("Clean up the installed Files profile first");
			const checkedPath = checkOutputPath(outputPath);
			const ownerId = require("node:crypto").randomUUID();
			const cdp = await getCDPSession({ page });
			await cdp.send("Network.enable");
			const frames = [];
			const queries = new Map();
			const sent = (event) => {
				if (event.response?.opcode !== 1 || typeof event.response.payloadData !== "string" || !Number.isFinite(event.timestamp)) return;
				let message;
				try { message = JSON.parse(event.response.payloadData); } catch { return; }
				if (!message || !["Mutation", "Action", "ModifyQuerySet"].includes(message.type)) return;
				const modifications = Array.isArray(message.modifications) ? message.modifications : [];
				const labels = modifications.filter((item) => item && Number.isFinite(item.queryId) && typeof item.type === "string").map((item) => {
					const label = {
						id: item.queryId,
						path: typeof item.udfPath === "string" ? item.udfPath : undefined,
						type: item.type,
					};
					if (typeof item.udfPath === "string") {
						queries.set(`${event.requestId}/${item.queryId}`, item.udfPath);
					}
					return label;
				});
				frames.push({
					direction: "sent",
					at: event.timestamp * 1000,
					type: message.type,
					requestId: Number.isFinite(message.requestId) ? message.requestId : undefined,
					path: typeof message.udfPath === "string" ? message.udfPath : undefined,
					queries: labels,
					bytes: Buffer.byteLength(event.response.payloadData),
				});
			};
			const received = (event) => {
				if (event.response?.opcode !== 1 || typeof event.response.payloadData !== "string" || !Number.isFinite(event.timestamp)) return;
				let message;
				try { message = JSON.parse(event.response.payloadData); } catch { return; }
				if (!message) return;
				if (message.type === "update") {
					frames.push({ direction: "received", at: event.timestamp * 1000, type: "ViteUpdate" });
					return;
				}
				if (!["Transition", "ActionResponse", "MutationResponse"].includes(message.type)) return;
				const modifications = Array.isArray(message.modifications) ? message.modifications : [];
				frames.push({
					direction: "received",
					at: event.timestamp * 1000,
					type: message.type,
					requestId: Number.isFinite(message.requestId) ? message.requestId : undefined,
					success: typeof message.success === "boolean" ? message.success : undefined,
					runId: typeof message.result?._yay?.runId === "string" ? message.result._yay.runId : undefined,
					activityId: typeof message.result?._yay?.activityId === "string" ? message.result._yay.activityId : undefined,
					refused: Boolean(message.result?._nay),
					queries: modifications.filter((item) => item && Number.isFinite(item.queryId) && typeof item.type === "string").map((item) => ({ id: item.queryId, path: queries.get(`${event.requestId}/${item.queryId}`), type: item.type })),
					bytes: Buffer.byteLength(event.response.payloadData),
				});
			};
			cdp.on("Network.webSocketFrameSent", sent);
			cdp.on("Network.webSocketFrameReceived", received);
			let pageTimeOrigin;
			try {
				pageTimeOrigin = await page.evaluate((ownerId) => {
					if (window.__filesProfile) throw new Error("A page Files profile is already installed");
					const rig = {
						ownerId,
						active: null,
						outgoing: [],
						responses: [],
						sockets: new Set(),
						longTasks: [],
						disposed: false,
						originalSend: WebSocket.prototype.send,
					};
					const visibleEditor = () => [...document.querySelectorAll(".FileEditorRichText-editor-content")].find((element) => element.checkVisibility());
					rig.responseListener = (event) => {
						if (typeof event.data !== "string") return;
						let message;
						try { message = JSON.parse(event.data); } catch { return; }
						if (!message || !["ActionResponse", "MutationResponse"].includes(message.type) || !Number.isFinite(message.requestId)) return;
						rig.responses.push({
							at: performance.now(),
							type: message.type,
							requestId: message.requestId,
							success: typeof message.success === "boolean" ? message.success : undefined,
							refused: Boolean(message.result?._nay),
						});
					};
					rig.send = function (data) {
						if (!rig.disposed) {
							if (!rig.sockets.has(this)) { rig.sockets.add(this); this.addEventListener("message", rig.responseListener); }
							if (typeof data === "string") {
								let message;
								try { message = JSON.parse(data); } catch {}
								if (message && ["Mutation", "Action", "ModifyQuerySet"].includes(message.type)) {
									const modifications = Array.isArray(message.modifications) ? message.modifications : [];
									rig.outgoing.push({
										at: performance.now(),
										type: message.type,
										requestId: Number.isFinite(message.requestId) ? message.requestId : undefined,
										path: typeof message.udfPath === "string" ? message.udfPath : undefined,
										bytes: new TextEncoder().encode(data).byteLength,
										queries: modifications.filter((item) => item && Number.isFinite(item.queryId) && typeof item.type === "string").map((item) => ({ id: item.queryId, path: typeof item.udfPath === "string" ? item.udfPath : undefined, type: item.type })),
									});
								}
							}
						}
						return rig.originalSend.call(this, data);
					};
					const check = () => {
						const active = rig.active;
						if (!active || active.start === undefined || active.predicateError) return;
						try {
							for (const [name, predicate] of Object.entries(active.milestonePredicates)) {
								if (active.milestones[name] === undefined && predicate()) active.milestones[name] = performance.now();
							}
							if (active.done !== undefined) return;
							if (active.requireNewEditor && (!visibleEditor() || visibleEditor() === rig.previousEditor)) return;
							if (!active.predicate()) return;
							active.done = performance.now();
							active.nodeId = new URL(location.href).searchParams.get("nodeId");
							active.focusTag = document.activeElement?.tagName;
							rig.frameRequest = requestAnimationFrame(() => {
								active.frame = performance.now();
								active.frameVisibility = document.visibilityState;
							});
						} catch { active.predicateError = true; }
					};
					rig.start = (event) => {
						const active = rig.active;
						if (!active || active.start !== undefined || event.type !== active.eventType) return;
						const fileChange = active.allowUntrustedChange === true && active.eventType === "change";
						if (!event.isTrusted && !fileChange) return;
						if (!event.target.closest?.(active.startSelector) || active.startKey && event.key !== active.startKey) return;
						active.start = performance.now();
						active.startedAt = new Date().toISOString();
						active.startVisibility = document.visibilityState;
						active.startFocus = document.hasFocus();
						active.eventIsTrusted = event.isTrusted;
						active.startKind = event.isTrusted ? "trusted-browser-event" : "browser-file-change";
						// Check after the event handlers, so capture does not finish on the old DOM.
						rig.startCheck = setTimeout(check, 0);
					};
					rig.visibilityListener = () => {
						if (rig.active?.start !== undefined && rig.active.frame === undefined && document.visibilityState !== "visible") rig.active.backgroundDuringAction = true;
					};
					rig.focusListener = () => {
						if (rig.active?.start !== undefined && rig.active.frame === undefined) rig.active.focusLostDuringAction = true;
					};
					rig.arm = (config) => {
						clearTimeout(rig.startCheck);
						cancelAnimationFrame(rig.frameRequest);
						rig.previousEditor = visibleEditor();
						rig.active = {
							...config,
							predicate: new Function(`return (${config.doneExpression})`),
							milestonePredicates: Object.fromEntries(Object.entries(config.milestoneExpressions ?? {}).map(([name, value]) => [name, new Function(`return (${value})`)])),
							milestones: {},
							devtoolsDisabled: window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.isDisabled === true,
							visibility: document.visibilityState,
							mountedRows: document.querySelectorAll(".FilesSidebarTreeItem").length,
						};
					};
					rig.read = () => {
						const active = rig.active;
						if (!active) return null;
						const readAt = performance.now();
						const end = active.frame ?? readAt;
						// Keep labels and timing only. Expressions can contain private baseline text.
						return {
							caseId: active.caseId,
							scenario: active.scenario,
							sampleId: active.sampleId,
							armedAt: active.armedAt,
							eventType: active.eventType,
							mainFunction: active.mainFunction,
							requireNewEditor: active.requireNewEditor,
							allowUntrustedChange: active.allowUntrustedChange === true && active.eventType === "change",
							eventIsTrusted: active.eventIsTrusted,
							startKind: active.startKind,
							measurementBoundary: active.startKind === "browser-file-change" ? "browser File input change" : "native browser event",
							frameHealth: active.frameHealth,
							devtoolsDisabled: active.devtoolsDisabled,
							visibility: active.visibility,
							start: active.start,
							startedAt: active.startedAt,
							done: active.done,
							frame: active.frame,
							readAt,
							startVisibility: active.startVisibility,
							startFocus: active.startFocus,
							frameVisibility: active.frameVisibility,
							endVisibility: document.visibilityState,
							endFocus: document.hasFocus(),
							backgroundDuringAction: Boolean(active.backgroundDuringAction),
							focusLostDuringAction: Boolean(active.focusLostDuringAction),
							predicateError: Boolean(active.predicateError),
							mountedRows: active.mountedRows,
							nodeId: active.nodeId,
							focusTag: active.focusTag,
							milestones: { ...active.milestones },
							pageTimeOrigin: performance.timeOrigin,
							outgoing: active.start === undefined ? [] : rig.outgoing.filter((item) => item.at >= active.start && item.at <= end + 3000),
							responses: active.start === undefined ? [] : rig.responses.filter((item) => item.at >= active.start && item.at <= end + 3000),
							uiMs: active.done === undefined ? null : active.done - active.start,
							frameMs: active.frame === undefined ? null : active.frame - active.start,
							longTasks: active.start === undefined ? [] : rig.longTasks.filter((item) => item.at + item.ms > active.start && item.at < end).map((item) => ({ at: Math.max(item.at, active.start), ms: Math.min(item.at + item.ms, end) - Math.max(item.at, active.start) })),
							measures: active.start === undefined ? [] : performance.getEntriesByType("measure").filter((item) => item.startTime >= active.start && item.startTime <= end).map((item) => ({ name: item.name, at: item.startTime, ms: item.duration })),
						};
					};
					rig.cleanup = () => {
						rig.disposed = true;
						const sendPatchRestored = WebSocket.prototype.send === rig.send;
						if (sendPatchRestored) WebSocket.prototype.send = rig.originalSend;
						for (const socket of rig.sockets) socket.removeEventListener("message", rig.responseListener);
						for (const type of ["click", "keydown", "input", "change", "drop"]) document.removeEventListener(type, rig.start, true);
						document.removeEventListener("visibilitychange", rig.visibilityListener);
						window.removeEventListener("blur", rig.focusListener);
						rig.observer.disconnect();
						rig.performanceObserver?.disconnect();
						clearInterval(rig.poll);
						clearTimeout(rig.startCheck);
						cancelAnimationFrame(rig.frameRequest);
						if (window.__filesProfile === rig) delete window.__filesProfile;
						return { pageCleaned: true, sendPatchRestored };
					};
					try {
						// Some browsers lack long-task entries. Keep that limit in each raw sample.
						rig.performanceObserver = new PerformanceObserver((list) => {
							for (const entry of list.getEntries()) rig.longTasks.push({ at: entry.startTime, ms: entry.duration });
						});
						rig.performanceObserver.observe({ type: "longtask", buffered: true });
					} catch { rig.performanceObserver?.disconnect(); rig.performanceObserver = null; }
					rig.observer = new MutationObserver(check);
					rig.observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
					WebSocket.prototype.send = rig.send;
					for (const type of ["click", "keydown", "input", "change", "drop"]) document.addEventListener(type, rig.start, true);
					document.addEventListener("visibilitychange", rig.visibilityListener);
					window.addEventListener("blur", rig.focusListener);
					rig.poll = setInterval(check, 25);
					window.__filesProfile = rig;
					return performance.timeOrigin;
				}, ownerId);
			} catch (error) {
				cdp.off("Network.webSocketFrameSent", sent);
				cdp.off("Network.webSocketFrameReceived", received);
				throw error;
			}
			run = {
				page,
				outputPath: checkedPath,
				ownerId,
				cdp,
				sent,
				received,
				frames,
				pageTimeOrigin,
				offset: undefined,
				frameStart: 0,
				sequence: 0,
				active: null,
				unsaved: false,
			};
			return { installed: true, outputPath: checkedPath };
		},

		async arm(config) {
			if (!run) throw new Error("Install the Files profile first");
			if (run.unsaved) throw new Error("Save the current raw sample before arming another");
			await run.page.bringToFront();
			let frameHealth;
			for (let attempt = 0; attempt < 3; attempt += 1) {
				frameHealth = await run.page.evaluate(() => new Promise((resolve) => {
					const times = [];
					let frame;
					let foreground = document.visibilityState === "visible" && document.hasFocus();
					const finish = (timedOut) => {
						cancelAnimationFrame(frame);
						const gaps = times.slice(1).map((at, index) => at - times[index]);
						resolve({
							gaps,
							median: [...gaps].sort((a, b) => a - b)[2],
							foreground,
							timedOut,
							visibility: document.visibilityState,
							focus: document.hasFocus(),
							at: new Date().toISOString(),
						});
					};
					const timer = setTimeout(() => finish(true), 750);
					const next = (at) => {
						times.push(at);
						foreground = foreground && document.visibilityState === "visible" && document.hasFocus();
						if (times.length === 6) { clearTimeout(timer); finish(false); }
						else frame = requestAnimationFrame(next);
					};
					frame = requestAnimationFrame(next);
				}));
				frameHealth.attempt = attempt + 1;
				if (!frameHealth.timedOut && frameHealth.foreground && frameHealth.gaps.length === 5 && frameHealth.gaps.every((gap) => Number.isFinite(gap) && gap > 0 && gap <= 50) && frameHealth.visibility === "visible" && frameHealth.focus) break;
				if (attempt === 2) throw new Error("All five quiet frame gaps, focus, and visibility must pass");
				await run.page.waitForTimeout(200);
			}
			run.sequence += 1;
			const labels = {
				caseId: config.caseId,
				scenario: config.scenario,
				mainFunction: config.mainFunction,
				sampleId: `${run.ownerId}/${run.sequence}`,
				armedAt: new Date().toISOString(),
			};
			run.frameStart = run.frames.length;
			await run.page.evaluate(({ ownerId, config }) => {
				const rig = window.__filesProfile;
				if (rig?.ownerId !== ownerId) throw new Error("The page Files profile changed; install again after cleanup");
				rig.arm(config);
			}, { ownerId: run.ownerId, config: { ...config, ...labels, frameHealth } });
			run.active = labels;
			run.unsaved = true;
			return { armed: true, sampleId: labels.sampleId, frameHealth };
		},

		async saveSample() {
			if (!run?.active) throw new Error("Arm a Files sample first");
			let sample;
			try {
				sample = await run.page.evaluate((ownerId) => {
					const rig = window.__filesProfile;
					if (rig?.ownerId !== ownerId) throw new Error("The page Files profile changed");
					return { ...rig.read(), longTasksSupported: Boolean(rig.performanceObserver) };
				}, run.ownerId);
			} catch {
				// A closed or replaced page still leaves an incomplete raw record.
				sample = { ...run.active, readFailed: true, outgoing: [], responses: [], uiMs: null, frameMs: null };
			}
			const currentFrames = run.frames.slice(run.frameStart);
			const offsets = [];
			for (const outgoing of sample.outgoing) {
				if (!Number.isFinite(outgoing.requestId) || typeof outgoing.path !== "string") continue;
				const matches = currentFrames.filter((item) => item.direction === "sent" && item.requestId === outgoing.requestId && item.type === outgoing.type && item.path === outgoing.path);
				if (matches.length === 1) offsets.push(outgoing.at - matches[0].at);
			}
			let queryOffset;
			for (const outgoing of sample.outgoing.filter((item) => item.type === "ModifyQuerySet" && item.queries.length > 0)) {
				const matches = currentFrames.filter((item) => item.direction === "sent" && item.type === "ModifyQuerySet" && JSON.stringify(item.queries) === JSON.stringify(outgoing.queries));
				if (matches.length === 1) { queryOffset = outgoing.at - matches[0].at; break; }
			}
			const samePage = sample.pageTimeOrigin === run.pageTimeOrigin;
			const offset = offsets[0] ?? queryOffset ?? (samePage ? run.offset : undefined);
			sample.clockAlignment = {
				method: offsets.length ? "request-id-and-path" : queryOffset !== undefined ? "query-set-ids-and-paths" : samePage && Number.isFinite(run.offset) ? "prior-sample-same-page" : "unavailable",
				offset,
				offsets,
			};
			if (samePage && Number.isFinite(offset)) run.offset = offset;
			const end = sample.frame ?? sample.readAt;
			sample.network = Number.isFinite(offset) && Number.isFinite(sample.start) ? currentFrames.filter((item) => item.at + offset >= sample.start && item.at + offset <= end + 3000).map((item) => ({ ...item, at: item.at + offset - sample.start })) : [];
			sample.incomplete = !Number.isFinite(sample.start) || !Number.isFinite(sample.done) || !Number.isFinite(sample.frame);
			// Without a clock match, an HMR frame cannot be placed inside the action.
			sample.unalignedHmr = !Number.isFinite(offset) && currentFrames.some((item) => item.type === "ViteUpdate");
			sample.hmrDuringSample = sample.network.some((item) => item.type === "ViteUpdate" && item.at <= sample.frameMs);
			sample.validSetup = !sample.incomplete && !sample.predicateError && !sample.unalignedHmr && !sample.hmrDuringSample && sample.visibility === "visible" && sample.startVisibility === "visible" && sample.startFocus === true && sample.frameVisibility === "visible" && sample.endVisibility === "visible" && sample.endFocus === true && !sample.backgroundDuringAction && !sample.focusLostDuringAction && sample.devtoolsDisabled === true;
			const requestIds = new Set(sample.outgoing.filter((item) => item.at <= end && ["Action", "Mutation"].includes(item.type) && (sample.mainFunction ? item.path === sample.mainFunction : item.path?.startsWith("files_"))).map((item) => item.requestId).filter(Number.isFinite));
			// Page replies are a failure check, not a substitute for the CDP network clock.
			sample.failedReply = sample.responses.some((item) => requestIds.has(item.requestId) && (item.success === false || item.refused)) || sample.network.some((item) => item.direction === "received" && ["ActionResponse", "MutationResponse"].includes(item.type) && requestIds.has(item.requestId) && (item.success === false || item.refused));
			fs.appendFileSync(checkOutputPath(run.outputPath), JSON.stringify(sample) + "\n");
			run.unsaved = false;
			return {
				caseId: sample.caseId,
				scenario: sample.scenario,
				sampleId: sample.sampleId,
				uiMs: sample.uiMs,
				frameMs: sample.frameMs,
				validSetup: sample.validSetup,
				incomplete: sample.incomplete,
				failedReply: sample.failedReply,
				hmrDuringSample: sample.hmrDuringSample,
				clockAlignment: sample.clockAlignment.method,
			};
		},

		async cleanup() {
			if (!run) return { cleaned: false };
			let pendingSampleSaved = null;
			try {
				if (run.unsaved) { await state.qa.filesProfile.saveSample(); pendingSampleSaved = true; }
			} catch { pendingSampleSaved = false; }
			let pageResult;
			try {
				pageResult = await run.page.evaluate((ownerId) => {
					const rig = window.__filesProfile;
					return rig?.ownerId === ownerId ? rig.cleanup() : { pageCleaned: false };
				}, run.ownerId);
			} catch { pageResult = { pageCleaned: false }; }
			run.cdp.off("Network.webSocketFrameSent", run.sent);
			run.cdp.off("Network.webSocketFrameReceived", run.received);
			// The CDP session and Network domain may be shared by other helpers.
			run = null;
			return { cleaned: true, pendingSampleSaved, ...pageResult };
		},
	};
})();
console.log("state.qa.filesProfile ready → install(), arm(), saveSample(), cleanup()");
