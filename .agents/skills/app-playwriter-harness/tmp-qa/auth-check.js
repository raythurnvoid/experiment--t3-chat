const auth = await state.appPlaywriterHarness.authSummary();
console.log("auth done:", auth.hasSession, auth.email || auth.external_id || "anon");
