# AquaLink v4

TypeScript client for Lavalink v4 and NodeLink. It comes with a player, a waiting
queue and filter helpers. You can replace those classes or change their handlers
from your bot code.

This branch is a source preview of the rewrite. npm packaging is still being
prepared. Some v3 APIs remain, but there are changes to migrate before using v4
in an existing bot.

## Try the sources

Use Bun 1.4.4 or newer for this checkout:

```sh
git clone --branch v4-ts-rewrite https://github.com/ToddyTheNoobDud/AquaLink.git
cd AquaLink
bun install
bun run typecheck
```

Import `src/index.ts` from your bot while testing this branch. Build tooling and
compiled packages aren't included in this source preview. The package metadata
targets Node.js 22.19+ as well, but Node execution hasn't been validated yet.

## Connect your bot

With an existing Seyfert client, create Aqua once:

```ts
import { Aqua } from './AquaLink/src/index.ts'
import type { GatewayVoiceStateUpdate } from 'seyfert'

const aqua = new Aqua(client, [
  {
    name: 'main',
    host: '127.0.0.1',
    port: 2333,
    password: process.env.NODE_PASSWORD!
  }
], {
  lazyloadPlayer: true,
  send: async (packet: GatewayVoiceStateUpdate) => {
    const shardId = client.gateway.calculateShardId(packet.d.guild_id)
    await client.gateway.send(shardId, packet)
  }
})

aqua.on('nodeReady', (node) => {
  console.log(`${node.name} is ready`)
})

// Call this when Discord has given you the bot's user ID.
await aqua.init(botId)
```

`send` forwards outgoing Discord voice packets. You also need to forward the two
incoming voice events from your gateway handler:

```ts
import type { VoicePacket } from './AquaLink/src/index.ts'

async function handleVoicePacket(packet: VoicePacket) {
  await aqua.updateVoiceState(packet)
}
```

Call that handler for `VOICE_STATE_UPDATE` and `VOICE_SERVER_UPDATE`, passing the
original `{ t, d }` packet. Aqua filters voice states by the bot's user ID.
The Discord client needs the Guilds and GuildVoiceStates intents.

`init()` starts the sockets. Wait for `nodeReady` before creating players; that
event confirms that the server sent a session ID. The node's session ID and
Discord's voice session ID are separate values.

## Search and play

```ts
const result = await aqua.resolve({ query: 'artist song', source: 'ytsearch' })

if (result.exception) {
  throw new Error(result.exception.message ?? 'Track loading failed')
}

const track = result.tracks[0]
if (track) {
  const player = await aqua.createConnection({ guildId, voiceChannel })
  await player.play(track)
}
```

URLs and playlists use the same `resolve` method. Search prefixes depend on the
sources enabled on your node. The object form returns `tracks`, `loadType`,
`exception`, `playlistInfo` and `pluginInfo`; `resolve(query, source?)` returns
an array of tracks, or `undefined` when loading fails.

`play(track)` starts a track when idle and queues it behind active playback.
`play()` starts the first waiting track. To replace the current track while
keeping the waiting queue, use `play(track, { noReplace: false })`.

## Player and queue

```ts
await player.pause(true)
await player.pause(false)
await player.seek(30_000)
await player.setVolume(80)
await player.filters.setNightcore(true)

player.setLoop('queue')
player.shuffle()

await player.skip()
await player.stop()
await player.destroy()
```

Await player controls and filter updates. Each call sends its own request.
`setLoop` and `shuffle` only change local state.

- `stop()` stops the current track and keeps the waiting tracks.
- `skip()` starts the next waiting track. With none waiting, it leaves current alone.
- The default event handler advances after `finished` or `loadFailed`.
- A manual voice kick destroys the player and clears its queue. A later
  `createConnection()` waits for cleanup before creating a replacement.

`current` belongs to the player. Its queue only contains waiting tracks.
With `lazyloadPlayer: true`, the queue is created when a track needs to wait or
your code reads `player.queue`. Check `player.hasQueue` to inspect allocation
without creating it. The default is eager allocation.

Set `queue: false` in Aqua options or player creation options to disable waiting
tracks. Reading `player.queue` then throws; explicit `play(track)` calls replace
current unless `noReplace: true` is passed.

## Events

Track listeners on Aqua receive the player first. Player listeners don't:

