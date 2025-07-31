"use strict";
const { getImageUrl } = require("../handlers/fetchImage");

class Track {
  constructor(data = {}, requester, nodes) {
    const { info = {}, encoded = null, playlist = null } = data;
    
    this.identifier = info.identifier || '';
    this.isSeekable = !!info.isSeekable;
    this.author = info.author || '';
    this.position = info.position || 0;
    this.duration = info.length || 0;
    this.isStream = !!info.isStream;
    this.title = info.title || '';
    this.uri = info.uri || '';
    this.sourceName = info.sourceName || '';
    this.artworkUrl = info.artworkUrl || '';
    
    this.track = encoded;
    this.playlist = playlist;
    this.requester = requester;
    this.nodes = nodes;
    
    this._infoCache = null;
  }

  get info() {
    if (!this._infoCache) {
      this._infoCache = Object.freeze({
        identifier: this.identifier,
        isSeekable: this.isSeekable,
        position: this.position,
        author: this.author,
        length: this.duration,
        isStream: this.isStream,
        get title() {
          return this.title;
        },
        uri: this.uri,
        sourceName: this.sourceName,
        artworkUrl: this.artworkUrl
      });
    }
    return this._infoCache;
  }

  get length() {
    return this.duration;
  }

  get thumbnail() {
    return this.artworkUrl;
  }

  resolveThumbnail(url = this.artworkUrl) {
    if (!url) return null;
    
    try {
      return getImageUrl(url);
    } catch (error) {
      console.warn(`Failed to resolve thumbnail for ${url}:`, error.message);
      return null;
    }
  }

  async resolve(aqua) {
    const searchPlatform = aqua?.options?.defaultSearchPlatform;
    if (!searchPlatform) {
      console.warn("No search platform configured for track resolution");
      return null;
    }

    if (!this.author || !this.title) {
      console.warn("Cannot resolve track: missing author or title");
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

      if (!result?.tracks?.length) {
        console.debug(`No tracks found for query: ${query}`);
        return null;
      }
      
      const matchedTrack = this._findBestMatch(result.tracks);
      if (!matchedTrack) {
        console.debug(`No matching track found for: ${query}`);
        return null;
      }

      this.identifier = matchedTrack.info.identifier;
      this.track = matchedTrack.track;
      this.playlist = matchedTrack.playlist || null;
      this._infoCache = null;
      
      return this;
    } catch (error) {
      if (error.name === 'TimeoutError') {
        console.error(`Timeout resolving track: ${this.title}`);
      } else if (error.name === 'NetworkError') {
        console.error(`Network error resolving track: ${this.title}`);
      } else {
        console.error(`Unexpected error resolving track ${this.title}:`, error.message);
      }
      return null;
    }
  }

  _findBestMatch(tracks) {
    const targetAuthor = this.author.toLowerCase();
    const targetTitle = this.title.toLowerCase();
    const targetDuration = this.duration;
    
    for (const track of tracks) {
      const info = track.info;
      if (info.author?.toLowerCase() === targetAuthor && 
          info.title?.toLowerCase() === targetTitle) {
        
        if (!targetDuration || !info.length || 
            Math.abs(info.length - targetDuration) <= 2000) {
          return track;
        }
      }
    }
    
    for (const track of tracks) {
      const info = track.info;
      if (info.author?.toLowerCase() === targetAuthor) {
        const titleSimilarity = this._calculateSimilarity(
          targetTitle, 
          info.title?.toLowerCase() || ''
        );
        
        if (titleSimilarity > 0.8) {
          if (!targetDuration || !info.length || 
              Math.abs(info.length - targetDuration) <= 5000) {
            return track;
          }
        }
      }
    }
    
    return null;
  }

  _calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1;
    
    const words1 = new Set(str1.split(/\s+/));
    const words2 = new Set(str2.split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  isValid() {
    return !!(this.identifier && this.title && (this.track || this.uri));
  }

  dispose() {
    this._infoCache = null;
    this.requester = null;
    this.nodes = null;
  }
}

module.exports = Track;
