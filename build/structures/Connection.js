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

        const previousVoiceRegion = this.region;
        this.voice.endpoint = endpoint;
        this.voice.token = token;
        this.region = endpoint.split(".")[0].replace(/[0-9]/g, "");

        this.player.aqua.emit("debug", `[Player ${this.player.guildId} - CONNECTION] ${previousVoiceRegion ? `Changed Voice Region from ${previousVoiceRegion} to ${this.region}` : `Voice Server: ${this.region}`}`);

        if (this.player.paused) this.player.pause(false);

        this.updatePlayerVoiceData();
    }

    setStateUpdate({ session_id, channel_id, self_deaf, self_mute }) {
        if (!channel_id || !session_id) {
            this.player.aqua.emit("playerLeave", this.player.voiceChannel);
            this.player.voiceChannel = null;
            this.voiceChannel = null;
            this.player.destroy();
            this.player.aqua.emit("playerDestroy", this.player);
            return;
        }

        if (this.player.voiceChannel !== channel_id) {
            this.player.aqua.emit("playerMove", this.player.voiceChannel, channel_id);
            this.player.voiceChannel = channel_id;
            this.voiceChannel = channel_id;
        }

        this.selfDeaf = self_deaf;
        this.selfMute = self_mute;
        this.voice.sessionId = session_id;

        this.updatePlayerVoiceData();
    }

    updatePlayerVoiceData() {
        this.player.nodes.rest.updatePlayer({
            guildId: this.player.guildId,
            data: {
                voice: this.voice,
                volume: this.player.volume
            }
        });
    }
}

module.exports = { Connection };
