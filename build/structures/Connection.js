class Connection {
    constructor(player) {
        this.player = player;
        this.voice = { sessionId: null, endpoint: null, token: null };
        this.region = null;
        this.selfDeaf = false;
        this.selfMute = false;
        this.voiceChannel = player.voiceChannel;
        this.lastUpdateTime = 0;
        this.updateThrottle = 1000;
    }

    setServerUpdate({ endpoint, token }) {
        if (!endpoint) throw new Error("Missing 'endpoint' property in VOICE_SERVER_UPDATE");
        const newRegion = this.extractRegion(endpoint);
        if (this.region !== newRegion) {
            this.updateRegion(newRegion, endpoint, token);
            this.updatePlayerVoiceData();
        }
    }

    extractRegion(endpoint) {
        return endpoint.split('.')[0].replace(/[0-9]/g, "");
    }

    updateRegion(newRegion, endpoint, token) {
        const previousVoiceRegion = this.region;
        this.region = newRegion;
        this.voice.endpoint = endpoint;
        this.voice.token = token;
        this.player.aqua.emit("debug", `[Player ${this.player.guildId} - CONNECTION] ${previousVoiceRegion ? `Changed Voice Region from ${previousVoiceRegion} to ${this.region}` : `Voice Server: ${this.region}`}`);
        if (this.player.paused) {
            this.player.pause(false);
        }
    }

    setStateUpdate(data) {
        if (!data.channel_id || !data.session_id) {
            this.cleanup();
            return;
        }

        if (this.player.voiceChannel !== data.channel_id) {
            this.player.aqua.emit("playerMove", this.player.voiceChannel, data.channel_id);
            this.player.voiceChannel = data.channel_id;
            this.voiceChannel = data.channel_id;
        }

        this.selfDeaf = data.self_deaf;
        this.selfMute = data.self_mute;
        this.voice.sessionId = data.session_id;
    }

    updatePlayerVoiceData() {
        const currentTime = Date.now();
        if (currentTime - this.lastUpdateTime >= this.updateThrottle) {
            this.lastUpdateTime = currentTime;
            const data = {
                voice: this.voice,
                volume: this.player.volume,
            };
            this.player.nodes.rest.updatePlayer({
                guildId: this.player.guildId,
                data,
            });
        }
    }

    cleanup() {
        this.player.aqua.emit("playerLeave", this.player.voiceChannel);
        this.player.voiceChannel = null;
        this.player.destroy();
        this.player.aqua.emit("playerDestroy", this.player);
        this.player = null;
        this.voice = null;
        this.region = null;
        this.selfDeaf = false;
        this.selfMute = false;
        this.voiceChannel = null;
    }
}

module.exports = { Connection };
