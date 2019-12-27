/*
Copyright 2018 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import logger from '../../../logger';
import RequestCallbackChannel from "./RequestCallbackChannel";
import {EventEmitter} from 'events';
import {
    newUnknownMethodError,
    newUnexpectedMessageError,
    errorFromEvent,
    errorFactory,
} from "../Error";

// the recommended amount of time before a verification request
// should be (automatically) cancelled without user interaction
// and ignored.
const VERIFICATION_REQUEST_TIMEOUT = 10 * 60 * 1000; //10m
// to avoid almost expired verification notifications
// from showing a notification and almost immediately
// disappearing, also ignore verification requests that
// are this amount of time away from expiring.
const VERIFICATION_REQUEST_MARGIN = 3 * 1000; //3s


export const EVENT_PREFIX = "m.key.verification.";
export const REQUEST_TYPE = EVENT_PREFIX + "request";
export const START_TYPE = EVENT_PREFIX + "start";
export const CANCEL_TYPE = EVENT_PREFIX + "cancel";
export const DONE_TYPE = EVENT_PREFIX + "done";
export const READY_TYPE = EVENT_PREFIX + "ready";

export const PHASE_UNSENT = 1;
export const PHASE_REQUESTED = 2;
export const PHASE_READY = 3;
export const PHASE_STARTED = 4;
export const PHASE_CANCELLED = 5;
export const PHASE_DONE = 6;


/**
 * State machine for verification requests.
 * Things that differ based on what channel is used to
 * send and receive verification events are put in `InRoomChannel` or `ToDeviceChannel`.
 * @event "change" whenever the state of the request object has changed.
 */
export default class VerificationRequest extends EventEmitter {
    constructor(channel, verificationMethods, client) {
        super();
        this.channel = channel;
        this._verificationMethods = verificationMethods;
        this._client = client;
        this._commonMethods = [];
        this._setPhase(PHASE_UNSENT, false);
        this._eventsByUs = new Map();
        this._eventsByThem = new Map();
        this._observeOnly = false;
    }

    /**
     * Stateless validation logic not specific to the channel.
     * Invoked by the same static method in either channel.
     * @param {string} type the "symbolic" event type, as returned by the `getEventType` function on the channel.
     * @param {MatrixEvent} event the event to validate. Don't call getType() on it but use the `type` parameter instead.
     * @param {number} timestamp the timestamp in milliseconds when this event was sent.
     * @param {MatrixClient} client the client to get the current user and device id from
     * @returns {bool} whether the event is valid and should be passed to handleEvent
     */
    static validateEvent(type, event, timestamp, client) {
        const content = event.getContent();

        if (!content) {
            console.log("VerificationRequest: validateEvent: no content", type);
        }

        if (!type.startsWith(EVENT_PREFIX)) {
            console.log("VerificationRequest: validateEvent: fail because type doesnt start with " + EVENT_PREFIX, type);
            return false;
        }

        if (type === REQUEST_TYPE || type === READY_TYPE) {
            if (!Array.isArray(content.methods)) {
                console.log("VerificationRequest: validateEvent: fail because methods", type);
                return false;
            }
        }

        if (type === REQUEST_TYPE || type === READY_TYPE || type === START_TYPE) {
            if (typeof content.from_device !== "string" ||
                content.from_device.length === 0
            ) {
                console.log("VerificationRequest: validateEvent: fail because from_device", type);
                return false;
            }
        }

        // a timestamp is not provided on all to_device events
        if (Number.isFinite(timestamp)) {
            const elapsed = Date.now() - timestamp;
            // ignore if event is too far in the past or too far in the future
            if (elapsed > (VERIFICATION_REQUEST_TIMEOUT - VERIFICATION_REQUEST_MARGIN) ||
                elapsed < -(VERIFICATION_REQUEST_TIMEOUT / 2)
            ) {
                console.log("VerificationRequest: validateEvent: verification event to far in future or past", type, elapsed);
                logger.log("received verification that is too old or from the future");
                return false;
            }
        }

        return true;
    }

    /** returns whether the phase is PHASE_REQUESTED */
    get requested() {
        return this.phase === PHASE_REQUESTED;
    }

    /** returns whether the phase is PHASE_CANCELLED */
    get cancelled() {
        return this.phase === PHASE_CANCELLED;
    }

    /** returns whether the phase is PHASE_READY */
    get ready() {
        return this.phase === PHASE_READY;
    }

