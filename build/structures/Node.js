const WebSocket = require("ws");
const { Rest } = require("./Rest");

class Node {
    // Private fields using # for better encapsulation
    #ws = null;
    #statsCache = new WeakMap();
    #lastStatsRequest = 0;
    #reconnectAttempted = 0;

    constructor(aqua, nodes, options) {
        const { 
            name, 
            host = "localhost", 
            port = 2333, 
            password = "youshallnotpass",
            secure = false,
            sessionId = null,
            regions = []
        } = nodes;

        // Core properties
        this.aqua = aqua;
        this.name = name || host;
        this.host = host;
        this.port = port;
        this.password = password;
        this.secure = secure;
        this.sessionId = sessionId;
        this.regions = regions;
        
        // Configuration
        this.wsUrl = new URL(`ws${secure ? 's' : ''}://${host}:${port}/v4/websocket`);
        this.rest = new Rest(aqua, this);
        
        // Connection options
        this.resumeKey = options?.resumeKey ?? null;
        this.resumeTimeout = options?.resumeTimeout ?? 60;
        this.autoResume = options?.autoResume ?? false;
        this.reconnectTimeout = options?.reconnectTimeout ?? 2000;
        this.reconnectTries = options?.reconnectTries ?? 3;
        
        // State
        this.connected = false;
        this.info = null;
        
        // Initialize stats with frozen objects to prevent modifications
        this.stats = Object.freeze(this.#createStats());
    }

    #createStats() {
        return {
            players: 0,
            playingPlayers: 0,
            uptime: 0,
            memory: Object.freeze({
                free: 0,
                used: 0,
                allocated: 0,
                reservable: 0,
                freePercentage: 0,
                usedPercentage: 0
            }),
            cpu: Object.freeze({
                cores: 0,
                systemLoad: 0,
                lavalinkLoad: 0,
                lavalinkLoadPercentage: 0
            }),
            frameStats: Object.freeze({
                sent: 0,
                nulled: 0,
                deficit: 0
            }),
            ping: 0
        };
    }

    async connect() {
        this.#cleanup();
        
        try {
            this.#ws = new WebSocket(this.wsUrl.href, {
                headers: this.#constructHeaders(),
                perMessageDeflate: false // Disable compression for better performance
            });
            
