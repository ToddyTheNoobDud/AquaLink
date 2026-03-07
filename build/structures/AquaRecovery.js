const fs = require('node:fs')
const readline = require('node:readline')
const { AqualinkEvents } = require('./AqualinkEvents')
const { reportSuppressedError } = require('./Reporting')

class AquaRecovery {
  constructor(aqua, deps) {
    this.aqua = aqua
    this._functions = deps._functions
    this.MAX_CONCURRENT_OPS = deps.MAX_CONCURRENT_OPS
    this.BROKEN_PLAYER_TTL = deps.BROKEN_PLAYER_TTL
    this.FAILOVER_CLEANUP_TTL = deps.FAILOVER_CLEANUP_TTL
    this.MAX_FAILOVER_QUEUE = deps.MAX_FAILOVER_QUEUE
    this.MAX_REBUILD_LOCKS = deps.MAX_REBUILD_LOCKS
    this.PLAYER_BATCH_SIZE = deps.PLAYER_BATCH_SIZE
    this.RECONNECT_DELAY = deps.RECONNECT_DELAY
    this.NODE_TIMEOUT = deps.NODE_TIMEOUT
    this.EMPTY_ARRAY = deps.EMPTY_ARRAY
  }

  _stateFor(id) {
    return (
      this.aqua._failoverState[id] ||
      (this.aqua._failoverState[id] = {
        connected: false,
        failoverInProgress: false,
        attempts: 0,
        lastAttempt: 0
      })
    )
  }

  _deleteState(id) {
    delete this.aqua._failoverState[id]
  }

  withGuildLifecycleLock(guildId, scope, fn) {
    const id = String(guildId)
    const previous = this.aqua._guildLifecycleLocks.get(id) || Promise.resolve()
    const run = previous
      .catch(() => {})
      .then(async () => {
        this.aqua._trace?.('guild.lock.acquire', { guildId: id, scope })
        try {
          return await fn()
        } finally {
          this.aqua._trace?.('guild.lock.release', { guildId: id, scope })
        }
      })

    const tail = run.finally(() => {
      if (this.aqua._guildLifecycleLocks.get(id) === tail) {
        this.aqua._guildLifecycleLocks.delete(id)
      }
    })

    this.aqua._guildLifecycleLocks.set(id, tail)
    return run
  }

  storeBrokenPlayers(node) {
    const id = node.name || node.host
    const now = Date.now()
    for (const player of this.aqua.players.values()) {
      if (player.nodes !== node) continue
      const state = this.capturePlayerState(player)
      if (state) {
        state.originalNodeId = id
        state.brokenAt = now
        this.aqua._brokenPlayers.set(String(player.guildId), state)
      }
    }
  }

  async rebuildBrokenPlayers(node) {
    const id = node.name || node.host
    const rebuilds = []
    const now = Date.now()
    for (const [guildId, state] of this.aqua._brokenPlayers) {
      if (
        state.originalNodeId === id &&
        now - state.brokenAt < this.BROKEN_PLAYER_TTL
      ) {
        rebuilds.push({ guildId, state })
      }
    }
    if (!rebuilds.length) return
    const successes = []
    for (let i = 0; i < rebuilds.length; i += this.MAX_CONCURRENT_OPS) {
      const batch = rebuilds.slice(i, i + this.MAX_CONCURRENT_OPS)
      const results = await Promise.allSettled(
        batch.map(({ guildId, state }) =>
          this.rebuildPlayer(state, node).then(() => guildId)
        )
      )
      for (const result of results) {
        if (result.status === 'fulfilled') successes.push(result.value)
      }
    }
    for (const guildId of successes) this.aqua._brokenPlayers.delete(guildId)
    if (successes.length)
      this.aqua.emit(AqualinkEvents.PlayersRebuilt, node, successes.length)
    this.performCleanup()
  }

