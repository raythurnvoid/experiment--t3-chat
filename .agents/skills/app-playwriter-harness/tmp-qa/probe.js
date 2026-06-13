// Quick session probe: what state exposes, current page binding.
console.log(
	JSON.stringify({
		keys: Object.keys(state),
		hasPage: !!state.page,
		url: state.page ? state.page.url() : null,
	}),
);
