"use strict";
const Node = require("./Node");
const Player = require("./Player");
const Track = require("./Track");
const { version: pkgVersion } = require("../../package.json");
const { EventEmitter } = require('tseep');
const fs = require('fs/promises');

const URL_REGEX = /^https?:\/\//;
const DEFAULT_OPTIONS = Object.freeze({
    shouldDeleteMessage: false,
    defaultSearchPlatform: 'ytsearch',
    leaveOnEnd: true,
    restVersion: 'v4',
    plugins: [],
    autoResume: false,
    infiniteReconnects: false,
    failoverOptions: {
        enabled: true,
        maxRetries: 3,
        retryDelay: 1000,
        preservePosition: true,
        resumePlayback: true,
        cooldownTime: 5000,
        maxFailoverAttempts: 5
    }
});

const LEAST_USED_CACHE_TTL = 30;

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

        this.options = { ...DEFAULT_OPTIONS, ...options };
        this.failoverOptions = { ...DEFAULT_OPTIONS.failoverOptions, ...options.failoverOptions };

        this.shouldDeleteMessage = this.options.shouldDeleteMessage;
        this.defaultSearchPlatform = this.options.defaultSearchPlatform;
        this.leaveOnEnd = this.options.leaveOnEnd;
        this.restVersion = this.options.restVersion;
        this.plugins = this.options.plugins;
        this.autoResume = this.options.autoResume;
        this.infiniteReconnects = this.options.infiniteReconnects;
        this.send = this.options.send || this.defaultSendFunction.bind(this);

        this._leastUsedCache = { nodes: [], timestamp: 0 };

        this._nodeStates = new Map();
        this._failoverQueue = new Map();
        this._lastFailoverAttempt = new Map();

        this._brokenPlayers = new Map();
        this._nodeReconnectHandlers = new Map();

        this._boundCleanupPlayer = this.cleanupPlayer.bind(this);
        this._boundHandlePlayerDestroy = this._handlePlayerDestroy.bind(this);
        this._boundHandleNodeReconnect = this._handleNodeReconnect.bind(this);
        this._boundHandleSocketClosed = this._handleSocketClosed.bind(this);

        this.on('nodeConnect', (node) => this._handleNodeReconnect(node));
        this.on('nodeDisconnect', (node) => this._handleSocketClosed(node));
    }

    defaultSendFunction(packet) {
        const guild = this.client?.cache?.guilds.get(packet.d.guild_id) ?? this.client.guilds.cache.get(packet.d.guild_id);
        if (guild) {
            if (this.client.gateway) {
                this.client.gateway.send(this.client.gateway.calculateShardId(packet.d.guild_id), packet);
            } else {
                guild.shard.send(packet);
            }
        }
    }

    get leastUsedNodes() {
        const now = Date.now();
        if (now - this._leastUsedCache.timestamp < LEAST_USED_CACHE_TTL) {
            return this._leastUsedCache.nodes;
        }

        const connectedNodes = Array.from(this.nodeMap.values())
            .filter(node => node.connected)
            .sort((a, b) => a.rest.calls - b.rest.calls);

        this._leastUsedCache = { nodes: connectedNodes, timestamp: now };
        return connectedNodes;
    }

    async init(clientId) {
        if (this.initiated) return this;
        this.clientId = clientId;

        try {
            const nodePromises = this.nodes.map(node => this.createNode(node).catch(err => {
                console.error(`Failed to create node ${node.name || node.host}:`, err);
                return null;
            }));

            const results = await Promise.allSettled(nodePromises);
            const successfulNodes = results.filter(r => r.status === 'fulfilled' && r.value).length;

            if (successfulNodes === 0) {
                throw new Error("No nodes could be connected");
            }

            await Promise.all(this.plugins.map(plugin =>
                Promise.resolve(plugin.load(this)).catch(err =>
                    console.error("Plugin load error:", err)
                )
            ));

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
        node.players = new Set();
        this.nodeMap.set(nodeId, node);
        this._invalidateCache();

        this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false });

        try {
            await node.connect();
            this._nodeStates.set(nodeId, { connected: true, failoverInProgress: false });
            this.emit("nodeCreate", node);
            return node;
        } catch (error) {
            this._cleanupNode(nodeId);
            throw error;
        }
    }

    async _handleNodeReconnect(node) {
        if (!this.autoResume) return;

        const nodeId = node.name || node.host;
        this.emit("debug", "Aqua", `Node ${nodeId} reconnected, attempting to rebuild broken players`);

        this._nodeStates.set(nodeId, { connected: true, failoverInProgress: false });

        await this._rebuildBrokenPlayers(node);
    }

    async _handleSocketClosed(node) {
        if (!this.autoResume) return;

        const nodeId = node.name || node.host;
        this.emit("debug", "Aqua", `Socket closed for node ${nodeId}, storing broken players`);

        this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false });

        await this._storeBrokenPlayersForNode(node);
    }

    async _storeBrokenPlayersForNode(node) {
        const nodeId = node.name || node.host;
        const affectedPlayers = await this._getPlayersForNode(node);


        for (const player of affectedPlayers) {
            try {
                const playerState = this._capturePlayerState(player);
                if (playerState) {
                    playerState.originalNodeId = nodeId;
                    playerState.brokenAt = Date.now();
                    this._brokenPlayers.set(player.guildId, playerState);

                    this.emit("debug", "Aqua", `Stored broken player state for guild ${player.guildId}`);
                }
            } catch (error) {
                this.emit("error", null, new Error(`Failed to store broken player state: ${error.message}`));
            }
        }
    }

    async _getPlayersForNode(node) {
        const affectedPlayers = [];
        for (const player of this.players.values()) {
            if (player.nodes === node || player.nodes?.name === node.name) {
                affectedPlayers.push(player);
            }
        }
        return affectedPlayers;
    }

    async _rebuildBrokenPlayers(node) {
        const nodeId = node.name || node.host;
        const rebuiltCount = 0;



        for (const [guildId, brokenState] of this._brokenPlayers.entries()) {
            if (brokenState.originalNodeId !== nodeId) continue;
            try {
                await this._rebuildPlayer(brokenState, node);
                this._brokenPlayers.delete(guildId);
                rebuiltCount++;


                this.emit("debug", "Aqua", `Successfully rebuilt player for guild ${guildId}`);
            } catch (error) {
                this.emit("error", null, new Error(`Failed to rebuild player for guild ${guildId}: ${error.message}`));

                if (Date.now() - brokenState.brokenAt > 300000) {
                    this._brokenPlayers.delete(guildId);
                }
            }
        }

        if (rebuiltCount > 0) {
            this.emit("playersRebuilt", node, rebuiltCount);
        }
    }

    async _rebuildPlayer(brokenState, targetNode) {
        const { guildId, textChannel, voiceChannel, current, volume = 65, deaf = true } = brokenState;

        const connectionOptions = { guildId, textChannel, voiceChannel, defaultVolume: volume, deaf };
        const existingPlayer = this.players.get(guildId);

        if (existingPlayer) {
            await existingPlayer.destroy();
        }

        setTimeout(async () => {
            const newestPlayer = await this.createConnection(connectionOptions);
            this.players.set(guildId, newestPlayer);

            if (current) {
                try {
                    await newestPlayer.queue.add(current);
                    await newestPlayer.play();
                } catch (error) {
                    console.error("Error while playing track:", error);
                }
            }

            this.emit("trackStart", newestPlayer, brokenState.current);
            return newestPlayer;
        }, 2000);
    }

    destroyNode(identifier) {
        const node = this.nodeMap.get(identifier);
        if (!node) return;

        this._cleanupNode(identifier);
        this.emit("nodeDestroy", node);
    }

    _cleanupNode(nodeId) {
        const node = this.nodeMap.get(nodeId);
        if (node) {
            node.removeAllListeners();
        }

        this.nodeMap.delete(nodeId);
        this._nodeStates.delete(nodeId);
        this._failoverQueue.delete(nodeId);
        this._lastFailoverAttempt.delete(nodeId);
        this._invalidateCache();
    }

    _invalidateCache() {
        this._leastUsedCache.timestamp = 0;
    }

    async handleNodeFailover(failedNode) {
        if (!this.failoverOptions.enabled) return;

        const nodeId = failedNode.name || failedNode.host;
        const now = Date.now();

        const nodeState = this._nodeStates.get(nodeId);
        if (nodeState?.failoverInProgress) return;

        const lastAttempt = this._lastFailoverAttempt.get(nodeId);
        if (lastAttempt && (now - lastAttempt) < this.failoverOptions.cooldownTime) return;

        const currentAttempts = this._failoverQueue.get(nodeId) || 0;
        if (currentAttempts >= this.failoverOptions.maxFailoverAttempts) return;

        this._nodeStates.set(nodeId, { connected: false, failoverInProgress: true });
        this._lastFailoverAttempt.set(nodeId, now);
        this._failoverQueue.set(nodeId, currentAttempts + 1);

        try {
            this.emit("nodeFailover", failedNode);

            const affectedPlayers = Array.from(failedNode.players);
            if (affectedPlayers.length === 0) {
                this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false });
                return;
            }

            const availableNodes = this._getAvailableNodesForFailover(failedNode);
            if (availableNodes.length === 0) {
                this.emit("error", null, new Error("No available nodes for failover"));
                this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false });
                return;
            }

            const failoverResults = await this._migratePlayersWithRetry(affectedPlayers, availableNodes);

            const successful = failoverResults.filter(r => r.success).length;
            const failed = failoverResults.length - successful;

            if (successful > 0) {
                this.emit("nodeFailoverComplete", failedNode, successful, failed);
            }

        } catch (error) {
            this.emit("error", null, new Error(`Failover failed for node ${nodeId}: ${error.message}`));
        } finally {
            this._nodeStates.set(nodeId, { connected: false, failoverInProgress: false });
        }
    }

    async _migratePlayersWithRetry(players, availableNodes) {
        const results = [];

        const concurrency = 3;
        for (let i = 0; i < players.length; i += concurrency) {
            const batch = players.slice(i, i + concurrency);
            const batchPromises = batch.map(async player => {
                try {
                    const result = await this._migratePlayer(player, availableNodes);
                    return { player, success: true, result };
                } catch (error) {
                    await this._boundCleanupPlayer(player);
                    return { player, success: false, error };
                }
            });

            const batchResults = await Promise.allSettled(batchPromises);
            results.push(...batchResults.map(r => r.value || r.reason));
        }

        return results;
    }

    async _migratePlayer(player, availableNodes) {
        if (!player || !availableNodes.length) {
            throw new Error("Invalid player or no available nodes");
        }

        const guildId = player.guildId;
        let retryCount = 0;

        while (retryCount < this.failoverOptions.maxRetries) {
            try {
                const targetNode = this._selectBestNode(availableNodes, player);
                if (!targetNode) throw new Error("No suitable node found");

                const playerState = this._capturePlayerState(player);
                if (!playerState) throw new Error("Failed to capture player state");

                const newPlayer = await this._createPlayerOnNode(targetNode, player, playerState);
                if (!newPlayer) throw new Error("Failed to create player on target node");

                await this._restorePlayerState(newPlayer, playerState);

                if (playerState.current) {
                    newPlayer.queue.add(playerState.current);
                }

                this.emit("playerMigrated", player, newPlayer, targetNode);
                return newPlayer;

            } catch (error) {
                retryCount++;
                if (retryCount < this.failoverOptions.maxRetries) {
                    await this._delay(this.failoverOptions.retryDelay);
                } else {
                    throw error;
                }
            }
        }
    }

    _selectBestNode(availableNodes, player) {
        if (player.region) {
            const regionNode = availableNodes.find(node =>
                node.regions?.includes(player.region.toLowerCase())
            );
            if (regionNode) return regionNode;
        }

        return availableNodes[0];
    }

    _capturePlayerState(player) {
        try {
            return {
                guildId: player.guildId,
                textChannel: player.textChannel,
                voiceChannel: player.voiceChannel,
                volume: player.volume || 100,
                paused: player.paused || false,
                position: player.position || 0,
                current: player.current ? { ...player.current } : null,
                queue: player.queue?.tracks ? [...player.queue.tracks] : [],
                repeat: player.loop,
                shuffle: player.shuffle,
                deaf: player.deaf || false,
                mute: player.mute || false,
                timestamp: Date.now(),
                connected: player.connected || false,
            };
        } catch (error) {
            return null;
        }
    }

    async _createPlayerOnNode(targetNode, originalPlayer, playerState) {
        const options = {
            guildId: playerState.guildId,
            textChannel: playerState.textChannel,
            voiceChannel: playerState.voiceChannel,
            defaultVolume: playerState.volume || 100,
            deaf: playerState.deaf || false,
            mute: playerState.mute || false,
            region: playerState.region
        };

        return this.createPlayer(targetNode, options);
    }

    async _restorePlayerState(newPlayer, playerState) {
        if (!newPlayer || !playerState) return;

        try {
            const operations = [];

            if (playerState.volume !== undefined) {
                operations.push(newPlayer.setVolume(playerState.volume));
            }

            if (playerState.queue?.length > 0) {
                newPlayer.queue.add(...playerState.queue);
            }

            await Promise.all(operations);

            if (playerState.current && this.failoverOptions.preservePosition) {
                newPlayer.queue.unshift(playerState.current);

                if (this.failoverOptions.resumePlayback) {
                    await newPlayer.play();

                    if (playerState.position > 0) {
                        await this._delay(300);
                        await newPlayer.seek(playerState.position);
                    }

                    if (playerState.paused) {
                        await newPlayer.pause();
                    }
                }
            }

            Object.assign(newPlayer, {
                repeat: playerState.repeat,
                shuffle: playerState.shuffle
            });

        } catch (error) {
            throw error;
        }
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async cleanupPlayer(player) {
        if (!player) return;
        try {
            await player.destroy();
        } catch (error) {
            // Silent fail for cleanup
        }
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
                this._boundCleanupPlayer(player);
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
            const loadA = loadCache.get(a) ?? (loadCache.set(a, this._calculateLoad(a)), loadCache.get(a));
            const loadB = loadCache.get(b) ?? (loadCache.set(b, this._calculateLoad(b)), loadCache.get(b));
            return loadA - loadB;
        });

        return regionNodes;
    }

    _calculateLoad(node) {
        const stats = node?.stats?.cpu;
        if (!stats) return 0;
        return (stats.systemLoad / stats.cores) * 100;
    }

    createConnection(options) {
        if (!this.initiated) throw new Error("Aqua must be initialized before this operation");

        const existingPlayer = this.players.get(options.guildId);
        if (existingPlayer?.voiceChannel) return existingPlayer;

        const availableNodes = options.region ? this.fetchRegion(options.region) : this.leastUsedNodes;
        if (!availableNodes.length) throw new Error("No nodes are available");

        return this.createPlayer(availableNodes[0], options);
    }

    createPlayer(node, options) {
        this.destroyPlayer(options.guildId);

        const player = new Player(this, node, options);
        this.players.set(options.guildId, player);

        player.once("destroy", this._boundHandlePlayerDestroy);
        player.connect(options);
        this.emit("playerCreate", player);
        return player;
    }

    _handlePlayerDestroy(player) {
        const node = player.nodes;
        if (node && node.players) {
            node.players.delete(player);
        }
        this.players.delete(player.guildId);
        this.emit("playerDestroy", player);
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
            // Silent fail for cleanup
        }
    }

    async resolve({ query, source = this.defaultSearchPlatform, requester, nodes }) {
        if (!this.initiated) throw new Error("Aqua must be initialized before this operation");

        const requestNode = this._getRequestNode(nodes);
        const formattedQuery = URL_REGEX.test(query) ? query : `${source}:${query}`;

        try {
            const endpoint = `/v4/loadtracks?identifier=${encodeURIComponent(formattedQuery)}`;
            const response = await requestNode.rest.makeRequest("GET", endpoint);

            if (["empty", "NO_MATCHES"].includes(response.loadType)) {
                return this._createEmptyResponse();
            }

            return this._constructResponse(response, requester, requestNode);
        } catch (error) {
            if (error.name === "AbortError") {
                throw new Error("Request timed out");
            }
            throw new Error(`Failed to resolve track: ${error.message}`);
        }
    }

    _getRequestNode(nodes) {
        if (!nodes) return this.leastUsedNodes[0];
        if (nodes instanceof Node) return nodes;
        if (typeof nodes === "string") {
            return this.nodeMap.get(nodes) || this.leastUsedNodes[0];
        }
        throw new TypeError(`'nodes' must be a string or Node instance, received: ${typeof nodes}`);
    }

    _createEmptyResponse() {
        return {
            loadType: "empty",
            exception: null,
            playlistInfo: null,
            pluginInfo: {},
            tracks: []
        };
    }

    _constructResponse(response, requester, requestNode) {
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

        switch (response.loadType) {
            case "track":
                if (response.data) {
                    baseResponse.tracks.push(new Track(response.data, requester, requestNode));
                }
                break;

            case "playlist": {
                const info = response.data?.info;
                if (info) {
                    baseResponse.playlistInfo = {
                        name: info.name ?? info.title,
                        thumbnail: response.data.pluginInfo?.artworkUrl ?? (response.data.tracks?.[0]?.info?.artworkUrl || null),
                        ...info
                    };
                }

                const tracks = response.data?.tracks;
                if (tracks?.length) {
                    baseResponse.tracks = tracks.map(track => new Track(track, requester, requestNode));
                }
                break;
            }

            case "search": {
                const searchData = response.data ?? [];
                if (searchData.length) {
                    baseResponse.tracks = searchData.map(track => new Track(track, requester, requestNode));
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
            return null;
        }
    }

    async savePlayer(filePath = "./AquaPlayers.json") {
        const data = Array.from(this.players.values()).map(player => {
            const requester = player.requester || player.current?.requester;

            return {
                g: player.guildId,
                t: player.textChannel,
                v: player.voiceChannel,
                u: player.current?.uri || null,
                p: player.position || 0,
                ts: player.timestamp || 0,
                q: player.queue?.tracks?.map(tr => tr.uri).slice(0, 5) || [],
                r: requester ? {
                    id: requester.id,
                    username: requester.username,
                    globalName: requester.globalName,
                    discriminator: requester.discriminator,
                    avatar: requester.avatar
                } : null,
                vol: player.volume,
                pa: player.paused,
                isPlaying: !!player.current && !player.paused
            };
        });

        await fs.writeFile(filePath, JSON.stringify(data), "utf8");
        this.emit("debug", "Aqua", `Saved ${data.length} players to ${filePath}`);
    }

    async loadPlayers(filePath = "./AquaPlayers.json") {
        try {
            await fs.access(filePath);
            await this._waitForFirstNode();

            const data = JSON.parse(await fs.readFile(filePath, "utf8"));

            const batchSize = 5;
            for (let i = 0; i < data.length; i += batchSize) {
                const batch = data.slice(i, i + batchSize);
                await Promise.all(batch.map(p => this._restorePlayer(p)));
            }

            await fs.writeFile(filePath, "[]", "utf8");
        } catch (error) {
        }
    }

    async _restorePlayer(p) {
        try {
            let player = this.players.get(p.g);
            if (!player) {
                const targetNode = (p.n && this.nodeMap.get(p.n)?.connected) ?
                    this.nodeMap.get(p.n) : this.leastUsedNodes[0];

                if (!targetNode) return;

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
                if (resolved.tracks?.[0]) {
                    player.queue.add(resolved.tracks[0]);
                    player.position = p.p || 0;
                    if (typeof p.ts === "number") player.timestamp = p.ts;
                }
            }

            if (p.q?.length && player) {
                const queuePromises = p.q
                    .filter(uri => uri !== p.u)
                    .map(uri => this.resolve({ query: uri, requester: p.r }));

                const queueResults = await Promise.allSettled(queuePromises);
                queueResults.forEach(result => {
                    if (result.status === 'fulfilled' && result.value.tracks?.[0]) {
                        player.queue.add(result.value.tracks[0]);
                    }
                });
            }

            if (player) {
                player.paused = !!p.pa;
                if ((p.isPlaying || (p.pa && p.u)) && player.queue.size > 0) {
                    player.play();
                }
            }
        } catch (error) {
        }
    }

    async _waitForFirstNode() {
        if (this.leastUsedNodes.length > 0) return;

        return new Promise(resolve => {
            const checkInterval = setInterval(() => {
                if (this.leastUsedNodes.length > 0) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
        });
    }

    // Auto-resume utility methods
    getBrokenPlayersCount() {
        return this._brokenPlayers.size;
    }

    getBrokenPlayers() {
        return Array.from(this._brokenPlayers.entries()).map(([guildId, state]) => ({
            guildId,
            originalNodeId: state.originalNodeId,
            brokenAt: state.brokenAt,
            hasCurrentTrack: !!state.current,
            queueSize: state.queue?.length || 0
        }));
    }

    clearBrokenPlayers() {
        this._brokenPlayers.clear();
    }

    async forceBrokenPlayerRebuild(guildId) {
        const brokenState = this._brokenPlayers.get(guildId);
        if (!brokenState) return false;

        try {
            const targetNode = this.nodeMap.get(brokenState.originalNodeId) || this.leastUsedNodes[0];
            if (!targetNode || !targetNode.connected) {
                throw new Error("No available nodes for rebuild");
            }

            await this._rebuildPlayer(brokenState, targetNode);
            this._brokenPlayers.delete(guildId);
            return true;
        } catch (error) {
            this.emit("error", null, new Error(`Failed to force rebuild player for guild ${guildId}: ${error.message}`));
            return false;
        }
    }

    // Utility methods
    resetFailoverAttempts(nodeId) {
        this._failoverQueue.delete(nodeId);
        this._lastFailoverAttempt.delete(nodeId);
        const nodeState = this._nodeStates.get(nodeId);
        if (nodeState) nodeState.failoverInProgress = false;
    }

    getFailoverStatus() {
        const status = {};
        for (const [nodeId, attempts] of this._failoverQueue) {
            const lastAttempt = this._lastFailoverAttempt.get(nodeId);
            const nodeState = this._nodeStates.get(nodeId);
            status[nodeId] = {
                attempts,
                lastAttempt,
                inProgress: nodeState?.failoverInProgress || false,
                connected: nodeState?.connected || false
            };
        }
        return status;
    }

    getNodeStats() {
        const stats = {};
        for (const [name, node] of this.nodeMap) {
            stats[name] = {
                connected: node.connected,
                players: node.stats?.players || 0,
                playingPlayers: node.stats?.playingPlayers || 0,
                uptime: node.stats?.uptime || 0,
                cpu: node.stats?.cpu || {},
                memory: node.stats?.memory || {},
                ping: node.stats?.ping || 0
            };
        }
        return stats;
    }

    async forceFailover(nodeIdentifier) {
        const node = this.nodeMap.get(nodeIdentifier);
        if (!node) return;

        if (node.connected) {
            await node.destroy();
        }

        this._cleanupNode(nodeIdentifier);
    }
}

module.exports = Aqua;
