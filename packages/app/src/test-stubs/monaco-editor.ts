/**
 * Stands in for the range `getFullModelRange` returns. The app only ever edits a stub model with
 * that whole-file range, so the stub recognises it by identity instead of doing range math.
 */
const FULL_MODEL_RANGE = Object.freeze({ fullModelRange: true });

export const editor = {
	EndOfLineSequence: {
		LF: 0,
	},
	createModel(value?: string) {
		// Hold the text so component tests can read and change the model like Monaco would.
		let currentValue = value ?? "";
		return {
			getValue() {
				return currentValue;
			},
			setValue(next: string) {
				currentValue = next;
			},
			getFullModelRange() {
				return FULL_MODEL_RANGE;
			},
			pushStackElement() {},
			applyEdits(edits: Array<{ range: unknown; text: string }>) {
				for (const edit of edits) {
					if (edit.range !== FULL_MODEL_RANGE) {
						throw new Error("The Monaco stub only applies edits that span the whole model");
					}

					currentValue = edit.text;
				}

				return [];
			},
			setEOL() {},
			dispose() {},
		};
	},
	defineTheme() {},
	setTheme() {},
};

// The app config turns the worker-backed language features off at import time (tokenizer-only
// rule), so the stub has to carry the same namespaces.
export const json = {
	jsonDefaults: {
		setModeConfiguration() {},
	},
};

export const css = {
	cssDefaults: {
		setModeConfiguration() {},
	},
};

export const typescript = {
	typescriptDefaults: {
		setModeConfiguration() {},
	},
	javascriptDefaults: {
		setModeConfiguration() {},
	},
};
