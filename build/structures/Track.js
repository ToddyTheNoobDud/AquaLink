const { getImageUrl } = require("../handlers/fetchImage");

/**
 * @typedef {import("../Aqua")} Aqua
 * @typedef {import("../structures/Player")} Player
 * @typedef {import("../structures/Node")} Node
 */

class Track {
  /**
   * @param {Object} data
   * @param {Player} requester
   * @param {Node} nodes
   */
  constructor(data, requester, nodes) {
    const { info = {}, encoded = null, playlist = null } = data || {};
    
    this.info = Object.freeze({
      identifier: info.identifier || '',
      isSeekable: Boolean(info.isSeekable),
      author: info.author || '',
      length: info.length | 0,
      isStream: Boolean(info.isStream),
      title: info.title || '',
      uri: info.uri || '',
      sourceName: info.sourceName || '',
      artworkUrl: info.artworkUrl || ''
    });

    this.track = encoded;
    this.playlist = playlist;
    this.requester = requester;
    this.nodes = nodes;
  }

  /**
   * @param {string} thumbnail
   * @returns {string|null}
   */
  resolveThumbnail(thumbnail) {
    return thumbnail && thumbnail.startsWith("http") ? 
      thumbnail : 
      thumbnail ? getImageUrl(thumbnail, this.nodes) : null;
  }

  /**
   * @param {Aqua} aqua
   * @returns {Promise<Track|null>}
   */
  async resolve(aqua) {
    const searchPlatform = aqua?.options?.defaultSearchPlatform;
    if (!searchPlatform) return null;

    try {
      const query = `${this.info.author} - ${this.info.title}`;
      const result = await aqua.resolve({
        query,
        source: searchPlatform,
        requester: this.requester,
        node: this.nodes
      });

      if (!result?.tracks?.length) return null;

      const track = this._findMatchingTrack(result.tracks);
      if (!track) return null;

      this.info.identifier = track.info.identifier;
      this.track = track.track;
      this.playlist = track.playlist || null;

      return this;
    } catch {
      return null;
    }
  }

  /**
   * @private
   */
  _findMatchingTrack(tracks) {
    const { author, title, length } = this.info;
    
    for (const track of tracks) {
      const tInfo = track.info;
      
      if (!author || !title || author !== tInfo.author || title !== tInfo.title) {
        continue;
      }
      
      if (!length || Math.abs(tInfo.length - length) <= 2000) {
        return track;
      }
    }

    return tracks[0];
  }
  destroy() {
    Object.keys(this).forEach(key => this[key] = null);
  }
}

module.exports = { Track };
