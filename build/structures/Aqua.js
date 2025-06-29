"use strict";
const Node = require("./Node");
const Player = require("./Player");
const Track = require("./Track");
const { version: pkgVersion } = require("../../package.json");
const { EventEmitter } = require('tseep');
const fs = require('fs-extra');

const URL_REGEX = /^https?:\/\//;
const DEFAULT_OPTIONS = Object.freeze({
    shouldDeleteMessage: false,
    defaultSearchPlatform: 'ytsearch',
    leaveOnEnd: true,
    restVersion: 'v4',
    plugins: [],
    autoResume: false,
    infiniteReconnects: false
});
const LEAST_USED_CACHE_TTL = 50;

class Aqua extends EventEmitter {
    constructor(client, nodes, options = {}) {
        super();
        if (!client) throw new Error("Client is required to initialize Aqua");
        if (!Array.isArray(nodes) || !nodes.length) {
            throw new TypeError(`Nodes must be a non-empty Array (Received ${typeof nodes})`);
        }

        this.client = client;
        this.nodes = nodes;
        this.nodeMap = new Map();
        this.players = new Map();
        this.clientId = null;
        this.initiated = false;
        this.version = pkgVersion;

        this.options = Object.assign({}, DEFAULT_OPTIONS, options);

        const {
            shouldDeleteMessage,
            defaultSearchPlatform,
            leaveOnEnd,
            restVersion,
            plugins,
            autoResume,
            infiniteReconnects,
            send
        } = this.options;

        this.shouldDeleteMessage = shouldDeleteMessage;
        this.defaultSearchPlatform = defaultSearchPlatform;
        this.leaveOnEnd = leaveOnEnd;
        this.restVersion = restVersion;
        this.plugins = plugins;
        this.autoResume = autoResume;
        this.infiniteReconnects = infiniteReconnects;

        this.send = send || this.defaultSendFunction.bind(this);

        this._leastUsedCache = { nodes: [], timestamp: 0 };
    }

    defaultSendFunction(payload) {
        const guild = this.client.guilds.cache.get(payload.d.guild_id);
        if (guild) guild.shard.send(payload);
    }

    get leastUsedNodes() {
        const now = Date.now();
        if (now - this._leastUsedCache.timestamp < LEAST_USED_CACHE_TTL) {
            return this._leastUsedCache.nodes;
        }

        const connectedNodes = [];
        for (const node of this.nodeMap.values()) {
            if (node.connected) connectedNodes.push(node);
        }

        connectedNodes.sort((a, b) => a.rest.calls - b.rest.calls);

        this._leastUsedCache = { nodes: connectedNodes, timestamp: now };
        return connectedNodes;
    }

    async init(clientId) {
        if (this.initiated) return this;
        this.clientId = clientId;

        try {
            const nodePromises = [];
            for (const node of this.nodes) {
                nodePromises.push(this.createNode(node));
            }
            await Promise.all(nodePromises);

            for (const plugin of this.plugins) {
                plugin.load(this);
            }

            this.initiated = true;
        } catch (error) {
            this.initiated = false;
            throw error;
        }

        return this;
    }

    async createNode(options) {
        const nodeId = options.name || options.host;
        this.destroyNode(nodeId);

        const node = new Node(this, options, this.options);
        this.nodeMap.set(nodeId, node);
        this._leastUsedCache.timestamp = 0;

        try {
            await node.connect();
            this.emit("nodeCreate", node);
            return node;
        } catch (error) {
            this.nodeMap.delete(nodeId);
            console.error("Failed to connect node:", error);
            throw error;
        }
    }

    destroyNode(identifier) {
        const node = this.nodeMap.get(identifier);
        if (!node) return;

        node.destroy();
        this.nodeMap.delete(identifier);
        this._leastUsedCache.timestamp = 0;
        this.emit("nodeDestroy", node);
    }

    updateVoiceState({ d, t }) {
        const player = this.players.get(d.guild_id);
        if (!player) return;

        if (t === "VOICE_SERVER_UPDATE" || (t === "VOICE_STATE_UPDATE" && d.user_id === this.clientId)) {
            if (t === "VOICE_SERVER_UPDATE") {
                player.connection?.setServerUpdate?.(d);
            } else {
                player.connection?.setStateUpdate?.(d);
            }

            if (d.channel_id === null) {
                this.cleanupPlayer(player);
            }
        }
    }

