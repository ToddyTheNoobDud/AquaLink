import { Aqua, type AquaOptions, type NodeOptions } from '../src/index.ts'
import { BotConnection } from './connection.ts'
import { BotEvents } from './events.ts'
import { BotFilters } from './filters.ts'
import { BotNode } from './node.ts'
import { BotPlayer } from './player.ts'
import { NextUpQueue } from './queue.ts'
import { BotRest } from './rest.ts'
import { BotTrack } from './track.ts'

// Register only the overrides you want. Omitted structures keep their defaults.
// Construction doesn't open sockets; call init(botId) from your bot's ready hook.
export function createExampleAqua(
  client: unknown,
  nodes: NodeOptions[],
  send: NonNullable<AquaOptions['send']>
) {
  return new Aqua(client, nodes, {
    send,
    lazyloadPlayer: true,
    structures: {
      Node: BotNode,
      Rest: BotRest,
      Player: BotPlayer,
      Queue: NextUpQueue,
      Connection: BotConnection,
      PlayerEvents: BotEvents,
      Filters: BotFilters,
      Track: BotTrack
    }
  })
}
