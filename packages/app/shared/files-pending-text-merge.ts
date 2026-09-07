import { diffLines } from "diff";
import { Result } from "common/errors-as-values-utils.ts";
import { files_text_diff_compute, files_text_diff_TOO_LARGE_MESSAGE } from "./files-text-diff.ts";

type TextEdit = { start: number; end: number; text: string; targetStart: number; targetEnd: number };

function collect_edits(changes: Array<{ value: string; added?: boolean; removed?: boolean }>) {
	const edits: TextEdit[] = [];
	let sourceOffset = 0;
	let targetOffset = 0;
	let edit: TextEdit | undefined;
	for (const change of changes) {
		if (!change.added && !change.removed) {
			if (edit) edits.push(edit);
			edit = undefined;
			sourceOffset += change.value.length;
			targetOffset += change.value.length;
			continue;
		}
		edit ??= { start: sourceOffset, end: sourceOffset, text: "", targetStart: targetOffset, targetEnd: targetOffset };
		if (change.removed) {
			sourceOffset += change.value.length;
			edit.end = sourceOffset;
		} else {
			edit.text += change.value;
			targetOffset += change.value.length;
			edit.targetEnd = targetOffset;
		}
	}
	if (edit) edits.push(edit);
	return edits;
}

/**
 * Apply proposed line changes over current text, keeping saved text outside their ranges.
 * Character matches locate those ranges; they never combine different edits inside a word.
 */