    /** returns whether the phase is PHASE_STARTED */
    get started() {
        return this.phase === PHASE_STARTED;
    }

    /** returns whether the phase is PHASE_DONE */
    get done() {
        return this.phase === PHASE_DONE;
    }

    /** once the phase is PHASE_STARTED (and !initiatedByMe) or PHASE_READY: common methods supported by both sides */
    get methods() {
        return this._commonMethods;
    }

    /** the timeout of the request, provided for compatibility with previous verification code */
    get timeout() {
        const elapsed = Date.now() - this._startTimestamp;
        return Math.max(0, VERIFICATION_REQUEST_TIMEOUT - elapsed);
    }

    /** the m.key.verification.request event that started this request, provided for compatibility with previous verification code */
    get event() {
        return this._requestEvent;
    }

    /** current phase of the request. Some properties might only be defined in a current phase. */
    get phase() {
        return this._phase;
    }

    /** The verifier to do the actual verification, once the method has been established. Only defined when the `phase` is PHASE_STARTED. */
    get verifier() {
        return this._verifier;
    }

    /** whether this request has sent it's initial event and needs more events to complete */
    get pending() {
        // TODO: if we remove local echo, PHASE_UNSENT should not be considered non-pending.
        return this._phase !== PHASE_UNSENT
            && this._phase !== PHASE_DONE
            && this._phase !== PHASE_CANCELLED;
    }

    /** Whether this request was initiated by the syncing user.
     * For InRoomChannel, this is who sent the .request event.
     * For ToDeviceChannel, this is who sent the .start event
     */
    get initiatedByMe() {
        return this._initiatedByMe;
    }

    /** the id of the user that initiated the request */
    get requestingUserId() {
        if (this.initiatedByMe) {
            return this._client.getUserId();
        } else {
            return this.otherUserId;
        }
    }

    /** the id of the user that (will) receive(d) the request */
    get receivingUserId() {
        if (this.initiatedByMe) {
            return this.otherUserId;
        } else {
            return this._client.getUserId();
        }
    }

    /** the user id of the other party in this request */
    get otherUserId() {
        // TODO: make sure this can be read from the first event passed to handleEvent
        return this.channel.userId;
    }

    /**
     * the id of the user that cancelled the request,
     * only defined when phase is PHASE_CANCELLED
     */
    get cancellingUserId() {
        return this._cancellingUserId;
    }

    get observeOnly() {
        return this._observeOnly;
    }

    /* Start the key verification, creating a verifier and sending a .start event.
     * If no previous events have been sent, pass in `targetDevice` to set who to direct this request to.
     * @param {string} method the name of the verification method to use.
     * @param {string?} targetDevice.userId the id of the user to direct this request to
     * @param {string?} targetDevice.deviceId the id of the device to direct this request to
     * @returns {VerifierBase} the verifier of the given method
     */
    beginKeyVerification(method, targetDevice = null) {
        // need to allow also when unsent in case of to_device
        if (!this._observeOnly && !this._verifier) {
            // TODO
            if (this._hasValidPreStartPhase()) {
                // when called on a request that was initiated with .request event
                // check the method is supported by both sides
                if (this._commonMethods.length && !this._commonMethods.includes(method)) {
                    throw newUnknownMethodError();
                }
                this._verifier = this._createVerifier(method, null, targetDevice);
                if (!this._verifier) {
                    throw newUnknownMethodError();
                }
            }
        }
        return this._verifier;
    }

    /**
     * sends the initial .request event.
     * @returns {Promise} resolves when the event has been sent.
     */
    async sendRequest() {
        if (!this._observeOnly && this._phase === PHASE_UNSENT) {
            this._initiatedByMe = true;
            const methods = [...this._verificationMethods.keys()];
            await this.channel.send(REQUEST_TYPE, {methods});
        }
    }

    /**
     * Cancels the request, sending a cancellation to the other party
     * @param {string?} error.reason the error reason to send the cancellation with
     * @param {string?} error.code the error code to send the cancellation with
     * @returns {Promise} resolves when the event has been sent.
     */
    async cancel({reason = "User declined", code = "m.user"} = {}) {
        if (!this._observeOnly && this._phase !== PHASE_CANCELLED) {
            if (this._verifier) {
                return this._verifier.cancel(errorFactory(code, reason));
            } else {
                this._cancellingUserId = this._client.getUserId();
                await this.channel.send(CANCEL_TYPE, {code, reason});
            }
        }
    }