  async rebuildPlayer(state, targetNode) {
    const {
      guildId,
      textChannel,
      voiceChannel,
      current,
      volume = 65,
      deaf = true
    } = state
    return this.withGuildLifecycleLock(guildId, 'rebuild', async () => {
      const lockKey = `rebuild_${guildId}`
      if (this.aqua._rebuildLocks.has(lockKey)) return
      this.aqua._rebuildLocks.add(lockKey)
      try {
        if (this.aqua.players.has(guildId)) {
          await this.aqua.destroyPlayer(guildId)
          await this._functions.delay(this.RECONNECT_DELAY)
        }
        const player = this.aqua.createPlayer(targetNode, {
          guildId,
          textChannel,
          voiceChannel,
          defaultVolume: volume,
          deaf
        })
        if (current && player?.queue?.add) {
          player.queue.add(current)
          await player.play()
          this.seekAfterTrackStart(player, guildId, state.position, 50)
          if (state.paused) player.pause(true)
        }
        return player
      } finally {
        this.aqua._rebuildLocks.delete(lockKey)
      }
    })
  }

  async handleNodeFailover(failedNode) {
    if (!this.aqua.failoverOptions.enabled) return
    const id = failedNode.name || failedNode.host
    const now = Date.now()
    const state = this._stateFor(id)
    if (state.failoverInProgress) return
    if (
      state.lastAttempt &&
      now - state.lastAttempt < this.aqua.failoverOptions.cooldownTime
    )
      return
    if (state.attempts >= this.aqua.failoverOptions.maxFailoverAttempts) return

    state.connected = false
    state.failoverInProgress = true
    state.lastAttempt = now
    state.attempts++

    try {
      this.aqua.emit(AqualinkEvents.NodeFailover, failedNode)
      const players = Array.from(failedNode.players || [])
      if (!players.length) return
      const available = []
      for (const node of this.aqua.nodeMap.values()) {
        if (node !== failedNode && node.connected) available.push(node)
      }
      if (!available.length) throw new Error('No failover nodes')
      const results = await this.migratePlayersOptimized(players, available)
      const successful = results.filter((r) => r.success).length
      if (successful) {
        this.aqua.emit(
          AqualinkEvents.NodeFailoverComplete,
          failedNode,
          successful,
          results.length - successful
        )
        this.performCleanup()
      }
    } catch (error) {
      this.aqua.emit(AqualinkEvents.Error, null, error)
    } finally {
      state.failoverInProgress = false
    }
  }

  async migratePlayersOptimized(players, nodes) {
    const loads = nodes.map((node) => this.aqua._getNodeLoad(node))
    const counts = new Array(nodes.length).fill(0)
    const pickNode = () => {
      let bestIndex = 0
      let bestScore = loads[0] + counts[0]
      for (let i = 1; i < nodes.length; i++) {
        const score = loads[i] + counts[i]
        if (score < bestScore) {
          bestIndex = i
          bestScore = score
        }
      }
      counts[bestIndex]++
      return nodes[bestIndex]
    }
    const results = []
    for (let i = 0; i < players.length; i += this.MAX_CONCURRENT_OPS) {
      const batch = players.slice(i, i + this.MAX_CONCURRENT_OPS)
      const batchResults = await Promise.allSettled(
        batch.map((player) => this.migratePlayer(player, pickNode))
      )
      for (const result of batchResults) {
        results.push({
          success: result.status === 'fulfilled',
          error: result.reason
        })
      }
    }
    return results
  }

  async migratePlayer(player, pickNode) {
    const guildId = String(player?.guildId)
    return this.withGuildLifecycleLock(guildId, 'failover-migrate', async () => {
      const state = this.capturePlayerState(player)
      if (!state) throw new Error('Failed to capture state')
      const { maxRetries, retryDelay } = this.aqua.failoverOptions
      for (let retry = 0; retry < maxRetries; retry++) {
        try {
          const targetNode = pickNode()
          const newPlayer = this.createPlayerOnNode(targetNode, state)
          await this.restorePlayerState(newPlayer, state)
          this.aqua.emit(
            AqualinkEvents.PlayerMigrated,
            player,
            newPlayer,
            targetNode
          )
          return newPlayer
        } catch (error) {
          if (retry === maxRetries - 1) throw error
          await this._functions.delay(retryDelay * 1.5 ** retry)
        }
      }
    })
  }

  regionMatches(configuredRegion, extractedRegion) {
    if (!configuredRegion || !extractedRegion) return false
    const configured = String(configuredRegion).trim().toLowerCase()
    const extracted = String(extractedRegion).trim().toLowerCase()
    if (!configured || !extracted) return false
    return configured === extracted
  }