            this.#setupWebSocketListeners();
            this.aqua.emit('debug', this.name, 'Connecting...');
            
        } catch (err) {
            this.aqua.emit('debug', this.name, `Connection failed: ${err.message}`);
            this.#reconnect();
        }
    }

    #cleanup() {
        if (this.#ws) {
            try {
                this.#ws.removeAllListeners();
                this.#ws.terminate(); // Force close connection
            } catch {} 
            finally {
                this.#ws = null;
            }
        }
    }

    #constructHeaders() {
        const headers = {
            Authorization: this.password,
            "User-Id": this.aqua.clientId,
            "Client-Name": `Aqua/${this.aqua.version}`,
        };
        
        if (this.sessionId) headers["Session-Id"] = this.sessionId;
        if (this.resumeKey) headers["Resume-Key"] = this.resumeKey;
        
        return Object.freeze(headers);
    }

    #setupWebSocketListeners() {
        if (!this.#ws) return;

        const ws = this.#ws;
        
        ws.once("open", this.#onOpen.bind(this));
        ws.once("error", this.#onError.bind(this));
        ws.on("message", this.#onMessage.bind(this));
        ws.once("close", this.#onClose.bind(this));
    }

    async #onOpen() {
        this.connected = true;
        this.aqua.emit('debug', this.name, `Connected to ${this.wsUrl.href}`);
        
        try {
            this.info = await this.rest.makeRequest("GET", "/v4/info");
            this.autoResume && await this.resumePlayers();
        } catch (err) {
            this.info = null;
            !this.aqua.bypassChecks?.nodeFetchInfo && 
                this.aqua.emit('error', `Failed to fetch node info: ${err.message}`);
        }
    }

    async getStats() {
        const now = Date.now();
        const STATS_COOLDOWN = 5000; // Reduced from 10s to 5s for more frequent updates
        
        if (now - this.#lastStatsRequest < STATS_COOLDOWN) {
            return this.#statsCache.get(this) ?? this.stats;
        }

        try {
            const stats = await this.rest.makeRequest("GET", "/v4/stats");
            this.#updateStats(stats);
            this.#lastStatsRequest = now;
            this.#statsCache.set(this, this.stats);
            return this.stats;
        } catch (err) {
            this.aqua.emit('debug', `Stats fetch error: ${err.message}`);
            return this.stats;
        }
    }

    #updateStats(payload) {
        if (!payload) return;

        const newStats = {
            players: payload.players ?? 0,
            playingPlayers: payload.playingPlayers ?? 0,
            uptime: payload.uptime ?? 0,
            ping: payload.ping ?? 0,
            memory: this.#updateMemoryStats(payload.memory),
            cpu: this.#updateCpuStats(payload.cpu),
            frameStats: this.#updateFrameStats(payload.frameStats)
        };

        this.stats = Object.freeze(newStats);
    }

    #updateMemoryStats(memory = {}) {
        const allocated = memory.allocated ?? 0;
        return Object.freeze({
            free: memory.free ?? 0,
            used: memory.used ?? 0,
            allocated,
            reservable: memory.reservable ?? 0,
            freePercentage: allocated ? (memory.free / allocated) * 100 : 0,
            usedPercentage: allocated ? (memory.used / allocated) * 100 : 0
        });
    }

    #updateCpuStats(cpu = {}) {
        const cores = cpu.cores ?? 0;
        return Object.freeze({
            cores,
            systemLoad: cpu.systemLoad ?? 0,
            lavalinkLoad: cpu.lavalinkLoad ?? 0,
            lavalinkLoadPercentage: cores ? (cpu.lavalinkLoad / cores) * 100 : 0
        });
    }

    #updateFrameStats() {
        return Object.freeze({
            sent: 0,
            nulled: 0,
            deficit: 0
        });
    }

    // More optimized message handling
    #onMessage(msg) {
        try {
            const payload = JSON.parse(msg.toString());
            if (!payload?.op) return;

            switch (payload.op) {
                case "stats":
                    this.#updateStats(payload);
                    break;
                case "ready":
                    this.#handleReadyOp(payload);
                    break;
                default:
                    this.#handlePlayerOp(payload);
            }
        } catch (err) {
            this.aqua.emit('debug', `Message parse error: ${err.message}`);
        }
    }

    #handleReadyOp(payload) {
        if (this.sessionId !== payload.sessionId) {
            this.sessionId = payload.sessionId;
            this.rest.setSessionId(payload.sessionId);
        }
        this.aqua.emit("nodeConnect", this);
    }

    #handlePlayerOp(payload) {
        const player = this.aqua.players.get(payload.guildId);
        player?.emit(payload.op, payload);
    }

    #onError(error) {
        this.aqua.emit("nodeError", this, error);
    }

    #onClose(code, reason) {
        this.connected = false;
        this.aqua.emit("nodeDisconnect", this, { code, reason });
        this.#reconnect();
    }

    #reconnect() {
        if (++this.#reconnectAttempted >= this.reconnectTries) {
            this.aqua.emit("nodeError", this, new Error(`Max reconnection attempts reached (${this.reconnectTries})`));
            return this.destroy();
        }

        setTimeout(() => {
            this.aqua.emit("nodeReconnect", this);
            this.connect();
        }, this.reconnectTimeout * this.#reconnectAttempted); // Exponential backoff
    }

    // Performance optimized penalties calculation
    get penalties() {
        if (!this.connected) return Number.MAX_SAFE_INTEGER;
        
        let penalties = this.stats.players;
        
        if (this.stats.cpu?.systemLoad) {
            penalties += Math.round(Math.pow(1.05, 100 * this.stats.cpu.systemLoad) * 10 - 10);
        }

        if (this.stats.frameStats) {
            penalties += this.stats.frameStats.deficit;
            penalties += this.stats.frameStats.nulled * 2;
        }

        return penalties;
    }

    destroy(clean = false) {
        if (clean) {
            this.aqua.emit("nodeDestroy", this);
            this.aqua.nodes.delete(this.name);
            return;
        }

        // Cleanup all players using this node
        if (this.connected) {
            for (const player of this.aqua.players.values()) {
                if (player.node === this) {
                    player.destroy();
                }
            }
        }

        this.#cleanup();
        this.connected = false;
        this.aqua.nodeMap.delete(this.name);
        this.aqua.emit("nodeDestroy", this);

        // Clear references
        this.info = null;
        this.#statsCache = new WeakMap();
        this.stats = Object.freeze(this.#createStats());
    }
}

module.exports = { Node };