export function files_pending_text_merge(args: { baseText: string; proposedText: string; currentText: string }) {
	const { baseText, proposedText, currentText } = args;
	if (proposedText === baseText) return Result({ _yay: currentText });
	if (currentText === baseText || proposedText === currentText) return Result({ _yay: proposedText });

	const deadline = Date.now() + 30_000;
	const proposedChanges = diffLines(baseText, proposedText, { timeout: 30_000 });
	const currentChanges = diffLines(baseText, currentText, { timeout: Math.max(0, deadline - Date.now()) });
	if (!proposedChanges || !currentChanges) return Result({ _nay: { message: files_text_diff_TOO_LARGE_MESSAGE } });
	const currentDiff = files_text_diff_compute({
		sourceText: baseText,
		targetText: currentText,
		deadlineMs: Math.max(0, deadline - Date.now()),
	});
	if (currentDiff._nay) return Result({ _nay: { message: currentDiff._nay.message } });
	const currentEdits = collect_edits(
		currentDiff._yay.map(([kind, value]) => ({ value, added: kind === 1, removed: kind === -1 })),
	);
	const currentLineEdits = collect_edits(currentChanges);
	const proposedEdits = collect_edits(proposedChanges).flatMap((edit) => {
		const oldLines = baseText.slice(edit.start, edit.end).split(/(?<=\n)/);
		const newLines = edit.text.split(/(?<=\n)/);
		if (oldLines.length !== newLines.length || oldLines.length === 1) return [edit];
		// Corresponding lines can move apart or have saved lines inserted between them.
		let start = edit.start;
		let targetStart = edit.targetStart;
		return newLines.map((text, index) => {
			const end = start + oldLines[index]!.length;
			const targetEnd = targetStart + text.length;
			const lineEdit = { start, end, text, targetStart, targetEnd };
			start = end;
			targetStart = targetEnd;
			return lineEdit;
		});
	});
	const mappedEdits: Array<{ start: number; end: number; text: string; baseStart: number; beforeNewlines?: number }> =
		[];

	function map_boundary(position: number, side: "start" | "end" | "insert") {
		let offset = 0;
		for (const edit of currentEdits) {
			if (position < edit.start) break;
			if (edit.start === edit.end && position === edit.start) {
				if (side === "insert") return edit.targetEnd;
				// Keep outside lines, but overwrite a prefix or suffix added on the proposed line.
				if (side === "start") return edit.targetStart + edit.text.lastIndexOf("\n") + 1;
				if (position > 0 && baseText[position - 1] === "\n") return edit.targetStart;
				const newline = edit.text.indexOf("\n");
				return newline < 0 ? edit.targetEnd : edit.targetStart + newline;
			}
			if (position === edit.start) return edit.targetStart;
			if (position < edit.end) {
				// A deleted section has one clear insertion point. A rewritten section may not.
				return edit.text === "" ? edit.targetStart : null;
			}
			if (position === edit.end) return edit.targetEnd;
			offset = edit.targetEnd - edit.end;
		}
		return position + offset;
	}

	for (const edit of proposedEdits) {
		if (Date.now() > deadline) return Result({ _nay: { message: files_text_diff_TOO_LARGE_MESSAGE } });
		if (edit.start === edit.end) {
			// Saved inserted lines can share a diff block with the following replacement.
			const currentInsert = currentLineEdits.find(
				(current) =>
					current.end === edit.start ||
					(current.start === edit.start &&
						current.text.split(/(?<=\n)/).length > baseText.slice(current.start, current.end).split(/(?<=\n)/).length),
			);
			const point = map_boundary(edit.start, "insert");
			if (point === null) return Result({ _nay: { message: "Could not match the proposed lines to the saved text" } });
			let text = edit.text;
			if (currentInsert) {
				// Match each saved line once, keeping proposal order and repeated-line counts.
				const savedLines = new Map<string, { ranges: Array<{ start: number; end: number }>; used: number }>();
				let offset = currentInsert.targetStart;
				for (const line of currentInsert.text.split(/(?<=\n)/)) {
					const key = line.replace(/\n$/, "");
					const saved = savedLines.get(key) ?? { ranges: [], used: 0 };
					saved.ranges.push({ start: offset, end: offset + line.length });
					savedLines.set(key, saved);
					offset += line.length;
				}
				let matchedEnd = currentInsert.targetStart;
				const proposedLines = edit.text.split(/(?<=\n)/);
				text = "";
				for (const [index, line] of proposedLines.entries()) {
					if (Date.now() > deadline) return Result({ _nay: { message: files_text_diff_TOO_LARGE_MESSAGE } });
					const saved = savedLines.get(line.replace(/\n$/, ""));
					const match = saved?.ranges[saved.used];
					if (match === undefined) {
						text += line;
						continue;
					}
					if (match.start < matchedEnd)
						return Result({ _nay: { message: "Could not match the proposed lines to the saved text" } });
					if (text) mappedEdits.push({ start: match.start, end: match.start, text, baseStart: edit.start });
					text = "";
					saved!.used++;
					matchedEnd = match.end;
					if (match.end === currentText.length && index === proposedLines.length - 1) {
						const currentNewline = currentText[match.end - 1] === "\n";
						if (line.endsWith("\n") !== currentNewline) {
							mappedEdits.push({
								start: currentNewline ? match.end - 1 : match.end,
								end: match.end,
								text: line.endsWith("\n") ? "\n" : "",
								baseStart: edit.start,
							});
						}
					}
				}
			}
			if (text) {
				if (point > 0 && currentText[point - 1] !== "\n") text = "\n" + text;
				mappedEdits.push({ start: point, end: point, text, baseStart: edit.start });
			}
			continue;
		}

		// The same base range may already contain the proposed replacement plus saved notes.
		const currentReplacement = currentLineEdits.find(
			(current) => current.start === edit.start && current.end === edit.end,
		);
		if (
			edit.text &&
			currentReplacement &&
			(edit.text.endsWith("\n")
				? `\n${currentReplacement.text}`.includes(`\n${edit.text}`)
				: `\n${currentReplacement.text}`.endsWith(`\n${edit.text}`))
		)
			continue;

		const oldText = baseText.slice(edit.start, edit.end);
		const movedStart = currentText.indexOf(oldText);
		// An exact unique range also keeps line alignment when character diff picks another match.
		const hasExactRange =
			movedStart >= 0 &&
			baseText.indexOf(oldText) === baseText.lastIndexOf(oldText) &&
			movedStart === currentText.lastIndexOf(oldText) &&
			(movedStart === 0 || currentText[movedStart - 1] === "\n") &&
			(oldText.endsWith("\n") ||
				movedStart + oldText.length === currentText.length ||
				currentText[movedStart + oldText.length] === "\n");
		const start = hasExactRange ? movedStart : map_boundary(edit.start, "start");
		const end = hasExactRange ? movedStart + oldText.length : map_boundary(edit.end, "end");
		if (start === null || end === null || start > end) {
			return Result({ _nay: { message: "Could not match the proposed lines to the saved text" } });
		}
		// More saved lines leave no clear target; shared words can belong to an unrelated note.
		if (
			!hasExactRange &&
			start !== end &&
			currentLineEdits.some(
				(current) =>
					current.start <= edit.start &&
					current.end >= edit.end &&
					current.text.split(/(?<=\n)/).length > baseText.slice(current.start, current.end).split(/(?<=\n)/).length,
			)
		) {
			return Result({ _nay: { message: "Could not match the proposed lines to the saved text" } });
		}
		let text = edit.text;
		// A longer replacement can include a prefix already inserted at this base boundary.
		const savedPrefix = currentLineEdits.find(
			(current) => current.start === edit.start && current.end === edit.start && current.targetEnd <= start,
		);
		if (
			savedPrefix?.text &&
			text.startsWith(savedPrefix.text) &&
			text.split(/(?<=\n)/).length > oldText.split(/(?<=\n)/).length
		)
			text = text.slice(savedPrefix.text.length);
		let beforeNewlines = 0;
		if (text && start === end) {
			// Restore only the missing paragraph separators around a deleted range.
			beforeNewlines = proposedText.slice(0, edit.targetStart).match(/\n*$/)![0].length;
			const after = proposedText.slice(edit.targetEnd).match(/^\n*/)![0].length;
			const currentAfter = currentText.slice(end).match(/^\n*/)![0].length;
			if (end < currentText.length) text += "\n".repeat(Math.max(0, after - currentAfter));
		}
		if (text && edit.end === baseText.length && end < currentText.length) {
			// The old EOF is now a line boundary before saved text.
			if (baseText.endsWith("\n") && !text.endsWith("\n")) text += "\n";
			else if (!baseText.endsWith("\n") && text.endsWith("\n") && currentText[end] === "\n") text = text.slice(0, -1);
		}
		mappedEdits.push({ start, end, text, baseStart: edit.start, beforeNewlines });
	}

	mappedEdits.sort((left, right) => left.start - right.start || left.baseStart - right.baseStart);
	let result = "";
	let offset = 0;
	for (let index = 0; index < mappedEdits.length; ) {
		const first = mappedEdits[index]!;
		let end = first.end;
		const overlapping = [first];
		index++;
		while (
			index < mappedEdits.length &&
			(mappedEdits[index]!.start < end || mappedEdits[index]!.start === first.start)
		) {
			const next = mappedEdits[index++]!;
			end = Math.max(end, next.end);
			overlapping.push(next);
		}
		overlapping.sort((left, right) => left.baseStart - right.baseStart);
		result += currentText.slice(offset, first.start);
		for (const edit of overlapping) {
			if (result && edit.beforeNewlines) {
				const currentBefore = result.match(/\n*$/)![0].length;
				result += "\n".repeat(Math.max(0, edit.beforeNewlines - currentBefore));
			}
			result += edit.text;
		}
		offset = end;
	}
	return Result({ _yay: result + currentText.slice(offset) });
}