```ts
aqua.on('trackStart', (player, track) => {
  console.log(player.guildId, track?.title)
})

player.on('trackEnd', (track, reason) => {
  console.log(track?.title, reason)
})

player.on('TrackEndEvent', (payload) => {
  console.log(payload)
})

aqua.on('nodeCustomOp', (node, op, payload) => {
  console.log(node.name, op, payload)
})
```

`trackEnd` runs before the default handler clears state and advances the queue.
Raw protocol events, such as `TrackEndEvent`, run after the handler. The player
also emits every raw player event as `event`. Node events are available through
`nodeEvent`, including events with no matching local player.

See [the event types](src/shared/Events.ts) for listener arguments. Unknown fields
remain available in payloads; narrow them before using them.

## Customize from your bot

Pass subclasses through `structures` before creating nodes or players:

```ts
import { PlayerEvents, type PlayerEventPayload } from './AquaLink/src/index.ts'

class BotEvents extends PlayerEvents {
  override async trackStart(payload: PlayerEventPayload) {
    await super.trackStart(payload)
    this.aqua.logger.info(`Playing in ${this.player.guildId}`)
  }

  override async handleCustomEvent(payload: PlayerEventPayload) {
    this.aqua.logger.debug({ type: payload.type }, 'Received a custom event')
  }
}

aqua.options.structures = { PlayerEvents: BotEvents }
```

Calling `super` keeps the built-in behavior. Replacing a handler entirely gives
your bot responsibility for that handler's state changes and queue progression.
Raw events are still emitted when a custom handler throws.

`Node`, `Rest`, `Player`, `Connection`, `Queue`, `Filters` and `Track` are also
replaceable. For a queue with a different implementation, use a per-player factory:

```ts
import { Queue } from './AquaLink/src/index.ts'

aqua.options.queue = () => new Queue()
```

A custom queue implements `QueueLike`. Its operations are synchronous; remote
storage needs a local adapter. Use a factory to keep each guild's queue separate.

## REST and server extensions

Use `player.node.rest` or `aqua.getNode(name)?.rest` for server requests:

```ts
const rest = player.node.rest
const info = await rest.getInfo()
const response = await rest.request('/v4/info')
console.log(info, response.status)
```

`makeRequest<T>(path, method?, body?)` reads JSON or text, returns `null` for 204,
and logs failures before returning `undefined`. `request()` returns a `Response`
and rejects on failure. Consume or cancel its body when using streams.
Type parameters describe the response; they don't validate incoming JSON.
Route helpers can still throw for missing arguments or an unavailable session.

The REST class includes player/session routes, track loading and decoding,
routeplanner helpers, and NodeLink extensions such as lyrics and mixers.
Endpoint availability depends on your server and installed plugins. Extra player
and filter fields can be sent through `player.updatePlayer()`.

Server API references: [Lavalink REST](https://lavalink.dev/api/rest),
[Lavalink WebSocket](https://lavalink.dev/api/websocket) and
[NodeLink REST](https://nodelink.js.org/docs/api/rest).

## Optional behavior

`autoResume` defaults to false. Enabling it configures server session resuming
and attempts to restore local players when a previous server session expires.
It doesn't rejoin a Discord channel after a kick or move players to another node.

Autoplay requires your `options.autoplay(player)` callback, which returns a Track
or `null`. Enable it per player with `setAutoplay(true)`.
`leaveOnEnd` also defaults to false.

Persistence runs only when you call `savePlayer(path?)` or `loadPlayers(path?)`.
It uses the v3 JSONL format. Save before destroying players. Your bot owns message
creation/deletion and any recovery policy beyond these hooks.

## Moving from v3

Await `createConnection`, playback, controls, filters and destruction. Use
`aqua.players.get(guildId)` for player lookup and `player.destroy()` for removal.
The generic REST signature is path first, with `null` for 204 and `undefined` on
failure; use `request()` when you need the error details.

The rewrite removes HTTP/2 configuration, trace history, automatic Discord message
deletion, control batching and automatic failover. The old Plugin registry is
replaced by structure overrides. `stop()` and `skip()` have separate behavior,
and autoplay needs your bot's recommendation callback.

The rewrite has local protocol and lifecycle tests, including package consumers.
Real Discord audio and Node.js runtime checks are still needed before calling
this release ready for production. Performance results from older snapshots
aren't guarantees for this version.

## License

[WTFPL](LICENSE.md).
