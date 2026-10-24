<div align="center">

<img src="https://capsule-render.vercel.app/api?type=wave&color=0099FF&height=220&section=header&text=AquaLink&fontSize=70&fontAlignY=35&fontColor=ffffff&desc=Lavalink%20v4%20%2B%20NodeLink%20Client&descSize=20&descAlignY=60" alt="AquaLink: Lavalink v4 and NodeLink client" />

[![NPM Downloads](https://img.shields.io/npm/dw/aqualink.svg?style=for-the-badge&color=3498db)](https://www.npmjs.com/package/aqualink)
[![NPM Version](https://img.shields.io/npm/v/aqualink?color=0061ff&label=AquaLink&style=for-the-badge&logo=npm)](https://www.npmjs.com/package/aqualink)
[![GitHub Stars](https://img.shields.io/github/stars/ToddyTheNoobDud/AquaLink?color=00bfff&style=for-the-badge&logo=github)](https://github.com/ToddyTheNoobDud/AquaLink/stargazers)
[![Discord](https://img.shields.io/discord/1346930640049803266?color=7289da&label=Discord&logo=discord&style=for-the-badge)](https://discord.gg/K4CVv84VBC)

[Examples](https://github.com/ToddyTheNoobDud/AquaLink/tree/v4-ts-rewrite/examples) · [Support](https://discord.gg/K4CVv84VBC)

</div>

# AquaLink v4

A Lavalink v4 and NodeLink client for Discord bots, written in TypeScript.
Players, queues and filters work out of the box. When you need different
behavior, replace the parts you want from your bot code. No fork needed.

## Features

- Track loading, searches and playlists, with typed Lavalink and NodeLink payloads.
- Playback controls, queue progression, looping and shuffle.
- Optional lazy queues, replaceable queue storage and playback without a queue.
- Equalizer, bassboost, nightcore, vaporwave, karaoke, 8D and other filter helpers.
- Multiple nodes, load balancing and node reconnection with configurable retries.
- Typed events, raw server events and custom ops for your own handlers.
- Optional session resuming, player persistence and replaceable built-in autoplay.
- ESM and CommonJS exports, TypeScript declarations and a replaceable stdout logger.

REST uses native `fetch`; WebSocket connections use `ws` on both Node.js and Bun.
Your bot owns Discord messages, commands and any extra recovery or recommendation
logic you want to add.

## Installation

Use Node.js **22.19+** or Bun **1.4.4+**, a Lavalink v4 or NodeLink server, and
your preferred Discord library. Your bot needs the Guilds and GuildVoiceStates intents.

| Package manager | Install v4 |
| --- | --- |
| npm | `npm install aqualink@4` |
| Bun | `bun add aqualink@4` |
| pnpm | `pnpm add aqualink@4` |
| Yarn | `yarn add aqualink@4` |

```ts
import { Aqua } from 'aqualink'
```

CommonJS works too: `const { Aqua } = require('aqualink')`.

## Connect your bot

This example uses your existing Seyfert client. Create Aqua once in your bot's
setup file, here called `aqua.ts`:

```ts
import { Aqua } from 'aqualink'

export const aqua = new Aqua(client, [
  {
    name: 'main',
    host: '127.0.0.1',
    port: 2333,
    password: process.env.NODE_PASSWORD!,
    ssl: false
  }
], {
  lazyloadPlayer: true,
  send: async (packet) => {
    const shardId = client.gateway.calculateShardId(packet.d.guild_id)
    await client.gateway.send(shardId, packet)
  }
})

aqua.on('nodeReady', (node) => {
  console.log(`${node.name} is ready`)
})

aqua.on('nodeError', (node, error) => {
  console.error(node.name, error)
})
```

Forward voice packets in `src/events/raw.ts`:

```ts
import { createEvent } from 'seyfert'
import { aqua } from '../../aqua.ts'

export default createEvent({
  data: { name: 'raw' },
  async run(packet) {
    if (packet.t === 'VOICE_STATE_UPDATE' || packet.t === 'VOICE_SERVER_UPDATE') {
      await aqua.updateVoiceState(packet)
    }
  }
})
```

Initialize it in `src/events/botReady.ts`, after Discord supplies the bot ID:

```ts
import { createEvent } from 'seyfert'
import { aqua } from '../../aqua.ts'

export default createEvent({
  data: { name: 'botReady', once: true },
  async run(user) {
    await aqua.init(user.id)
  }
})
```

Use your bot's configured events directory and adjust the `aqua.ts` import to its
location. If you already have these handlers, merge the calls into them.

For another Discord library, provide its gateway sender through `send` and forward
the same two incoming voice packets to `aqua.updateVoiceState()`. Keep the original
`{ t, d }` payload; AquaLink filters voice states by the bot's user ID.

`init(botId)` opens the node connections. Wait for `nodeReady` before creating
players. Node hosts have no URL scheme; set `ssl: true` for HTTPS/WSS.

## Search and play

Inside your command, use the guild ID and the user's voice channel ID:

```ts
const result = await aqua.resolve({
  query: 'artist song',
  source: 'ytsearch',
  requester: { id: userId }
})

if (result.exception) {
  throw new Error(result.exception.message ?? 'Track loading failed')
}

const track = result.tracks[0]
if (track) {
  const player = await aqua.createConnection({
    guildId,
    voiceChannel,
    textChannel
  })
  await player.play(track)
}
```

URLs use the same method. Search sources depend on what's enabled on your node.
For playlists, add `result.tracks` to `player.queue` and call `await player.play()`
when idle. `result.playlistInfo` contains the playlist metadata.

`play(track)` starts immediately when idle, or adds the track behind current
playback. `play()` starts the first waiting track. To replace current while
keeping the queue, use `play(track, { noReplace: false })`.

### Controls and filters

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

Await playback controls, filter updates and destruction. Looping and shuffle
only change local state.

| Operation | Behavior |
| --- | --- |
| `stop()` / `skip()` | Ends current; its `stopped` event advances the queue or autoplay, or emits `queueEnd` |
| `destroy()` | Leaves voice, clears the queue and removes the player |
| Track finishes, fails to load or is stopped | The default handler starts the next waiting track, or tries autoplay when enabled |
| Bot is kicked from voice | Destroys the player and queue; the next explicit connection creates a new player |

`player.current` holds the current track; `player.queue` holds waiting tracks.
With `lazyloadPlayer: true`, waiting storage is created only when needed or when
you read `player.queue`. Reading `player.hasQueue` doesn't allocate anything.
Set `queue: false` to play without waiting storage; see the queue examples below.

`stop()` resolves when the node accepts the stop. Its end event performs
progression and clears `current`. To end playback entirely, disable autoplay,
clear any waiting queue and then call `stop()`:

```ts
player.setAutoplay(false)
if (player.hasQueue) {
  player.queue.clear()
}
await player.stop()
```

## Events

Listen on Aqua for all players, or on a Player for one guild:

```ts
aqua.on('trackStart', (player, track) => {
  console.log(player.guildId, track?.title)
})

player.on('trackEnd', (track, reason) => {
  console.log(track?.title, reason)
})

player.on('event', (payload) => {
  console.log(payload.type)
})

aqua.on('nodeCustomOp', (node, op, payload) => {
  console.log(node.name, op, payload)
})
```

Aqua's track events receive the player first. Raw player events are available
through `event` or their protocol name, such as `player.on('TrackEndEvent', ...)`.
`trackEnd` runs before queue progression; raw events run after the handler.
`nodeEvent` receives server events even without a matching local player.

See [event types](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/src/shared/Events.ts)
for listener arguments and the [custom event example](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/events.ts)
for adding your own behavior.

## Make it yours

The [examples/ guide](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/README.md)
shows how to replace each part from your bot. Start with
[setup.ts](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/setup.ts)
to see the overrides registered together, then copy only the ones you need.

| Example | What you can change |
| --- | --- |
| [Player](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/player.ts) | Add controls, settings or your own playback methods |
| [PlayerEvents](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/events.ts) | Extend built-in handling and add typed custom events |
| [Queue](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/queue.ts) / [QueueLike](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/queue-storage.ts) | Change ordering or supply your own storage |
| [Rest](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/rest.ts) | Add routes for server plugins |
| [Filters](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/filters.ts) | Add presets |
| [Track](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/track.ts) | Add properties and getters |
| [Connection](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/connection.ts) / [Node](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/node.ts) | Extend connection behavior or node reporting |
| [Autoplay](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/autoplay.ts) | Replace the built-in recommendation policy |
| [Logger](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/examples/logger.ts) | Route logs through Seyfert or your own logger |

Register subclasses through `options.structures` before creating their instances.
Call `super` where you want to keep the default behavior. For independent queue
storage, supply a `QueueLike` factory through `options.queue`.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `defaultSearchPlatform` | `'ytsearch'` | Search prefix for plain queries |
| `lazyloadPlayer` | `false` | Create waiting storage on demand |
| `loadBalancer` | `'leastLoad'` | Choose a node by load, or use `'random'` |
| `nodeConfigs.maxRetries` | `10` | Maximum node reconnect attempts |
| `nodeConfigs.infiniteReconnects` | `false` | Keep reconnecting past that limit |
| `autoResume` | `false` | Request session resuming and restore players when the session expires |
| `leaveOnEnd` | `false` | Destroy the player when playback and its waiting queue end |
| `logging.level` | `'info'` | Built-in log threshold; `'silent'` disables it |

Pass `logger` to replace the native stdout logger. Your logger controls its own
levels and output. The funny messages stay either way.

Enable autoplay with `player.setAutoplay(true)`. When the queue ends, it picks
another track using the previous source:

- **YouTube / YouTube Music:** loads a YouTube radio mix.
- **Spotify:** uses `sprec:seed_tracks=...` on NodeLink. On LavaSrc, it tries an
  ISRC mix (or track mix without an ISRC), then `seed_tracks` if the mix is empty.
  Local Spotify entries are matched with `spsearch:` first.
- **SoundCloud:** searches the previous artist with `scsearch:`. This is artist
  discovery, not SoundCloud's related-tracks API.
- **Other sources:** matches artist/title to YouTube before loading a mix.

The previous seed is excluded. Selection uses the player's node and requester,
doesn't create queue storage, and keeps no history. Autoplay is off by default
and doesn't schedule retries.
Failures emit `autoplayFailed`, followed by `queueEnd` if playback stays idle.

Your node needs the matching sources enabled. Spotify support comes from
[NodeLink](https://nodelink.js.org/docs/api#recommendation-prefixes) or
[LavaSrc](https://github.com/topi314/LavaSrc#supported-urls-and-queries);
credentials and recommendation availability are handled there. Spotify's seed
endpoint requires extended quota access or anonymous tokens with LavaSrc.

Supply `options.autoplay(player)` or override `Player.getAutoplayTrack()` to
replace that policy. A custom callback returns a Track or `null`; `null` ends
playback without falling back to the built-in policy.

Persistence is explicit: call `savePlayer(path?)` and `loadPlayers(path?)` when needed.
Session resuming doesn't automatically rejoin Discord after a manual kick.

All options and defaults are documented in the
[TypeScript types](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/src/types/shared.ts).

## REST and server APIs

Use `player.node.rest` or `aqua.getNode(name)?.rest` for direct requests.
Helpers cover player/session updates, track loading and decoding, routeplanner,
lyrics, mixers and other NodeLink endpoints. Availability depends on your server
and its plugins.

`makeRequest<T>(path, method?, body?)` reads JSON or text, returns `null` for 204,
and logs request failures before returning `undefined`. `request()` returns an
unread `Response` and rejects on failure. Consume or cancel streaming bodies.

Protocol references: [Lavalink REST](https://lavalink.dev/api/rest),
[Lavalink WebSocket](https://lavalink.dev/api/websocket) and
[NodeLink REST](https://nodelink.js.org/docs/api/rest).

## Moving from v3

Many familiar names remain: `Aqua`, `createConnection`, `resolve`, players,
queues and filter helpers. Update these parts when moving an existing bot:

- Supply `options.send` for your Discord library and forward both voice events.
- Await player creation, playback, controls, filter updates and destruction.
- Look up players with `aqua.players.get(guildId)` and keep current on `player.current`.
- `stop()` and `skip()` both advance through the server's `stopped` event.
- Replace the old Plugin registry with structure overrides from your bot.
- Built-in autoplay is optional and replaceable. Handle Discord messages in your bot.

HTTP/2 settings, debug trace storage and automatic node failover are no longer
part of the client. The [examples](https://github.com/ToddyTheNoobDud/AquaLink/tree/v4-ts-rewrite/examples)
show the v4 extension points.

## Support

Need help or found a bug? Join the [Discord server](https://discord.gg/K4CVv84VBC)
or [open an issue](https://github.com/ToddyTheNoobDud/AquaLink/issues).

## License

[WTFPL](https://github.com/ToddyTheNoobDud/AquaLink/blob/v4-ts-rewrite/LICENSE.md).