    /**
     * Accepts the request, sending a .ready event to the other party
     * @returns {Promise} resolves when the event has been sent.
     */
    async accept() {
        if (!this._observeOnly && this.phase === PHASE_REQUESTED && !this.initiatedByMe) {
            const methods = [...this._verificationMethods.keys()];
            await this.channel.send(READY_TYPE, {methods});
        }
    }

    /**
     * Can be used to listen for state changes until the callback returns true.
     * @param {Function} fn callback to evaluate whether the request is in the desired state.
     *                      Takes the request as an argument.
     * @returns {Promise} that resolves once the callback returns true
     * @throws {Error} when the request is cancelled
     */
    waitFor(fn) {
        return new Promise((resolve, reject) => {
            const check = () => {
                let handled = false;
                if (fn(this)) {
                    resolve(this);
                    handled = true;
                } else if (this.cancelled) {
                    reject(new Error("cancelled"));
                    handled = true;
                }
                if (handled) {
                    this.off("change", check);
                }
                return handled;
            };
            if (!check()) {
                this.on("change", check);
            }
        });
    }

    _setPhase(phase, notify = true) {
        this._phase = phase;
        if (notify) {
            this.emit("change");
        }
    }

    _getEventByEither(type) {
        return this._eventsByThem.get(type) || this._eventsByUs.get(type);
    }

    _getEventByOther(type, notSender) {
        if (notSender === this._client.getUserId()) {
            return this._eventsByThem.get(type);
        } else {
            return this._eventsByUs.get(type);
        }
    }

    _getEventBy(type, sender) {
        if (sender === this._client.getUserId()) {
            return this._eventsByUs.get(type);
        } else {
            return this._eventsByThem.get(type);
        }
    }

    _calculatePhaseTransitions() {
        const transitions = [{phase: PHASE_UNSENT}];
        const phase = () => transitions[transitions.length - 1].phase;

        const cancelEvent = this._getEventByEither(CANCEL_TYPE);
        if (cancelEvent) {
            transitions.push({phase: PHASE_CANCELLED, event: cancelEvent});
            return transitions;
        }

        const requestEvent = this._getEventByEither(REQUEST_TYPE);
        if (requestEvent) {
            transitions.push({phase: PHASE_REQUESTED, event: requestEvent});

            const readyEvent =
                this._getEventByOther(READY_TYPE, requestEvent.getSender());
            if (readyEvent) {
                transitions.push({phase: PHASE_READY, event: readyEvent});
            }
        }

        const startEvent = this._getEventByEither(START_TYPE);
        if (startEvent) {
            const fromRequestPhase = phase() === PHASE_REQUESTED &&
                requestEvent.getSender() !== startEvent.getSender();
            const fromUnsentPhase = phase() === PHASE_UNSENT &&
                this.channel.constructor.canCreateRequest(START_TYPE);
            if (fromRequestPhase || phase() === PHASE_READY || fromUnsentPhase) {
                transitions.push({phase: START_TYPE, event: startEvent});
            }
        }

        const ourDoneEvent = this._eventsByUs[DONE_TYPE];
        const theirDoneEvent = this._eventsByThem[DONE_TYPE];
        if (ourDoneEvent && theirDoneEvent && phase() === START_TYPE) {
            transitions.push({phase: PHASE_DONE});
        }

        return transitions;
    }

    _transitionToPhase(transition) {
        const {phase, event} = transition;
        // get common methods
        if (phase === PHASE_REQUESTED || phase === PHASE_READY) {
            if (!this._wasSentByOwnDevice(event)) {
                const content = event.getContent();
                this._commonMethods =
                    content.methods.filter(m => this._verificationMethods.has(m));
            }
        }
        // detect if we're not a party in the request, and we should just observe
        if (!this._observeOnly) {
            if (phase === PHASE_REQUESTED) {
                // if requested by one of my other devices
                if (this._wasSentByOwnUser(event) && !this._wasSentByOwnDevice(event)) {
                    this._observeOnly = true;
                }
            } else if (phase === PHASE_STARTED || phase === PHASE_READY) {
                this._observeOnly = !this._wasSentByOwnDevice(event);
            }
        }
        // create verifier
        if (phase === PHASE_STARTED) {
            const {method} = event.getContent();
            if (!this._verifier && !this._observeOnly) {
                this._verifier = this._createVerifier(method, event);
            }
            this._handleStart(transition);
        }
    }

