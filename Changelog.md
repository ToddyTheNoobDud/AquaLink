# Changelog

Notable changes to AquaLink. This file follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.0.0] - 2026-11-04

This release rewrites the client in TypeScript and changes
parts of the v3 API. Read the breaking changes before upgrading an existing bot.

### Changed

#### Breaking changes

- **Runtime requirements:** Node.js 22.19+ or Bun 1.4.0+. Server endpoints target
  Lavalink v4 and NodeLink; `restVersion` is no longer configurable.
- **Voice forwarding:** supply `options.send` for your Discord library and forward
  the original `{ t, d }` voice packets to `aqua.updateVoiceState()`. AquaLink no
  longer guesses how to send packets through your client's guild or shard cache.
- **Player creation:** `aqua.createConnection()` returns a Promise and completes
  after the Discord voice handshake and node voice update succeed. Await it before
  playing. Calling it for an existing active player returns that player unchanged;
  it no longer moves it to another channel. Use `await player.connect(...)` to move.
  `init()` opens sockets; wait for `nodeReady` before creating players.
- **Controls and filters:** await `connect`, `pause`, `seek`, `stop`, `skip`,
  `setVolume`, `replay`, `disconnect` and `destroy`. Filter setters also return
  Promises, so synchronous chains of setters must become separate awaited calls.
  `aqua.destroy()` is asynchronous too. `setLoop`, `setAutoplay` and `shuffle`
  remain synchronous.
- **Playback:** `play(track)` queues behind current playback by default. Use
  `play(track, { noReplace: false })` to replace current, or `playNext(track)` to
  start a specific track without appending it. `play()` starts the next waiting
  track. Playback failures reject instead of being handled only through internal
  logging and events.
- **Stop and skip:** both stop current and let the server's `stopped` event advance
  the queue or autoplay. An empty player emits `queueEnd`. Awaiting `stop()` waits
  for the stop request, not the next track's start. `skip(target)` is removed;
  select or remove waiting tracks yourself before calling `skip()`.
- **End and error handling:** `finished`, `loadFailed` and `stopped` can advance
  playback. `replaced` never advances; `cleanup` only clears local state.
  `trackError` and `trackStuck` report the error without automatically stopping or
  skipping. Add that recovery in your bot if you want it.
- **REST requests:** change `makeRequest(method, path, body)` to
  `makeRequest(path, method?, body?)`. It reads JSON or text, returns `null` for
  HTTP 204, and logs failures before returning `undefined`. For a rejecting API
  or access to headers, binary data and streams, use `request()`, which returns
  the unread `Response`. Consume or cancel its body. Its timeout covers response
  headers; destroying Rest also aborts active responses.
  Request bodies are JSON-serialized; pass objects instead of pre-stringified JSON.
- **REST session:** `rest.sessionId` reads the Node's current session.
  `rest.setSessionId()` is removed; do not keep a separate REST session ID.
- **Recovery defaults:** `autoResume` and `infiniteReconnects` default to `false`
  instead of `true`. Reconnects stop after ten attempts by default; use
  `nodeConfigs.maxRetries` or `nodeConfigs.infiniteReconnects` to change that.
  Backoff starts at five seconds and grows up to seven minutes. Automatic node
  failover, region migration, voice watchdogs and scheduled voice rejoining are
  removed. With `autoResume: true`, the client requests server session resuming
  and restores players on the same node if that session expired.
- **Manual kicks:** a bot voice-state update with `channel_id: null` destroys the
  player and its waiting queue. AquaLink does not rejoin after a kick. A later
  explicit connection creates a fresh player. `player.disconnect()` remains a
  reusable leave operation and preserves waiting tracks.
- **Queues:** the built-in queue is a plain FIFO, not an Array subclass. Use
  `add`, `dequeue`, `at`, `remove`, `move`, `unshift`, `clear`, `shuffle` and
  `toArray`. `enqueue`, `peek`, `isEmpty`, `swap`, `first` and `last` are removed.
  Array methods such as `map` must be called on `toArray()`; v3's Array-style
  declarations did not match all of its runtime methods. `at(-1)` now reads the
  last track. Queue removal and clearing release references without disposing
  shared Track objects.
- **Previous track:** `player.previous` holds one previous track. The previous-track
  history buffer, autoplay identifier history and `autoplaySeed` are removed.
  Autoplay excludes its seed but no longer keeps a listening history or runs a
  retry loop. SoundCloud autoplay uses artist search instead of scraping the
  SoundCloud recommendations page.