  findBestNodeForRegion(region) {
    if (!region) return null
    const candidates = []
    for (const node of this.aqua.nodeMap.values()) {
      if (!node?.connected) continue
      const regions = Array.isArray(node.regions) ? node.regions : []
      if (regions.some((r) => this.regionMatches(r, region))) {
        candidates.push(node)
      }
    }
    if (!candidates.length) return null
    return this.aqua._chooseLeastBusyNode(candidates)
  }

  async movePlayerToNode(guildId, targetNode, reason = 'region') {
    const id = String(guildId)
    return this.withGuildLifecycleLock(id, `move:${reason}`, async () => {
      const player = this.aqua.players.get(id)
      if (!player || player.destroyed) throw new Error(`Player not found: ${id}`)
      if (!targetNode?.connected) throw new Error('Target node is not connected')
      if (player.nodes === targetNode || player.nodes?.name === targetNode.name)
        return player

      const state = this.capturePlayerState(player)
      if (!state) throw new Error(`Failed to capture state for ${id}`)
      const oldPlayer = player
      const oldNode = oldPlayer.nodes
      const oldMessage = oldPlayer.nowPlayingMessage || null
      const oldConn = oldPlayer.connection
      const oldVoice = oldConn
        ? {
            sessionId: oldConn.sessionId || null,
            endpoint: oldConn.endpoint || null,
            token: oldConn.token || null,
            region: oldConn.region || null,
            channelId: oldConn.channelId || null
          }
        : null

      oldPlayer.destroy({
        preserveClient: true,
        skipRemote: true,
        preserveMessage: true,
        preserveTracks: true,
        preserveReconnecting: true
      })

      const newPlayer = this.aqua.createPlayer(targetNode, {
        guildId: state.guildId,
        textChannel: state.textChannel,
        voiceChannel: state.voiceChannel,
        defaultVolume: state.volume || 100,
        deaf: state.deaf || false,
        mute: oldPlayer.mute || false,
        resuming: true,
        preserveMessage: true
      })

      if (oldVoice && newPlayer.connection) {
        if (oldVoice.sessionId) newPlayer.connection.sessionId = oldVoice.sessionId
        if (oldVoice.endpoint) newPlayer.connection.endpoint = oldVoice.endpoint
        if (oldVoice.token) newPlayer.connection.token = oldVoice.token
        if (oldVoice.region) newPlayer.connection.region = oldVoice.region
        if (oldVoice.channelId) newPlayer.connection.channelId = oldVoice.channelId
        newPlayer.connection._lastVoiceDataUpdate = Date.now()
        newPlayer.connection.resendVoiceUpdate(true)
        this.aqua._trace('player.migrate.voiceBootstrap', {
          guildId: id,
          from: oldNode?.name || oldNode?.host,
          to: targetNode?.name || targetNode?.host,
          hasSessionId: !!newPlayer.connection.sessionId,
          hasEndpoint: !!newPlayer.connection.endpoint,
          hasToken: !!newPlayer.connection.token
        })
      }

      await this.restorePlayerState(newPlayer, state)
      if (oldMessage) newPlayer.nowPlayingMessage = oldMessage

      this.aqua._trace('player.migrated', {
        guildId: id,
        reason,
        from: oldNode?.name || oldNode?.host,
        to: targetNode?.name || targetNode?.host,
        region:
          newPlayer?.connection?.region || oldPlayer?.connection?.region || null
      })
      this.aqua.emit(
        AqualinkEvents.PlayerMigrated,
        oldPlayer,
        newPlayer,
        targetNode
      )
      return newPlayer
    })
  }

  capturePlayerState(player) {
    if (!player) return null
    let position = player.position || 0
    if (player.playing && !player.paused && player.timestamp) {
      const elapsed = Date.now() - player.timestamp
      position = Math.min(
        position + elapsed,
        player.current?.info?.length || position + elapsed
      )
    }
    return {
      guildId: player.guildId,
      textChannel: player.textChannel,
      voiceChannel: player.voiceChannel,
      volume: player.volume ?? 100,
      paused: !!player.paused,
      position,
      current: player.current || null,
      queue: player.queue?.toArray?.() || this.EMPTY_ARRAY,
      loop: player.loop,
      shuffle: player.shuffle,
      deaf: player.deaf ?? false,
      connected: !!player.connected
    }
  }

