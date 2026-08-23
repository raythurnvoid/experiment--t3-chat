// Reusable overlay-blocking helpers stored on state.qa.overlay (session-persistent).
//
// Why this exists: an overlay that visually covers a control is a screenshot finding, and a
// screenshot finding is easy to argue with. `document.elementFromPoint` runs the same hit test the
// browser runs for a real press, so it settles the question a reviewer actually has: can a person
// still press this? A control that answers with the overlay's markup cannot be pressed there,
// whatever the picture looks like.
//
// Sample five points per control, not the centre alone. A control can have its centre clear and its
// edge covered, and a press aimed at the covered edge then lands on the overlay instead. Proven on a
// fixture at 512x384 on 2026-08-23: a button whose top 20px sat under the overlay answered with its
// own id at the centre, so the centre-only version listed it as reachable, while a real
// `mouse.click` on that top strip was received by the overlay. `auditAccessibility` in
// `install-harness.js` was corrected the same way and for the same reason — keep the two samplers
// the same.
//
// A sample outside the window is skipped, not counted as clear. `elementFromPoint` answers `null`
// outside the viewport, and the centre-only version read that `null` as "nothing is covering it".
// So a control scrolled or clipped out of view was reported reachable. The zoom viewports below are
// exactly the sizes where a stage scrolls its lower rows out of view, so the old code hid that case
// at its own defaults. A control with no sampled point is reported under `outOfView` instead, which
// is a scroll finding to chase, not a pass.
//
// Found the round-5 P1 in the Council room: a host-error banner left `position: absolute` inside a
// media block that had already turned the control bar static, so at 512x384 (a 1024x768 display at
// 200% zoom, i.e. WCAG 1.4.4) five of six controls answered `host-error` at their centre and only
// Leave was clear. The same defect had been fixed one media block away and the rule behind it was
// never re-checked, which is exactly the case a sweep catches and a single-viewport screenshot does
// not.
state.qa = state.qa ?? {};
state.qa.overlay = {
	/**
	 * Report which controls the overlay blocks at the CURRENT viewport.
	 *
	 * Returns the overlay's and container's computed `position`, the vertical overlap in pixels, the
	 * ids of blocked controls, the ids of controls no sample could reach, and per control `sampled`,
	 * `topAtCenter` and `blockedPoints`. Read `blockedPoints` to tell a fully covered control from a
	 * partly covered one, and read `sampled` so a zero-blocked result can be trusted as evidence
	 * rather than as a probe that silently measured nothing. The field names match
	 * `auditAccessibility` in `install-harness.js`, so the two outputs can be compared directly.
	 */
	async blocked(overlaySelector, controlSelector) {
		return await state.page.evaluate(
			({ overlaySelector, controlSelector }) => {
				const overlay = document.querySelector(overlaySelector);
				const controls = [...document.querySelectorAll(controlSelector)];
				// Say which half is missing. A typo in either selector otherwise reads as "nothing is
				// blocked", which is the same shape as a pass.
				if (!overlay || controls.length === 0) {
					return {
						error: !overlay ? `no element for ${overlaySelector}` : `no elements for ${controlSelector}`,
					};
				}

				const describe = (node) => {
					if (!node) {
						return null;
					}
					return node.id || (typeof node.className === "string" ? node.className.slice(0, 24) : node.tagName);
				};

				const overlayBox = overlay.getBoundingClientRect();
				const hits = controls.map((control) => {
					const box = control.getBoundingClientRect();
					// Inset the corners so a 1px border or a rounded edge does not answer for a neighbour.
					// Halve it on a tiny control so the four corners stay inside the box.
					const inset = Math.min(3, box.width / 2, box.height / 2);
					const samples = [
						{ point: "center", x: box.left + box.width / 2, y: box.top + box.height / 2 },
						{ point: "top-left", x: box.left + inset, y: box.top + inset },
						{ point: "top-right", x: box.right - inset, y: box.top + inset },
						{ point: "bottom-left", x: box.left + inset, y: box.bottom - inset },
						{ point: "bottom-right", x: box.right - inset, y: box.bottom - inset },
					];

					const blockedPoints = [];
					let sampled = 0;
					let topAtCenter = null;
					for (const sample of samples) {
						// Skip a point outside the window. There is no element under it, and `elementFromPoint`
						// answers `null` there, which is not the same answer as "nothing is covering it".
						if (sample.x < 0 || sample.y < 0 || sample.x >= window.innerWidth || sample.y >= window.innerHeight) {
							continue;
						}

						sampled += 1;
						// Hit-test the same unrounded coordinate the bounds check just accepted.
						// Rounding here can push 511.6 to 512 on a 512px-wide window, and the hit test then
						// answers `null` for a point the check called in-window.
						const top = document.elementFromPoint(sample.x, sample.y);
						// `elementFromPoint` answers with the deepest node, which for an overlay with inner
						// markup is a child rather than the overlay itself. Ask the tree, not the id.
						if (top === null || (top !== overlay && !overlay.contains(top))) {
							continue;
						}

						// Same meaning as `topAtCenter` in `install-harness.js`: the overlay node covering the
						// centre, or null when the centre is clear and only an edge is covered.
						if (sample.point === "center") {
							topAtCenter = describe(top);
						}
						blockedPoints.push({ point: sample.point, hit: describe(top) });
					}

					return { id: describe(control), sampled, topAtCenter, blockedPoints };
				});

				return {
					overlayPosition: getComputedStyle(overlay).position,
					overlayHidden: overlay.hidden,
					overlayRect: { top: Math.round(overlayBox.top), bottom: Math.round(overlayBox.bottom) },
					blocked: hits.filter((hit) => hit.blockedPoints.length > 0).map((hit) => hit.id),
					// A control no sample could reach is scrolled or clipped out of the window. That is its
					// own finding, and it is never evidence that the control is clear.
					outOfView: hits.filter((hit) => hit.sampled === 0).map((hit) => hit.id),
					hits,
				};
			},
			{ overlaySelector, controlSelector },
		);
	},

	/**
	 * Run `blocked` across several viewports, optionally re-triggering the overlay at each one.
	 *
	 * Pass `trigger` when the overlay is transient — most are, because they appear on a failed action
	 * and a viewport change does not replay it. Pass `screenshotDir` to save one shot per viewport;
	 * a blocked-control list is the proof, and the shot is what a person reads next to it.
	 *
	 * Restores the starting viewport, so a sweep in the middle of a longer session does not leave
	 * every later measurement on the last size in the list.
	 */
	async sweep(args) {
		const { overlaySelector, controlSelector, viewports, trigger, screenshotDir, prefix } = args;
		const started = state.page.viewportSize();
		const results = [];

		for (const viewport of viewports) {
			await state.page.setViewportSize({ width: viewport.w, height: viewport.h });
			// Let the media query settle before measuring; a reflow read on the same tick reports the
			// previous layout and the whole sweep then agrees with itself for the wrong reason.
			await state.page.waitForTimeout(300);

			if (trigger) {
				await trigger(state.page, viewport);
			}

			const measured = await state.qa.overlay.blocked(overlaySelector, controlSelector);
			const entry = { viewport: `${viewport.w}x${viewport.h}`, ...measured };

			if (screenshotDir) {
				const path = `${screenshotDir}/${prefix ?? "overlay"}-${viewport.w}x${viewport.h}.png`;
				await state.page.screenshot({ path });
				entry.screenshot = path;
			}

			// Print `outOfView` too. A viewport that scrolls controls away otherwise reports an empty
			// blocked list, which reads exactly like a viewport where nothing is covered.
			// This line only reaches the CLI when the sweep runs in the SAME call that installed this
			// file. A helper called from a later call keeps the installing call's console and its output
			// is dropped — read the returned `results` instead. See `known-hazards.md`.
			console.log(
				`${entry.viewport} → blocked: ${JSON.stringify(measured.blocked ?? measured.error)} outOfView: ${JSON.stringify(measured.outOfView ?? [])}`,
			);
			results.push(entry);
		}

		if (started) {
			await state.page.setViewportSize(started);
		}
		return results;
	},

	/**
	 * The viewports worth sweeping for a reflow defect.
	 *
	 * The four narrow ones are not phones. They are ordinary desktop displays at 200% and 250% browser
	 * zoom, which WCAG 1.4.4 requires to keep working, and they land in media blocks written for
	 * phones without anyone testing them there. 512x384 is 1024x768 at 200%.
	 */
	ZOOM_VIEWPORTS: [
		{ w: 512, h: 384 },
		{ w: 500, h: 400 },
		{ w: 480, h: 360 },
		{ w: 400, h: 300 },
	],
};

console.log("state.qa.overlay ready → blocked(), sweep(), ZOOM_VIEWPORTS");
