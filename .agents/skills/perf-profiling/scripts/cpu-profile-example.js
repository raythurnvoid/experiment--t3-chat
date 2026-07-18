// Playwriter script — TEMPLATE. Records a CDP CPU profile around one interaction.
// Before running, set state.perfProfilePath to an absolute .cpuprofile path under
// ../t3-chat-+personal/+ai/<topic>-YYYY-MM-DD/ and create that folder in PowerShell.
// Analyze the saved .cpuprofile with analyze-cpu-profile.mjs (same folder).
if (typeof state.perfProfilePath !== "string") {
	throw new Error(
		"Set state.perfProfilePath to an absolute .cpuprofile path under ../t3-chat-+personal/+ai/",
	);
}

// Keep this template standalone. A prior latency rig owns a different CDP session and page hooks.
if (typeof state.cleanupLatencyRig === "function") {
	await state.cleanupLatencyRig();
}

const cdp = await getCDPSession({ page: state.page });
let interactionError;
let profilerError;
let profile;
let profilerStarted = false;

try {
	await cdp.send("Profiler.enable");
	await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
	try {
		await cdp.send("Profiler.start");
		profilerStarted = true;

		// ADAPT: the interaction and the DOM state that means it finished.
		const btn = state.page.locator('button[aria-label="New folder"]');
		await btn.click();
		await state.page.waitForSelector('[aria-label="Add folder to new-folder-1"]', {
			state: "attached",
			timeout: 30000,
		});
	} catch (error) {
		interactionError = error;
	} finally {
		try {
			if (profilerStarted) {
				({ profile } = await cdp.send("Profiler.stop"));
			}
		} catch (error) {
			profilerError = error;
		} finally {
			await cdp.send("Profiler.disable").catch((error) => {
				profilerError ??= error;
			});
		}
	}

	if (!profile) {
		throw interactionError ?? profilerError ?? new Error("The CPU profiler did not return a profile");
	}

	const downloadPromise = state.page.waitForEvent("download");
	await state.page.evaluate((profileJson) => {
		const url = URL.createObjectURL(new Blob([profileJson], { type: "application/json" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = "interaction.cpuprofile";
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}, JSON.stringify(profile));
	const download = await downloadPromise;
	await download.saveAs(state.perfProfilePath);
	console.log(
		"profile saved:",
		state.perfProfilePath,
		"nodes:",
		profile.nodes.length,
		"samples:",
		profile.samples.length,
	);

	if (interactionError) {
		throw interactionError;
	}
} finally {
	await cdp.detach().catch(() => undefined);
}
