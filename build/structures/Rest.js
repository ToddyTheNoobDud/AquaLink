const { request } = require("undici");

class Rest {
    constructor(aqua, options) {
        this.aqua = aqua;
        this.url = `http${options.secure ? "s" : ""}://${options.host}:${options.port}`;
        this.sessionId = options.sessionId;
        this.password = options.password;
        this.version = options.restVersion || "v4";
        this.calls = 0;
        this.headers = {
            "Content-Type": "application/json",
            Authorization: this.password,
        };
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    async makeRequest(method, endpoint, body = null, includeHeaders = false) {
        try {
            const response = await request(`${this.url}${endpoint}`, {
                method,
                headers: this.headers,
                body: body ? JSON.stringify(body) : undefined,
            });

            this.calls++;
            const { headers, body: responseBody } = response;
            const data = await responseBody.json();
            await responseBody.dump(); // force consumption of body
            this.aqua.emit("apiResponse", endpoint, response);

            return includeHeaders ? { data, headers } : data;
        } catch (error) {
            this.aqua.emit("apiError", endpoint, error);
            throw new Error(`Failed to make request to ${endpoint}: ${error.message}`);
        }
    }

    getPlayers() {
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

    destroyPlayer(guildId) {
        return this.makeRequest("DELETE", `/${this.version}/sessions/${this.sessionId}/players/${guildId}`);
    }

    getTracks(identifier) {
        return this.makeRequest("GET", `/${this.version}/loadtracks?identifier=${encodeURIComponent(identifier)}`);
    }

    decodeTrack(track) {
        return this.makeRequest("GET", `/${this.version}/decodetrack?encodedTrack=${encodeURIComponent(track)}`);
    }

    decodeTracks(tracks) {
        return this.makeRequest("POST", `/${this.version}/decodetracks`, tracks);
    }

    getStats() {
        return this.makeRequest("GET", `/${this.version}/stats${this.version !== "v3" ? "/all" : ""}`);
    }

    getInfo() {
        return this.makeRequest("GET", `/${this.version}/info`);
    }

    getRoutePlannerStatus() {
        return this.makeRequest("GET", `/${this.version}/routeplanner/status`);
    }

    getRoutePlannerAddress(address) {
        return this.makeRequest("POST", `/${this.version}/routeplanner/free/address`, { address });
    }
}

module.exports = { Rest };