    fetchRegion(region) {
        if (!region) return this.leastUsedNodes;

        const lowerRegion = region.toLowerCase();
        const regionNodes = [];

        for (const node of this.nodeMap.values()) {
            if (node.connected && node.regions?.includes(lowerRegion)) {
                regionNodes.push(node);
            }
        }

        const loadCache = new Map();
        regionNodes.sort((a, b) => {
            if (!loadCache.has(a)) loadCache.set(a, this.calculateLoad(a));
            if (!loadCache.has(b)) loadCache.set(b, this.calculateLoad(b));
            return loadCache.get(a) - loadCache.get(b);
        });

        return regionNodes;
    }

    calculateLoad(node) {
        const stats = node?.stats?.cpu;
        if (!stats) return 0;
        const { systemLoad, cores } = stats;
        return (systemLoad / cores) * 100;
    }

    createConnection(options) {
        if (!this.initiated) throw new Error("Aqua must be initialized before this operation");

        const existingPlayer = this.players.get(options.guildId);
        if (existingPlayer && existingPlayer.voiceChannel) return existingPlayer;

        const availableNodes = options.region ? this.fetchRegion(options.region) : this.leastUsedNodes;
        const node = availableNodes[0];
        if (!node) throw new Error("No nodes are available");

        return this.createPlayer(node, options);
    }

    createPlayer(node, options) {
        this.destroyPlayer(options.guildId);

        const player = new Player(this, node, options);
        this.players.set(options.guildId, player);

        player.on("destroy", () => {
            this.players.delete(options.guildId);
            this.emit("playerDestroy", player);
        });

        player.connect(options);
        this.emit("playerCreate", player);
        return player;
    }

    async destroyPlayer(guildId) {
        const player = this.players.get(guildId);
        if (!player) return;

        try {
            await player.clearData();
            player.removeAllListeners();
            this.players.delete(guildId);
            this.emit("playerDestroy", player);
        } catch (error) {
            console.error(`Error destroying player for guild ${guildId}:`, error);
        }
    }

    async resolve({ query, source = this.defaultSearchPlatform, requester, nodes }) {
        if (!this.initiated) throw new Error("Aqua must be initialized before this operation");

        const requestNode = this.getRequestNode(nodes);
        const formattedQuery = URL_REGEX.test(query) ? query : `${source}:${query}`;

        try {
            const endpoint = `/v4/loadtracks?identifier=${encodeURIComponent(formattedQuery)}`;
            const response = await requestNode.rest.makeRequest("GET", endpoint);

            if (["empty", "NO_MATCHES"].includes(response.loadType)) {
                return await this.handleNoMatches(query);
            }

            return this.constructResponse(response, requester, requestNode);
        } catch (error) {
            if (error.name === "AbortError") {
                throw new Error("Request timed out");
            }
            throw new Error(`Failed to resolve track: ${error.message}`);
        }
    }

    getRequestNode(nodes) {
        if (!nodes) return this.leastUsedNodes[0];

        if (nodes instanceof Node) return nodes;
        if (typeof nodes === "string") {
            const mappedNode = this.nodeMap.get(nodes);
            return mappedNode || this.leastUsedNodes[0];
        }

        throw new TypeError(`'nodes' must be a string or Node instance, received: ${typeof nodes}`);
    }

    async handleNoMatches(query) {
        return {
            loadType: "empty",
            exception: null,
            playlistInfo: null,
            pluginInfo: {},
            tracks: []
        };
    }

