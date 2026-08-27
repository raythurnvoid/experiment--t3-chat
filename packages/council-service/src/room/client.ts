/**
 * The two inline scripts of the meeting room page, as plain strings.
 *
 * The strings avoid backticks and template interpolation because `page.ts` embeds them in a
 * template literal. The client keeps the session proof in its httpOnly cookie and keeps the CSRF
 * token only in this script closure.
 */

export const council_room_boot_js = `
(function () {
	"use strict";
	var entry = { ticket: null };
	var hash = window.location.hash;
	if (hash && hash.length > 1) {
		entry.ticket = new URLSearchParams(hash.slice(1)).get("ticket");
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}
	window.__councilEntry = entry;
})();
`;

export const council_room_client_js = `
(function () {
	"use strict";

	// Keep this below ADMISSION_ATTEMPT_LEASE_MS in routes-room.ts. When the join gives up, the
	// host presses again, and that retry must arrive while the server still holds the lease for
	// the first attempt. With the two values equal the retry lands on the lease boundary, two
	// attempts run on one participant row, and the late one can delete the provider participant
	// the winner is already using. The other deadlines below are unrelated to that lease.
	var JOIN_TIMEOUT_MS = 30000;
	var GUEST_SESSION_TIMEOUT_MS = 30000;
	var START_RECORDING_TIMEOUT_MS = 30000;
	var CLOSE_TIMEOUT_MS = 30000;
	var STATE_POLL_TIMEOUT_MS = 30000;

	/**
	 * The featured stage has two explicit rows and the featured tile spans both, so its side
	 * columns hold four tiles at most. One featured tile plus four is the whole layout.
	 */
	var FEATURED_LAYOUT_MAX_TILES = 5;

	/**
	 * The label of the one recording control, by recording stage. A meeting records at most once, so
	 * "requested", "finished" and "unavailable" are dead ends, and the button stays disabled in all
	 * three. "pending" is not a dead end. It only says this browser is still waiting for the start
	 * answer. The button stays enabled through it and only marks itself busy, because a disabled
	 * control blurs and the host would spend the whole wait on the body.
	 *
	 * "idle" and "unsaved" both offer the control, and both wear the same label, because the one
	 * action it offers is the same. The service answers 503 when the provider answered and refused
	 * the start, and 500 when storing the recording id failed. It leaves the meeting open with no
	 * recording on it in both, so a new press can still work. handle_start_recording in
	 * routes-room.ts says so at each of those two answers.
	 *
	 * What the room may say about files differs. After a 503 nothing was ever recorded, so "idle"
	 * is true. After a 500 the provider did start a recording and the service kept no id for it, so
	 * its files can never be sealed, however long it ran. "unsaved" says that: no files from that
	 * attempt, and the control is still open. Plain "idle" cannot say it, because the provider's
	 * own broadcast promotes "idle" to "requested" and the room would go on to promise those files.
	 */
	var RECORDING_LABELS = {
		idle: "Start recording",
		pending: "Starting recording…",
		requested: "Recording requested",
		finished: "Recording finished",
		unavailable: "Recording unavailable",
		unsaved: "Start recording",
	};

	var csrfToken = null;
	var csrfRefresh = null;
	var bootGeneration = 0;
	var endConfirmDescription = "";

	var state = {
		meeting: null,
		participant: null,
		guestMeetingId: null,
		joinAttempt: null,
		joinOperation: null,
		joinSequence: 0,
		sdk: null,
		pollTimer: null,
		pollRequest: null,
		elapsedTimer: null,
		callStatusTimer: null,
		closeController: null,
		meetingStartedAt: null,
		callListeners: [],
		tiles: {},
		blockedAudio: [],
		pendingAudio: [],
		pinnedKey: null,
		reconnecting: false,
		recordingStage: "idle",
		recordingActive: false,
		over: false,
		disposed: false,
	};

	function byId(id) {
		return document.getElementById(id);
	}

	var VIEW_IDS = ["view-loading", "view-guest", "view-lobby", "view-call", "view-ended", "view-error"];

	function showView(viewId, focusId) {
		VIEW_IDS.forEach(function (candidate) {
			byId(candidate).hidden = candidate !== viewId;
		});
		byId("room-header").hidden = viewId !== "view-call";
		if (focusId) {
			var target = byId(focusId);
			if (target) {
				target.focus();
			}
		}
	}

	function showFatal(message) {
		// Unhide first, then write. #error-message is role="alert", and its whole view ships hidden.
		// A hidden ancestor takes the element out of the accessibility tree, so it carries no live
		// region and text written before this line changes nothing a screen reader was watching.
		// Every sentence that reaches here names the one thing the participant can still do, so
		// losing it leaves them on a screen that says nothing. setError and setCallStatus do the
		// same two steps in the same order.
		showView("view-error", "error-heading");
		setText("error-message", message);
	}

	function setText(id, text) {
		var element = byId(id);
		if (element) {
			element.textContent = text;
		}
	}

	function setError(id, message) {
		var element = byId(id);
		if (message === null) {
			element.hidden = true;
			element.textContent = "";
		} else {
			element.hidden = false;
			element.textContent = message;
		}
	}

	/**
	 * Refuse one field. Say why in the form's error line, and make the field itself carry that
	 * reason.
	 *
	 * The error line is role="alert", so it speaks once and is never read again. Each field's
	 * aria-describedby names only its static hint. So a member who tabs away and comes back hears
	 * "Join code, edit, invalid entry, The code the meeting host shared with you" and never learns
	 * which of the four reasons applied. Pointing the field's description at the error line while it
	 * is refused puts the reason back in the field's own name, every time focus enters it.
	 *
	 * The Council plugin's CreateMeetingForm solves the same problem by swapping the reason into the
	 * field's help paragraph. Here one shared line already carries every message on screen, so
	 * pointing at it keeps the sentence in one place instead of printing it twice.
	 *
	 * Write the message before moving focus, so the description is already there when it is read.
	 */
	function refuseField(input, hintId, errorId, message) {
		setError(errorId, message);
		input.setAttribute("aria-invalid", "true");
		input.setAttribute("aria-describedby", hintId + " " + errorId);
		input.focus();
	}

	function clearFieldRefusal(input, hintId) {
		input.removeAttribute("aria-invalid");
		input.setAttribute("aria-describedby", hintId);
	}

	function apiPost(path, body, signal) {
		var headers = { "Content-Type": "application/json" };
		if (csrfToken !== null) {
			headers["X-Council-Csrf"] = csrfToken;
		}
		return fetch(path, {
			method: "POST",
			headers: headers,
			credentials: "same-origin",
			body: JSON.stringify(body),
			signal: signal,
		}).then(function (response) {
			if (response.ok) {
				return response.json();
			}
			return response
				.json()
				.catch(function () {
					return {};
				})
				.then(function (data) {
					var message =
						data && typeof data.message === "string" && data.message !== ""
							? data.message
							: "Request failed (" + response.status + ")";
					var error = new Error(message);
					error.status = response.status;
					throw error;
				});
		});
	}

	/**
	 * Resume the cookie session once per page, and let every waiting call share that one resume.
	 *
	 * This page holds one csrfToken, and the server keeps one CSRF token per session, so a resume
	 * replaces the token for everybody. If two calls answer 401 together and each starts its own
	 * resume, the server rotates twice and keeps only the last token. The other call then repeats
	 * itself with a token the server has already replaced, takes a second 401, and the page tells
	 * the participant to reload a room that is fine. The page also stays one rotation behind after
	 * that, because whichever resume answered last wrote its own dead token into csrfToken, so every
	 * later call is refused too. The meeting-state poll runs every ten seconds, so a call is nearly
	 * always in the air and an overlapping pair needs no second document.
	 */
	function refreshCsrfOnce() {
		if (csrfRefresh !== null) {
			return csrfRefresh;
		}
		// Do not take a caller's signal here. The callers share this one resume, so one caller's
		// deadline would abort the resume the others are waiting on. Carry a private deadline
		// instead, the way every other request in this file does, so a session route that never
		// answers cannot leave the waiters pending for good.
		var controller = typeof AbortController === "function" ? new AbortController() : null;
		var timeout = setTimeout(function () {
			if (controller) {
				controller.abort();
			}
		}, GUEST_SESSION_TIMEOUT_MS);
		// Name the meeting this page is in. A resume with no meeting id adopts the session the
		// room cookie points at, which may be a different meeting.
		csrfRefresh = apiPost(
			"/room/api/session",
			{ meetingId: state.meeting.id },
			controller ? controller.signal : undefined,
		)
			.then(function (session) {
				csrfToken = session.csrfToken;
			})
			.finally(function () {
				clearTimeout(timeout);
				csrfRefresh = null;
			});
		return csrfRefresh;
	}

	// A second document on this same room URL takes the CSRF token away from this one. Resuming the
	// cookie session rotates the token, and a duplicated tab or a guest who opens their invite link
	// again does exactly that. This page's token then answers 401 on every route that checks it. In
	// the lobby that is Join, and the room becomes a dead end: the page never gets into the meeting
	// and pressing Join again repeats the same refusal. In the call the host controls stop working,
	// and the meeting-state poll, which is the room's only server-side end detection, dies without a
	// sign on screen. So resume the session once, take the fresh token, and repeat the call. Every
	// route below checks auth first, so a 401 changed nothing and repeating the call is safe.
	function apiPostWithCsrfRefresh(path, body, signal) {
		return apiPost(path, body, signal).catch(function (error) {
			if (!error || error.status !== 401) {
				throw error;
			}
			return refreshCsrfOnce()
				.then(function () {
					return apiPost(path, body, signal);
				})
				.catch(function (retryError) {
					// Keep every other failure as it is, including an abort at the caller's deadline.
					// Only a second 401 says this page cannot speak for its session any more.
					if (retryError && retryError.status === 401) {
						var stale = new Error("This room page is no longer the active one. Reload the page.");
						stale.status = 401;
						throw stale;
					}
					throw retryError;
				});
		});
	}

	function errorText(error) {
		return error && typeof error.message === "string" && error.message !== ""
			? error.message
			: "Something went wrong.";
	}

	function safeOff(emitter, eventName, handler) {
		if (!emitter) {
			return;
		}
		if (typeof emitter.off === "function") {
			emitter.off(eventName, handler);
		} else if (typeof emitter.removeListener === "function") {
			emitter.removeListener(eventName, handler);
		}
	}

	function addCallListener(emitter, eventName, handler) {
		if (!emitter || typeof emitter.on !== "function") {
			return;
		}
		emitter.on(eventName, handler);
		state.callListeners.push(function () {
			safeOff(emitter, eventName, handler);
		});
	}

	function clearCallListeners() {
		state.callListeners.splice(0).forEach(function (cleanup) {
			cleanup();
		});
	}

	// #region session

	function adoptSession(session) {
		csrfToken = session.csrfToken;
		state.meeting = session.meeting;
		state.participant = session.participant;
		state.over = false;
		restoreJoinButton();
		// A refusal belongs to the session it refused, and this is a different session. Pasting a
		// fresh room link into a tab that is already in the lobby is a hashchange, not a navigation,
		// so nothing reloads the document: the red line about the previous meeting would stay on
		// screen, with #host-name still marked invalid and described by that line. Put both back the
		// way joinMeeting does before every attempt. teardownCall clears #host-error for the same
		// reason.
		setError("lobby-error", null);
		clearFieldRefusal(byId("host-name"), "host-name-hint");
		renderLobby();
		showView("view-lobby", "lobby-heading");
	}

	function resetLiveCall() {
		state.over = true;
		cancelJoinOperation();
		teardownCall(true);
	}

	function displayInitials(name) {
		var parts = typeof name === "string" ? name.trim().split(/\s+/).filter(Boolean) : [];
		if (parts.length === 0) {
			return "?";
		}
		return (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "")).toUpperCase();
	}

	function renderLobby() {
		var meeting = state.meeting || {};
		var participant = state.participant || {};
		var title = typeof meeting.title === "string" && meeting.title !== "" ? meeting.title : "Council meeting";
		setText("meeting-title", title);
		setText("lobby-meeting", title);
		var displayName = typeof participant.displayName === "string" ? participant.displayName : "";
		setText("lobby-name", displayName || "Choose a display name");
		setText("lobby-avatar", displayInitials(displayName));
		setText("lobby-role", participant.role === "host" ? "Host" : "Guest");
		var hostNeedsName = participant.role === "host" && displayName === "";
		byId("host-name-field").hidden = !hostNeedsName;
		// The markup cannot carry required: this field is hidden for a host who already has a name,
		// and a hidden control is still constraint-validated, so required here would block the lobby
		// form's submit for every one of them. joinMeeting runs the check, and this attribute is the
		// only thing that tells a screen reader the field has to be filled in.
		byId("host-name").setAttribute("aria-required", hostNeedsName ? "true" : "false");
		if (typeof meeting.deadlineAt === "number" && isFinite(meeting.deadlineAt)) {
			setText("lobby-deadline", "The room closes at " + new Date(meeting.deadlineAt).toLocaleString() + ".");
		} else {
			setText("lobby-deadline", "");
		}
		byId("start-recording-button").hidden = participant.role !== "host";
		byId("end-meeting-button").hidden = participant.role !== "host";
	}

	// #endregion session

	// #region guest form

	function submitGuestForm(event) {
		event.preventDefault();
		var submitButton = byId("guest-submit");
		// Do not disable the button while the invite check runs. The browser blurs a focused control
		// the moment it turns disabled, nothing brings focus back, and this is the only control on
		// the page: the guest would spend the whole wait on the body with nothing to tab to. Mark it
		// busy and ignore repeat presses instead.
		if (submitButton.getAttribute("aria-busy") === "true") {
			return;
		}
		var codeInput = byId("guest-code");
		var nameInput = byId("guest-name");
		var emailInput = byId("guest-email");
		var code = codeInput.value.trim();
		var displayName = nameInput.value.trim();
		var email = emailInput.value.trim();

		clearFieldRefusal(codeInput, "guest-code-hint");
		clearFieldRefusal(nameInput, "guest-name-hint");
		if (code === "") {
			refuseField(codeInput, "guest-code-hint", "guest-error", "Enter the join code you were given.");
			return;
		}
		if (displayName === "") {
			refuseField(nameInput, "guest-name-hint", "guest-error", "Enter the name to show to other participants.");
			return;
		}
		// The server caps the display name at 128 UTF-8 bytes. A length limit in the markup cannot
		// stand in for this check, because the browser counts UTF-16 units: 44 CJK characters are 44
		// units and 132 bytes, so the form would send them. The refusal that comes back is the raw
		// validator line "displayName is longer than 128 bytes", which names a JSON field and a unit
		// the guest never typed. Each of those tries also spends one of the guest-join attempts
		// the server allows per address in ten minutes, because it charges that bucket before it
		// reads the body. The count itself lives in council_RATE_LIMITS in db.ts. Naming it here is
		// how this line went stale, and this file is served to every guest as plain text, so a
		// wrong number is readable in view-source.
		if (new TextEncoder().encode(displayName).length > 128) {
			refuseField(nameInput, "guest-name-hint", "guest-error", "That display name is too long. Try a shorter one.");
			return;
		}
		setError("guest-error", null);

		var attemptKey = code + "\\u0000" + displayName + "\\u0000" + email;
		if (state.joinAttempt === null || state.joinAttempt.key !== attemptKey) {
			state.joinAttempt = { key: attemptKey, id: crypto.randomUUID() };
		}

		var generation = bootGeneration;
		var controller = typeof AbortController === "function" ? new AbortController() : null;
		var timeout = setTimeout(function () {
			if (controller) {
				controller.abort();
			}
		}, GUEST_SESSION_TIMEOUT_MS);
		submitButton.setAttribute("aria-busy", "true");
		submitButton.textContent = "Checking invite…";
		apiPost("/room/api/guest-session", {
			meetingId: state.guestMeetingId,
			code: code,
			displayName: displayName,
			email: email === "" ? null : email,
			joinAttemptId: state.joinAttempt.id,
		}, controller ? controller.signal : undefined)
			.then(function (session) {
				if (generation !== bootGeneration) {
					return;
				}
				submitButton.removeAttribute("aria-busy");
				submitButton.textContent = "Continue";
				adoptSession(session);
			})
			.catch(function (error) {
				if (generation !== bootGeneration) {
					return;
				}
				submitButton.removeAttribute("aria-busy");
				submitButton.textContent = "Continue";
				var message =
					error && error.name === "AbortError"
						? "Checking the invite took too long. Check your connection, then try again."
						: errorText(error);
				// A mistyped code is the common way this form fails, and the route answers 401 for
				// that one case only. Mark and focus the field the same way the empty-code branch
				// above does, so the guest lands on the box they have to fix instead of staying on
				// the submit button with nothing pointing at it.
				if (error && error.status === 401) {
					refuseField(codeInput, "guest-code-hint", "guest-error", message);
					return;
				}
				setError("guest-error", message);
			})
			.finally(function () {
				clearTimeout(timeout);
			});
	}

	// #endregion guest form

	// #region join operation

	function isJoinActive(operation) {
		return (
			state.joinOperation !== null &&
			state.joinOperation.id === operation.id &&
			operation.bootGeneration === bootGeneration &&
			!state.disposed
		);
	}

	function restoreJoinButton() {
		var joinButton = byId("join-button");
		joinButton.removeAttribute("aria-busy");
		joinButton.textContent = "Join meeting";
		setText("lobby-progress", "");
	}

	function clearJoinDeadline(operation) {
		if (operation.timer !== null) {
			clearTimeout(operation.timer);
			operation.timer = null;
		}
	}

	function leaveSdk(sdk) {
		if (sdk && typeof sdk.leave === "function") {
			Promise.resolve(sdk.leave()).catch(function () {});
		}
	}

	function cancelJoinOperation() {
		var operation = state.joinOperation;
		if (!operation) {
			return;
		}
		state.joinOperation = null;
		clearJoinDeadline(operation);
		if (operation.controller) {
			operation.controller.abort();
		}
		if (operation.cancelRoomJoined) {
			operation.cancelRoomJoined();
		}
		if (operation.sdk) {
			if (state.sdk === operation.sdk) {
				state.sdk = null;
			}
			leaveSdk(operation.sdk);
		}
	}

	function failJoin(operation, message) {
		if (!isJoinActive(operation)) {
			return;
		}
		cancelJoinOperation();
		teardownCall(false);
		restoreJoinButton();
		setError("lobby-error", message);
	}

	function createRoomJoinedWaiter(operation, sdk) {
		var settled = false;
		var handler = null;
		var resolveWaiter = null;
		var promise = new Promise(function (resolve) {
			resolveWaiter = resolve;
		});

		function finish(joined) {
			if (settled) {
				return;
			}
			settled = true;
			if (handler) {
				safeOff(sdk.self, "roomJoined", handler);
			}
			resolveWaiter(joined);
		}

		handler = function () {
			finish(true);
		};
		if (sdk.self && typeof sdk.self.on === "function") {
			sdk.self.on("roomJoined", handler);
		}
		operation.cancelRoomJoined = function () {
			finish(false);
		};
		return {
			promise: promise,
			finish: finish,
		};
	}

	function joinSdk(operation, sdk) {
		var waiter = createRoomJoinedWaiter(operation, sdk);
		return Promise.resolve(sdk.join()).then(
			function () {
				if (!isJoinActive(operation)) {
					waiter.finish(false);
					leaveSdk(sdk);
					return false;
				}
				if (sdk.self.roomJoined) {
					waiter.finish(true);
				}
				return waiter.promise;
			},
			function () {
				waiter.finish(false);
				throw new Error("provider-join-failed");
			}
		);
	}

	function joinMeeting() {
		var joinButton = byId("join-button");
		// Do not disable the button while the admission request runs. The browser blurs a focused
		// control the moment it turns disabled, nothing brings focus back, and the lobby then has
		// nothing left to tab to for the whole JOIN_TIMEOUT_MS wait. Mark it busy and ignore repeat
		// presses instead. The guard is what makes that safe: joinMeeting cancels the join in
		// progress on every call, so without it a second press would cancel and restart the join.
		if (joinButton.getAttribute("aria-busy") === "true") {
			return;
		}
		var joinBody = {};
		var hostNameField = byId("host-name-field");
		if (hostNameField && !hostNameField.hidden) {
			var nameInput = byId("host-name");
			var displayName = nameInput.value.trim();
			clearFieldRefusal(nameInput, "host-name-hint");
			if (displayName === "") {
				refuseField(nameInput, "host-name-hint", "lobby-error", "Enter the name to show to other participants.");
				return;
			}
			// Same 128-byte cap the guest form checks, and the same reason a length limit in the
			// markup cannot stand in for it: the browser counts UTF-16 units, the server counts bytes.
			if (new TextEncoder().encode(displayName).length > 128) {
				refuseField(nameInput, "host-name-hint", "lobby-error", "That display name is too long. Try a shorter one.");
				return;
			}
			joinBody.displayName = displayName;
		}

		cancelJoinOperation();
		var controller = typeof AbortController === "function" ? new AbortController() : null;
		var operation = {
			id: ++state.joinSequence,
			bootGeneration: bootGeneration,
			controller: controller,
			timer: null,
			stage: "admission",
			sdk: null,
			cancelRoomJoined: null,
		};
		state.joinOperation = operation;
		state.over = false;
		setError("lobby-error", null);
		joinButton.setAttribute("aria-busy", "true");
		joinButton.textContent = "Joining…";
		setText("lobby-progress", "Requesting a place in the meeting…");
		operation.timer = setTimeout(function () {
			failJoin(operation, "Joining took too long. Check your connection, then try again.");
		}, JOIN_TIMEOUT_MS);

		// Join checks the CSRF token like the in-call routes do, so it needs the same refresh. Without
		// it a second document on this room URL leaves this page's Join answering 401 for good, and
		// the lobby has no way into the meeting. The refresh names the meeting through state.meeting,
		// which adoptSession set before the lobby rendered. Repeating the join is safe: the 401 comes
		// back before the route's rate limit, so a refused try spends no attempt, and the admission is
		// idempotent through its attempt id.
		apiPostWithCsrfRefresh("/room/api/join", joinBody, controller ? controller.signal : undefined)
			.then(function (data) {
				if (!isJoinActive(operation)) {
					return null;
				}
				if (typeof RealtimeKitClient === "undefined") {
					failJoin(operation, "The meeting software did not load. Reload the page and try again.");
					return null;
				}
				operation.stage = "initializing";
				setText("lobby-progress", "Starting secure audio and video…");
				return RealtimeKitClient.init({ authToken: data.authToken, defaults: { audio: true, video: false } });
			})
			.then(function (sdk) {
				if (!sdk) {
					return null;
				}
				if (!isJoinActive(operation)) {
					leaveSdk(sdk);
					return null;
				}
				operation.sdk = sdk;
				state.sdk = sdk;
				// Listen for the device reason here, not in wireCallEvents. The join-time enableAudio
				// below emits mediaPermissionUpdate during its own call, and wireCallEvents only runs
				// after the join succeeds, so a listener added there never hears it. Without this the
				// room could say only that the microphone is off, never why.
				// Start from an empty status line, because enterCall reads it to decide whether
				// anything already said why. A line left over from an earlier call in this same
				// document would answer for this join.
				setCallStatus("");
				addCallListener(sdk.self, "mediaPermissionUpdate", function (payload) {
					handleMediaPermissionUpdate(payload, sdk);
				});
				operation.stage = "joining";
				setText("lobby-progress", "Waiting for the meeting to admit you…");
				return joinSdk(operation, sdk);
			})
			.then(function (roomJoined) {
				if (roomJoined === null || roomJoined === false || !isJoinActive(operation)) {
					return null;
				}
				operation.cancelRoomJoined = null;
				operation.stage = "microphone";
				setText("lobby-progress", "Setting up your microphone…");
				if (state.sdk.self.audioEnabled) {
					return true;
				}
				// Judge the microphone by the track, not by the promise. The SDK swallows every
				// device and permission error in an empty catch, so enableAudio resolves even when
				// the microphone never started. The listener registered above is already running, so
				// a reason the SDK does send has reached the status line by the time this settles.
				// This flag only tells enterCall whether the microphone came up at all.
				return Promise.resolve(state.sdk.self.enableAudio()).then(
					function () {
						return state.sdk.self.audioEnabled === true;
					},
					function () {
						return false;
					}
				);
			})
			.then(function (micOn) {
				if (micOn === null || !isJoinActive(operation)) {
					return;
				}
				clearJoinDeadline(operation);
				enterCall(micOn);
				state.joinOperation = null;
				restoreJoinButton();
			})
			.catch(function (error) {
				if (!isJoinActive(operation)) {
					return;
				}
				var message =
					operation.stage === "admission"
						? errorText(error)
						: "Could not enter the meeting. Check your connection, then try again.";
				failJoin(operation, message);
			});
	}

	// #endregion join operation

	// #region participant media

	function participantName(participant) {
		return participant && typeof participant.name === "string" && participant.name.trim() !== ""
			? participant.name.trim()
			: "Participant";
	}

	function participantCustomId(participant) {
		var value = participant && (participant.customParticipantId || participant.custom_participant_id);
		return typeof value === "string" && value !== "" ? value : null;
	}

	function participantPeerId(participant) {
		var value = participant && (participant.id || participant.peerId);
		return typeof value === "string" && value !== "" ? value : null;
	}

	function participantKey(participant, isSelf) {
		var customId = participantCustomId(participant);
		if (customId) {
			return "custom:" + customId;
		}
		var peerId = participantPeerId(participant);
		if (peerId) {
			return "peer:" + peerId;
		}
		return isSelf ? "local" : null;
	}

	function makeTrackStream(track) {
		if (!track) {
			return null;
		}
		return new MediaStream([track]);
	}

	function currentElementTrack(element, kind) {
		var stream = element.srcObject;
		if (!stream) {
			return null;
		}
		var tracks = kind === "video" ? stream.getVideoTracks() : stream.getAudioTracks();
		return tracks.length > 0 ? tracks[0] : null;
	}

	/**
	 * Point the element at one track, and report whether that replaced what it was playing.
	 * Callers need the answer because changing srcObject aborts a play() that is still in flight.
	 */
	function attachTrack(element, kind, track) {
		if (currentElementTrack(element, kind) === track) {
			return false;
		}
		element.srcObject = track ? makeTrackStream(track) : null;
		return true;
	}

	function removeBlockedAudio(audio) {
		state.blockedAudio = state.blockedAudio.filter(function (candidate) {
			return candidate !== audio;
		});
		byId("play-audio-button").hidden = state.blockedAudio.length === 0;
	}

	function markBlockedAudio(audio) {
		if (state.blockedAudio.indexOf(audio) === -1) {
			state.blockedAudio.push(audio);
		}
		byId("play-audio-button").hidden = false;
	}

	function removePendingAudio(audio) {
		state.pendingAudio = state.pendingAudio.filter(function (candidate) {
			return candidate !== audio;
		});
	}

	function playRemoteAudio(audio, fromGesture) {
		if (!audio.srcObject || typeof audio.play !== "function") {
			return;
		}
		if (state.pendingAudio.indexOf(audio) !== -1) {
			return;
		}
		if (state.blockedAudio.indexOf(audio) !== -1 && !fromGesture) {
			return;
		}
		if (fromGesture) {
			removeBlockedAudio(audio);
		}
		state.pendingAudio.push(audio);
		try {
			Promise.resolve(audio.play()).then(
				function () {
					removePendingAudio(audio);
					removeBlockedAudio(audio);
				},
				function (error) {
					removePendingAudio(audio);
					// The browser refuses autoplay with NotAllowedError, and only that needs the
					// recovery button. A play() that was interrupted by a track swap or a detach
					// rejects with AbortError, and there is nothing for the listener to fix.
					// The element also has to still belong to the room. A peer who hangs up while
					// this play() is unresolved runs removeTile first: it drops both marks and takes
					// the element out of the document, and marking it again here would push a removed
					// element back into the blocked list and leave "Play audio" on screen for the
					// rest of the meeting, with nothing to play. retryBlockedAudio drops the same two
					// cases from its own list.
					if (error && error.name === "NotAllowedError" && audio.isConnected && audio.srcObject) {
						markBlockedAudio(audio);
					}
				}
			);
		} catch (_error) {
			removePendingAudio(audio);
			markBlockedAudio(audio);
		}
	}

	function retryBlockedAudio() {
		var button = byId("play-audio-button");
		var hadFocus = document.activeElement === button;
		state.blockedAudio.slice().forEach(function (audio) {
			if (!audio.isConnected || !audio.srcObject) {
				removeBlockedAudio(audio);
				return;
			}
			playRemoteAudio(audio, true);
		});
		// playRemoteAudio hides this button as soon as the last blocked element clears, and the
		// browser drops the focus of a hidden control to the body. The listener would then be left
		// with no control, no confirmation, and a next Tab that restarts at the top of the call view.
		// Say what happened and hand focus to that line, the way the recording control does. Focus it
		// directly instead of through catchFocusOnCallNotice: the button is gone and it had focus, so
		// there is nothing left to check.
		if (hadFocus && button.hidden) {
			// Say nothing while the room is out of the meeting. The line holds the connection message
			// there, and the five-second clear below would take that sentence away for good. Losing a
			// confirmation the listener can hear for themselves is the smaller loss. Focus still lands
			// on the line, so they are told where they are either way.
			if (!state.reconnecting) {
				setCallStatus("Remote audio is playing now.", 5000);
			}
			byId("call-status").focus();
		}
	}

	function updateParticipantTile(record) {
		var participant = record.participant;
		var name = participantName(participant);
		record.name.textContent = name + (record.isSelf ? " (you)" : "");
		record.avatar.textContent = displayInitials(name);
		var videoEnabled = participant.videoEnabled === true && participant.videoTrack;
		record.element.dataset.video = videoEnabled ? "on" : "off";
		// Say why the tile shows initials instead of a picture. Do not name a reason: the SDK cannot
		// tell the two reasons apart. When a peer leaves the subscribed set the SDK calls
		// setVideoEnabled(false) and clears the track, which is the same state as a peer who turned
		// their camera off. "No video" is true either way. This matters once the call passes the
		// subscription limit, 6 peers by default: every peer past it arrives with no picture, and a
		// tile that says nothing reads as broken or as an empty seat.
		record.videoState.textContent = videoEnabled ? "" : "No video";
		attachTrack(record.video, "video", videoEnabled ? participant.videoTrack : null);
		if (videoEnabled && typeof record.video.play === "function") {
			try {
				Promise.resolve(record.video.play()).catch(function () {});
			} catch (_error) {}
		}

		var audioEnabled = participant.audioEnabled === true;
		record.mic.dataset.muted = audioEnabled ? "false" : "true";
		// Claim a mute only for a peer whose audio the room really receives. Past the SDK's audio
		// subscription limit, 10 peers by default in a room that allows 25, the SDK turns that peer's
		// audio off and clears its track. That is the same state as the peer muting themselves, so
		// "Mic off" there would be a guess. Say the neutral "No audio" instead, the same way the video
		// label above refuses to name a reason. The local tile is always known, and a provider build
		// without the collection keeps the plain reading.
		var subscribed = state.sdk && state.sdk.participants && state.sdk.participants.audioSubscribed;
		var audioKnown =
			record.isSelf ||
			!subscribed ||
			typeof subscribed.has !== "function" ||
			subscribed.has(participantPeerId(participant));
		record.mic.textContent = audioEnabled ? "Mic on" : audioKnown ? "Mic off" : "No audio";
		if (record.audio) {
			var audioSwapped = attachTrack(
				record.audio,
				"audio",
				audioEnabled && participant.audioTrack ? participant.audioTrack : null
			);
			// A remote mute or a track swap replaces srcObject, and the browser then rejects the
			// play() that was still running. Drop both marks that rejection would leave behind:
			// otherwise the new track is never played, and the room shows a "Play audio" button
			// for an element that has no audio problem.
			if (audioSwapped) {
				removePendingAudio(record.audio);
				removeBlockedAudio(record.audio);
			}
			if (record.audio.srcObject) {
				playRemoteAudio(record.audio);
			} else {
				removeBlockedAudio(record.audio);
			}
		}
		// The button shows "Pinned" once it is on, so its accessible name has to contain that word
		// too. A speech-input user says what they see (WCAG 2.5.3 Label in Name).
		var pinned = state.pinnedKey === record.key;
		record.pin.setAttribute("aria-label", pinned ? "Pinned — unpin " + name : "Pin " + name);
		record.pin.setAttribute("aria-pressed", pinned ? "true" : "false");
		record.pin.textContent = pinned ? "Pinned" : "Pin";
	}

	function removeTile(key) {
		var record = state.tiles[key];
		if (!record) {
			return;
		}
		record.cleanups.forEach(function (cleanup) {
			cleanup();
		});
		record.video.srcObject = null;
		if (record.audio) {
			removeBlockedAudio(record.audio);
			removePendingAudio(record.audio);
			record.audio.srcObject = null;
			record.audio.remove();
		}
		record.element.remove();
		delete state.tiles[key];
	}

	function createTile(key, participant, isSelf) {
		var element = document.createElement("div");
		element.className = "participant-tile";
		element.setAttribute("role", "listitem");
		element.dataset.participantKey = key;

		var video = document.createElement("video");
		video.className = "participant-video";
		video.autoplay = true;
		video.playsInline = true;
		video.muted = isSelf;
		video.setAttribute("aria-hidden", "true");
		element.appendChild(video);

		var avatar = document.createElement("div");
		avatar.className = "participant-avatar";
		avatar.setAttribute("aria-hidden", "true");
		var avatarText = document.createElement("span");
		avatar.appendChild(avatarText);
		element.appendChild(avatar);

		var pin = document.createElement("button");
		pin.type = "button";
		pin.className = "participant-pin";
		pin.addEventListener("click", function () {
			state.pinnedKey = state.pinnedKey === key ? null : key;
			renderStageLayout();
		});
		element.appendChild(pin);

		var meta = document.createElement("div");
		meta.className = "participant-meta";
		var name = document.createElement("span");
		name.className = "participant-name";
		var videoState = document.createElement("span");
		videoState.className = "participant-video-state";
		var mic = document.createElement("span");
		mic.className = "participant-mic";
		meta.appendChild(name);
		meta.appendChild(videoState);
		meta.appendChild(mic);
		element.appendChild(meta);

		var audio = null;
		if (!isSelf) {
			audio = document.createElement("audio");
			audio.autoplay = true;
			byId("audio-bin").appendChild(audio);
		}

		var record = {
			key: key,
			participant: participant,
			isSelf: isSelf,
			element: element,
			video: video,
			audio: audio,
			avatar: avatarText,
			name: name,
			videoState: videoState,
			mic: mic,
			pin: pin,
			cleanups: [],
		};
		var videoHandler = function () {
			updateParticipantTile(record);
		};
		var audioHandler = function () {
			updateParticipantTile(record);
		};
		if (participant && typeof participant.on === "function") {
			participant.on("videoUpdate", videoHandler);
			participant.on("audioUpdate", audioHandler);
			record.cleanups.push(function () {
				safeOff(participant, "videoUpdate", videoHandler);
				safeOff(participant, "audioUpdate", audioHandler);
			});
		}
		state.tiles[key] = record;
		updateParticipantTile(record);
		return record;
	}

	function renderStageLayout() {
		var keys = Object.keys(state.tiles).sort();
		var localKey = null;
		keys.forEach(function (key) {
			if (state.tiles[key].isSelf) {
				localKey = key;
			}
		});
		if (state.pinnedKey && !state.tiles[state.pinnedKey]) {
			state.pinnedKey = null;
		}
		var featuredKey = state.pinnedKey;
		if (!featuredKey && state.participant && state.participant.role === "host" && localKey) {
			featuredKey = localKey;
		}
		if (!featuredKey && keys.length > 0) {
			featuredKey = keys[0];
		}
		var stage = byId("participant-list");
		stage.dataset.count = String(keys.length);
		// The featured tile spans both explicit rows, so the two side columns hold four more tiles.
		// Five is everything the declared grid can place. A sixth tile opens an implicit row, and
		// from the ninth tile on the browser squeezes the two explicit rows down to fit the extra
		// ones, so the featured tile paints on top of its neighbours (measured at 1440x900: 4
		// overlapping pairs at 9 tiles, 7 at 12). Bigger meetings get the plain grid instead.
		if (keys.length >= 3 && keys.length <= FEATURED_LAYOUT_MAX_TILES) {
			stage.dataset.layout = "featured";
			stage.dataset.sideColumns = keys.length >= 4 ? "2" : "1";
		} else if (keys.length > FEATURED_LAYOUT_MAX_TILES) {
			stage.dataset.layout = "grid";
			delete stage.dataset.sideColumns;
		} else {
			delete stage.dataset.layout;
			delete stage.dataset.sideColumns;
		}
		keys.sort(function (left, right) {
			if (left === featuredKey) {
				return -1;
			}
			if (right === featuredKey) {
				return 1;
			}
			return left.localeCompare(right);
		});
		// Mark the tile the stage really features. The accent border in page.ts is not scoped to the
		// featured layout, so a pin has to mark its tile at every meeting size: without this the host
		// pins in a two-person call or a seven-person grid, the button says "Pinned", and nothing on
		// the stage changes. Outside the featured layout only an explicit pin marks a tile, because
		// the implicit featured key is the host's own tile and nobody asked for a border there.
		var markedKey = stage.dataset.layout === "featured" || state.pinnedKey !== null ? featuredKey : null;
		// Remember who has focus before the loop below. Appending a tile the stage already holds
		// moves it, and the browser blurs whatever was focused inside a node it moves. The loop
		// re-appends every tile on every render, so a keyboard user pressing Pin drops to the body,
		// and so does one who was simply resting on a tile when somebody joined or left. The control
		// bar is last in tab order, so from the body they walk all the pins again to reach Leave.
		var focused = document.activeElement;
		keys.forEach(function (key) {
			var record = state.tiles[key];
			record.element.dataset.featured = key === markedKey ? "true" : "false";
			stage.appendChild(record.element);
			updateParticipantTile(record);
		});
		// Only a tile that survived this render can take its focus back, because a detached button
		// cannot hold focus. The other case is the tile the user was standing on being removed, and
		// this function cannot see it: the removal already dropped focus to the body before the line
		// above read it. reconcileParticipants is where that case is caught, because it is the one
		// caller that removes tiles.
		if (focused !== null && focused !== document.activeElement && focused.isConnected) {
			focused.focus();
		}
		setText("participant-count", String(keys.length));
		byId("participant-count-status").setAttribute(
			"aria-label",
			keys.length === 1 ? "1 participant" : keys.length + " participants"
		);
	}

	function reconcileParticipants(preferredParticipant) {
		var sdk = state.sdk;
		if (!sdk) {
			return;
		}
		var desired = {};
		var selfKey = participantKey(sdk.self, true);
		desired[selfKey] = { participant: sdk.self, isSelf: true };
		var joined = sdk.participants && sdk.participants.joined;
		if (joined && typeof joined.toArray === "function") {
			joined.toArray().forEach(function (participant) {
				var key = participantKey(participant, false);
				if (!key || key === selfKey) {
					return;
				}
				// RealtimeKit can briefly keep the old peer beside its reconnect replacement. The
				// later snapshot entry is the new peer; an explicit participantJoined payload wins too.
				// The second half of the condition is what makes that payload win: it refuses to
				// overwrite an entry that already holds the preferred participant. Keep it. Assigning
				// every entry instead would give the tile to whichever peer the snapshot lists last,
				// and that can be the ghost.
				if (!desired[key] || desired[key].participant !== preferredParticipant) {
					desired[key] = { participant: participant, isSelf: false };
				}
			});
		}

		// Note the tile the keyboard user is standing in before the removal loop below detaches it.
		// renderStageLayout cannot work this out for itself: it reads document.activeElement after
		// the removal has already dropped focus to the body.
		var focusedTile = null;
		Object.keys(state.tiles).forEach(function (key) {
			if (state.tiles[key].element.contains(document.activeElement)) {
				focusedTile = state.tiles[key].element;
			}
		});

		Object.keys(state.tiles).forEach(function (key) {
			if (!desired[key] || state.tiles[key].participant !== desired[key].participant) {
				removeTile(key);
			}
		});
		Object.keys(desired).forEach(function (key) {
			if (!state.tiles[key]) {
				createTile(key, desired[key].participant, desired[key].isSelf);
			} else {
				updateParticipantTile(state.tiles[key]);
			}
		});
		renderStageLayout();
		// The render above puts every surviving tile back, so a tile that is still detached here is
		// one the removal loop took away. Nothing can give its button the focus back, and the
		// browser leaves the user on the body. From there the control bar is last in tab order, so
		// reaching Leave means walking every pin on the stage: 6 Tab presses in a four-person call,
		// mid-meeting, because a peer hung up. Hand them the first tile on the stage instead. That
		// is the featured tile after the sort above, so it is the stage's first control in tab order
		// and the shortest walk to every other one, and it keeps them among the tile controls they
		// were using rather than on a heading they cannot act on.
		if (focusedTile !== null && !focusedTile.isConnected) {
			var replacement = byId("participant-list").querySelector(".participant-pin");
			if (replacement) {
				replacement.focus();
			}
		}
	}

	function clearParticipantTiles() {
		Object.keys(state.tiles).forEach(removeTile);
		state.pinnedKey = null;
		state.blockedAudio = [];
		state.pendingAudio = [];
		byId("play-audio-button").hidden = true;
		byId("participant-list").textContent = "";
		setText("participant-count", "0");
	}

	// #endregion participant media

	// #region call state

	function setCallStatus(message, clearAfterMs) {
		var element = byId("call-status");
		if (state.callStatusTimer !== null) {
			clearTimeout(state.callStatusTimer);
			state.callStatusTimer = null;
		}
		// catchFocusOnCallNotice can park the host on this line, and retryBlockedAudio focuses it
		// directly. Hiding the element they are standing on drops their focus to the body, and the
		// browser never brings it back, so hand them a landing before the line goes away. The
		// landing is catchFocusOnCallNotice's ladder without the dying line itself: the host-error
		// banner first, then the recording pill while a recording shows it, then the call heading.
		// A visible box the focus ring can paint on wins over the invisible heading. The two
		// ladders have to agree on that order.
		function hideCallStatus() {
			if (document.activeElement === element) {
				byId(
					!byId("host-error").hidden
						? "host-error"
						: !byId("recording-indicator").hidden
							? "recording-indicator"
							: "call-heading",
				).focus();
			}
			element.textContent = "";
			element.hidden = true;
		}

		if (message === "") {
			hideCallStatus();
			return;
		}

		// Unhide first, then write. A hidden element is out of the accessibility tree and carries no
		// live region at all, so text that lands before this line changes nothing a live region was
		// watching. setError does the same two steps in the same order.
		element.hidden = false;
		element.textContent = message;
		if (typeof clearAfterMs === "number") {
			state.callStatusTimer = setTimeout(function () {
				if (element.textContent === message) {
					hideCallStatus();
				}
				state.callStatusTimer = null;
			}, clearAfterMs);
		}
	}

	function clearCallStatus(prefix) {
		var message = byId("call-status").textContent || "";
		if (message.indexOf(prefix) === 0) {
			setCallStatus("");
		}
	}

	function setConnectionStatus(label, connectionState) {
		var element = byId("connection-status");
		element.dataset.state = connectionState;
		element.lastElementChild.textContent = label;
	}

	function renderLocalControls() {
		var sdk = state.sdk;
		if (!sdk) {
			return;
		}
		// Write only the state here. Both buttons carry a "Microphone" or "Camera" label in the
		// markup, and that visible text is their accessible name. A name that says "Turn microphone
		// off" would say the opposite of aria-pressed="true", and it would take the visible word out
		// of the name, so a speech-input user saying "click Microphone" would reach nothing (WCAG
		// 2.5.3 Label in Name).
		var micButton = byId("mute-button");
		var micOn = sdk.self.audioEnabled === true;
		micButton.setAttribute("aria-pressed", micOn ? "true" : "false");

		var cameraButton = byId("camera-button");
		var cameraOn = sdk.self.videoEnabled === true;
		cameraButton.setAttribute("aria-pressed", cameraOn ? "true" : "false");
	}

	function toggleLocalMedia(kind) {
		var sdk = state.sdk;
		if (!sdk) {
			return;
		}
		var button = byId(kind === "audio" ? "mute-button" : "camera-button");
		// Do not disable the button while the provider works. The browser blurs a focused control
		// the moment it turns disabled, and nothing brings focus back, so a keyboard user loses
		// their place on the most-used control in the call. Mark it busy and ignore repeat
		// presses instead.
		if (button.getAttribute("aria-busy") === "true") {
			return;
		}
		var enabled = kind === "audio" ? sdk.self.audioEnabled === true : sdk.self.videoEnabled === true;
		button.setAttribute("aria-busy", "true");
		var action =
			kind === "audio"
				? enabled
					? sdk.self.disableAudio()
					: sdk.self.enableAudio()
				: enabled
					? sdk.self.disableVideo()
					: sdk.self.enableVideo();
		Promise.resolve(action).then(
			// Check the call before clearing the busy mark, not after. This promise can belong to a
			// call that already ended, and its button is shared with the call running now. Clearing
			// the mark there strips the repeat-press guard off a press the current call still has in
			// the air, and the next press starts a second enableVideo on top of it. teardownCall
			// already clears the mark for the call that ended.
			function () {
				if (state.sdk !== sdk) {
					return;
				}
				button.removeAttribute("aria-busy");
				renderLocalControls();
				reconcileParticipants(sdk.self);
				var deviceOn = kind === "audio" ? sdk.self.audioEnabled === true : sdk.self.videoEnabled === true;
				// A promise that resolves is not proof the device turned on. The SDK swallows every
				// device and permission error in an empty catch and resolves anyway, so a press that
				// asked for a dead camera lands here, right after its own mediaPermissionUpdate wrote
				// the reason, and clearing the line here erased that reason in the same press.
				if (!enabled && !deviceOn) {
					// No line is showing, so no permission event arrived at all and nothing said why.
					// Use the same words the permission branch of handleMediaPermissionUpdate uses,
					// so a later press that does work still clears this line by its first words.
					if (byId("call-status").hidden) {
						setCallStatus(
							kind === "audio"
								? "Microphone unavailable. Check the browser microphone permission."
								: "Camera unavailable. Check the browser camera permission."
						);
					}
					return;
				}
				clearCallStatus(kind === "audio" ? "Microphone unavailable" : "Camera unavailable");
			},
			function () {
				if (state.sdk !== sdk) {
					return;
				}
				button.removeAttribute("aria-busy");
				renderLocalControls();
				// Same hold as handleMediaPermissionUpdate. While the room is out of the meeting the
				// status line carries the connection message, and a device line would take away the
				// only sentence pointing at the control that still works.
				if (state.reconnecting) {
					return;
				}
				setCallStatus(
					kind === "audio"
						? "Microphone unavailable. Check the browser microphone permission."
						: "Camera unavailable. Check the browser camera permission."
				);
			}
		);
	}

	function parseMeetingStartedAt(value) {
		var timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
		return isFinite(timestamp) ? timestamp : null;
	}

	function formatElapsed(milliseconds) {
		var totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
		var hours = Math.floor(totalSeconds / 3600);
		var minutes = Math.floor((totalSeconds % 3600) / 60);
		var seconds = totalSeconds % 60;
		function twoDigits(value) {
			return value < 10 ? "0" + value : String(value);
		}
		return hours > 0
			? twoDigits(hours) + ":" + twoDigits(minutes) + ":" + twoDigits(seconds)
			: twoDigits(minutes) + ":" + twoDigits(seconds);
	}

	function renderElapsed() {
		setText(
			"meeting-elapsed",
			state.meetingStartedAt === null ? "00:00" : formatElapsed(Date.now() - state.meetingStartedAt)
		);
	}

	function startElapsedTimer() {
		if (state.elapsedTimer !== null) {
			clearInterval(state.elapsedTimer);
		}
		var sdk = state.sdk;
		state.meetingStartedAt = sdk && sdk.meta ? parseMeetingStartedAt(sdk.meta.meetingStartedTimestamp) : null;
		renderElapsed();
		state.elapsedTimer = setInterval(renderElapsed, 1000);
	}

	/**
	 * True while the stage still offers a start. "unsaved" offers one for the same reason "idle"
	 * does: the service kept nothing from the last attempt and left the meeting open with no
	 * recording on it. Keep the two guards that read this in one place. They have to agree, and if
	 * they drift the control is either enabled and inert or closed on a press the service accepts.
	 */
	function recordingCanStart() {
		return state.recordingStage === "idle" || state.recordingStage === "unsaved";
	}

	function renderRecordingState(recordingState) {
		var sdk = state.sdk;
		var current =
			typeof recordingState === "string"
				? recordingState
				: sdk && sdk.recording
					? sdk.recording.recordingState
					: null;
		var active = current === "STARTING" || current === "RECORDING";
		byId("recording-indicator").hidden = !active;
		// Announce both edges. Only the start was announced before, so a stopped recording kept
		// telling the room it had started.
		if (active && !state.recordingActive) {
			setText("recording-live", "Recording has started.");
			// The provider says a recording is running, so move the stage with it, the way the stop
			// edge below moves it to "finished". The end dialog, the ended message and the button
			// label all read the stage alone, and the stage only ever tracked this browser's own
			// start request: a start whose answer was lost left the stage at "idle" while the pill
			// was lit and the button read "Recording", and the end dialog then told the host that no
			// recording was started while everyone in the room was being recorded.
			// Promote only from the two stages that mean "this browser has no answer yet".
			// "unavailable" and "unsaved" are answers: the service recorded no recording id, so no
			// files can be sealed even if the provider is running one, and promising them here would
			// take back what the room already said.
			if (state.recordingStage === "idle" || state.recordingStage === "pending") {
				state.recordingStage = "requested";
			}
		} else if (!active && state.recordingActive) {
			setText("recording-live", "Recording has stopped.");
			// "unavailable" and "unsaved" are terminal on this edge too, for the same reason they are
			// on the edge above. The service stored no recording id, so no files can be sealed however
			// long the provider kept recording. Moving to "finished" here would promise the host files
			// that cannot arrive, and the end dialog and the ended message both read the stage alone.
			if (state.recordingStage !== "unavailable" && state.recordingStage !== "unsaved") {
				state.recordingStage = "finished";
			}
		}
		state.recordingActive = active;
		if (current === "RECORDING") {
			clearCallStatus("Recording is starting");
		}
		var button = byId("start-recording-button");
		// The request is still in the air, so leave the control enabled and only mark it busy.
		// A disabled control blurs, and the host would spend the whole wait on the body with no
		// way back. startRecording ignores the repeat presses this allows.
		var waiting = !active && state.recordingStage === "pending";
		if (waiting) {
			button.setAttribute("aria-busy", "true");
		} else {
			button.removeAttribute("aria-busy");
		}
		button.disabled = active || (!recordingCanStart() && !waiting);
		button.querySelector(".control-label").textContent = active
			? "Recording"
			: RECORDING_LABELS[state.recordingStage];
	}

	/**
	 * Answer the provider's own recording broadcast.
	 *
	 * The render above disables the control for an active recording, and the browser takes focus off
	 * a control in the same statement that disables it. Every other path that closes this control is
	 * answering a press, so each one catches the focus itself. This path answers nobody's press: the
	 * provider reports a recording the host did not just start, because another host started it or a
	 * reconnect replays the state. The host was standing on the control, the broadcast closed it, and
	 * nothing put them back.
	 *
	 * Stay out of the way while this browser's own start request is still in the air. That request
	 * always ends in a catch call of its own, on the line that says what the answer was, and a rescue
	 * here would park the host on the recording pill first and leave that better line unable to claim
	 * them. "pending" is the stage that means an answer is still coming, and it has to be read before
	 * the render, because the render moves it on.
	 */
	function handleRecordingUpdate(recordingState) {
		var answerPending = state.recordingStage === "pending";
		renderRecordingState(recordingState);
		if (!answerPending) {
			catchFocusOnCallNotice();
		}
	}

	function handleRoomLeft(payload, sdk) {
		if (state.sdk !== sdk || state.over) {
			return;
		}
		if (payload && payload.state === "disconnected") {
			state.reconnecting = true;
			setConnectionStatus("Reconnecting", "reconnecting");
			setCallStatus("Connection lost. Reconnecting…");
			return;
		}
		// "failed" is the SDK saying it has given up. It comes from a socket reconnect that ran out
		// of attempts, or from a room node that failed, and both log that the SDK has to be created
		// again. Nothing retries after it, and no socketConnectionUpdate follows either. The meeting
		// itself is still running, so the state poll never ends this call: only this participant is
		// gone. Promising a reconnect that can never arrive left them watching stale tiles with
		// nothing on screen pointing at the one control that still works.
		if (payload && payload.state === "failed") {
			// Keep the reconnecting mark, so a roomJoined that somehow does arrive still restores
			// the call the way it does after a plain disconnect.
			state.reconnecting = true;
			setConnectionStatus("Connection problem", "problem");
			setCallStatus("The connection to the meeting was lost. Press Leave, then rejoin from the next screen.");
			return;
		}
		// Say nothing while the host's own close is still in the air. This frame is that close
		// arriving early: the service stops the recording, then kicks everyone, then seals the
		// meeting and projects it, so the provider's kick can still reach this browser before the
		// close answer does. Ending here sets state.over, the
		// close's own answer then hits endLocally's early return, and the host who recorded gets
		// "The meeting has ended." instead of being told where their files will appear. The close
		// writes the ended screen itself when it settles. state.closeController is cleared when it
		// does, so this wait is bounded by the close deadline and by Cancel or Escape, and the state
		// poll ends the call on its next tick if the close never answered. The state poll below
		// waits on the same controller for the same reason.
		if (state.closeController !== null) {
			return;
		}
		endLocally("The meeting has ended.");
	}

	function handleRoomJoined(sdk) {
		if (state.sdk !== sdk || state.over) {
			return;
		}
		if (state.reconnecting) {
			state.reconnecting = false;
			setConnectionStatus("Connected", "connected");
			setCallStatus("Connection restored.", 3000);
			reconcileParticipants(null);
		}
	}

	function handleMediaPermissionUpdate(payload, sdk) {
		if (state.sdk !== sdk || !payload) {
			return;
		}
		// The device stopped feeding the call after the join, and the provider has already turned that
		// track off. ACCEPTED is the only message that leaves the track working, so it is the only
		// silent one. SDK 2.0.1 sends ACCEPTED, DENIED, SYSTEM_DENIED, NOT_REQUESTED, COULD_NOT_START
		// or NO_DEVICES_AVAILABLE for these two kinds. NOT_REQUESTED arrives from the
		// navigator.permissions onchange handler when someone resets the site permission during the
		// call, so it is a loss like DENIED.
		if (payload.message === "ACCEPTED") {
			return;
		}
		renderLocalControls();
		// Leave the status line alone while the room is out of the meeting. handleRoomLeft owns it
		// there. After a terminal "failed" it holds the one sentence naming the only control that
		// still works, and nothing writes that sentence again. A device notice needs no user action
		// at all, because unplugging a headset is enough for NO_DEVICES_AVAILABLE. So it would take
		// that sentence away by itself, and #call-status is a role="status" live region, which makes
		// microphone advice the last word a screen reader hears about a call that is gone. The device
		// is still reported, because renderLocalControls above already moved the button.
		// handleSocketConnectionUpdate holds the connection chip back on this same mark.
		if (state.reconnecting) {
			return;
		}
		// COULD_NOT_START is not a permission answer. It is where the SDK's Chromium mapper sends
		// NotReadableError and every error it does not recognise, so it means another app holds the
		// device, the hardware failed, or the device was unplugged. Pointing the listener at the
		// permission there would send them to check the wrong thing, so only the second sentence
		// differs from the permission message below. Both start with the same words on purpose:
		// clearCallStatus matches on that prefix, and toggleLocalMedia passes it after a successful
		// retry. A line that opened any other way would stay on screen for the rest of the meeting,
		// long after the listener closed the other app and the device came back.
		if (payload.message === "COULD_NOT_START") {
			setCallStatus(
				payload.kind === "video"
					? "Camera unavailable. Close any other app using it, then turn the camera on."
					: "Microphone unavailable. Close any other app using it, then turn the microphone on."
			);
			return;
		}
		// NO_DEVICES_AVAILABLE is not a permission answer either. The SDK sends it when the browser
		// lists no input of that kind at all: a desktop with no webcam, a camera switched off in the
		// system settings, an unplugged headset. The permission line below would send that person to
		// a panel that already says allow, and there is nothing for them to do there. The first words
		// stay the same as the other two, for the same clearCallStatus reason.
		if (payload.message === "NO_DEVICES_AVAILABLE") {
			setCallStatus(
				payload.kind === "video"
					? "Camera unavailable. No camera was found. Connect one, then turn the camera on."
					: "Microphone unavailable. No microphone was found. Connect one, then turn the microphone on."
			);
			return;
		}
		setCallStatus(
			payload.kind === "video"
				? "Camera unavailable. Check the browser camera permission."
				: "Microphone unavailable. Check the browser microphone permission."
		);
	}

	function handleSocketConnectionUpdate(update, sdk) {
		if (state.sdk !== sdk || !update) {
			return;
		}
		// The chip reports the room, not the socket under it. state.reconnecting means the room has
		// left the meeting: handleRoomLeft wrote "Reconnecting" for a plain drop, or "Connection
		// problem" plus "Press Leave, then rejoin" after a terminal "failed", where the SDK has given
		// up and has to be built again. A socket that comes back does not put this participant back
		// in the room, so "Connected" here would contradict that message and, because
		// #connection-status is a role="status" live region, "Connected" would be the last word a
		// screen reader heard about a connection that is gone. handleRoomJoined owns that
		// transition: it clears the mark and paints the chip when the room really is back.
		if (update.state === "connected" && !state.reconnecting) {
			setConnectionStatus("Connected", "connected");
		} else if (update.state === "disconnected" || update.state === "reconnecting") {
			setConnectionStatus("Reconnecting", "reconnecting");
		} else if (update.state === "failed") {
			setConnectionStatus("Connection problem", "problem");
		}
	}

	function wireCallEvents() {
		var sdk = state.sdk;
		var joined = sdk.participants && sdk.participants.joined;
		addCallListener(joined, "participantJoined", function (participant) {
			reconcileParticipants(participant);
		});
		addCallListener(joined, "participantLeft", function () {
			reconcileParticipants(null);
		});
		// The SDK empties this collection on every socket (re)join and then adds the fresh peers back
		// one by one. Its clear() emits only this event, never one participantLeft per peer, so a
		// meeting that came back with fewer peers would keep the missing tiles forever. Reconciling
		// here drops every remote tile; the re-added peers each emit participantJoined, which the
		// listener above turns back into a tile. If the fresh list is empty, no tile comes back, which
		// is the whole point.
		addCallListener(joined, "participantsCleared", function () {
			reconcileParticipants(null);
		});
		addCallListener(sdk.self, "audioUpdate", function () {
			renderLocalControls();
			reconcileParticipants(sdk.self);
		});
		addCallListener(sdk.self, "videoUpdate", function () {
			renderLocalControls();
			reconcileParticipants(sdk.self);
		});
		// mediaPermissionUpdate is not wired here. The join registers it as soon as the SDK exists,
		// because the join-time enableAudio emits it before this function runs.
		addCallListener(sdk.self, "roomLeft", function (payload) {
			handleRoomLeft(payload, sdk);
		});
		addCallListener(sdk.self, "roomJoined", function () {
			handleRoomJoined(sdk);
		});
		addCallListener(sdk.recording, "recordingUpdate", handleRecordingUpdate);
		addCallListener(sdk.meta, "meetingStartTimeUpdate", function () {
			state.meetingStartedAt = parseMeetingStartedAt(sdk.meta.meetingStartedTimestamp);
			renderElapsed();
		});
		addCallListener(sdk.meta, "socketConnectionUpdate", function (update) {
			handleSocketConnectionUpdate(update, sdk);
		});
	}

	function enterCall(micOn) {
		state.over = false;
		state.reconnecting = false;
		// A meeting records at most once, and the server remembers that across reloads. Without
		// this seed a reloaded room would offer "Start recording" again for a meeting whose
		// recording already ran, and the server could only refuse the press.
		// recording_start_unknown is the same dead end from the other side. The start request was
		// lost, so nothing was recorded and recordingStarted stays false, but the meeting is no
		// longer open and the route answers 409 to a second press. The call itself keeps running, so
		// only the recording control closes.
		var meeting = state.meeting || {};
		state.recordingStage =
			meeting.status === "recording_start_unknown"
				? "unavailable"
				: meeting.recordingStarted === true
					? "finished"
					: "idle";
		state.recordingActive = false;
		wireCallEvents();
		reconcileParticipants(null);
		renderLocalControls();
		renderRecordingState();
		setConnectionStatus("Connected", "connected");
		startElapsedTimer();
		showView("view-call", "call-heading");
		if (micOn === false) {
			// The permission listener the join registered may already have written the real reason:
			// no microphone on the machine, or another app holding it. Naming the permission over
			// that would send someone with no microphone to a panel that already says allow, where
			// there is nothing to do. Speak only when nothing said why, and then name the permission,
			// which is the likeliest cause left, the same way toggleLocalMedia does for its own
			// silent failure.
			if (byId("call-status").hidden) {
				setCallStatus("Microphone unavailable. Allow microphone access, then turn the microphone on.");
			}
		} else {
			setCallStatus("");
		}
		startPolling();
	}

	// #endregion call state

	// #region host controls

	/**
	 * Put focus on the line that says what happened, when the control the host just used turned
	 * disabled. The browser takes focus off a disabled control, drops it to the body, and never
	 * brings it back.
	 *
	 * Take the host-error banner first. It is the answer to the press the host just made, and on
	 * every recording failure it is the only line showing at all. The call status line is an older
	 * message, so it comes second. Both are boxes the host can see, and the page's :focus-visible
	 * ring is not turned off for either, so a keyboard host gets a mark where the sentence is.
	 *
	 * The recording pill comes third, and only while a recording shows it. It carries no sentence,
	 * so both lines outrank it, but it is a visible box the ring paints on, and it names the very
	 * fact that closed the control: the paths that reach it are the ones where the provider says a
	 * recording is running and neither line is up. renderRecordingState always runs before this, so
	 * the pill's visibility already matches the broadcast being answered — shown on the start edge,
	 * hidden again on the stop edge.
	 *
	 * The call heading is the last resort and it marks nothing: it is 1px and clipped, so a ring
	 * there paints no pixels at all. Reaching it means no line and no pill is showing and there is
	 * nothing visible left to stand on. Do not park a host on it while a banner is up. A hidden
	 * line cannot take focus either, and the host would stay on the body.
	 *
	 * hideCallStatus in setCallStatus walks this same order, minus the status line, when the line
	 * the host is standing on goes away. Keep the two orders the same.
	 */
	function catchFocusOnCallNotice() {
		// The browser takes focus off a control in the same statement that disables it. Measured in
		// Edge on this page: the control's focusout had already fired and document.activeElement
		// already read BODY before the assignment returned. Every caller disables the control
		// first and calls this after, so the host is on the body by the time this runs, and the body
		// check is the one that does the work. A "the host is still on a disabled control" check
		// would never fire in a browser, so do not add one back.
		var focused = document.activeElement;
		if (focused === null || focused === document.body) {
			byId(
				!byId("host-error").hidden
					? "host-error"
					: !byId("call-status").hidden
						? "call-status"
						: !byId("recording-indicator").hidden
							? "recording-indicator"
							: "call-heading",
			).focus();
		}
	}

	function startRecording() {
		if (!recordingCanStart() || state.recordingActive) {
			return;
		}
		var generation = bootGeneration;
		// A fresh attempt drops the last one's verdict along with its banner. "unsaved" is what the
		// previous answer said about the previous recording, and this press is asking again.
		state.recordingStage = "pending";
		setError("host-error", null);
		renderRecordingState();
		var controller = typeof AbortController === "function" ? new AbortController() : null;
		var timeout = setTimeout(function () {
			if (controller) {
				controller.abort();
			}
		}, START_RECORDING_TIMEOUT_MS);
		apiPostWithCsrfRefresh("/room/api/host/start-recording", {}, controller ? controller.signal : undefined)
			.then(function () {
				if (generation !== bootGeneration || state.over) {
					return;
				}
				state.recordingStage = "requested";
				renderRecordingState();
				// Say the recording is starting only while it has not started yet. The provider's own
				// recordingStarted broadcast can reach the browser before this answer does, and the
				// one place that clears this line is renderRecordingState, which ran before the line
				// was written. No second recordingUpdate("RECORDING") follows, because the SDK emits
				// that event only on a change, so the line stayed on screen for the rest of the
				// meeting: it was still promising a start after the recording had already stopped.
				if (!state.recordingActive) {
					setCallStatus("Recording is starting.");
				}
				catchFocusOnCallNotice();
			})
			.catch(function (error) {
				if (generation !== bootGeneration || state.over) {
					return;
				}
				// On this route the service answers 502 for one case only: the provider never
				// answered the start. It then moves the meeting to recording_start_unknown, which
				// records nothing and admits nobody new, and it refuses a second start. So this is
				// the dead end: say both facts once and leave the control closed. A provider that
				// answers and refuses is a different case and gets a different status, because the
				// meeting is untouched there and pressing again can still work.
				if (error && error.status === 502) {
					state.recordingStage = "unavailable";
					renderRecordingState();
					setCallStatus("Recording could not be started. This meeting will not be saved, and no one else can join.");
					catchFocusOnCallNotice();
					return;
				}

				// 500 is the one answer on this route that says the recording is not being kept: the
				// provider started one, storing its id failed, and the service stopped that recording
				// itself. Nothing holds an id, so that attempt can never produce files. The meeting is
				// still open with no recording on it, so a new press can still work. That is why the
				// route answers 500 here and not 502, and handle_start_recording says so in the
				// comment above that answer. "unsaved" is both facts, and neither recording edge
				// moves it.
				// Answer the 500 before reading state.recordingActive below. The provider's broadcast
				// and this answer race, and the room must say the same thing whichever wins. While
				// this branch sat inside that check, the order where the answer arrives first fell
				// through to "idle", the late broadcast promoted "idle" to "requested", its stop edge
				// moved that to "finished", and both end wordings then sent the host to wait for
				// files the service holds no id for.
				if (error && error.status === 500) {
					state.recordingStage = "unsaved";
					renderRecordingState();
					setError(
						"host-error",
						"The recording could not be saved, so it produced no files. You can start a new recording."
					);
					catchFocusOnCallNotice();
					return;
				}

				// The provider's broadcast can land while this request is still in the air, and it
				// already moved the stage in renderRecordingState. Keep that stage: the end dialog
				// and the ended message read it alone, so resetting to "idle" here would tell the
				// host that nothing was recorded while every participant is being recorded. The
				// retry the line below offers cannot work either, because startRecording refuses
				// every press while a recording is active. Only put the host back in the page: the
				// broadcast disabled the control they were standing on, and the browser dropped them
				// to the body when it did.
				if (state.recordingActive) {
					setError(
						"host-error",
						error && typeof error.status === "number"
							? errorText(error)
							: "Starting the recording got no answer, but the recording is running.",
					);
					catchFocusOnCallNotice();
					return;
				}

				state.recordingStage = "idle";
				renderRecordingState();
				setError(
					"host-error",
					error && error.name === "AbortError"
						? "Starting the recording took too long. Check your connection, then try again."
						: errorText(error)
				);
				byId("start-recording-button").focus();
				// The line above is a no-op when the button is disabled, and it can be: the provider
				// can already hold recordingState at RECORDING, and the render above then disables the
				// control for an active recording. That disable took the host's focus to the body in
				// the same statement, so the line below is what puts them back. Without it they are
				// left with no place in the page at all.
				catchFocusOnCallNotice();
			})
			.finally(function () {
				clearTimeout(timeout);
			});
	}

	function openEndConfirm() {
		// Say what the recording did instead of asking the same open question every time. The room
		// already knows the answer here, and this dialog is the last moment the host can still act on
		// it: a host who meant to record and forgot only finds out afterwards otherwise. The branches
		// are the ones confirmEndMeeting uses for its ended-message. Writing the text on every open
		// also puts the question back after an attempt that left the pending wording behind.
		var question;
		if (state.recordingStage === "unavailable") {
			question = "Everyone will leave the room. The recording could not be started, so this meeting will not be saved.";
		} else if (state.recordingStage === "unsaved") {
			// A recording did start here, so do not say none did. It was never stored, so its files
			// cannot arrive either.
			question =
				"Everyone will leave the room. The recording could not be saved, so there will be no files to prepare.";
		} else if (state.recordingStage === "idle") {
			question = "Everyone will leave the room. No recording was started, so there will be no files to prepare.";
		} else if (state.recordingStage === "pending") {
			// The start request has no answer yet, so nobody can say here whether files will come.
			question = "Everyone will leave the room. The recording start has no answer yet, so its files may not arrive.";
		} else {
			question = "Everyone will leave the room. Council will prepare the recording files.";
		}
		setText("host-confirm-text", question);
		byId("host-confirm").hidden = false;
		// Land on Cancel, never on the destructive button. A button activates on Enter keydown, and
		// the operating system repeats keydown while the key stays down: one held Enter would open
		// this dialog and confirm it, so resting a finger on Enter would end the meeting for
		// everyone. Focus still moves into the dialog, so a screen reader reads the heading and the
		// warning, and the Tab trap below keeps End meeting one Tab away.
		byId("host-confirm-cancel").focus();
	}

	function closeEndConfirm(refocus) {
		byId("host-confirm").hidden = true;
		// Leaving the dialog also stops waiting for a close that is still in the air. Its catch
		// branch puts the buttons back and says that no answer arrived.
		if (state.closeController !== null) {
			state.closeController.abort();
		}
		if (refocus) {
			byId("end-meeting-button").focus();
		}
	}

	function handleDialogKeydown(event) {
		if (byId("host-confirm").hidden) {
			return;
		}
		var cancelButton = byId("host-confirm-cancel");
		var confirmButton = byId("host-confirm-yes");
		// Escape has to work even while the close request is still in the air. Without it a close
		// that never answers wedges the host behind a dialog that covers every other control.
		if (event.key === "Escape") {
			event.preventDefault();
			closeEndConfirm(true);
			return;
		}
		if (event.key !== "Tab") {
			return;
		}
		// While the close is pending Cancel is the only control left, so both Tab directions keep
		// focus on it instead of walking out of the dialog.
		if (confirmButton.disabled) {
			event.preventDefault();
			cancelButton.focus();
			return;
		}
		// Focus can sit outside both buttons while the dialog is open. A click on the backdrop, on the
		// heading or on the warning line moves it to the body, and from there the browser's own Tab
		// order walks into the controls this dialog covers. Leave is the first one it reaches, and
		// Enter on Leave takes the host out of the meeting instead of ending it for everyone. The two
		// branches below only look at the two buttons, so nothing caught that case.
		if (!byId("host-confirm").contains(document.activeElement)) {
			event.preventDefault();
			cancelButton.focus();
			return;
		}
		if (event.shiftKey && document.activeElement === cancelButton) {
			event.preventDefault();
			confirmButton.focus();
		} else if (!event.shiftKey && document.activeElement === confirmButton) {
			event.preventDefault();
			cancelButton.focus();
		}
	}

	function confirmEndMeeting() {
		var generation = bootGeneration;
		var confirmButton = byId("host-confirm-yes");
		var cancelButton = byId("host-confirm-cancel");
		// Move focus off the confirm button before it turns disabled: the browser blurs a focused
		// element the moment it is disabled, and focus would land on the body inside a modal
		// dialog. Cancel stays enabled because it is the way out while the close is pending.
		cancelButton.focus();
		confirmButton.disabled = true;
		confirmButton.textContent = "Ending…";
		setText("host-confirm-text", "Ending the meeting… Cancel or Escape stops waiting for the answer.");
		setError("host-error", null);
		byId("end-meeting-button").disabled = true;
		var controller = typeof AbortController === "function" ? new AbortController() : null;
		state.closeController = controller;
		var timeout = setTimeout(function () {
			if (controller) {
				controller.abort();
			}
		}, CLOSE_TIMEOUT_MS);
		apiPostWithCsrfRefresh("/room/api/host/close", {}, controller ? controller.signal : undefined)
			.then(function (answer) {
				if (generation !== bootGeneration) {
					return;
				}
				// The close answer carries the server's read of the row after admission closed, and
				// that read is final: once the close commits, no recording can attach any more. So
				// prefer it over this page's own stage — the stage can be one step behind, and the
				// worst answer is sending the host to wait for files that can never arrive.
				var recorded = answer && typeof answer.recorded === "boolean" ? answer.recorded : null;
				var endedMessage;
				if (recorded === true) {
					endedMessage =
						"You ended the meeting. The recording files will appear on the Council page when they are ready.";
				} else if (recorded === false) {
					// No recording ever attached, so no files can come. The local stage still knows
					// the most specific reason why.
					if (state.recordingStage === "unavailable") {
						endedMessage =
							"You ended the meeting. The recording could not be started, so this meeting was not saved.";
					} else if (
						state.recordingStage === "unsaved" ||
						state.recordingStage === "requested" ||
						state.recordingStage === "finished"
					) {
						// The same pair of facts the end dialog gave: a recording did start, and it
						// was never stored, so nothing can seal its files. "requested" and "finished"
						// belong here too: the provider's broadcast moved the page to those stages, so
						// this page watched a recording run that was never stored. Saying no recording
						// was started would deny what the room already announced.
						endedMessage =
							"You ended the meeting. The recording could not be saved, so there are no files to prepare.";
					} else {
						endedMessage = "You ended the meeting. No recording was started, so there are no files to prepare.";
					}
				} else if (state.recordingStage === "unavailable") {
					// The answer carried no recorded flag; fall back to what this page saw.
					endedMessage =
						"You ended the meeting. The recording could not be started, so this meeting was not saved.";
				} else if (state.recordingStage === "unsaved") {
					endedMessage =
						"You ended the meeting. The recording could not be saved, so there are no files to prepare.";
				} else if (state.recordingStage === "idle") {
					endedMessage = "You ended the meeting. No recording was started, so there are no files to prepare.";
				} else if (state.recordingStage === "pending") {
					// The start request was still in the air when the close ran, so the close decided
					// it: either the recording attached and its files come, or the start was refused
					// afterwards and nothing was saved. Neither answer is known here.
					endedMessage =
						"You ended the meeting. If the recording started, its files will appear on the Council page when they are ready.";
				} else {
					endedMessage =
						"You ended the meeting. The recording files will appear on the Council page when they are ready.";
				}
				endLocally(endedMessage);
			})
			.catch(function (error) {
				if (generation !== bootGeneration || state.over) {
					return;
				}
				byId("end-meeting-button").disabled = false;
				confirmButton.disabled = false;
				confirmButton.textContent = "End meeting";
				closeEndConfirm(false);
				setError(
					"host-error",
					error && error.name === "AbortError"
						? "Ending the meeting got no answer. It may still be ending, and this page follows the meeting by itself."
						: errorText(error)
				);
				byId("end-meeting-button").focus();
			})
			.finally(function () {
				clearTimeout(timeout);
				state.closeController = null;
			});
	}

	// #endregion host controls

	// #region lifecycle

	function startPolling() {
		stopPolling();
		state.pollTimer = setInterval(pollMeetingState, 10000);
	}

	function stopPolling() {
		if (state.pollTimer !== null) {
			clearInterval(state.pollTimer);
			state.pollTimer = null;
		}
	}

	function pollMeetingState() {
		// One poll at a time. The interval does not check whether the last tick answered, so a route
		// that stalls would stack one more request every ten seconds, and they would all land
		// together when the network came back. A stalled Wi-Fi hop or a phone waking from sleep is
		// enough to reach that.
		if (state.pollRequest !== null) {
			return;
		}
		var generation = bootGeneration;
		var controller = typeof AbortController === "function" ? new AbortController() : null;
		var request = { controller: controller };
		state.pollRequest = request;
		var timeout = setTimeout(function () {
			if (controller) {
				controller.abort();
			}
		}, STATE_POLL_TIMEOUT_MS);
		apiPostWithCsrfRefresh("/room/api/state", {}, controller ? controller.signal : undefined)
			.then(function (data) {
				if (generation !== bootGeneration) {
					return;
				}
				// /room/api/state answers { meeting: meeting_room_view(...) } and nothing else.
				var status = data && data.meeting && typeof data.meeting.status === "string" ? data.meeting.status : null;
				// recording_start_unknown still holds a live call: the meeting keeps running, it
				// just cannot record and cannot admit anyone new.
				// Say nothing while the host's own close is still in the air. The service closes the
				// meeting in the database first and only then does the provider and Convex work, so
				// this poll can read "closed" while the close request has not answered yet. Ending
				// here sets state.over, the close's own answer then hits endLocally's early return,
				// and the host who recorded gets "The meeting has ended." instead of being told where
				// their files will appear. state.closeController is cleared when the close settles,
				// so this wait is bounded by the close deadline and by Cancel or Escape.
				if (
					status !== null &&
					status !== "open" &&
					status !== "recording_start_unknown" &&
					!state.over &&
					state.closeController === null
				) {
					endLocally("The meeting has ended.");
				}
			})
			.catch(function (error) {
				if (generation !== bootGeneration || state.over) {
					return;
				}
				// Stay silent for every other failure: a poll that misses one answer on a bad network
				// is normal, and the next tick tries again. A 401 that survived the refresh is not
				// that. This page cannot ask about the meeting any more, so nothing here will ever
				// notice that the meeting ended, and the room must not look healthy while that is
				// true.
				if (error && error.status === 401) {
					setCallStatus(errorText(error));
				}
			})
			.finally(function () {
				clearTimeout(timeout);
				// Compare the identity: a poll left over from a previous call must not free the slot
				// of the poll running for the current one.
				if (state.pollRequest === request) {
					state.pollRequest = null;
				}
			});
	}

	function teardownCall(shouldLeave) {
		stopPolling();
		// A poll still in the air holds the one-at-a-time slot, and nothing else frees it. The next
		// call in this same document would then skip its own polls until this request settles or its
		// 30s deadline aborts it. Stop waiting for an answer the room no longer needs, the way
		// closeEndConfirm stops waiting for a close.
		if (state.pollRequest !== null) {
			if (state.pollRequest.controller) {
				state.pollRequest.controller.abort();
			}
			state.pollRequest = null;
		}
		// A close still in the air switches end detection off. handleRoomLeft and the state poll both
		// stay silent while this latch is set, and only the close's own answer clears it. The host can
		// leave that close behind by pasting a fresh room link into the same tab. The next call in
		// this document would then ignore its own end until the old close hit its 30s deadline. Stop
		// waiting for that answer, the same way the poll above does. The abort settles the old close
		// right away, so its finally cannot later null a latch a newer close has stored.
		if (state.closeController !== null) {
			state.closeController.abort();
			state.closeController = null;
		}
		if (state.elapsedTimer !== null) {
			clearInterval(state.elapsedTimer);
			state.elapsedTimer = null;
		}
		if (state.callStatusTimer !== null) {
			clearTimeout(state.callStatusTimer);
			state.callStatusTimer = null;
		}
		clearCallListeners();
		clearParticipantTiles();
		state.meetingStartedAt = null;
		state.reconnecting = false;
		state.recordingStage = "idle";
		state.recordingActive = false;
		byId("recording-indicator").hidden = true;
		setText("recording-live", "");
		// A media toggle whose provider call never settled would leave its button marked busy, and
		// the next call in this same document would start with a dead microphone or camera button.
		// A start-recording request still in the air leaves the same mark.
		byId("mute-button").removeAttribute("aria-busy");
		byId("camera-button").removeAttribute("aria-busy");
		byId("start-recording-button").removeAttribute("aria-busy");
		// A close that already succeeded leaves the confirmation dialog open on its pending wording,
		// with the confirm button disabled. It is invisible only because the call view is hidden, so
		// the next call in this same document would start under a full-screen modal that says a
		// running meeting is being ended. Put the dialog and both its buttons back the way they open.
		byId("host-confirm").hidden = true;
		var confirmButton = byId("host-confirm-yes");
		confirmButton.disabled = false;
		confirmButton.textContent = "End meeting";
		setText("host-confirm-text", endConfirmDescription);
		// The same close disabled End meeting itself, and nothing else ever puts it back.
		byId("end-meeting-button").disabled = false;
		// A failed start-recording or a failed close leaves this alert on screen, and only the next
		// press of those two controls clears it. The next call in this same document would open with
		// a red error about a meeting that is already over, beside controls that are back to idle.
		setError("host-error", null);
		var sdk = state.sdk;
		state.sdk = null;
		if (shouldLeave) {
			leaveSdk(sdk);
		}
	}

	function endLocally(message, canRejoin) {
		if (state.over) {
			return;
		}
		state.over = true;
		cancelJoinOperation();
		teardownCall(true);
		setText("ended-message", message);
		// Leaving is the only end a participant can undo: the room cookie still resumes the session.
		// Every other end really is over. So canRejoin is the exact marker for "you left", and both
		// the heading and the button below read it.
		var canRejoinNow = canRejoin === true;
		// The heading is the label of this whole view and the element showView puts focus on, so a
		// screen reader may read it and nothing else. Telling someone who only left that the meeting
		// ended is wrong twice over: the meeting is still running for everyone else, and the message
		// and the Rejoin button under the heading say the opposite.
		setText("ended-heading", canRejoinNow ? "You left the meeting" : "Meeting ended");
		var rejoinButton = byId("rejoin-button");
		rejoinButton.hidden = !canRejoinNow;
		rejoinButton.removeAttribute("aria-busy");
		rejoinButton.textContent = "Rejoin the meeting";
		showView("view-ended", "ended-heading");
	}

	function handlePageHide(event) {
		// persisted true means the browser is putting this document in the back/forward cache and can
		// show this very same document again later. dispose() cannot be undone: it ends the call, kills
		// the timers and removes every listener, so a restored document would show a healthy-looking
		// meeting whose Leave button does nothing and whose clock has stopped. End the call the honest
		// way instead, so the participant comes back to the ended screen and can rejoin from there.
		// Only a live call needs that end. A live call holds the microphone, and Chrome refuses to
		// cache a document that does, so the pages this branch really sees are the guest form and the
		// lobby. Announcing a meeting nobody joined would replace the form the participant was filling
		// in with "You left the meeting". Leave those pages alone: there is no call to end, and the
		// same reason that rules out dispose() above rules it out here too.
		if (event && event.persisted === true) {
			if (state.sdk !== null) {
				endLocally("This page was put to sleep, so you left the meeting.", true);
			}
			return;
		}
		dispose();
	}

	function dispose() {
		if (state.disposed) {
			return;
		}
		state.disposed = true;
		bootGeneration += 1;
		state.over = true;
		cancelJoinOperation();
		teardownCall(true);
		if (typeof window.__councilOnHashChange === "function") {
			window.removeEventListener("hashchange", window.__councilOnHashChange);
		}
		window.removeEventListener("pagehide", handlePageHide);
		document.removeEventListener("keydown", handleDialogKeydown);
	}

	// #endregion lifecycle

	function captureTicketFromHash() {
		var hash = window.location.hash;
		if (!hash || hash.length <= 1) {
			return null;
		}
		var ticket = new URLSearchParams(hash.slice(1)).get("ticket");
		history.replaceState(null, "", window.location.pathname + window.location.search);
		return ticket;
	}

	function exchangeTicket(ticket) {
		var generation = ++bootGeneration;
		resetLiveCall();
		// resetLiveCall ends the call but leaves whatever view is on screen. Pasting a fresh room link
		// into the tab already in a call is a hashchange, not a navigation, so the call screen stayed
		// up with no tiles, a frozen clock and a "Connected" chip for the whole exchange. Show the
		// loading view instead, the same one the page opens with.
		showView("view-loading");
		// Without a deadline a request that never answers leaves the page on "Preparing the
		// meeting room…" forever, with nothing to press.
		var controller = typeof AbortController === "function" ? new AbortController() : null;
		var timeout = setTimeout(function () {
			if (controller) {
				controller.abort();
			}
		}, GUEST_SESSION_TIMEOUT_MS);
		apiPost("/room/api/session", { ticket: ticket }, controller ? controller.signal : undefined)
			.then(function (session) {
				if (generation !== bootGeneration) {
					return;
				}
				adoptSession(session);
			})
			.catch(function (error) {
				if (generation !== bootGeneration) {
					return;
				}
				// apiPost puts a status on the error only when the service answered and refused. An
				// error with no status never reached the service, so nothing there read the ticket,
				// and the line below would tell the host their room link is spent when it was never
				// used. A deadline abort has no status either, so it lands here too.
				if (!error || typeof error.status !== "number") {
					showFatal("The meeting room did not answer. Check your connection, then reload the page.");
					return;
				}

				// Do not glue the service's own words onto this sentence. Every refusal this branch can
				// take is a bare noun phrase with no full stop: "Unauthorized" for the ticket, and
				// "Failed to create the host participant" for a write that failed. What the host read
				// was: Unauthorized Room links are single-use. Every other showFatal here writes a
				// whole sentence of its own, so do the same. handle_session answers that one word for
				// a spent ticket, an expired one and one that never existed alike, so this wording may
				// not claim the link was already used.
				showFatal(
					error.status === 401
						? "That room link did not work. Room links are single-use and they expire, so get a fresh room link from the Council page."
						: "The meeting room could not open this room link. Reload the page, or get a fresh room link from the Council page."
				);
			})
			.finally(function () {
				clearTimeout(timeout);
			});
	}

	function resumeOrGuest() {
		var generation = ++bootGeneration;
		var controller = typeof AbortController === "function" ? new AbortController() : null;
		var timeout = setTimeout(function () {
			if (controller) {
				controller.abort();
			}
		}, GUEST_SESSION_TIMEOUT_MS);
		// Name the meeting this page was opened for. One room cookie covers the whole origin, so
		// without this the service would resume whatever meeting the visitor was in last and put
		// them back into it. A refused resume lands in the guest branch below, which asks for this
		// meeting's join code — the same path a visitor with no cookie takes.
		var meetingId = new URLSearchParams(window.location.search).get("m");
		apiPost(
			"/room/api/session",
			meetingId === null ? {} : { meetingId: meetingId },
			controller ? controller.signal : undefined,
		)
			.then(function (session) {
				if (generation !== bootGeneration) {
					return;
				}
				adoptSession(session);
			})
			.catch(function (error) {
				if (generation !== bootGeneration) {
					return;
				}
				// A refused session is the normal answer for a visitor with no room cookie, and
				// the join code is the way in. A request that never answered says nothing about
				// the cookie, so asking for a join code there would send the host down a dead end.
				// apiPost puts a status on the error only when the service answered and refused, so
				// an error with no status is one that never reached it. A deadline abort has no
				// status either, so it lands here too.
				if (!error || typeof error.status !== "number") {
					showFatal("The meeting room did not answer. Check your connection, then reload the page.");
					return;
				}

				if (meetingId !== null) {
					state.guestMeetingId = meetingId;
					showView("view-guest", "guest-heading");
				} else {
					showFatal("This is not a valid meeting link. Ask the meeting host for a new invite link.");
				}
			})
			.finally(function () {
				clearTimeout(timeout);
			});
	}

	function boot() {
		// The dialog question lives in the document. Keep a copy so teardownCall can put that exact
		// sentence back without repeating it in two files. openEndConfirm then picks the wording that
		// fits the recording stage every time the dialog opens.
		endConfirmDescription = byId("host-confirm-text").textContent;
		byId("guest-form").addEventListener("submit", submitGuestForm);
		// Listen on the lobby form, not on the Join button. The button is the form's submit button,
		// so a press and Enter in the display-name field both land here, and Enter is what a host who
		// is still typing their name reaches for.
		byId("lobby-form").addEventListener("submit", function (event) {
			event.preventDefault();
			joinMeeting();
		});
		byId("mute-button").addEventListener("click", function () {
			toggleLocalMedia("audio");
		});
		byId("camera-button").addEventListener("click", function () {
			toggleLocalMedia("video");
		});
		byId("play-audio-button").addEventListener("click", retryBlockedAudio);
		byId("leave-button").addEventListener("click", function () {
			endLocally("You left the meeting.", true);
		});
		byId("rejoin-button").addEventListener("click", function () {
			var button = byId("rejoin-button");
			// Keep the button focusable while the session request runs, and ignore repeat presses.
			if (button.getAttribute("aria-busy") === "true") {
				return;
			}
			button.setAttribute("aria-busy", "true");
			button.textContent = "Rejoining…";
			resumeOrGuest();
		});
		byId("start-recording-button").addEventListener("click", startRecording);
		byId("end-meeting-button").addEventListener("click", openEndConfirm);
		byId("host-confirm-yes").addEventListener("click", confirmEndMeeting);
		byId("host-confirm-cancel").addEventListener("click", function () {
			closeEndConfirm(true);
		});

		if (typeof window.__councilOnHashChange === "function") {
			window.removeEventListener("hashchange", window.__councilOnHashChange);
		}
		window.__councilOnHashChange = function () {
			var pasted = captureTicketFromHash();
			if (pasted) {
				exchangeTicket(pasted);
			}
		};
		window.addEventListener("hashchange", window.__councilOnHashChange);
		// pagehide only. beforeunload also fires for navigations that never replace the document — a
		// link whose response is 204 No Content is enough — and disposing there leaves the participant
		// looking at a call that has already ended, with no way to leave it or rejoin.
		window.addEventListener("pagehide", handlePageHide);
		document.addEventListener("keydown", handleDialogKeydown);
		window.__councilDispose = dispose;

		var entry = window.__councilEntry || { ticket: null };
		delete window.__councilEntry;
		if (entry.ticket) {
			exchangeTicket(entry.ticket);
		} else {
			resumeOrGuest();
		}
	}

	boot();
})();
`;
