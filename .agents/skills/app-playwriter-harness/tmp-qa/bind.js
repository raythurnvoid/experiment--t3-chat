await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/personal/home' });
console.log('bound:', await state.page.evaluate(() => location.href));
