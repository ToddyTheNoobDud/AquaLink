"use strict";
const WebSocket = require('ws');
const Rest = require("./Rest");

const LYRICS_OP_REGEX = /^Lyrics/;
const JSON_VALIDATION_REGEX = /^[\s]*[{\[]/;

class Node {
    static BACKOFF_MULTIPLIER = 1.5;
    static MAX_BACKOFF = 60000;
    static WS_OPEN = WebSocket.OPEN;
    static WS_CLOSE_NORMAL = 1000;
    static DEFAULT_RECONNECT_TIMEOUT = 2000;
    static DEFAULT_RESUME_TIMEOUT = 60;
    static JITTER_MAX = 2000;
    static JITTER_FACTOR = 0.2;

    constructor(aqua, connOptions, options = {}) {
        this.aqua = aqua;

        const {
            host = "localhost",
            name = host,
            port = 2333,
            password = "youshallnotpass",
            secure = false,
            sessionId = null,
            regions = []
        } = connOptions;

        Object.assign(this, {
            host, name, port, password, sessionId, regions,
            secure: !!secure,
            wsUrl: `ws${secure ? "s" : ""}://${host}:${port}/v4/websocket`
        });

        this.rest = new Rest(aqua, this);

        const {
            resumeTimeout = Node.DEFAULT_RESUME_TIMEOUT,
            autoResume = false,
            reconnectTimeout = Node.DEFAULT_RECONNECT_TIMEOUT,
            reconnectTries = 3,
            infiniteReconnects = false
        } = options;

        Object.assign(this, {
            resumeTimeout, autoResume, reconnectTimeout, 
            reconnectTries, infiniteReconnects
        });

        this.connected = false;
        this.info = null;
        this.ws = null;
        this.reconnectAttempted = 0;
        this.reconnectTimeoutId = null;
        this.isDestroyed = false;

        this._boundHandlers = {
            onOpen: () => this._onOpen(),
            onError: (error) => this._onError(error),
            onMessage: (msg) => this._onMessage(msg),
            onClose: (code, reason) => this._onClose(code, reason)
        };

        this._headers = this._constructHeaders();
        this._initializeStats();
    }

    _initializeStats() {
        this.stats = {
            players: 0,
            playingPlayers: 0,
            uptime: 0,
            memory: { 
                free: 0, used: 0, allocated: 0, reservable: 0, 
                freePercentage: 0, usedPercentage: 0 
            },
            cpu: { 
                cores: 0, systemLoad: 0, lavalinkLoad: 0, 
                lavalinkLoadPercentage: 0 
            },
            frameStats: { sent: 0, nulled: 0, deficit: 0 },
            ping: 0
        };
    }

    _constructHeaders() {
        const headers = Object.create(null);
        headers.Authorization = this.password;
        headers["User-Id"] = this.aqua.clientId;
        headers["Client-Name"] = `Aqua/${this.aqua.version} (https://github.com/ToddyTheNoobDud/AquaLink)`;

        if (this.sessionId) {
            headers["Session-Id"] = this.sessionId;
        }

        return headers;
    }

    async _onOpen() {
        this.connected = true;
        this.reconnectAttempted = 0;
        this.aqua.emit("debug", this.name, "WebSocket connection established");

        if (this.aqua.bypassChecks?.nodeFetchInfo) return;

        try {
            this.info = await this.rest.makeRequest("GET", "/v4/info");
            this.aqua.emit("nodeConnected", this);

            if (this.autoResume && this.sessionId) {
                await this.aqua.loadPlayers();
            }
        } catch (err) {
            this.info = null;
            this._emitError(`Failed to fetch node info: ${err.message}`);
        }
    }

    _onError(error) {
        this.aqua.emit("nodeError", this, error);
    }

    _onMessage(msg) {
        if (!JSON_VALIDATION_REGEX.test(msg)) {
            this.aqua.emit("debug", this.name, `Received invalid JSON format: ${msg.slice(0, 100)}...`);
            return;
        }

        let payload;
        try {
            payload = JSON.parse(msg);
        } catch {
            this.aqua.emit("debug", this.name, `JSON parse failed: ${msg.slice(0, 100)}...`);
            return;
        }

        const { op, guildId } = payload;
        if (!op) return;

        switch (op) {
            case "stats":
                this._updateStats(payload);
                break;
            case "ready":
                this._handleReadyOp(payload);
                break;
            default:
                this._handleCustomOp(op, guildId, payload);
                break;
        }
    }

    _handleCustomOp(op, guildId, payload) {
        if (LYRICS_OP_REGEX.test(op)) {
            const player = guildId ? this.aqua.players.get(guildId) : null;
            this.aqua.emit(op, player, payload.track || null, payload);
        } else if (guildId) {
            const player = this.aqua.players.get(guildId);
            if (player) player.emit(op, payload);
        }
    }

    _onClose(code, reason) {
        this.connected = false;
        const reasonStr = reason?.toString() || "No reason provided";

        this.aqua.emit("nodeDisconnect", this, { code, reason: reasonStr });
        this.aqua.handleNodeFailover(this);
        this._scheduleReconnect(code);
    }

    _scheduleReconnect(code) {
        this._clearReconnectTimeout();

        if (code === Node.WS_CLOSE_NORMAL || this.isDestroyed) {
            this.aqua.emit("debug", this.name, "WebSocket closed normally, not reconnecting");
            return;
        }

        if (this.infiniteReconnects) {
            this.aqua.emit("nodeReconnect", this, "Infinite reconnects enabled, trying again in 10 seconds");
            this.reconnectTimeoutId = setTimeout(() => this.connect(), 10000);
            return;
        }

        if (this.reconnectAttempted >= this.reconnectTries) {
            this._emitError(new Error(`Max reconnection attempts reached (${this.reconnectTries})`));
            this.destroy(true);
            return;
        }

        const backoffTime = this._calculateBackoff();
        this.reconnectAttempted++;

        this.aqua.emit("nodeReconnect", this, {
            attempt: this.reconnectAttempted,
            backoffTime
        });

        this.reconnectTimeoutId = setTimeout(() => this.connect(), backoffTime);
    }

    _calculateBackoff() {
        const baseBackoff = this.reconnectTimeout * (Node.BACKOFF_MULTIPLIER ** this.reconnectAttempted);
        const maxJitter = Math.min(Node.JITTER_MAX, baseBackoff * Node.JITTER_FACTOR);
        const jitter = Math.random() * maxJitter;
        return Math.min(baseBackoff + jitter, Node.MAX_BACKOFF);
    }

    _clearReconnectTimeout() {
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = null;
        }
    }

    async connect() {
        if (this.isDestroyed) return;

        if (this.ws?.readyState === Node.WS_OPEN) {
            this.aqua.emit("debug", this.name, "WebSocket already connected");
            return;
        }

        this._cleanupExistingConnection();

        this.ws = new WebSocket(this.wsUrl, {
            headers: this._headers,
            perMessageDeflate: false
        });

        const handlers = this._boundHandlers;
        this.ws.once("open", handlers.onOpen);
        this.ws.once("error", handlers.onError);
        this.ws.on("message", handlers.onMessage);
        this.ws.once("close", handlers.onClose);
    }

    _cleanupExistingConnection() {
        if (!this.ws) return;

        this.ws.removeAllListeners();

        if (this.ws.readyState === Node.WS_OPEN) {
            try {
                this.ws.close();
            } catch (err) {
                this._emitError(`Failed to close WebSocket: ${err.message}`);
            }
        }

        this.ws = null;
    }

    destroy(clean = false) {
        this.isDestroyed = true;
        this._clearReconnectTimeout();
        this._cleanupExistingConnection();

        if (!clean) {
            this.aqua.handleNodeFailover(this);
        }

        this.connected = false;
        this.aqua.destroyNode(this.name);
        this.aqua.emit("nodeDestroy", this);
        this.info = null;
    }

    async getStats() {
        if (this.connected && this.stats) {
            return this.stats;
        }

        try {
            const newStats = await this.rest.getStats();
            if (newStats && this.stats) {
                this._mergeStats(newStats);
            }
            return this.stats;
        } catch (err) {
            this._emitError(`Failed to fetch node stats: ${err.message}`);
            return this.stats;
        }
    }

    _mergeStats(newStats) {
        this.stats.players = newStats.players ?? this.stats.players;
        this.stats.playingPlayers = newStats.playingPlayers ?? this.stats.playingPlayers;
        this.stats.uptime = newStats.uptime ?? this.stats.uptime;
        this.stats.ping = newStats.ping ?? this.stats.ping;

        if (newStats.memory) {
            Object.assign(this.stats.memory, newStats.memory);
            this._calculateMemoryPercentages();
        }

        if (newStats.cpu) {
            Object.assign(this.stats.cpu, newStats.cpu);
            this._calculateCpuPercentages();
        }

        if (newStats.frameStats) {
            Object.assign(this.stats.frameStats, newStats.frameStats);
        }
    }

    _updateStats(payload) {
        if (!payload) return;

        Object.assign(this.stats, {
            players: payload.players,
            playingPlayers: payload.playingPlayers,
            uptime: payload.uptime,
            ping: payload.ping
        });

        if (payload.memory) {
            Object.assign(this.stats.memory, payload.memory);
            this._calculateMemoryPercentages();
        }

        if (payload.cpu) {
            Object.assign(this.stats.cpu, payload.cpu);
            this._calculateCpuPercentages();
        }

        if (payload.frameStats) {
            Object.assign(this.stats.frameStats, payload.frameStats);
        }
    }

    _calculateMemoryPercentages() {
        const { memory } = this.stats;
        if (memory.allocated > 0) {
            const allocated = memory.allocated;
            memory.freePercentage = (memory.free / allocated) * 100;
            memory.usedPercentage = (memory.used / allocated) * 100;
        }
    }

    _calculateCpuPercentages() {
        const { cpu } = this.stats;
        if (cpu.cores > 0) {
            cpu.lavalinkLoadPercentage = (cpu.lavalinkLoad / cpu.cores) * 100;
        }
    }

    _handleReadyOp(payload) {
        if (!payload.sessionId) {
            this._emitError("Ready payload missing sessionId");
            return;
        }

        this.sessionId = payload.sessionId;
        this.rest.setSessionId(payload.sessionId);
        this._headers = this._constructHeaders();
        this.aqua.emit("nodeConnect", this);
    }

    async resumePlayers() {
        try {
            await this.aqua.loadPlayers();
            this.aqua.emit("debug", this.name, "Session resumed successfully");
        } catch (err) {
            this._emitError(`Failed to resume session: ${err.message}`);
        }
    }

    _emitError(error) {
        const errorObj = error instanceof Error ? error : new Error(error);
        console.error(`[Aqua] [${this.name}] Error:`, errorObj);
        this.aqua.emit("error", this, errorObj);
    }
}

module.exports = Node;
