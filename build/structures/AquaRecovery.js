const fs = require('node:fs')
const path = require('node:path')
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
    this._trackResolveActive = 0
    this._trackResolveQueue = []
    this._brokenSnapshotNodes = new Set()
    this._brokenSnapshotWrites = new Map()
  }

  _stateFor(id) {
    const existing = this.aqua._failoverState[id]
    if (existing) return existing

    const created = {
      connected: false,
      failoverInProgress: false,
      attempts: 0,
      lastAttempt: 0
    }
    this.aqua._failoverState[id] = created
    return created
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
        if (this.aqua?.debugTrace) {
          this.aqua._trace('guild.lock.acquire', { guildId: id, scope })
        }
        try {
          return await fn()
        } finally {
          if (this.aqua?.debugTrace) {
            this.aqua._trace('guild.lock.release', { guildId: id, scope })
          }
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
    const records = []
    for (const player of this.aqua.players.values()) {
      if (player.nodes !== node) continue
      const record = this._serializeBrokenPlayer(player, id, now)
      if (!record) continue
      this.aqua._brokenPlayers.set(String(player.guildId), {
        originalNodeId: id,
        brokenAt: now
      })
      records.push(record)
    }
    return this._writeBrokenPlayerSnapshot(id, records)
  }

  async rebuildBrokenPlayers(node) {
    const id = node.name || node.host
    const rebuildGuilds = new Set()
    const now = Date.now()
    for (const [guildId, state] of this.aqua._brokenPlayers) {
      if (
        state.originalNodeId === id &&
        now - state.brokenAt < this.BROKEN_PLAYER_TTL
      ) {
        rebuildGuilds.add(guildId)
      }
    }
    if (!rebuildGuilds.size) {
      await this._deleteBrokenPlayerSnapshot(id)
      return
    }
    const pendingWrite = this._brokenSnapshotWrites.get(id)
    if (pendingWrite) await pendingWrite.catch(this._functions.noop)
    const rebuilds = await this._readBrokenPlayerSnapshot(id, rebuildGuilds)
    if (!rebuilds.length) return
    const successes = []
    const failed = []
    for (let i = 0; i < rebuilds.length; i += this.MAX_CONCURRENT_OPS) {
      const batch = rebuilds.slice(i, i + this.MAX_CONCURRENT_OPS)
      const results = await Promise.allSettled(
        batch.map((state) =>
          this.restorePlayer(state, node).then((ok) => ({
            ok,
            guildId: state.g
          }))
        )
      )
      for (let j = 0; j < results.length; j++) {
        const result = results[j]
        const state = batch[j]
        if (result.status === 'fulfilled' && result.value?.ok) {
          successes.push(result.value.guildId)
        } else {
          failed.push(state)
        }
      }
    }
    for (const guildId of successes) this.aqua._brokenPlayers.delete(guildId)
    for (const state of failed) {
      this.aqua._brokenPlayers.set(String(state.g), {
        originalNodeId: id,
        brokenAt: state.brokenAt || now
      })
    }
    await this._writeBrokenPlayerSnapshot(id, failed)
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
    const id = String(guildId)
    return this.withGuildLifecycleLock(id, 'rebuild', async () => {
      const lockKey = `rebuild_${id}`
      if (this.aqua._rebuildLocks.has(lockKey)) return
      this.aqua._rebuildLocks.add(lockKey)
      try {
        if (this.aqua.players.has(id)) {
          await this.aqua.destroyPlayer(id)
          await this._functions.delay(this.RECONNECT_DELAY)
        }
        const player = this.aqua.createPlayer(targetNode, {
          guildId: id,
          textChannel,
          voiceChannel,
          defaultVolume: volume,
          deaf,
          mute: !!state.mute,
          resuming: true
        })
        if (current && player?.queue?.add) {
          player.queue.add(current)
          await player.play()
          this.seekAfterTrackStart(player, id, state.position, 50)
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
    return this.withGuildLifecycleLock(
      guildId,
      'failover-migrate',
      async () => {
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
      }
    )
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
      if (!player || player.destroyed)
        throw new Error(`Player not found: ${id}`)
      if (!targetNode?.connected)
        throw new Error('Target node is not connected')
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
        mute: state.mute || false,
        resuming: true,
        preserveMessage: true
      })

      if (
        this._applyVoiceBootstrap(newPlayer, {
          sid: oldVoice?.sessionId,
          ep: oldVoice?.endpoint,
          tok: oldVoice?.token,
          reg: oldVoice?.region,
          cid: oldVoice?.channelId
        })
      ) {
        if (this.aqua.debugTrace) {
          this.aqua._trace('player.migrate.voiceBootstrap', {
            guildId: id,
            from: oldNode?.name || oldNode?.host,
            to: targetNode?.name || targetNode?.host,
            hasSessionId: !!newPlayer.connection.sessionId,
            hasEndpoint: !!newPlayer.connection.endpoint,
            hasToken: !!newPlayer.connection.token
          })
        }
      }

      await this.restorePlayerState(newPlayer, state)
      if (oldMessage) newPlayer.nowPlayingMessage = oldMessage

      if (this.aqua.debugTrace) {
        this.aqua._trace('player.migrated', {
          guildId: id,
          reason,
          from: oldNode?.name || oldNode?.host,
          to: targetNode?.name || targetNode?.host,
          region:
            newPlayer?.connection?.region ||
            oldPlayer?.connection?.region ||
            null
        })
      }
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
      mute: !!player.mute,
      connected: !!player.connected
    }
  }

  createPlayerOnNode(targetNode, state) {
    return this.aqua.createPlayer(targetNode, {
      guildId: state.guildId,
      textChannel: state.textChannel,
      voiceChannel: state.voiceChannel,
      defaultVolume: state.volume || 100,
      deaf: state.deaf || false,
      mute: !!state.mute,
      resuming: true
    })
  }

  seekAfterTrackStart(player, guildId, position, delay = 50) {
    if (!player || !guildId || !(position > 0)) return
    const seekOnce = (startedPlayer) => {
      if (startedPlayer.guildId !== guildId) return
      this._functions.unrefTimeout(() => player.seek?.(position), delay)
    }
    this.aqua.once(AqualinkEvents.TrackStart, seekOnce)
    player.once('destroy', () =>
      this.aqua.off(AqualinkEvents.TrackStart, seekOnce)
    )
  }

  async restorePlayerState(newPlayer, state) {
    const ops = []
    if (typeof state.volume === 'number') {
      if (typeof newPlayer.setVolume === 'function')
        ops.push(newPlayer.setVolume(state.volume))
      else newPlayer.volume = state.volume
    }
    if (state.queue?.length && newPlayer.queue?.add)
      newPlayer.queue.add(...state.queue)
    if (state.current && this.aqua.failoverOptions.preservePosition) {
      if (this.aqua.failoverOptions.resumePlayback) {
        ops.push(newPlayer.play(state.current))
        this.seekAfterTrackStart(
          newPlayer,
          newPlayer.guildId,
          state.position,
          50
        )
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
        const results = await Promise.allSettled(
          entries.map((p) => this.restorePlayer(p))
        )
        for (let i = 0; i < results.length; i++) {
          if (results[i].status !== 'fulfilled' || !results[i].value)
            failed.push(entries[i])
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
      await fs.promises.writeFile(
        filePath,
        lines.length ? `${lines.join('\n')}\n` : ''
      )
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

  async restorePlayer(p, preferredNode = null) {
    const gId = String(p.g)
    return this.withGuildLifecycleLock(gId, 'restore', async () => {
      try {
        const existing = this.aqua.players.get(gId)
        if (existing?.playing && !existing.destroyed) return true
        if (existing?.destroyed) this.aqua.players.delete(gId)

        const targetNode = preferredNode?.connected
          ? preferredNode
          : this.aqua.leastUsedNodes[0]
        if (!targetNode?.connected) {
          throw new Error(`No connected node available to restore guild ${gId}`)
        }

        const player =
          !existing || existing.destroyed
            ? this.aqua.createPlayer(targetNode, {
                guildId: gId,
                textChannel: p.t,
                voiceChannel: p.v,
                defaultVolume: p.vol || 65,
                deaf: p.d ?? true,
                mute: !!p.m,
                resuming: !!p.resuming
              })
            : existing
        player._resuming = !!p.resuming
        this._applyVoiceBootstrap(player, p.vs)
        const requester = this._functions.parseRequester(p.r)
        const tracksToResolve = [p.u, ...(p.q || [])]
          .filter(Boolean)
          .slice(0, this.aqua.maxTracksRestore)
        const resolved = await Promise.all(
          tracksToResolve.map((uri) =>
            this._resolveTrackWithLimit(() =>
              this.aqua.resolve({ query: uri, requester }).catch(() => null)
            )
          )
        )
        const validTracks = resolved.flatMap((result) => result?.tracks || [])
        if (validTracks.length && player.queue?.add) {
          player.queue.add(...validTracks)
        }
        if (typeof p.loop === 'number') player.loop = p.loop
        if (p.sh !== undefined) player.shuffle = p.sh
        if (p.u && validTracks[0]) {
          if (p.vol != null) {
            if (typeof player.setVolume === 'function')
              await player.setVolume(p.vol)
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
          if (this.aqua.debugTrace) {
            this.aqua._trace('player.nowPlaying.restore', {
              guildId: gId,
              messageId: p.nw,
              restored: !!player.nowPlayingMessage
            })
          }
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

    const activeBrokenNodes = new Set()
    for (const state of this.aqua._brokenPlayers.values()) {
      if (state?.originalNodeId) activeBrokenNodes.add(state.originalNodeId)
    }
    for (const nodeId of this._brokenSnapshotNodes) {
      if (!activeBrokenNodes.has(nodeId)) {
        this._deleteBrokenPlayerSnapshot(nodeId).catch(this._functions.noop)
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
              const nodeOptions = this.aqua.nodes.find(
                (n) => (n.name || n.host) === name
              )
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

  async dispose() {
    const deletions = []
    for (const pending of this._brokenSnapshotWrites.values()) {
      deletions.push(pending.catch(this._functions.noop))
    }
    for (const nodeId of this._brokenSnapshotNodes) {
      deletions.push(this._deleteBrokenPlayerSnapshot(nodeId))
    }
    this._brokenSnapshotNodes.clear()
    this._brokenSnapshotWrites.clear()
    this._trackResolveQueue.length = 0
    await Promise.allSettled(deletions)
  }

  _resolveTrackWithLimit(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this._trackResolveActive++
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this._trackResolveActive--
            const next = this._trackResolveQueue.shift()
            if (next) next()
          })
      }
      if (this._trackResolveActive < this.aqua.trackResolveConcurrency) run()
      else this._trackResolveQueue.push(run)
    })
  }

  _applyVoiceBootstrap(player, voiceState) {
    if (!voiceState || !player?.connection) return false
    const connection = player.connection
    connection.sessionId = voiceState.sid || connection.sessionId
    connection.endpoint = voiceState.ep || connection.endpoint
    connection.token = voiceState.tok || connection.token
    connection.region = voiceState.reg || connection.region
    connection.channelId = voiceState.cid || connection.channelId
    connection._lastEndpoint = voiceState.ep || connection._lastEndpoint
    if (!connection.sessionId || !connection.endpoint || !connection.token)
      return false
    connection._lastVoiceDataUpdate = Date.now()
    connection.resendVoiceUpdate(true)
    return true
  }

  _serializeBrokenPlayer(player, nodeId, brokenAt) {
    const state = this.capturePlayerState(player)
    if (!state) return null
    const requester = player.requester || player.current?.requester
    const connection = player.connection
    return {
      type: 'broken_player',
      n: nodeId,
      brokenAt,
      g: state.guildId,
      t: state.textChannel,
      v: state.voiceChannel,
      u: state.current?.uri || null,
      p: state.position || 0,
      q: (state.queue || [])
        .slice(0, this.aqua.maxQueueSave)
        .map((track) => track?.uri)
        .filter(Boolean),
      r: requester ? `${requester.id}:${requester.username}` : null,
      vol: state.volume,
      pa: state.paused,
      pl: state.playing,
      nw: player.nowPlayingMessage?.id || null,
      d: state.deaf,
      m: !!player.mute,
      loop: state.loop,
      sh: state.shuffle,
      vs: connection
        ? {
            sid: connection.sessionId || null,
            ep: connection.endpoint || null,
            tok: connection.token || null,
            reg: connection.region || null,
            cid: connection.channelId || null
          }
        : null,
      resuming: true
    }
  }

  _getBrokenPlayerSnapshotPath(nodeId) {
    const base = this.aqua.brokenPlayerStorePath
    const ext = path.extname(base) || '.jsonl'
    const dir = path.dirname(base)
    const name = path.basename(base, ext)
    const safeId = String(nodeId || 'unknown').replace(/[^a-z0-9._-]+/gi, '_')
    return path.join(dir, `${name}.${safeId}${ext}`)
  }

  async _writeBrokenPlayerSnapshot(nodeId, records) {
    const filePath = this._getBrokenPlayerSnapshotPath(nodeId)
    if (!records.length) {
      await this._deleteBrokenPlayerSnapshot(nodeId)
      return
    }
    const tempFile = `${filePath}.tmp`
    this._brokenSnapshotNodes.add(nodeId)
    const writeTask = (async () => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      await fs.promises.writeFile(
        tempFile,
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
        'utf8'
      )
      await fs.promises.rename(tempFile, filePath)
    })()
    this._brokenSnapshotWrites.set(nodeId, writeTask)
    try {
      await writeTask
    } finally {
      if (this._brokenSnapshotWrites.get(nodeId) === writeTask) {
        this._brokenSnapshotWrites.delete(nodeId)
      }
    }
  }

  async _readBrokenPlayerSnapshot(nodeId, guildIds) {
    const filePath = this._getBrokenPlayerSnapshotPath(nodeId)
    let stream = null
    let rl = null
    const entries = []
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8' })
      rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of rl) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          if (
            parsed?.type === 'broken_player' &&
            parsed.n === nodeId &&
            guildIds.has(String(parsed.g))
          ) {
            entries.push(parsed)
          }
        } catch {}
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        reportSuppressedError(this.aqua, 'aqua.brokenPlayers.read', error, {
          node: nodeId
        })
      }
    } finally {
      if (rl) this._functions.safeCall(() => rl.close())
      if (stream) this._functions.safeCall(() => stream.destroy())
    }
    return entries
  }

  async _deleteBrokenPlayerSnapshot(nodeId) {
    const filePath = this._getBrokenPlayerSnapshotPath(nodeId)
    this._brokenSnapshotNodes.delete(nodeId)
    await fs.promises.unlink(filePath).catch(this._functions.noop)
    await fs.promises.unlink(`${filePath}.tmp`).catch(this._functions.noop)
  }
}

module.exports = AquaRecovery