- **Track data:** `track.info` is the original payload reference. Flat properties
  such as `title`, `duration` and `track` are getters/setters over `info` and
  `encoded`; `info` is no longer a frozen cached copy. Keep `uri`, `artworkUrl`,
  `isrc` and `thumbnail` nullable. `Track.resolve()` can reject on transport failure
  instead of always returning `null` on errors. Its node override is `node`.
  When constructing a Track manually, supplied `TrackData` must include `info`;
  the no-argument constructor still supplies empty metadata.
- **Validation:** guild and channel IDs use strings. Node host and password/auth
  must be supplied; the implicit `youshallnotpass` password is removed. Use `ssl`
  instead of the old runtime `secure` alias. `setVolume` requires a finite number;
  numeric strings are no longer accepted. `setLoop` rejects unsupported values,
  and equalizer bands/gains are validated.
- **Selection:** `loadBalancer: 'leastRest'` is removed; use `'leastLoad'` or
  `'random'`. `resolve({ nodes: [...] })` selects the first connected entry;
  it no longer ranks that array or falls back to other nodes when it is empty.
  An explicitly named node is looked up directly rather than falling back to
  another one.
- **Messages:** `shouldDeleteMessage` is removed. AquaLink never edits or deletes
  Discord messages. Use your `trackEnd`, `queueEnd` and `playerDestroy` listeners
  for cleanup. `nowPlayingMessage` remains a bot-owned reference and is readable
  during destruction events before AquaLink releases it.
- **Persistence:** `savePlayer`/`loadPlayers` retain the JSONL player record format,
  URL/full-track modes and queue limits. Loading rejoins through fresh Discord
  voice credentials; saved `node_sessions` records are not used to resume a
  session. Discord message references are not restored.
- **License metadata:** the package now declares [WTFPL](LICENSE.md), matching
  its included license file. The npm v3.2.1 package declared ISC.

#### Listener and property migration

Aqua track aliases still receive Player first. Player listeners receive the same
arguments without that first Player. Use protocol-name listeners such as
`player.on('TrackStartEvent', ...)` when you need the original server payload.

| v3 usage | v4 replacement or behavior |
| --- | --- |
| `aqua.on('trackStart', (player, track, payload) => ...)` | `(player, track)`; read the raw payload from the Player's `TrackStartEvent` |
| `aqua.on('trackError', (player, track, payload) => ...)` | `(player, track, exception)` |
| `aqua.on('trackStuck', (player, track, payload) => ...)` | `(player, track, thresholdMs)` |
| `aqua.on('socketClosed', (player, track, payload) => ...)` | `(player, payload)` |
| `aqua.on('playerMove', (player, oldChannel, newChannel) => ...)` | `(oldChannel, newChannel)`; listen on a Player when you need its guild context |
| `nodeReconnect` payload `{ attempt, backoffTime, infinite }` | `{ attempt, delay }` |
| `nodeReady` payload with derived session flags | Original ready payload, including `sessionId` and `resumed` |
| Overriding `Player.trackStart`, `trackEnd`, `trackError`, `trackStuck` or `socketClosed` | Override those methods on a `PlayerEvents` subclass through `structures.PlayerEvents` |
| `player.currenttrack` | `player.current` |
| `player.isAutoplay` | `player.isAutoplayEnabled` |
| `player.self_deaf` / `self_mute` | `player.deaf` / `mute` |
| `node.auth` / `node.ws` | `node.password` / `node.websocket`; the Node option `auth` is still accepted |
| `node.reconnectAttempted` / `reconnectTries` | `node.reconnectRetries` / `maxRetries` |
| Numeric `node.state` | String `node.nodeState` |
| Replacing `aqua.nodeMap` | Replace `aqua.nodesMap`; `nodeMap` is a getter for the same registry |
| Assigning option fields such as `aqua.autoResume` or `aqua.leaveOnEnd` | Configure `aqua.options` before creating nodes/players, or change the corresponding instance |

`trackEnd` is emitted before state cleanup and progression, including when no
waiting track remains. Raw player events are emitted after their handler, even
if it rejects. Constants for some old failover/recovery event names remain for
extensions; they do not enable the removed automatic policies.

#### Other changes

- Replaced the custom HTTP/HTTP2 transport, agent management and chunk buffering
  with native `fetch`. Both Node.js and Bun use the `ws` interface for WebSockets.
- Removed update batching. Each playback control or filter setter sends its own
  request, and its Promise reports that request's completion or failure.
