// Fixed templates only. The model supplies operation data, never source code.
export const PLAYWRITER_EXECUTOR_REVISION = "guarded-navigation-2026-09-29-v3";
export const PLAYWRITER_EXECUTOR_JS = String.raw`
import { WorkerEntrypoint } from "cloudflare:workers";
import { connect, browser_web_url_host_matches } from "./playwright.js";
// Trusted utility adapter pinned to @cloudflare/playwright 1.3.6 private APIs.
async function backgroundClick(page, locator, action, revision) {
  const deadline = performance.now() + 4500;
  const result = { ok: false, reason: 'not_started', inputSent: false, cleanup: 'complete' };
  let lastTimedOutStage;
  let handles = [];
  const originals = new Map();
  let utilityElement;
  let guard;
  let guardStopped = false;
  let pressed = false;

  async function bounded(stage, work, until = deadline) {
    const started = performance.now();
    // Setup groups share the work deadline across several native round trips.
    const remaining = ['element_handles', 'guard_create'].includes(stage) ? until - started : Math.min(1000, until - started);
    if (remaining <= 0) {
      throw new Error('helper_deadline');
    }
    let timer;
    let timedOut = false;
    try {
      const value = await Promise.race([
        work(),
        new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; lastTimedOutStage = stage; reject(new Error('helper_deadline')); }, remaining); }),
      ]);
      return value;
    } catch (error) {
      if (!timedOut) lastTimedOutStage = undefined;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function geometry(value) {
    if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') throw new Error('invalid_geometry');
    if (!value.ok) {
      if (!['detached', 'iframe_unsupported', 'not_visible', 'disabled', 'inert', 'geometry_unsupported', 'viewport_unsupported', 'hit_target_blocked', 'invalid_geometry', 'sensitive_input', 'unsupported_field', 'field_changed'].includes(value.reason)) throw new Error('invalid_geometry');
      return value;
    }
    for (const key of ['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight', 'pointX', 'pointY']) {
      if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Math.abs(value[key]) > 1000000) throw new Error('invalid_geometry');
    }
    if (value.width <= 0 || value.height <= 0 || value.viewportWidth <= 0 || value.viewportHeight <= 0 || value.viewportWidth > 32768 || value.viewportHeight > 32768 || value.pointX < 0 || value.pointY < 0 || value.pointX >= value.viewportWidth || value.pointY >= value.viewportHeight) throw new Error('invalid_geometry');
    return value;
  }

  function nativeHandle(handle) {
    return handle?.__jshandle === true && handle._disposed === false &&
      typeof handle._objectId === 'string' && handle._objectId.length > 0 &&
      Number.isSafeInteger(handle._context?.delegate?._contextId) && handle._context.delegate._contextId > 0 &&
      typeof handle._context.delegate._client?.send === 'function';
  }

  function registered(client, connection) {
    return client?._connection === connection && typeof client._guid === 'string' &&
      connection?._objects instanceof Map && connection._objects.get(client._guid) === client;
  }

  function implementation(client) {
    const connection = client?._connection;
    if (typeof connection?.toImpl !== 'function' || !registered(client, connection) || !registered(page, connection)) throw new Error('adapter_unsupported');
    const handle = connection.toImpl(client);
    if (!nativeHandle(handle) || handle.__elementhandle !== true || handle._page !== connection.toImpl(page) ||
      handle._frame?._page !== handle._page || handle._context.frame !== handle._frame || handle._context.world !== 'main') throw new Error('adapter_unsupported');
    originals.set(client, handle);
    return handle;
  }

  async function releaseOwned(handle) {
    if (!nativeHandle(handle)) throw new Error('release_unknown');
    // SDK dispose() starts a release without waiting and hides native errors.
    handle._disposed = true;
    if (globalThis.leakedJSHandles) globalThis.leakedJSHandles.delete(handle);
    await handle._context.delegate._client.send('Runtime.releaseObject', { objectId: handle._objectId });
  }

  try {
    if (locator.page() !== page) {
      result.reason = 'wrong_page';
      return result;
    }
    handles = await bounded('element_handles', () => locator.elementHandles());
    if (handles.length !== 1) {
      result.reason = handles.length ? 'duplicate_matches' : 'no_match';
      return result;
    }
    const element = handles[0];
    const serverElement = implementation(element);
    const connection = element._connection;
    const mainFrame = page.mainFrame();
    if (!registered(mainFrame, connection) || serverElement._frame !== connection.toImpl(mainFrame) ||
      typeof serverElement._frame._utilityContext !== 'function' || typeof serverElement._page.delegate?.adoptElementHandle !== 'function') throw new Error('adapter_unsupported');
    await bounded('guard_create', async () => {
      const utility = await serverElement._frame._utilityContext();
      if (utility?.world !== 'utility' || utility.frame !== serverElement._frame || typeof utility.evaluateHandle !== 'function' || typeof utility.injectedScript !== 'function' ||
        !Number.isSafeInteger(utility.delegate?._contextId) || utility.delegate._contextId <= 0 ||
        utility.delegate._contextId === serverElement._context.delegate._contextId ||
        utility.delegate._client !== serverElement._context.delegate._client) throw new Error('adapter_unsupported');
      const binding = '__bonobo_guard_' + revision;
      if (action.action === 'click' || (action.action === 'press' && action.key === 'Enter')) {
        await utility.delegate._client.send('Runtime.addBinding', {name:binding, executionContextId:utility.delegate._contextId});
      }
      const injected = await utility.injectedScript();
      const adopted = await serverElement._page.delegate.adoptElementHandle(serverElement, utility);
      if (!nativeHandle(adopted) || adopted === serverElement || adopted.__elementhandle !== true ||
        adopted._objectId === serverElement._objectId || adopted._context !== utility ||
        adopted._page !== serverElement._page || adopted._frame !== serverElement._frame) {
        result.cleanup = 'unknown';
        throw new Error('adapter_unsupported');
      }
      utilityElement = adopted;
      const created = await utility.evaluateHandle(({element, action, injected, binding}) => {
        if (typeof injected?.utils?.getElementAccessibleName !== 'function' || typeof injected.utils.elementText !== 'function') throw new Error('adapter_unsupported');
        // Keep adopted nodes inside this exact utility document.
        const doc = document;
        const view = window;
        const report = view[binding];
        const mayNavigate = action.action === 'click' || (action.action === 'press' && action.key === 'Enter');
        if (mayNavigate && typeof report !== 'function') throw new Error('adapter_unsupported');
        // DOM wrappers and this clock belong to the isolated utility world.
        const now = view.performance.now.bind(view.performance);
        const keyboard = action?.action === 'fill' || action?.action === 'press';
        const types = action?.action === 'fill' ? ['beforeinput', 'input'] : action?.action === 'press' ? ['keydown', 'keyup'] : ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        let active = false;
        let expiry = 0;
        let timer;
        let expected;
        let eventIndex = 0;
        let failure = null;

        function parent(node) {
          return node.assignedSlot || node.parentElement || node.getRootNode().host || null;
        }

        function hitsTarget(x, y) {
          let hit = doc.elementFromPoint(x, y);
          while (hit?.shadowRoot) {
            const inside = hit.shadowRoot.elementFromPoint(x, y);
            if (!inside || inside === hit) break;
            hit = inside;
          }
          while (hit) {
            if (hit === element) return true;
            hit = parent(hit);
          }
          return false;
        }

        function read() {
          if (!element.isConnected || element.ownerDocument !== doc) return { ok: false, reason: 'detached' };
          const field = element.control || element;
          // Credential names apply only to real fields.
          if (['INPUT','TEXTAREA','SELECT'].includes(field.tagName) || field.isContentEditable) {
            const fieldNames = [field.id,field.getAttribute('name'),field.getAttribute('autocomplete'),field.getAttribute('aria-label')];
            // An aria-label can hide a native credential label. Read all current labels.
            const labels = [...(field.labels||[]),...(field.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>field.getRootNode().getElementById(id))].filter(Boolean);
            const textCache = new Map();
            fieldNames.push(injected.utils.getElementAccessibleName(field,true),...labels.map(label=>injected.utils.elementText(textCache,label).full));
            if (field.matches('input[type="password"],input[type="file"],[autocomplete="one-time-code"]') || /password|passcode|one.?time|otp|verification.?code/i.test(fieldNames.join(' '))) return {ok:false,reason:'sensitive_input'};
          }
          if (action?.action === 'fill' && (field.tagName !== 'INPUT' && field.tagName !== 'TEXTAREA')) return {ok:false,reason:'unsupported_field'};
          if (action?.action === 'fill' && (field.readOnly || !['text','search','url','email','tel','number','textarea'].includes(field.type))) return {ok:false,reason:'unsupported_field'};
          if (action?.action === 'fill' && (!action.expected || (eventIndex === 0 && field.value !== action.expected.value) || field.tagName !== action.expected.tag || field.getAttribute('type') !== action.expected.type)) return {ok:false,reason:'field_changed'};
          if (view !== view.top || ['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(element.tagName)) return { ok: false, reason: 'iframe_unsupported' };
          for (let node = element; node; node = parent(node)) {
            if (node.inert || node.hasAttribute('inert')) return { ok: false, reason: 'inert' };
            if (node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' };
            const style = view.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') return { ok: false, reason: 'not_visible' };
            if (style.transform !== 'none' || !['', 'normal', '1'].includes(style.zoom)) return { ok: false, reason: 'geometry_unsupported' };
          }
          const viewport = view.visualViewport;
          if (viewport && (viewport.scale !== 1 || viewport.offsetLeft !== 0 || viewport.offsetTop !== 0)) return { ok: false, reason: 'viewport_unsupported' };
          const rect = element.getBoundingClientRect();
          const width = view.innerWidth;
          const height = view.innerHeight;
          if (![rect.x, rect.y, rect.width, rect.height, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || width > 32768 || height > 32768) return { ok: false, reason: 'invalid_geometry' };
          if (rect.width <= 0 || rect.height <= 0 || element.getClientRects().length !== 1) return { ok: false, reason: 'not_visible' };
          const left = Math.max(0, rect.x);
          const top = Math.max(0, rect.y);
          const right = Math.min(width, rect.x + rect.width);
          const bottom = Math.min(height, rect.y + rect.height);
          if (right - left < 2 || bottom - top < 2) return { ok: false, reason: 'not_visible' };
          const pointX = Math.floor((left + right) / 2);
          const pointY = Math.floor((top + bottom) / 2);
          if (!hitsTarget(pointX, pointY)) return { ok: false, reason: 'hit_target_blocked' };
          return { ok: true, x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: width, viewportHeight: height, pointX, pointY };
        }

        function unchanged(current, previous) {
          return ['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight', 'pointX', 'pointY'].every(key => current[key] === previous[key]);
        }

        function stop() {
          active = false;
          view.clearTimeout(timer);
          for (const type of types) view.removeEventListener(type, listener, true);
        }

        function ready() {
          if (!active) return false;
          // A paused page timer must not leave a guard that blocks later clicks.
          if (now() >= expiry) {
            if (eventIndex !== types.length) failure ||= 'guard_expired';
            stop();
            return false;
          }
          return true;
        }

        function listener(event) {
          if (keyboard) {
            if (!ready() || !event.isTrusted) return;
            const field = element.control || element;
            const current = read();
            if (!current.ok) failure ||= current.reason;
            else if (!unchanged(current, expected)) failure ||= 'moving_target';
            else if (doc.activeElement !== field || !event.composedPath().includes(field)) failure ||= 'hit_target_changed';
            else if (event.type !== types[eventIndex] || (action.action === 'press' && event.key !== action.key)) failure ||= 'target_events_missing';
            if (failure) { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); return; }
            eventIndex += 1;
            // Enter may replace the document before keyup can be observed.
            if (mayNavigate && event.type === 'keydown') report('complete');
            return;
          }
          if (!ready() || !event.isTrusted || event.button !== 0 || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
          if (Math.abs(event.clientX - expected.pointX) > 1 || Math.abs(event.clientY - expected.pointY) > 1) return;
          const current = read();
          if (!current.ok) failure ||= current.reason;
          else if (!unchanged(current, expected)) failure ||= 'moving_target';
          else if (!event.composedPath().includes(element) || !hitsTarget(event.clientX, event.clientY)) failure ||= 'hit_target_changed';
          else if (event.type !== types[eventIndex]) failure ||= 'target_events_missing';
          if (failure) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
          }
          eventIndex += 1;
          if (eventIndex === types.length) report('complete');
        }

        return {
          read,
          ready,
          arm(previous) {
            const current = read();
            if (!current.ok) return current;
            if (!unchanged(current, previous)) return { ok: false, reason: 'moving_target' };
            expected = current;
            if (keyboard) {
              const field = element.control || element;
              field.focus({preventScroll:true});
              if (action.action === 'fill') field.select();
              if (doc.activeElement !== field) return {ok:false,reason:'hit_target_changed'};
              const focused = read();
              if (!focused.ok || !unchanged(focused, current)) return {ok:false,reason:focused.reason||'moving_target'};
            }
            expiry = now() + 3000;
            active = true;
            for (const type of types) view.addEventListener(type, listener, { capture: true, passive: false });
            timer = view.setTimeout(() => { if (eventIndex !== types.length) failure ||= 'guard_expired'; stop(); }, 3000);
            return { ok: true };
          },
          outcome() {
            ready();
            return { ok: !failure && eventIndex === types.length && (action?.action !== 'fill' || (element.control||element).value === action.value), reason: failure || (eventIndex === types.length ? null : 'target_events_missing'), events: eventIndex };
          },
          stop,
        };
      }, {element: utilityElement, action, injected, binding});
      if (!nativeHandle(created) || created._context !== utility || typeof created.evaluate !== 'function' ||
        created._objectId === utilityElement._objectId || created._objectId === serverElement._objectId) {
        result.cleanup = 'unknown';
        throw new Error('adapter_unsupported');
      }
      guard = created;
    });

    const first = geometry(await bounded('geometry_first', () => guard.evaluate(control => control.read())));
    if (!first.ok) {
      result.reason = first.reason;
      return result;
    }
    // Hidden tabs may stop animation frames. This uses a Worker timer instead.
    await bounded('stability_wait', () => new Promise(resolve => setTimeout(resolve, 75)));
    if (action?.action === 'press' && action.key === 'Tab') {result.reason='unsupported_key';return result;}
    if (action?.action === 'fill' || action?.action === 'press') result.inputSent = true;
    // arm() checks the second geometry snapshot before it installs listeners.
    const armed = await bounded('guard_arm', () => guard.evaluate((control, previous) => control.arm(previous), first));
    if (!armed || typeof armed !== 'object' || typeof armed.ok !== 'boolean') throw new Error('invalid_guard');
    if (!armed.ok) {
      result.reason = typeof armed.reason === 'string' && armed.reason.length <= 80 ? armed.reason : 'invalid_guard';
      return result;
    }

    if (await bounded('guard_ready', () => guard.evaluate(control => control.ready())) !== true) {
      result.reason = 'guard_expired';
      return result;
    }
    result.inputSent = true;
    if (action?.action === 'fill') {
      await bounded('field_fill', () => action.value === '' ? page.keyboard.press('Backspace') : page.keyboard.insertText(action.value));
    } else if (action?.action === 'press') {
      await bounded('field_press', () => page.keyboard.press(action.key));
    } else {
      pressed = true;
      // Native click sends move, press, and release together. The guard stays active.
      await bounded('mouse_click', () => page.mouse.click(first.pointX, first.pointY, { button: 'left' }));
      pressed = false;
    }
    // A lost reply still needs the separate fallback stop below.
    const outcome = await bounded('guard_outcome', () => guard.evaluate(control => {
      try { return control.outcome(); }
      finally { control.stop(); }
    }));
    guardStopped = true;
    if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean' || !Number.isInteger(outcome.events) || outcome.events < 0 || outcome.events > 5 || !(outcome.reason === null || (typeof outcome.reason === 'string' && outcome.reason.length <= 80))) throw new Error('invalid_guard');
    result.ok = outcome.ok && outcome.events === (action?.action === 'fill' || action?.action === 'press' ? 2 : 5) && outcome.reason === null;
    result.reason = result.ok ? null : outcome.reason || 'target_events_missing';
  } catch (error) {
    // A lost call may still reach Chrome. The caller must settle the transport.
    // A timed-out guard check sent no input; cleanup decides if refusal is safe.
    const timedOutReady = !result.inputSent && error?.message === 'helper_deadline' && lastTimedOutStage === 'guard_ready';
    result.reason = timedOutReady ? 'guard_expired' : !result.inputSent && ['invalid_geometry', 'invalid_guard', 'adapter_unsupported'].includes(error?.message) ? error.message : 'outcome_unknown';
    if (result.reason === 'outcome_unknown') result.cleanup = 'unknown';
  } finally {
    const cleanupDeadline = performance.now() + 1000;
    try {
      if (pressed) await bounded('cleanup_mouse_up', () => page.mouse.up({ button: 'left' }), cleanupDeadline);
    } catch {
      result.cleanup = 'unknown';
    }
    let stopSettled = !guard || guardStopped;
    try {
      if (guard && !guardStopped) await bounded('cleanup_guard_stop', async () => {
        try { await guard.evaluate(control => control.stop()); }
        finally { stopSettled = true; }
      }, cleanupDeadline);
    } catch {
      result.cleanup = 'unknown';
    }
    // Timeout does not cancel native stop. Keep its handles until it settles.
    if (stopSettled) await Promise.all([
      ...[guard, utilityElement].map(async handle => {
        if (!handle) return;
        try {
          await bounded('cleanup_dispose', () => releaseOwned(handle), cleanupDeadline);
        } catch {
          result.cleanup = 'unknown';
        }
      }),
      ...handles.map(async client => {
        try {
          await bounded('cleanup_dispose', () => releaseOwned(originals.get(client) ?? implementation(client)), cleanupDeadline);
        } catch {
          result.cleanup = 'unknown';
        }
        // Skip SDK disposal when ownership was refused.
        if (!originals.has(client)) return;
        try {
          // Clear the client dispatcher only after its native release attempt.
          await bounded('cleanup_dispose', () => client.dispose(), cleanupDeadline);
        } catch {
          result.cleanup = 'unknown';
        }
      }),
    ]);
    if (result.cleanup === 'unknown') {
      result.ok = false;
      result.reason = 'outcome_unknown';
    }
  }
  return result;
}


function locate(frame, input) {
  if (input.by === 'role') return frame.getByRole(input.role, { name: input.name, exact: true, includeHidden: true });
  if (input.by === 'label') return frame.getByLabel(input.label, { exact: true });
  return frame.getByText(input.text, { exact: true });
}
async function utilityRead(page, label) {
  const connection = page._connection;
  if (
    typeof connection?.toImpl !== 'function' ||
    !(connection._objects instanceof Map) ||
    connection._objects.get(page._guid) !== page
  )
    throw new Error('adapter_unsupported');
  const frame = page.mainFrame();
  if (connection._objects.get(frame._guid) !== frame) throw new Error('adapter_unsupported');
  const server = connection.toImpl(frame);
  const utility = await server._utilityContext();
  if (utility.world !== 'utility' || utility.frame !== server || typeof utility.injectedScript !== 'function')
    throw new Error('adapter_unsupported');
  const injected = await utility.injectedScript();
  return utility.evaluate(
    ({ injected, label }) => {
      if (
        typeof injected?.utils?.getElementAccessibleName !== 'function' ||
        typeof injected.utils.elementText !== 'function'
      )
        throw new Error('adapter_unsupported');
      // Use the SDK's names and label aliases on the same utility document.
      const name = (node) => injected.utils.getElementAccessibleName(node, true);
      function sensitive(field) {
        const labels = [
          ...(field.labels || []),
          ...(field.getAttribute('aria-labelledby') || '')
            .split(/\s+/)
            .filter(Boolean)
            .map((id) => field.getRootNode().getElementById(id)),
        ].filter(Boolean);
        const textCache = new Map();
        return (
          field.matches('input[type="password"],input[type="file"],[autocomplete="one-time-code"]') ||
          /password|passcode|one.?time|otp|verification.?code/i.test(
            [
              field.id,
              field.name,
              field.autocomplete,
              field.getAttribute('aria-label'),
              name(field),
              ...labels.map((label) => injected.utils.elementText(textCache, label).full),
            ].join(' '),
          )
        );
      }
      let selectedLabel = null;
      if (label !== undefined) {
        const matches = injected.querySelectorAll(
          injected.parseSelector('internal:label=' + JSON.stringify(label) + 's'),
          document,
        );
        if (matches.length === 1) selectedLabel = name(matches[0]);
      }
      const fields = [];
      for (const field of document.querySelectorAll('input,textarea')) {
        if (fields.length >= 128) break;
        if (sensitive(field)) continue;
        fields.push({
          tag: field.tagName,
          type: field.getAttribute('type'),
          value: String(field.value).slice(0, 16384),
          label: name(field).slice(0, 500),
        });
      }
      const lines = [];
      for (const node of document.querySelectorAll('button,a,input,textarea,select,[role]')) {
        if (lines.length >= 200) break;
        if ((['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) || node.isContentEditable) && sensitive(node))
          continue;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        lines.push((node.getAttribute('role') || node.tagName.toLowerCase()) + ' ' + name(node).slice(0, 500));
      }
      return {
        text: (document.body?.innerText || '').slice(0, 24000),
        accessibility: lines.join('\n').slice(0, 24000),
        fields,
        selectedLabel,
        iframeCount: document.querySelectorAll('iframe,frame').length,
      };
    },
    { injected, label },
  );
}
async function checkedFrames(page, allowed) {
  const frames = page.frames();
  const frameSet = new Set(frames);
  const main = page.mainFrame();
  if (frames.length > 65 || frameSet.size !== frames.length || !frameSet.has(main)) return null;
  const connection = page._connection;
  const policies = new Map();
  function policy(frame) {
    if (policies.has(frame)) return policies.get(frame);
    if (!frameSet.has(frame) || connection._objects.get(frame._guid) !== frame) return null;
    policies.set(frame, null);
    const parent = frame.parentFrame();
    if (frame === main) {
      if (parent !== null) return null;
      const accepted = allowed(frame.url());
      policies.set(frame, accepted);
      return accepted;
    }
    if (!parent || !frameSet.has(parent) || !parent.childFrames().includes(frame)) return null;
    const parentAllowed = policy(parent);
    if (parentAllowed === null) return null;
    const url = frame.url();
    let protocol;
    try {
      protocol = new URL(url).protocol;
    } catch {
      return null;
    }
    let accepted;
    // Blank and data documents inherit the checked parent host policy.
    if (url === 'about:blank' || url === 'about:srcdoc' || protocol === 'data:') accepted = parentAllowed;
    else if (protocol === 'http:' || protocol === 'https:') accepted = allowed(url);
    else return null;
    policies.set(frame, accepted);
    return accepted;
  }
  if (policy(main) !== true) return null;
  const allowedFrames = [];
  let blocked = false;
  for (const frame of frames) {
    const accepted = policy(frame);
    if (accepted === null) return null;
    // Skip blocked child utility worlds; Capture refuses the blocked flag.
    if (!accepted) {
      blocked = true;
      continue;
    }
    const server = connection.toImpl(frame);
    const utility = await server._utilityContext();
    if (utility.world !== 'utility' || utility.frame !== server) return null;
    const count = await utility.evaluate(() => document.querySelectorAll('iframe,frame').length);
    if (!Number.isSafeInteger(count) || count < 0 || count > frame.childFrames().length) return null;
    allowedFrames.push(frame);
  }
  return { frames: allowedFrames, blocked };
}
export default class PlaywriterExecutor extends WorkerEntrypoint {
  revision() {
    return '${PLAYWRITER_EXECUTOR_REVISION}';
  }
  async evaluate(input) {
    let browser;
    const result = { ok: false, reason: 'outcome_unknown', inputSent: false, cleanup: 'complete' };
    try {
      browser = await connect(
        'http://fake.host/v1/devtools/browser/' + input.commandId + '?persistent=true&browser_binding=BROWSER',
      );
      const contexts = browser.contexts();
      if (contexts.length !== 1 || contexts[0].pages().length !== 1) return { ...result, reason: 'inventory_changed' };
      const page = contexts[0].pages()[0];
      page.on('dialog', () => {});
      page.setDefaultTimeout(Math.min(4500, Math.max(1, input.deadline - Date.now())));
      const allowed = (url) => {
        try {
          if (url === 'about:blank') return true;
          const parsed = new URL(url);
          return (
            ['http:', 'https:'].includes(parsed.protocol) &&
            !parsed.username &&
            !parsed.password &&
            !browser_web_url_host_matches(url, input.blockedHosts)
          );
        } catch {
          return false;
        }
      };
      if (!allowed(page.url())) return { ...result, reason: 'blocked_site' };
      const operation = input.operation;
      if (operation.kind === 'read') {
        if (!(await checkedFrames(page, allowed))) return { result: { ...result, reason: 'iframe_unsupported' } };
        const read = await utilityRead(page);
        const title = (await page.title()).slice(0, 1024);
        if (!allowed(page.url())) return { result: { ...result, reason: 'blocked_site' } };
        const current = await checkedFrames(page, allowed);
        if (!current) return { result: { ...result, reason: 'iframe_unsupported' } };
        const frames = current.frames.filter((frame) => frame !== page.mainFrame()).slice(0, 64);
        return {
          result: { ...result, ok: true, reason: null },
          observation: {
            kind: 'read',
            observationRevision: input.observationRevision,
            url: page.url().slice(0, 8192),
            title,
            text: read.text,
            accessibility: read.accessibility,
            frames: frames.map((frame) => ({ frameRef: crypto.randomUUID(), url: frame.url().slice(0, 8192) })),
          },
          privateFields: read.fields,
        };
      }
      if (operation.kind === 'capture') {
        const initial = await checkedFrames(page, allowed);
        if (!initial || initial.blocked) return { result: { ...result, reason: 'iframe_unsupported' } };
        const cdp = await contexts[0].newCDPSession(page);
        try {
          const image = await cdp.send('Page.captureScreenshot', {
            format: operation.format,
            captureBeyondViewport: false,
          });
          if (!allowed(page.url())) return { result: { ...result, reason: 'blocked_site' } };
          // A child can navigate while the screenshot is pending.
          const current = await checkedFrames(page, allowed);
          if (!current || current.blocked) return { result: { ...result, reason: 'iframe_unsupported' } };
          return {
            result: { ...result, ok: true, reason: null },
            observation: {
              kind: 'capture',
              observationRevision: input.observationRevision,
              format: operation.format,
              data: image.data,
            },
          };
        } finally {
          await cdp.detach();
        }
      }
      if (operation.kind === 'navigate') {
        if (operation.url === 'about:blank' || !allowed(operation.url))
          return { result: { ...result, reason: 'blocked_site' } };
        result.inputSent = true;
        await page.goto(operation.url, {
          waitUntil: 'domcontentloaded',
          timeout: Math.max(1, input.deadline - Date.now()),
        });
        result.ok = allowed(page.url());
        result.reason = result.ok ? null : 'blocked_site';
        return { result };
      }
      if (operation.frameRef !== undefined) return { result: { ...result, reason: 'iframe_unsupported' } };
      if (operation.action === 'scroll') {
        const server = page._connection.toImpl(page.mainFrame());
        const utility = await server._utilityContext();
        if (utility.world !== 'utility' || utility.frame !== server)
          return { result: { ...result, reason: 'adapter_unsupported' } };
        result.inputSent = true;
        await utility.evaluate(({ x, y }) => window.scrollBy({ left: x, top: y, behavior: 'instant' }), {
          x: operation.deltaX,
          y: operation.deltaY,
        });
        result.ok = true;
        result.reason = null;
      } else {
        const locator = locate(page, operation.locator);
        let expected;
        if (operation.action === 'fill') {
          const read = await utilityRead(page, operation.locator.by === 'label' ? operation.locator.label : undefined);
          const label =
            operation.locator.by === 'label'
              ? read.selectedLabel
              : operation.locator.by === 'role' &&
                  ['textbox', 'spinbutton', 'combobox'].includes(operation.locator.role)
                ? operation.locator.name
                : null;
          if (label === null) return { result: { ...result, reason: 'field_unobserved' } };
          const matches = input.privateFields.filter((field) => field.label === label);
          const current = read.fields.filter((field) => field.label === label);
          if (matches.length !== 1 || current.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(current[0]))
            return { result: { ...result, reason: 'field_changed' } };
          expected = matches[0];
        }
        const clicked = await backgroundClick(page, locator, { ...operation, expected }, input.observationRevision);
        result.ok = clicked.ok;
        result.reason = clicked.reason;
        result.inputSent = clicked.inputSent;
        result.cleanup = clicked.cleanup;
      }
      if (!allowed(page.url())) {
        result.ok = false;
        result.reason = 'blocked_site';
      }
      return { result };
    } catch {
      return { result: { ...result, reason: 'outcome_unknown', cleanup: 'unknown' } };
    } finally {
      try {
        await browser?.close();
      } catch {}
    }
  }
}
`;
