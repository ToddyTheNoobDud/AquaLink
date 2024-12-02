const { fetch: undiciFetch } = require("undici");

class Rest {
    constructor(aqua, options) {
        this.aqua = aqua;
        this.url = `http${options.secure ? "s" : ""}://${options.host}:${options.port}`;
        this.sessionId = options.sessionId;
        this.password = options.password;
        this.version = options.restVersion;
        this.calls = 0;
        this.queue = [];
        this.maxQueueSize = options.maxQueueSize || 100;
        this.maxConcurrentRequests = options.maxConcurrentRequests || 5;
        this.activeRequests = 0;
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    async makeRequest(method, endpoint, body = null, includeHeaders = false) {
        const headers = {
            "Content-Type": "application/json",
            Authorization: this.password,
        };

        try {
            const response = await undiciFetch(`${this.url}${endpoint}`, {
                method,
                headers,
                body: body && JSON.stringify(body),
            });
            this.calls++;
            const data = await this.parseResponse(response);
            this.aqua.emit("apiResponse", endpoint, response);
            this.aqua.emit(
                "debug",
                `[Rest] ${method} ${endpoint} ${body ? `body: ${JSON.stringify(body)}` : ""} -> Status Code: ${response.status} Response(body): ${JSON.stringify(data)}`
            );
            return includeHeaders ? { data, headers: response.headers } : data;
        } catch (error) {
            this.aqua.emit("debug", `Network error during request: ${method} ${this.url}${endpoint}`, { cause: error });
            throw new Error(`Network error during request: ${method} ${this.url}${endpoint}`, { cause: error });
        }
    }

    async getPlayers() {
        return this.makeRequest("GET", `/${this.version}/sessions/${this.sessionId}/players`);
    }

    async updatePlayer(options) {
        const requestBody = { ...options.data };

        if ((requestBody.track && requestBody.track.encoded && requestBody.track.identifier) ||
            (requestBody.encodedTrack && requestBody.identifier)) {
            throw new Error(`Cannot provide both 'encoded' and 'identifier' for track in Update Player Endpoint`);
        }

        if (this.version === "v3" && options.data?.track) {
            const { track } = requestBody;
            delete requestBody.track;
            Object.assign(requestBody, track.encoded ? { encodedTrack: track.encoded } : { identifier: track.identifier });
        }

        return this.makeRequest("PATCH", `/${this.version}/sessions/${this.sessionId}/players/${options.guildId}?noReplace=false`, requestBody);
    }

    async destroyPlayer(guildId) {
        return this.makeRequest("DELETE", `/${this.version}/sessions/${this.sessionId}/players/${guildId}`);
    }

    async getTracks(identifier) {
        return this.makeRequest("GET", `/${this.version}/loadtracks?identifier=${encodeURIComponent(identifier)}`);
    }

    async decodeTrack(track) {
        return this.makeRequest("GET", `/${this.version}/decodetrack?encodedTrack=${encodeURIComponent(track)}`);
    }

    async decodeTracks(tracks) {
        return this.makeRequest("POST", `/${this.version}/decodetracks`, tracks);
    }

    async getStats() {
        return this.makeRequest("GET", this.version === "v3" ? `/${this.version}/stats` : `/${this.version}/stats/all`);
    }

    async getInfo() {
        return this.makeRequest("GET", `/${this.version}/info`);
    }

    async getRoutePlannerStatus() {
        return this.makeRequest("GET", `/${this.version}/routeplanner/status`);
    }

    async getRoutePlannerAddress(address) {
        return this.makeRequest("POST", `/${this.version}/routeplanner/free/address`, { address });
    }

    async parseResponse(response) {
        if (response.status === 204) return null;
        try {
            return response.headers.get("Content-Type").includes("text/plain") ? await response.text() : await response.json();
        } catch (error) {
            this.aqua.emit("debug", `[Rest - Error] Failed to process response from ${response.url}: ${error}`);
            return null;
        }
    }

    cleanupQueue() {
        this.queue = [];
    }
}

module.exports = { Rest };

