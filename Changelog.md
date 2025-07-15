# Aqualink 2.7.1

- ignore message errors on shouldDeleteMessage
- Removed fs-extra usage, switch to fs/promises
- Fixed player breaking if no track given on autoResume
- Fixed an circular buffer cache related to user handling on autoResume / player saving
- Optimized node, made message handling faster, improved events binding efficiency, and other misc improviments.
  - This also improves the voice / audio stability, since its better for handling it.

## Breaking change

renamed the 'nodeConnect' event to 'nodeReady'

# Aqualink 2.7.0

## Rewrited the aqua class

- ~20-30% reduction in memory usage
-  ~15-25% improvement in response times
-  Better scalability with multiple concurrent operations
-  Reduced CPU overhead for repetitive operations
-  More efficient resource cleanup
-  Many optimizations related to caching, regions fetching
-  Added batch updates for less overload and speed.

## Added true node AutoResume 
 - Node disconnected? have a 2nd? Aqua will now use it.
  - Avalible options:
```js

const nodes = [
    {
        name: "Noded",
        host: NODE_HOST,
        port: NODE_PORT,
        password: NODE_PASSWORD,
        secure: false,
    },
    {
        name: "AquaLink", 
        host: NODE_HOST2,
        port: NODE_PORT2,
        password: NODE_PASSWORD2,
        secure: false,
    },
];

const aqua = new Aqua(client, nodes, {
    failoverOptions: {
        enabled: true, // enable it
        maxRetries: 3,  // max amounts of retrys until the node connects
        retryDelay: 1000,  // self-explain
        preservePosition: true,  // continue from the song position
        resumePlayback: true  //self-explain
    }
});
```