  createPlayerOnNode(targetNode, state) {
    return this.aqua.createPlayer(targetNode, {
      guildId: state.guildId,
      textChannel: state.textChannel,
      voiceChannel: state.voiceChannel,
      defaultVolume: state.volume || 100,
      deaf: state.deaf || false
    })
  }

  seekAfterTrackStart(player, guildId, position, delay = 50) {
    if (!player || !guildId || !(position > 0)) return
    const seekOnce = (startedPlayer) => {
      if (startedPlayer.guildId !== guildId) return
      this._functions.unrefTimeout(() => player.seek?.(position), delay)
    }
    this.aqua.once(AqualinkEvents.TrackStart, seekOnce)
    player.once('destroy', () => this.aqua.off(AqualinkEvents.TrackStart, seekOnce))
  }

  async restorePlayerState(newPlayer, state) {
    const ops = []
    if (typeof state.volume === 'number') {
      if (typeof newPlayer.setVolume === 'function')
        ops.push(newPlayer.setVolume(state.volume))
      else newPlayer.volume = state.volume
    }
    if (state.queue?.length && newPlayer.queue?.add) newPlayer.queue.add(...state.queue)
    if (state.current && this.aqua.failoverOptions.preservePosition) {
      if (this.aqua.failoverOptions.resumePlayback) {
        ops.push(newPlayer.play(state.current))
        this.seekAfterTrackStart(newPlayer, newPlayer.guildId, state.position, 50)
        if (state.paused) ops.push(newPlayer.pause(true))
      } else if (newPlayer.queue?.add) {
        newPlayer.queue.add(state.current)
      }
    }
    newPlayer.loop = state.loop
    newPlayer.shuffle = state.shuffle
    await Promise.allSettled(ops)
  }

