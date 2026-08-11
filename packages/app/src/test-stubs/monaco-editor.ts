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