- Fixed an long-standing bug about node.destroy(), now it should work fine
- Reworked the seek() method thanks to @soulcosmic1406_ 
- Improved the destroy() method with connections
- Added seyfert package support (https://www.seyfert.dev/)

# Aqualink 2.6.4-r2

- Reworked node event handling, improved the speed and performance.
- Added new event:
```js
aqua.on("lyricsNotFound", (player, track, payload) => console.log(`Lyrics not found: ${track.info.title}`));
// Emitted when live lyrics din't found anything, should fix an error.
```

# Aqualink 2.6.4

- Rewrite the lyrics again
  - Improved support for lavalyrics / java timed lyrics
  - Improved fetching by using fallback system
  - Added live lyrics from lavalyrics

```js
// Turning on:
            player.subscribeLiveLyrics()
// Turning off:
            player.unsubscribeLiveLyrics();
```
Depends on lavalyrics API, so may break a lot

- Made getLyrics method more performant
- Add souldevs as a contribuitor on readme
New 2 events:
```js
aqua.on("lyricsFound", (player, track, payload) => console.log(`Lyrics found: ${track.info.title}`));
// Emitted when live lyrics found a lyric;

aqua.on("lyricsLine", async (player, track, payload) 
// Emitted when the lyrics starts updating by line (Eg: changing from line 1, to line 2, line 3 ...)
```

# Aqualink 2.6.3
- Rewrited the getLyrics method
  - Added skipTrackSource [true, false]
example usage.

 ```js
const lyricsResult = await player.getLyrics({
query: searchQuery,
useCurrentTrack: !searchQuery,
skipTrackSource: false
});
```

- Remade some code on the Connection handle, improved lazy load, improved speed and region fetching
- Rewrited the autoResume code, Way more lightweight, faster, and auto cleans up on reload
- Rewrited Rest handler, this makes way faster, and reduces the recourses usage by a lot (especially RAM)
- Rewrited player, way faster, improved batching speed and efficiency, also shuffle() now can contain both async and sync, for better performance
- Fixed timestamp on player
- Improved the HTTP2, Secure nodes handling
- Added Agents / keepalive, for better performance

# 2.6.2

- Added 2 new methods: Aqua.savePlayer()
Usage: ```js
process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  await aqua.savePlayer();
  process.exit(0);
})
```
Method 2: Aqua.loadPlayers()
Usage```
set autoResume to true
```

- Fixed some memory leaks on the aqua handler (specfific destroy)
- Improved the NODE performance (also fixed some bugs to stats)
- Added track.position (player.position) and timestamp
- Added playlist.thumbnail 
Example usage:
```js
console.log(result.playlistInfo.thumbnail)
```
- Misc fixes for player.connect()

# 2.6.1 Bug Fixes + Performance update - Aqualink

- Fix: destroy() not allowing to update voice channel status
- skip track source set to true on lyrics
- Reworked the player system to be way more lightweight, fast, and performant
- Rewrited some stuff on the node handler to be more lightweight, less bugs, better checks, better error checking / logging and bug fixes on memory leaks
- createPlayer will now listen to the destroy event, making it more performant
- Made the connection handler lazy-load, reducing the memory usage on initial and faster regions extraction, better early returnings
- remade the rest handler to be more performant with chunks

NEW EVENT SYSTEM
- moved from eventemitter3 to tseep

why? its way better for long living events, and players normally are long, also its more performant in memory and wayyy more lightweight, while beign better for "once", which aqualink uses a lot

Library    'Once' Ops/Sec    'Add-Remove'   Ops/Sec    
Tseep    108,688,843    70,905,688
EventEmitter3    52,871,196    113,090,638

# 2.6.0 Performance Update + Fixes - Aqualink

- Now player will respect the Aqua constructor options

now you can use:
```js
const aqua = new Aqua(client, nodes, {
  defaultSearchPlatform: "ytsearch",
  restVersion: "v4",
  shouldDeleteMessage: true, // Before you needed to set directly on player, now here on Aqua is the required one
  autoResume: true,
  infiniteReconnects: true, 
  leaveOnEnd: false, // // Before you needed to set directly on player, now here on Aqua is the required one
}); 
```

- Improved `resolve()` method speed by ~30% / 50% , also less requests beign sent
- Rewrited the player connection manager, improved the caching, speed, performance
  - Also improved the region fetching, making it faster and better direct calls
- Rewrited the `Filters` system
  - Much faster
  - Now uses batching updates, allowing multiple filters be updated with less network latency, more speed, and less recourses
- Optimizations on the Queue methods (Shuffle, remove, etc)
- Added track.duration on the track object

# 2.5.0 Performance update - Aqualink

- Rewrited `PLAYER` handler
  - 3x faster handling into loops, events handlings, and lookups
  - Made the autoplay faster for locating the sources
  - Added batch updates (Way less latency + less overhead for high demand bots, etc)
  - Improved lyrics by making it all in one
  - Improved the shuffle code
  - Improved Destroy method, this has way less memory leaks and cleans more
  - Made the connect method faster
  - Improved the previous / queue handling into arrays

- Improved `NODE` handler
  - Faster connections speed
  - Better checkings for message / payloads handling
  - Added jitter reconections (Better performance for reconnecting the node)
  - Improved the error checkings
  - Improved the stats creating speed / saving

- Improved `Rest` handler
  - some fixes related to https, http2
  - Improved async loading
  - Improved error checkings, more safer now

# 2.4.0 Rewrited performance - Aqualink

- Rewrited the `AUTOPLAY` module fully
  - Now uses my own method, so less chances of getting patched
  - New method is 3x faster, uses less memory, and less requests
  - Made the soundcloud only fetch the sounds, not the full page, making it way more memory efficient
  - Improved the fetching speed / memory cleaning up

- Rewrited the `AQUA` handler
  - Way faster nodes connecting (even on multiple)
  - Faster track resolving with less duplications
  - Better player creating with checks
  - Made the Voice Update dynamic (allow more speed), by setting server and state
  - Optimized the overall caching system
  - Now allocates less arrays

- Small optimizations on `Connection`
  - Improved the checkins, and make them faster too
  - Make the bot connect a bit more faster
  - Better logs on errors 

- Rewrite the `Player` handler
  - 30% Faster code
  - More smaller
  - Fixed more events handling
  - Improved event handling, now faster and less overhead on memory
  - Removed useless functions

- Improved the HTTP 2 / HTTP Support on REST, making it load faster, also made it fully async

## New track system

**now you can use both track.info and track.title (example: you can now use track.thumbnail, track.title directly)**
also new readme thanks to @lavalink.py

#  2.3.0 Another performance update - Aqualink

- now is ~21% more lightweight, reduced disk space

- Improved the `AQUA` module
  - 3x better cleanup system
  - Fixed some memory leaks
  - Improved long process support
  - Faster node caching

- Remade the `Player` module
  - Added circular buffer for previousTracks (way more memory efficient)
  - Reorganized the event handlings
  - Way better Memory management

- Rewrite the `Node` system
  - Fixed an memory leak in connections
  - Improved the overal speed
  - Improved code readbility / modules
  - improved cleanup System
  - Better long runtime
  - Rewrite the Filter system

- Improved `Rest` code
  - Fixed lyrics (both search and get)
  - Better chunks system for more performance

- Improved `fetchImage` speed and recourses

# 2.2.0 Performance Update - Aqualink

- Improved the `AQUA` module
  - Added  Fast path in getRequestNode (     Reduces unnecessary type checks    )
  - Early return in handleNoMatches (    Avoids unnecessary Spotify requests     )
  - Rewrite to use manual loops on constructResponse (      faster than Array.prototype.map, makes the playlists and tracks load way faster and less recourses     )
  - Pre-allocated arrays (    Avoids dynamic resizing   )
  - Also fixed it sending double requests to lavalink.


- Remade the `Player` module
  - More efficient track addition, void Array re-call
  - faster event handling with direct states
  - Faster autoplay system and more efficient by map()
  - Reduced Object Creation
  - Rewrite destroy() method
  - Also improved Resource Cleanup
  - Now emit TrackEnd and queueEnd correctly

- Rewrite the `autoplay` system
  - Added redirect handling
  - More efficient regex processing
  - Set for unique URLs to avoid duplicate
  - Use array chunks for better performance
  - About ~30%-40% faster for resolving now.

- Rewrite the Filter system
  - Uses Direct Assigments
  - Avoid recreating objects on each update
  - Property reuse in updateFilters()
  - Uses traditional for loop

## 2.1.0 Released - Aqualink

---
- Improved the `AQUA` module
  - Faster nodes loading
  - Faster plugin loading
  - Better listeners for player
  - Faster resolving system for playlists

- Remade the `Connection` system
  - Less overheard now.
  - Faster connections
  - Improved the checkings
  - Improved error handling
  - Fixed creating useless Objects and arrays

- Fully rewrite the `Node` system
  - Way faster connections
  - More stable (i think so)
  - Faster events / messages / payloads handling
  - Better stats handling (reusing, creating, destroyin)
  - Some more bug fixes and stuff i forgot.

- Remade the `Player` module
  - Now support Lazy Loading by default
  - Better State Updates
  - Improved Garbage Collection
  - Rewrite to use direct comparasions

- Improved the `Rest` module
  - Lazy loading of http2
  - Faster request chunks
  - Some overall upgrades

- Improved `Track` module
  - Faster track looking
  - More micro optimizations (use Boolean instead of !!)

- Remade the INDEX.D.TS File: Added more 1000 lines of code. Added autocomplete, options, and documented everything.
