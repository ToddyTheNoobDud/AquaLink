"use strict";

class Connection {
    constructor(player) {
        this.player = player;
        this.voiceChannel = player.voiceChannel;
        this.guildId = player.guildId;
        this.aqua = player.aqua;
        this.nodes = player.nodes;

        this.sessionId = null;
        this.endpoint = null;
        this.token = null;
        this.region = null;
        this.selfDeaf = false;
        this.selfMute = false;
    }

    setServerUpdate(data) {
        if (!data?.endpoint) return;

        const { endpoint, token } = data;
        const newRegion = endpoint.split('.')[0];
        if (!newRegion) return;

        if (this.region !== newRegion) {
            const oldRegion = this.region;
            this.endpoint = endpoint;
            this.token = token;
            this.region = newRegion;

            this.aqua.emit(
                "debug",
                `[Player ${this.guildId} - CONNECTION] Voice Server: ${
                    oldRegion ? `Changed from ${oldRegion} to ${newRegion}` : newRegion
                }`
            );

            this._updatePlayerVoiceData();
        }
    }

    setStateUpdate(data) {
        if (!data) {
            this.player?.destroy();
            return;
        }

        const { channel_id, session_id, self_deaf, self_mute } = data;
        if (!channel_id || !session_id) {
            this.player?.destroy();
            return;
        }

        if (this.voiceChannel !== channel_id) {
            this.aqua.emit("playerMove", this.voiceChannel, channel_id);
            this.voiceChannel = channel_id;
        }

        this.selfDeaf = Boolean(self_deaf);
        this.selfMute = Boolean(self_mute);
        this.sessionId = session_id;
    }

    _updatePlayerVoiceData() {
        if (!this.player) return;

        const voiceData = {
            sessionId: this.sessionId,
            endpoint: this.endpoint,
            token: this.token
        };

        try {
            this.nodes.rest.updatePlayer({
                guildId: this.guildId,
                data: {
                    voice: voiceData,
                    volume: this.player.volume
                }
            });
        } catch (error) {
            this.aqua.emit("apiError", "updatePlayer", {
                error,
                guildId: this.guildId,
                voiceData
            });
        }
    }
}

module.exports = Connection;