- Filters are created on first access. Queue creation stays eager by default;
  enable `lazyloadPlayer` to defer it until a waiting track is needed or the queue
  is accessed. Reading `hasQueue` does not create storage.
- Reduced per-player initialization by removing watchdog timers, previous-track
  buffers and generic data caches. Queue insertion avoids spreading a second
  argument list, and playback cleanup creates fewer intermediate Promises.

### Added

- `options.structures` lets bots replace Node, Rest, Player, Connection, Queue,
  PlayerEvents, Filters and Track with subclasses. Register overrides before
  creating their instances. [Examples](examples/README.md) cover each structure.
- `QueueLike` and `options.queue` support independent waiting-track storage.
  A factory creates storage per player; an explicitly shared instance stays shared.
  Set `queue: false` to disable waiting tracks while playing explicit tracks.
- Queue construction accepts initial tracks, and iteration reads a snapshot of
  waiting tracks. Changes to the queue do not change an iterator already created.
- `PlayerEvents` separates protocol handling from the public Player emitter.
  Override a built-in handler or `handleCustomEvent`; the bot can keep using
  `player.on(...)`. `PlayerEventMap` and `AquaEventMap` support declaration merging
  for custom listener arguments.
- Raw Player `event` and protocol-name listeners, plus `nodeEvent` for events
  without a matching local player. Existing `nodeCustomOp` handling remains.
- Replaceable autoplay selection through `options.autoplay` or
  `Player.getAutoplayTrack()`. Built-in selection uses YouTube radio mixes,
  Spotify recommendations through NodeLink/LavaSrc, and SoundCloud artist search.
  A custom callback returning `null` ends selection without a built-in fallback.
  Selection failures emit `autoplayFailed`.
- Public `getNode`, `createNode`, `constructResponse` and `restorePlayer` methods.
  Existing `nodeMap` and `player.nodes` aliases remain available.
- Positional `resolve(query, source?, node?)` returning a track array or
  `undefined`. The existing object form continues to return a `ResolveResponse`.
- A stdout logger with level filtering and an injectable `options.logger`.
  The [logger example](examples/logger.ts) adapts Seyfert's logger.
- Explicit ESM and CommonJS builds, separate declaration entry points and a default
  Aqua export. Method documentation and examples are included in the typings.
- REST helpers for session updates, track encoding, SponsorBlock, NodeLink worker
  management, YouTube configuration/OAuth, chapters, track meanings, audio streams
  and metrics. Endpoints still depend on the node and its plugins.
- Separate Lavalink/NodeLink info and stats types, nullable track metadata,
  optional/null frame stats and NodeLink process-load/detailed-stats fields.
  Plugin fields remain open in track, event, player-update and filter payloads.

### Removed

- `Plugin`, `options.plugins` and automatic plugin load/unload. Use structure
  overrides and bot-owned functions instead. The `VoiceRegion` export and
  region-selection API are removed.
- `shouldDeleteMessage`, `useHttp2`, `debugTrace`, `traceMaxEntries`, `traceSink`,
  `failoverOptions`, `autoRegionMigrate`, `restVersion`, URL-filter configuration,
  broken-player store/rebuild settings and track-restore concurrency settings.
  Configure URL policy, failover, persistence scheduling and voice recovery in
  your bot. AquaLink no longer maintains a debug trace buffer.
- The old `CircularBuffer` and `MicrotaskUpdateBatcher` declarations, generic
  Player `set`/`get`/`clearData` storage and internal playback state/transaction IDs.
- V3-only type names `FailoverOptions`, `AutoplaySeed`, `PlayerState`,
  `BrokenPlayerState`, `MigrationResult`, `DiscordVoiceRegion`, `RestVersion` and
  `ExtendedResolveOptions`. The old `PlayerEvents` listener type is replaced by
  `PlayerEventMap`/`AquaEventMap`; `PlayerEvents` now names the handler class.
  For direct lyrics requests, use `GetLyricsOptions` instead of `LyricsOptions`.