  async loadPlayers(filePath = './AquaPlayers.jsonl') {
    if (this.aqua._loading) return
    this.aqua._loading = true
    const lockFile = `${filePath}.lock`
    let stream = null,
      rl = null
    try {
      await fs.promises.access(filePath)
      await fs.promises.writeFile(lockFile, String(process.pid), { flag: 'wx' })
      await this.waitForFirstNode()

      stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

      const batch = []
      const failed = []
      let nodeSessions = null
      const flushBatch = async () => {
        if (!batch.length) return
        const entries = batch.splice(0, batch.length)
        const results = await Promise.all(entries.map((p) => this.restorePlayer(p)))
        for (let i = 0; i < results.length; i++) {
          if (!results[i]) failed.push(entries[i])
        }
      }
      for await (const line of rl) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'node_sessions') {
            nodeSessions = parsed
            continue
          }
          batch.push(parsed)
        } catch {
          continue
        }
        if (batch.length >= this.PLAYER_BATCH_SIZE) await flushBatch()
      }
      await flushBatch()

      const lines = []
      if (nodeSessions) lines.push(JSON.stringify(nodeSessions))
      for (const entry of failed) lines.push(JSON.stringify(entry))
      await fs.promises.writeFile(filePath, lines.length ? `${lines.join('\n')}\n` : '')
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`[Aqua/Autoresume]Error loading players:`, error)
        this.aqua.emit(AqualinkEvents.Error, null, error)
      }
    } finally {
      this.aqua._loading = false
      if (rl) this._functions.safeCall(() => rl.close())
      if (stream) this._functions.safeCall(() => stream.destroy())
      await fs.promises.unlink(lockFile).catch(this._functions.noop)
    }
  }

  async restorePlayer(p) {
    const gId = String(p.g)
    return this.withGuildLifecycleLock(gId, 'restore', async () => {
      try {
        const existing = this.aqua.players.get(gId)
        if (existing?.playing) return true

        const player =
          existing ||
          this.aqua.createPlayer(
            this.aqua._chooseLeastBusyNode(this.aqua.leastUsedNodes),
            {
              guildId: gId,
              textChannel: p.t,
              voiceChannel: p.v,
              defaultVolume: p.vol || 65,
              deaf: true,
              resuming: !!p.resuming
            }
          )
        player._resuming = !!p.resuming
        const requester = this._functions.parseRequester(p.r)
        const tracksToResolve = [p.u, ...(p.q || [])]
          .filter(Boolean)
          .slice(0, this.aqua.maxTracksRestore)
        const resolved = await Promise.all(
          tracksToResolve.map((uri) =>
            this.aqua.resolve({ query: uri, requester }).catch(() => null)
          )
        )
        const validTracks = resolved.flatMap((result) => result?.tracks || [])
        if (validTracks.length && player.queue?.add) {
          player.queue.add(...validTracks)
        }
        if (p.u && validTracks[0]) {
          if (p.vol != null) {
            if (typeof player.setVolume === 'function') await player.setVolume(p.vol)
            else player.volume = p.vol
          }

          this.seekAfterTrackStart(player, gId, p.p, 100)
          await player.play(undefined, { startTime: p.p, paused: p.pa })
        }
        if (p.nw && p.t) {
          const channel = this.aqua.client.channels?.cache?.get?.(p.t)
          if (channel?.messages?.fetch) {
            player.nowPlayingMessage = await channel.messages
              .fetch(p.nw)
              .catch(() => null)
          } else if (this.aqua.client.messages?.fetch) {
            player.nowPlayingMessage = await this.aqua.client.messages
              .fetch(p.nw, p.t)
              .catch(() => null)
          }
          this.aqua._trace('player.nowPlaying.restore', {
            guildId: gId,
            messageId: p.nw,
            restored: !!player.nowPlayingMessage
          })
        }
        return true
      } catch (error) {
        console.error(
          `[Aqua/Autoresume]Failed to restore player for guild: ${p.g}`,
          error
        )
        return false
      }
    })
  }

  async waitForFirstNode(timeout = this.NODE_TIMEOUT) {
    if (this.aqua.leastUsedNodes.length) return
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.aqua.off(AqualinkEvents.NodeConnect, onReady)
        this.aqua.off(AqualinkEvents.NodeCreate, onReady)
      }
      const onReady = () => {
        if (this.aqua.leastUsedNodes.length) {
          cleanup()
          resolve()
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Timeout waiting for first node'))
      }, timeout)
      timer.unref?.()
      this.aqua.on(AqualinkEvents.NodeConnect, onReady)
      this.aqua.on(AqualinkEvents.NodeCreate, onReady)
      onReady()
    })
  }

  performCleanup() {
    const now = Date.now()
    for (const [guildId, state] of this.aqua._brokenPlayers) {
      if (now - state.brokenAt > this.BROKEN_PLAYER_TTL) {
        this.aqua._brokenPlayers.delete(guildId)
      }
    }

    const ids = Object.keys(this.aqua._failoverState)
    if (ids.length > this.MAX_FAILOVER_QUEUE) {
      this.aqua._failoverState = Object.create(null)
    } else {
      for (const id of ids) {
        const state = this.aqua._failoverState[id]
        if (!this.aqua.nodeMap.has(id)) {
          this._deleteState(id)
          continue
        }
        if (
          state.lastAttempt &&
          now - state.lastAttempt > this.FAILOVER_CLEANUP_TTL
        ) {
          state.lastAttempt = 0
          state.attempts = 0
        }
      }
    }

    if (this.aqua._rebuildLocks.size > this.MAX_REBUILD_LOCKS) {
      this.aqua._rebuildLocks.clear()
    }
  }

  async loadNodeSessions(filePath = './AquaPlayers.jsonl') {
    let stream = null,
      rl = null
    try {
      await fs.promises.access(filePath)
      stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

      for await (const line of rl) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'node_sessions') {
            for (const [name, sessionId] of Object.entries(parsed.data)) {
              const nodeOptions = this.aqua.nodes.find((n) => (n.name || n.host) === name)
              if (nodeOptions) nodeOptions.sessionId = sessionId
            }
            break
          }
        } catch {}
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        reportSuppressedError(this.aqua, 'aqua.loadNodeSessions', error)
      }
    } finally {
      if (rl) this._functions.safeCall(() => rl.close())
      if (stream) this._functions.safeCall(() => stream.destroy())
    }
  }
}

module.exports = AquaRecovery
