"use strict";
const { getImageUrl } = require("../handlers/fetchImage");

class Track {
  constructor(data = {}, requester, nodes) {
    const { info = {}, encoded = null, playlist = null } = data;
    
    this._rawInfo = info;
    
    this.identifier = info.identifier || '';
    this.isSeekable = Boolean(info.isSeekable);
    this.author = info.author || '';
    this.position = info.position || 0;
    this.length = info.length || 0;
    this.duration = info.length || 0;
    this.isStream = Boolean(info.isStream);
    this.title = info.title || '';
    this.uri = info.uri || '';
    this.sourceName = info.sourceName || '';
    this.artworkUrl = info.artworkUrl || '';
    this.thumbnail = info.artworkUrl || '';
    
    this.track = encoded;
    this.playlist = playlist;
    this.requester = requester;
    this.nodes = nodes;
  }

  get info() {
    return {
      identifier: this.identifier,
      isSeekable: this.isSeekable,
      position: this.position,
      author: this.author,
      length: this.length,
      isStream: this.isStream,
      title: this.title,
      uri: this.uri,
      sourceName: this.sourceName,
      artworkUrl: this.artworkUrl
    };
  }

  resolveThumbnail(artworkUrl) {
    return artworkUrl ? getImageUrl(artworkUrl) : null;
  }

  async resolve(aqua) {
    const searchPlatform = aqua?.options?.defaultSearchPlatform;
    if (!searchPlatform) {
      console.warn("No search platform configured.");
      return null;
    }

    try {
      const query = `${this.author} - ${this.title}`;
      
      const result = await aqua.resolve({
        query,
        source: searchPlatform,
        requester: this.requester,
        node: this.nodes
      });

      if (!result?.tracks?.length) return null;
      
      const track = this._findMatchingTrack(result.tracks);
      if (!track) return null;

      // Update properties directly
      this.identifier = track.info.identifier;
      this.track = track.track;
      this.playlist = track.playlist || null;
      
      return this;
    } catch (error) {
      console.error("Error resolving track:", error);
      return null;
    }
  }

  _findMatchingTrack(tracks) {
    for (const track of tracks) {
      const tInfo = track.info;
      if (this.author === tInfo.author && this.title === tInfo.title) {
        if (!this.length || Math.abs(tInfo.length - this.length) <= 2000) {
          return track;
        }
      }
    }
    
    return null;
  }
}

module.exports = Track;
