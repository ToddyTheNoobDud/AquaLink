# Examples

Start with [setup.ts](setup.ts). It registers all eight structure overrides in
one Aqua instance. Keep the overrides you need; the rest can use their defaults.
Importing these files doesn't open sockets or start a bot.

The files use `../src/index.ts` so they can run inside this checkout. When copying
them into a bot installed from npm, replace that import with `'aqualink'` and keep
imports between copied example files relative. In `events.ts`, also change
`declare module '../src/shared/Events.ts'` to `declare module 'aqualink'`.
You don't need to clone or edit the library to use these overrides.

Gateway setup and voice forwarding are covered in the
[main README](../README.md#connect-your-bot). Your bot supplies its Discord client,
node list and gateway sender; the examples don't start those for you.

## Pick a starting point

| File | What it changes |
| --- | --- |
| [player.ts](player.ts) | Adds a `maxVolume` setting and a `playNow()` method |
| [events.ts](events.ts) | Extends a built-in handler and emits a typed custom event |
| [queue.ts](queue.ts) | Makes new batches go to the front of the waiting queue |
| [queue-storage.ts](queue-storage.ts) | Implements `QueueLike` without inheriting Queue |
| [rest.ts](rest.ts) | Adds a typed route for a server plugin |
| [filters.ts](filters.ts) | Adds an equalizer preset |
| [track.ts](track.ts) | Adds a computed display title |
| [connection.ts](connection.ts) | Runs extra work after the normal voice handshake |
| [node.ts](node.ts) | Counts reported errors while keeping the default error events |
| [autoplay.ts](autoplay.ts) | Replaces built-in autoplay with an artist-search policy |
| [logger.ts](logger.ts) | Sends AquaLink logs through your Seyfert logger |

## Register an override

You can use one class on its own. In your bot's setup, with its client, node list
and voice adapter already defined:

```ts
import { Aqua } from '../src/index.ts'
import { BotPlayer } from './player.ts'

const aqua = new Aqua(client, nodes, {
  send: sendVoicePacket,
  structures: { Player: BotPlayer }
})
```

Set structures before their instances are created. Changing the option doesn't
convert an existing player, node or track into your subclass.

The factory methods still return the base types. Narrow them to use added methods:

```ts
import { BotFilters } from './filters.ts'
import { BotPlayer } from './player.ts'
import { BotRest } from './rest.ts'
import { BotTrack } from './track.ts'

if (player instanceof BotPlayer) {
  player.maxVolume = 80
  await player.playNow(track)
}

const filters = player.filters
if (filters instanceof BotFilters) {
  await filters.setBassCut(true)
}

const rest = player.node.rest
if (rest instanceof BotRest) {
  const status = await rest.getPluginStatus()
  console.log(status?.enabled)
}

if (track instanceof BotTrack) {
  console.log(track.displayTitle)
}
```

`maxVolume` limits calls to this subclass's `setVolume()`. It doesn't rewrite the
initial volume or raw REST updates. `playNow()` replaces current and preserves
waiting tracks. `BotTrack.displayTitle` is computed and isn't added to saved JSON.

## Add an event

`BotEvents.trackStart()` calls `super` to keep the normal state changes and
listeners. Its `handleCustomEvent()` handles this example server/plugin message:

```json
{
  "op": "event",
  "type": "AnnouncementEvent",
  "guildId": "123456789012345678",
  "message": "An announcement from my plugin"
}
```

`AnnouncementEvent` and `/v4/example-plugin/status` are demonstration names. Your
server needs to implement them, or you can replace them with its actual API.

Register player listeners once, before playback:

```ts
aqua.on('playerCreate', (player) => {
  player.on('announcement', (message) => {
    console.log(message.toUpperCase())
  })

  player.on('event', (payload) => {
    console.log(payload.type)
  })
})

aqua.on('nodeCustomOp', (node, op) => {
  console.log(node.name, op)
})
```

The declaration in `events.ts` gives `announcement` its string argument type.
The handler checks the unknown server field before emitting it. AquaLink also
emits the original event as `event` and by its protocol name after handling it.

If you replace `trackEnd()` without calling `super`, your handler takes over its
state changes, queue progression and loop/autoplay behavior. Override the
individual handlers to keep the normal routing and raw event emission.

## Replace queue storage

`structures.Queue` takes a Queue subclass. To use an unrelated implementation,
pass a `QueueLike` instance or factory through `queue`:

```ts
import { BotQueue } from './queue-storage.ts'

// Do this before creating players. Each call returns separate guild storage.
aqua.options.queue = () => new BotQueue()
```

This factory supplies storage in place of `structures.Queue`. `BotQueue` implements
only the required methods, so `player.shuffle()` does nothing for it. Add a
`shuffle()` method if your storage should support that operation.

Queue methods are synchronous. A database-backed queue needs a local adapter;
returning promises from `at()` or `dequeue()` won't work. `toArray()` should return
a snapshot, and `clear()` should release references without disposing shared tracks.

The setup example enables lazy queues. Reading `player.queue` creates one;
`player.current` and `player.hasQueue` don't. To disable waiting storage entirely:

```ts
const player = await aqua.createConnection({
  guildId,
  voiceChannel,
  queue: false
})

await player.play(track)
```

With the queue disabled, `player.queue` throws. Explicit tracks replace current
unless you pass `noReplace: true`.

## Add an autoplay policy

Autoplay works without a callback: `player.setAutoplay(true)` enables the built-in
policy in `src/player/autoplay.ts`. It uses Spotify recommendations, SoundCloud
artist searches, or YouTube radio mixes, depending on the previous track.
To use your own policy instead:

```ts
import { artistAutoplay } from './autoplay.ts'

aqua.options.autoplay = artistAutoplay
player.setAutoplay(true)
```

This example searches for another track by the previous artist and returns
`null` when none is found. You can replace that search with your own service.
It doesn't keep a listening history or promise a different track on every call.
Your callback fully replaces the built-in policy; returning `null` ends playback.
You can also override `getAutoplayTrack()` in your Player subclass. SoundCloud's
default searches an artist; replace it if you want a related-tracks service.

Spotify queries and URLs go straight to your node, including advanced searches,
seed parameters, and LavaSrc's artist/track/album/ISRC mixes. For example, a custom
policy can resolve its own mix and pick a track from `result.tracks`:

```ts
const result = await aqua.resolve({
  query: 'sprec:mix:artist:0gxyHStUsqpMadRV0Di1Qt',
  requester: player.previous?.requester,
  nodes: player.node
})
```

These query formats depend on your node and plugins. See
[LavaSrc's supported queries](https://github.com/topi314/LavaSrc#supported-urls-and-queries)
and [NodeLink's prefixes](https://nodelink.js.org/docs/api#recommendation-prefixes).
No Spotify credentials belong in AquaLink.

## Use your bot's logger

`options.logger` replaces the built-in logger. You can pass Seyfert's
`client.logger` directly. The adapter in [logger.ts](logger.ts) also adds an
`[AquaLink]` prefix and puts the message before its fields:

```ts
import { createSeyfertLogger } from './logger.ts'
import { createExampleAqua } from './setup.ts'

const aqua = createExampleAqua(
  client,
  nodes,
  sendVoicePacket,
  createSeyfertLogger(client.logger)
)
```

The fourth setup argument is optional. Leave it out to keep the native logger.
For your own Aqua instance, pass the adapter as `options.logger` instead.

Both `logger.info('message')` and `logger.error({ err, node }, 'message')` work.
Fields stay as objects, including Error instances. The adapter calls methods on
the original logger, so their `this` binding stays intact.

Seyfert controls filtering and output here. AquaLink's `logging.level` only
applies to the built-in logger; it doesn't filter or duplicate your custom logs.
The adapter doesn't install Seyfert, start the bot or modify library code.

## Check the examples

From the repository root:

```sh
bun run typecheck
```

The examples are part of that check. Running a file directly only loads its
exports. To hear audio, wire it into your bot, forward the gateway packets and
wait for `nodeReady` before creating a player.

Keep `super` calls where you want the base behavior. If your subclass owns timers,
listeners on external objects or connections, release them in its cleanup too.
