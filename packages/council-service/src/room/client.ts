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

	var JOIN_TIMEOUT_MS = 30000;
	var GUEST_SESSION_TIMEOUT_MS = 30000;
	var csrfToken = null;
	var bootGeneration = 0;

	var state = {
		meeting: null,
		participant: null,
		guestMeetingId: null,
		joinAttempt: null,
		joinOperation: null,
		joinSequence: 0,
		sdk: null,
		pollTimer: null,
		elapsedTimer: null,
		callStatusTimer: null,
		meetingStartedAt: null,
		callListeners: [],
		tiles: {},
		blockedAudio: [],
		pendingAudio: [],
		pinnedKey: null,
		reconnecting: false,
		recordingPending: false,
		recordingRequested: false,
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
		setText("error-message", message);
		showView("view-error", "error-heading");
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
		var joinButton = byId("join-button");
		joinButton.disabled = false;
		joinButton.textContent = "Join meeting";
		setText("lobby-progress", "");
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
		var codeInput = byId("guest-code");
		var nameInput = byId("guest-name");
		var emailInput = byId("guest-email");
		var code = codeInput.value.trim();
		var displayName = nameInput.value.trim();
		var email = emailInput.value.trim();

		codeInput.removeAttribute("aria-invalid");
		nameInput.removeAttribute("aria-invalid");
		if (code === "") {
			codeInput.setAttribute("aria-invalid", "true");
			setError("guest-error", "Enter the join code you were given.");
			codeInput.focus();
			return;
		}
		if (displayName === "") {
			nameInput.setAttribute("aria-invalid", "true");
			setError("guest-error", "Enter the name to show to other participants.");
			nameInput.focus();
			return;
		}
		setError("guest-error", null);

		var attemptKey = code + "\\u0000" + displayName + "\\u0000" + email;
		if (state.joinAttempt === null || state.joinAttempt.key !== attemptKey) {
			state.joinAttempt = { key: attemptKey, id: crypto.randomUUID() };
		}

		var submitButton = byId("guest-submit");
		var generation = bootGeneration;
		var controller = typeof AbortController === "function" ? new AbortController() : null;
		var timeout = setTimeout(function () {
			if (controller) {
				controller.abort();
			}
		}, GUEST_SESSION_TIMEOUT_MS);
		submitButton.disabled = true;
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
				submitButton.disabled = false;
				submitButton.textContent = "Continue";
				adoptSession(session);
			})
			.catch(function (error) {
				if (generation !== bootGeneration) {
					return;
				}
				submitButton.disabled = false;
				submitButton.textContent = "Continue";
				setError(
					"guest-error",
					error && error.name === "AbortError"
						? "Checking the invite took too long. Check your connection, then try again."
						: errorText(error)
				);
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
		joinButton.disabled = false;
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
		var joinBody = {};
		var hostNameField = byId("host-name-field");
		if (hostNameField && !hostNameField.hidden) {
			var nameInput = byId("host-name");
			var displayName = nameInput.value.trim();
			nameInput.removeAttribute("aria-invalid");
			if (displayName === "") {
				nameInput.setAttribute("aria-invalid", "true");
				setError("lobby-error", "Enter the name to show to other participants.");
				nameInput.focus();
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
		var joinButton = byId("join-button");
		joinButton.disabled = true;
		joinButton.textContent = "Joining…";
		setText("lobby-progress", "Requesting a place in the meeting…");
		operation.timer = setTimeout(function () {
			failJoin(operation, "Joining took too long. Check your connection, then try again.");
		}, JOIN_TIMEOUT_MS);

		apiPost("/room/api/join", joinBody, controller ? controller.signal : undefined)
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
				return Promise.resolve(state.sdk.self.enableAudio()).then(
					function () {
						return true;
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

	function attachTrack(element, kind, track) {
		if (currentElementTrack(element, kind) === track) {
			return;
		}
		element.srcObject = track ? makeTrackStream(track) : null;
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
				function () {
					removePendingAudio(audio);
					markBlockedAudio(audio);
				}
			);
		} catch (_error) {
			removePendingAudio(audio);
			markBlockedAudio(audio);
		}
	}

	function retryBlockedAudio() {
		state.blockedAudio.slice().forEach(function (audio) {
			if (!audio.isConnected || !audio.srcObject) {
				removeBlockedAudio(audio);
				return;
			}
			playRemoteAudio(audio, true);
		});
	}

	function updateParticipantTile(record) {
		var participant = record.participant;
		var name = participantName(participant);
		record.name.textContent = name + (record.isSelf ? " (you)" : "");
		record.avatar.textContent = displayInitials(name);
		var videoEnabled = participant.videoEnabled === true && participant.videoTrack;
		record.element.dataset.video = videoEnabled ? "on" : "off";
		attachTrack(record.video, "video", videoEnabled ? participant.videoTrack : null);
		if (videoEnabled && typeof record.video.play === "function") {
			try {
				Promise.resolve(record.video.play()).catch(function () {});
			} catch (_error) {}
		}

		var audioEnabled = participant.audioEnabled === true;
		record.mic.dataset.muted = audioEnabled ? "false" : "true";
		record.mic.textContent = audioEnabled ? "Mic on" : "Mic off";
		if (record.audio) {
			attachTrack(record.audio, "audio", audioEnabled && participant.audioTrack ? participant.audioTrack : null);
			if (record.audio.srcObject) {
				playRemoteAudio(record.audio);
			} else {
				removeBlockedAudio(record.audio);
			}
		}
		record.pin.setAttribute("aria-label", (state.pinnedKey === record.key ? "Unpin " : "Pin ") + name);
		record.pin.setAttribute("aria-pressed", state.pinnedKey === record.key ? "true" : "false");
		record.pin.textContent = state.pinnedKey === record.key ? "Pinned" : "Pin";
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
		var mic = document.createElement("span");
		mic.className = "participant-mic";
		meta.appendChild(name);
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
		if (keys.length >= 3) {
			stage.dataset.layout = "featured";
			stage.dataset.sideColumns = keys.length >= 4 ? "2" : "1";
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
		keys.forEach(function (key) {
			var record = state.tiles[key];
			record.element.dataset.featured = keys.length >= 3 && key === featuredKey ? "true" : "false";
			stage.appendChild(record.element);
			updateParticipantTile(record);
		});
		setText("participant-count", String(keys.length));
		byId("participant-count-button").setAttribute(
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
				if (!desired[key] || desired[key].participant !== preferredParticipant) {
					desired[key] = { participant: participant, isSelf: false };
				}
				if (participant === preferredParticipant) {
					desired[key] = { participant: preferredParticipant, isSelf: false };
				}
			});
		}

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
		element.textContent = message;
		element.hidden = message === "";
		if (message !== "" && typeof clearAfterMs === "number") {
			state.callStatusTimer = setTimeout(function () {
				if (element.textContent === message) {
					element.textContent = "";
					element.hidden = true;
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
		var micButton = byId("mute-button");
		var micOn = sdk.self.audioEnabled === true;
		micButton.setAttribute("aria-pressed", micOn ? "true" : "false");
		micButton.setAttribute("aria-label", micOn ? "Turn microphone off" : "Turn microphone on");

		var cameraButton = byId("camera-button");
		var cameraOn = sdk.self.videoEnabled === true;
		cameraButton.setAttribute("aria-pressed", cameraOn ? "true" : "false");
		cameraButton.setAttribute("aria-label", cameraOn ? "Turn camera off" : "Turn camera on");
	}

	function toggleLocalMedia(kind) {
		var sdk = state.sdk;
		if (!sdk) {
			return;
		}
		var button = byId(kind === "audio" ? "mute-button" : "camera-button");
		var enabled = kind === "audio" ? sdk.self.audioEnabled === true : sdk.self.videoEnabled === true;
		button.disabled = true;
		var action =
			kind === "audio"
				? enabled
					? sdk.self.disableAudio()
					: sdk.self.enableAudio()
				: enabled
					? sdk.self.disableVideo()
					: sdk.self.enableVideo();
		Promise.resolve(action).then(
			function () {
				if (state.sdk !== sdk) {
					return;
				}
				button.disabled = false;
				renderLocalControls();
				reconcileParticipants(sdk.self);
				clearCallStatus(kind === "audio" ? "Microphone unavailable" : "Camera unavailable");
			},
			function () {
				if (state.sdk !== sdk) {
					return;
				}
				button.disabled = false;
				renderLocalControls();
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
		if (active && !state.recordingActive) {
			setText("recording-live", "Recording has started.");
		}
		state.recordingActive = active;
		if (current === "RECORDING") {
			clearCallStatus("Recording is starting");
		}
		var button = byId("start-recording-button");
		button.disabled = state.recordingPending || state.recordingRequested || active;
		button.querySelector(".control-label").textContent = active
			? "Recording"
			: state.recordingRequested
				? "Recording requested"
				: "Start recording";
	}

	function handleRoomLeft(payload, sdk) {
		if (state.sdk !== sdk || state.over) {
			return;
		}
		if (payload && (payload.state === "disconnected" || payload.state === "failed")) {
			state.reconnecting = true;
			setConnectionStatus("Reconnecting", "reconnecting");
			setCallStatus("Connection lost. Reconnecting…");
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

	function handleSocketConnectionUpdate(update, sdk) {
		if (state.sdk !== sdk || !update) {
			return;
		}
		if (update.state === "connected") {
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
		addCallListener(sdk.self, "audioUpdate", function () {
			renderLocalControls();
			reconcileParticipants(sdk.self);
		});
		addCallListener(sdk.self, "videoUpdate", function () {
			renderLocalControls();
			reconcileParticipants(sdk.self);
		});
		addCallListener(sdk.self, "roomLeft", function (payload) {
			handleRoomLeft(payload, sdk);
		});
		addCallListener(sdk.self, "roomJoined", function () {
			handleRoomJoined(sdk);
		});
		addCallListener(sdk.recording, "recordingUpdate", renderRecordingState);
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
		state.recordingPending = false;
		state.recordingRequested = false;
		state.recordingActive = false;
		wireCallEvents();
		reconcileParticipants(null);
		renderLocalControls();
		renderRecordingState();
		setConnectionStatus("Connected", "connected");
		startElapsedTimer();
		showView("view-call", "call-heading");
		if (micOn === false) {
			setCallStatus("Microphone unavailable. Allow microphone access, then turn the microphone on.");
		} else {
			setCallStatus("");
		}
		startPolling();
	}

	// #endregion call state

	// #region host controls

	function startRecording() {
		if (state.recordingPending || state.recordingRequested || state.recordingActive) {
			return;
		}
		var generation = bootGeneration;
		state.recordingPending = true;
		setError("host-error", null);
		renderRecordingState();
		apiPost("/room/api/host/start-recording", {})
			.then(function () {
				if (generation !== bootGeneration || state.over) {
					return;
				}
				state.recordingPending = false;
				state.recordingRequested = true;
				renderRecordingState();
				setCallStatus("Recording is starting.");
			})
			.catch(function (error) {
				if (generation !== bootGeneration || state.over) {
					return;
				}
				state.recordingPending = false;
				renderRecordingState();
				setError("host-error", errorText(error));
				byId("start-recording-button").focus();
			});
	}

	function openEndConfirm() {
		byId("host-confirm").hidden = false;
		byId("host-confirm-yes").focus();
	}

	function closeEndConfirm(refocus) {
		byId("host-confirm").hidden = true;
		if (refocus) {
			byId("end-meeting-button").focus();
		}
	}

	function handleDialogKeydown(event) {
		if (byId("host-confirm").hidden) {
			return;
		}
		if (byId("host-confirm-yes").disabled) {
			event.preventDefault();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			closeEndConfirm(true);
			return;
		}
		if (event.key !== "Tab") {
			return;
		}
		var cancelButton = byId("host-confirm-cancel");
		var confirmButton = byId("host-confirm-yes");
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
		confirmButton.disabled = true;
		cancelButton.disabled = true;
		confirmButton.textContent = "Ending…";
		setError("host-error", null);
		byId("end-meeting-button").disabled = true;
		apiPost("/room/api/host/close", {})
			.then(function () {
				if (generation !== bootGeneration) {
					return;
				}
				endLocally(
					"You ended the meeting. If recording was started, its files will appear on the Council page when they are ready."
				);
			})
			.catch(function (error) {
				if (generation !== bootGeneration || state.over) {
					return;
				}
				byId("end-meeting-button").disabled = false;
				confirmButton.disabled = false;
				cancelButton.disabled = false;
				confirmButton.textContent = "End meeting";
				closeEndConfirm(false);
				setError("host-error", errorText(error));
				byId("end-meeting-button").focus();
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
		var generation = bootGeneration;
		apiPost("/room/api/state", {})
			.then(function (data) {
				if (generation !== bootGeneration) {
					return;
				}
				var status =
					data && data.meeting && typeof data.meeting.status === "string"
						? data.meeting.status
						: data && typeof data.status === "string"
							? data.status
							: null;
				if (status !== null && status !== "open" && status !== "recording_start_unknown" && !state.over) {
					endLocally("The meeting has ended.");
				}
			})
			.catch(function () {});
	}

	function teardownCall(shouldLeave) {
		stopPolling();
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
		state.recordingPending = false;
		state.recordingRequested = false;
		state.recordingActive = false;
		byId("recording-indicator").hidden = true;
		setText("recording-live", "");
		var sdk = state.sdk;
		state.sdk = null;
		if (shouldLeave) {
			leaveSdk(sdk);
		}
	}

	function endLocally(message) {
		if (state.over) {
			return;
		}
		state.over = true;
		cancelJoinOperation();
		teardownCall(true);
		setText("ended-message", message);
		showView("view-ended", "ended-heading");
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
		window.removeEventListener("pagehide", dispose);
		window.removeEventListener("beforeunload", dispose);
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
		apiPost("/room/api/session", { ticket: ticket })
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
				showFatal(errorText(error) + " Room links are single-use. Get a fresh room link from the Council page.");
			});
	}

	function resumeOrGuest() {
		var generation = ++bootGeneration;
		apiPost("/room/api/session", {})
			.then(function (session) {
				if (generation !== bootGeneration) {
					return;
				}
				adoptSession(session);
			})
			.catch(function () {
				if (generation !== bootGeneration) {
					return;
				}
				var meetingId = new URLSearchParams(window.location.search).get("m");
				if (meetingId !== null) {
					state.guestMeetingId = meetingId;
					showView("view-guest", "guest-heading");
				} else {
					showFatal("This is not a valid meeting link. Ask the meeting host for a new invite link.");
				}
			});
	}

	function boot() {
		byId("guest-form").addEventListener("submit", submitGuestForm);
		byId("join-button").addEventListener("click", joinMeeting);
		byId("mute-button").addEventListener("click", function () {
			toggleLocalMedia("audio");
		});
		byId("camera-button").addEventListener("click", function () {
			toggleLocalMedia("video");
		});
		byId("play-audio-button").addEventListener("click", retryBlockedAudio);
		byId("leave-button").addEventListener("click", function () {
			endLocally("You left the meeting.");
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
		window.addEventListener("pagehide", dispose);
		window.addEventListener("beforeunload", dispose);
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