| Removed methods | What to use in v4 |
| --- | --- |
| `aqua.get(guildId)` | `aqua.players.get(guildId)`, which returns `undefined` when absent |
| `aqua.search(...)` | `aqua.resolve({ query, source, requester })` and its `tracks` array |
| `aqua.createPlayer(...)` / `destroyPlayer(guildId)` | `await aqua.createConnection(...)` / `await aqua.players.get(guildId)?.destroy()` |
| `aqua.fetchRegion`, `movePlayerToNode`, `handleNodeFailover` | Bot-owned node selection and migration |
| `aqua.getTrace`, `getVoiceStateQueueDelay`, `queueVoiceStateUpdate` | Bot-owned diagnostics and gateway scheduling |
| `node.getStats()` | `node.rest.getStats()`; `node.stats` is empty until stats arrive |
| `player.setTextChannel`, `setVoiceChannel`, `getQueue` | Assign `textChannel`, use `await connect(...)` to move, and access `queue` |
| `player.getLyrics`, `getLoadLyrics`, `liveLyrics`, live-lyrics subscriptions and mixer wrappers | Corresponding `player.node.rest` methods; use subscribe/unsubscribe for live lyrics |
| `player.cleanup()` | `await player.destroy()` |
| `player.batchUpdatePlayer(...)` | `await player.updatePlayer(...)` |
| `connection.updateSequence(...)` | No sequence tracking in the built-in connection |
| Synchronous `connection.setStateUpdate`, `setServerUpdate`, `destroy` or `resendVoiceUpdate` | Await completion; `resendVoiceUpdate(force)` no longer uses the `force` argument |

### Fixed

- WebSocket failures on older Bun versions emit the underlying Error rather than
  an ErrorEvent wrapper. Bun 1.4.0 may report the expected upgrade status instead
  of the actual HTTP response code in its error message, and uses close code
  `1002` for a failed upgrade where newer versions use `1006`.
- Overlapping play/stop/skip requests are serialized so late responses and old
  `stopped`/`replaced` events cannot clear a newer current track or advance twice.
  Failed starts restore the previous playing state and can be retried.
- Discord voice packets can arrive in either order or overlap without losing the
  completed handshake. Duplicate gateway packets do not issue another voice update;
  stale updates cannot reconnect a moved, disconnected or destroyed player.
- Destruction waits for in-flight playback, controls and voice updates before
  remote deletion. Repeated destruction shares cleanup, and a fresh connection
  for the same guild waits for the old player to finish deletion.
- Destroy listeners can read `nowPlayingMessage` before it is released, allowing
  the bot to clean its old Now Playing message after a manual kick.
- Late node-info responses cannot revive a closed socket or disconnect its
  replacement. Duplicate close notifications create at most one reconnect timer.
- Queue clearing/removal no longer disposes Track objects still referenced by
  other players or bot code. Track wrappers retain server `userData`, and flat
  metadata no longer becomes stale behind a frozen `info` cache.
- Autoplay checks player state after a lookup: disabling it, leaving voice,
  destroying the player or starting another track prevents a late recommendation
  from starting. Tracks queued during selection take priority. No queue is created
  just to play an autoplay result.

## Earlier releases

The entries below are preserved from the previous changelog. That file did not
record a v3 release history or release dates for these entries.

## 2.7.1

- ignore message errors on shouldDeleteMessage
- Removed fs-extra usage, switch to fs/promises
- Fixed player breaking if no track given on autoResume
- Fixed an circular buffer cache related to user handling on autoResume / player saving
- Optimized node, made message handling faster, improved events binding efficiency, and other misc improviments.
  - This also improves the voice / audio stability, since its better for handling it.

### Breaking change

renamed the 'nodeConnect' event to 'nodeReady'

## 2.7.0

### Rewrited the aqua class

- ~20-30% reduction in memory usage
-  ~15-25% improvement in response times
-  Better scalability with multiple concurrent operations
-  Reduced CPU overhead for repetitive operations
-  More efficient resource cleanup
-  Many optimizations related to caching, regions fetching
-  Added batch updates for less overload and speed.

### Added true node AutoResume
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

## 2.6.4-r2

- Reworked node event handling, improved the speed and performance.
- Added new event:
```js
aqua.on("lyricsNotFound", (player, track, payload) => console.log(`Lyrics not found: ${track.info.title}`));
// Emitted when live lyrics din't found anything, should fix an error.
```

## 2.6.4

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

## 2.6.3
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

## 2.6.2

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

## 2.6.1

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

## 2.6.0

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

## 2.5.0

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

## 2.4.0

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

### New track system

**now you can use both track.info and track.title (example: you can now use track.thumbnail, track.title directly)**
also new readme thanks to @lavalink.py

## 2.3.0

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

## 2.2.0

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

## 2.1.0

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


[4.0.0]: https://github.com/ToddyTheNoobDud/AquaLink/compare/05e17af49fcc2c238247596c70247de435297fbb...v4-ts-rewrite