    /**
     * Changes the state of the request and verifier in response to a key verification event.
     * @param {string} type the "symbolic" event type, as returned by the `getEventType` function on the channel.
     * @param {MatrixEvent} event the event to handle. Don't call getType() on it but use the `type` parameter instead.
     * @param {bool} isLiveEvent whether this is an even received through sync or not
     * @returns {Promise} a promise that resolves when any requests as an anwser to the passed-in event are sent.
     */
    async handleEvent(type, event, isLiveEvent) {
        // don't send out events for historical requests
        if (!isLiveEvent) {
            this._observeOnly = true;
        }

        const sender = event.getSender();
        const isOurs = sender === this._client.getUserId();
        const isTheirs = sender === this.otherUserId;

        if (isOurs) {
            this._eventsByUs.set(type, event);
        } else if (isTheirs) {
            this._eventsByThem.set(type, event);
        }

        const transitions = this._calculatePhaseTransitions();
        const existingIdx = transitions.findIndex(t => t.phase === this._phase);
        // trim off phases we already went through, if any
        const newTransitions = transitions.slice(existingIdx + 1);
        // transition to all new phases
        for (const transition of newTransitions) {
            this._transitionToPhase(transition);
        }
        // only pass events from the other side to the verifier,
        // no remote echos of our own events
        if (this._verifier && sender === this.otherUserId) {
            if (type === CANCEL_TYPE || (this._verifier.events
                && this._verifier.events.includes(type))) {
                this._verifier.handleEvent(event);
            }
        }

        if (newTransitions.length) {
            const lastTransition = newTransitions[newTransitions.length - 1];
            this._setPhase(lastTransition.phase);
        }

        /*
        // .request && .ready
if (!this._observeOnly && this._phase !== PHASE_REQUESTED) {
            logger.warn("Cancelling, unexpected .request verification event from " +
                event.getSender());
            await this.cancel(errorFromEvent(newUnexpectedMessageError()));
        }


        cancel on handle unexpected events (only if !this._observeOnly):
        const sentByMe = this._wasSentByOwnDevice(event);
            if (!sentByMe && !this._verificationMethods.has(method)) {
                await this.cancel(errorFromEvent(newUnknownMethodError()));
                return;
            }
        */

        console.log("VerificationRequest: handleEvent", event.getSender(), event.getType(), event, isLiveEvent);
        }
    }

    _createVerifier(method, startEvent = null, targetDevice = null) {
        const initiatedByMe = !startEvent || this._wasSentByOwnDevice(startEvent);
        const {userId, deviceId} = this._getVerifierTarget(startEvent, targetDevice);

        const VerifierCtor = this._verificationMethods.get(method);
        if (!VerifierCtor) {
            console.warn("could not find verifier constructor for method", method);
            return;
        }
        return new VerifierCtor(
            this.channel,
            this._client,
            userId,
            deviceId,
            initiatedByMe ? null : startEvent,
        );
    }

    _getVerifierTarget(startEvent, targetDevice) {
        // targetDevice should be set when creating a verifier for to_device before the .start event has been sent,
        // so the userId and deviceId are provided
        if (targetDevice) {
            return targetDevice;
        } else {
            let targetEvent;
            if (startEvent && !this._wasSentByOwnDevice(startEvent)) {
                targetEvent = startEvent;
            } else if (this._readyEvent && !this._wasSentByOwnDevice(this._readyEvent)) {
                targetEvent = this._readyEvent;
            } else if (this._requestEvent && !this._wasSentByOwnDevice(this._requestEvent)) {
                targetEvent = this._requestEvent;
            } else {
                throw new Error(
                    "can't determine who the verifier should be targeted at. " +
                    "No .request or .start event and no targetDevice");
            }
            // TODO: could be replaced by otherUserId
            const userId = targetEvent.getSender();
            const content = targetEvent.getContent();
            const deviceId = content && content.from_device;
            return {userId, deviceId};
        }
    }

    _wasSentByOwnUser(event) {
        return event.getSender() === this._client.getUserId();
    }

    // only for .request, .ready or .start
    _wasSentByOwnDevice(event) {
        if (!this._wasSentByOwnUser(event)) {
            return false;
        }
        const content = event.getContent();
        if (!content || content.from_device !== this._client.getDeviceId()) {
            return false;
        }
        return true;
    }
}