    async constructResponse(response, requester, requestNode) {
        const baseResponse = {
            loadType: response.loadType,
            exception: null,
            playlistInfo: null,
            pluginInfo: response.pluginInfo ?? {},
            tracks: []
        };

        if (response.loadType === "error" || response.loadType === "LOAD_FAILED") {
            baseResponse.exception = response.data ?? response.exception;
            return baseResponse;
        }

        const trackFactory = (trackData) => new Track(trackData, requester, requestNode);

        switch (response.loadType) {
            case "track":
                if (response.data) {
                    baseResponse.tracks.push(trackFactory(response.data));
                }
                break;
            case "playlist": {
                const info = response.data?.info;
                if (info) {
                    const playlistInfo = {
                        name: info.name ?? info.title,
                        thumbnail: response.data.pluginInfo?.artworkUrl ?? (response.data.tracks?.[0]?.info?.artworkUrl || null),
                        ...info
                    };
                    baseResponse.playlistInfo = playlistInfo;
                }

                const tracks = response.data?.tracks;
                if (tracks?.length) {
                    const trackCount = tracks.length;
                    baseResponse.tracks = new Array(trackCount);
                    for (let i = 0; i < trackCount; i++) {
                        baseResponse.tracks[i] = trackFactory(tracks[i]);
                    }
                }
                break;
            }

            case "search": {
                const searchData = response.data ?? [];
                const dataLength = searchData.length;
                if (dataLength) {
                    baseResponse.tracks = new Array(dataLength);
                    for (let i = 0; i < dataLength; i++) {
                        baseResponse.tracks[i] = trackFactory(searchData[i]);
                    }
                }
                break;
            }
        }

        return baseResponse;
    }

    get(guildId) {
        const player = this.players.get(guildId);
        if (!player) throw new Error(`Player not found for guild ID: ${guildId}`);
        return player;
    }

    async search(query, requester, source = this.defaultSearchPlatform) {
        if (!query || !requester) return null;

        try {
            const { tracks } = await this.resolve({ query, source, requester });
            return tracks || null;
        } catch (error) {
            console.error("Search error:", error);
            return null;
        }
    }

    async savePlayer(filePath = "./AquaPlayers.json") {
        const data = Array.from(this.players.values()).map(player => ({
            g: player.guildId,
            t: player.textChannel,
            v: player.voiceChannel,
            u: player.current?.uri || null,
            p: player.position || 0,
            ts: player.timestamp || 0,
            q: player.queue?.tracks?.map(tr => tr.uri).slice(0, 5) || [],
            r: player.requester || player.current?.requester,
            vol: player.volume,
            pa: player.paused
        }));
        await fs.writeFile(filePath, JSON.stringify(data), "utf8");
        this.emit("debug", "Aqua", `Saved ${data.length} players to ${filePath}`);
    }

    async waitForFirstNode() {
        if (this.leastUsedNodes.length > 0) return;
        return new Promise(resolve => {
            const check = () => {
                if (this.leastUsedNodes.length > 0) {
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }

    async loadPlayers(filePath = "./AquaPlayers.json") {
        try {
            await fs.promises.access(filePath);
        } catch {
            this.emit("debug", "Aqua", `File ${filePath} does not exist, skipping load.`);
            return;
        }
        try {
            await this.waitForFirstNode();
            const data = JSON.parse(await fs.readFile(filePath, "utf8"));
            for (const p of data) {
                let player = this.players.get(p.g);
                if (!player) {
                    player = await this.createConnection({
                        guildId: p.g,
                        textChannel: p.t,
                        voiceChannel: p.v,
                        defaultVolume: p.vol || 65,
                        deaf: true
                    });
                }

                if (p.u && player) {
                    const resolved = await this.resolve({ query: p.u, requester: p.r });
                    if (resolved.tracks && resolved.tracks.length > 0) {
                        player.queue.add(resolved.tracks[0]);
                        player.position = p.p || 0;
                        if (typeof p.ts === "number") {
                            player.timestamp = p.ts;
                        }
                    }
                }
                if (Array.isArray(p.q) && player) {
                    for (const uri of p.q) {
                        if (!p.u || uri !== p.u) {
                            const resolved = await this.resolve({ query: uri, requester: p.r });
                            if (resolved.tracks && resolved.tracks.length > 0) {
                                player.queue.add(resolved.tracks[0]);
                                player.position = p.p || 0;
                                if (typeof p.ts === "number") {
                                    player.timestamp = p.ts;
                                }
                            }
                        }
                    }
                }
                if (player) {
                    player.paused = !!p.pa;
                    if (!player.playing && !player.paused && player.queue.size > 0) {
                        player.play();
                    }
                }
            }
            await fs.writeFile(filePath, "[]", "utf8");
            this.emit("debug", "Aqua", `Loaded players from ${filePath} and cleared its content.`);
        } catch (error) {
            console.error(`Failed to load players from ${filePath}:`, error);
        }
    }

    async cleanupPlayer(player) {
        if (!player) return;

        try {
            await player.destroy();
        } catch (error) {
            console.error(`Error during player cleanup: ${error.message}`);
        }
    }
}

module.exports = Aqua;
