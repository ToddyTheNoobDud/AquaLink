<div align="center">

<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=wave&color=0099FF&height=300&section=header&text=Aqualink&fontSize=90&fontAlignY=35&animation=twinkling&fontColor=ffffff&desc=Performance-focused%20Lavalink%20Client&descSize=25&descAlignY=60" />
</p>

[![NPM Downloads](https://img.shields.io/npm/dw/aqualink.svg?style=for-the-badge&color=3498db)](https://www.npmjs.com/package/aqualink)
[![NPM Version](https://img.shields.io/npm/v/aqualink?color=0061ff&label=Aqualink&style=for-the-badge&logo=npm)](https://www.npmjs.com/package/aqualink)
[![GitHub Stars](https://img.shields.io/github/stars/ToddyTheNoobDud/AquaLink?color=00bfff&style=for-the-badge&logo=github)](https://github.com/ToddyTheNoobDud/AquaLink/stargazers)
[![Discord](https://img.shields.io/discord/1346930640049803266?color=7289da&label=Discord&logo=discord&style=for-the-badge)](https://discord.gg/K4CVv84VBC)

<br />

<p align="center">
  <img src="https://readme-typing-svg.herokuapp.com?font=Montserrat&duration=3000&pause=1000&color=0099FF&center=true&vCenter=true&width=700&lines=Powerful+Audio+Streaming+for+Discord+Bots;Optimized+for+Lavalink+v4+and+Nodelink;Failover%2C+Filters%2C+Autoplay%2C+Lyrics;Easy+to+Integrate%2C+Built+for+Stability" />
</p>

</div>

<div align="center">
  <h3>🌊 REIMAGINING AUDIO STREAMING FOR DISCORD 🌊</h3>
  <h4>Built for high uptime, clean APIs, and real-world bot workloads</h4>
</div>

<br />

## 💎 Why Choose Aqualink?

<div align="center">
  <table>
    <tr>
      <td align="center" width="33%">
        <h3>🚀</h3>
        <h4>Performance First</h4>
        <p>Efficient queue/player internals and load-balanced node selection.</p>
      </td>
      <td align="center" width="33%">
        <h3>🛠️</h3>
        <h4>Developer Friendly</h4>
        <p>Simple API surface with CJS/ESM compatibility and TypeScript types.</p>
      </td>
      <td align="center" width="33%">
        <h3>🔌</h3>
        <h4>Extensible</h4>
        <p>Plugin base class + rich event system for custom bot behavior.</p>
      </td>
    </tr>
  </table>
</div>

## 📦 Installation
**Latest Stable Release: `v2.20.1`**

<details>
<summary><strong>📦 NPM</strong></summary>

```bash
# Stable release
npm install aqualink

# Development build
npm install ToddyTheNoobDud/aqualink
```

</details>

<details>
<summary><strong>🧶 Yarn</strong></summary>

```bash
yarn add aqualink
yarn add ToddyTheNoobDud/aqualink
```

</details>

<details>
<summary><strong>⚡ Bun</strong></summary>

```bash
bun add aqualink
bun add ToddyTheNoobDud/aqualink
```

</details>

<details>
<summary><strong>📦 pnpm</strong></summary>

```bash
pnpm add aqualink
pnpm add ToddyTheNoobDud/aqualink
```
</details>

## 🔥 Implemented Highlights (v2.20.1)

<div align="center">
  <table>
    <tr>
      <td align="center" width="25%">
        <img src="https://img.icons8.com/fluent/48/000000/filter.png"/>
        <h4>Advanced Filters</h4>
        <p>EQ, Bassboost, Nightcore, Vaporwave, 8D, Karaoke, and more.</p>
      </td>
      <td align="center" width="25%">
        <img src="https://img.icons8.com/fluent/48/000000/cloud-backup-restore.png"/>
        <h4>Failover + Recovery</h4>
        <p>Node failover, player migration, auto-resume, queue persistence.</p>
      </td>
      <td align="center" width="25%">
        <img src="https://img.icons8.com/fluent/48/000000/bar-chart.png"/>
        <h4>Diagnostics</h4>
        <p>Debug events + trace buffer for production troubleshooting.</p>
      </td>
      <td align="center" width="25%">
        <img src="https://img.icons8.com/fluent/48/000000/settings.png"/>
        <h4>Flexible Runtime</h4>
        <p>Load balancing, region-aware nodes, autoplay, lyrics, mixer APIs.</p>
      </td>
    </tr>
  </table>
</div>

## 📦 Resources

<div align="center">
  <a href="https://discord.gg/K4CVv84VBC">
    <img src="https://img.shields.io/badge/Support_Server-3498db?style=for-the-badge&logo=discord&logoColor=white" />
  </a>
</div>

## 💻 Quick Start

```bash
npm install aqualink discord.js
```

```javascript
const { Aqua, AqualinkEvents } = require('aqualink')
const { Client, GatewayIntentBits, Events } = require('discord.js')

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
})

const nodes = [
  {
    host: '127.0.0.1',
    password: 'your_password', // alias for `auth`
    port: 2333,
    ssl: false,
    name: 'main-node'
  }
]

const aqua = new Aqua(client, nodes, {
  defaultSearchPlatform: 'ytsearch',
  restVersion: 'v4',
  autoResume: true,
  infiniteReconnects: true,
  loadBalancer: 'leastLoad',
  leaveOnEnd: false,
  autoRegionMigrate: false
})

client.once(Events.ClientReady, async () => {
  await aqua.init(client.user.id)
  console.log(`Logged in as ${client.user.tag}`)
})

// Forward Discord voice packets to Aqualink
client.on(Events.Raw, (packet) => {
  if (packet.t === 'VOICE_SERVER_UPDATE' || packet.t === 'VOICE_STATE_UPDATE') {
    aqua.updateVoiceState(packet)
  }
})

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.content.startsWith('!play')) return

  const query = message.content.slice(6).trim()
  if (!query) return message.channel.send('Please provide a song to play.')
  if (!message.member.voice.channel) {
    return message.channel.send('You need to be in a voice channel to play music!')
  }

  const player = aqua.createConnection({
    guildId: message.guild.id,
    voiceChannel: message.member.voice.channel.id,
    textChannel: message.channel.id,
    deaf: true
  })

  try {
    const resolved = await aqua.resolve({
      query,
      requester: message.member
    })

    const { loadType, tracks, playlistInfo } = resolved

    if (loadType === 'playlist') {
      player.queue.add(...tracks)
      message.channel.send(`Added ${tracks.length} songs from ${playlistInfo?.name || 'playlist'}.`)
    } else if (loadType === 'search' || loadType === 'track') {
      const track = tracks[0]
      player.queue.add(track)
      message.channel.send(`Added **${track.title}** to the queue.`)
    } else {
      return message.channel.send('No results found.')
    }

    if (!player.playing && !player.paused) {
      await player.play()
    }
  } catch (error) {
    console.error('Playback error:', error)
    message.channel.send('An error occurred while trying to play the song.')
  }
})

aqua.on(AqualinkEvents.NodeConnect, (node) => {
  console.log(`Node connected: ${node.name}`)
})

aqua.on(AqualinkEvents.NodeError, (node, error) => {
  console.log(`Node "${node.name}" encountered an error: ${error.message}`)
})

aqua.on(AqualinkEvents.TrackStart, (player, track) => {
  const channel = client.channels.cache.get(player.textChannel)
  if (channel) channel.send(`Now playing: **${track.title}**`)
})

aqua.on(AqualinkEvents.QueueEnd, (player) => {
  const channel = client.channels.cache.get(player.textChannel)
  if (channel) channel.send('The queue has ended.')
  player.destroy()
})

client.login('YOUR_DISCORD_BOT_TOKEN')
```

### Additional Commands You Can Add

```javascript
client.on(Events.MessageCreate, async (message) => {
  if (message.content === '!skip') {
    const player = aqua.players.get(message.guild.id)
    if (player) {
      player.skip()
      message.channel.send('⏭️ Skipped current track!')
    }
  }
})

client.on(Events.MessageCreate, async (message) => {
  if (message.content === '!stop') {
    const player = aqua.players.get(message.guild.id)
    if (player) {
      player.destroy()
      message.channel.send('⏹️ Stopped playback and cleared queue!')
    }
  }
})
```

## 🌟 Featured Projects

<div align="center">
<table>
<tr>
<td align="center" width="33%">
  <img width="120" height="120" src="https://img.icons8.com/fluent/240/000000/water-element.png"/>
  <br/>
  <img src="https://img.shields.io/badge/Kenium-00bfff?style=for-the-badge&logo=discord&logoColor=white" /><br />
  <a href="https://discord.com/oauth2/authorize?client_id=1202232935311495209">Add to Discord</a>
</td>
<td align="center" width="33%">
  <img width="120" height="120" src="https://cdn.discordapp.com/attachments/1347414750463660032/1365654298989690930/soya1.jpg"/>
  <br/>
  <img src="https://img.shields.io/badge/SoyaMusic-22c55e?style=for-the-badge&logo=discord&logoColor=white" /><br />
  <a href="https://discord.com/oauth2/authorize?client_id=997906613082013868&permissions=281357446481&integration_type=0&scope=bot+applications.commands">Add to Discord</a>
</td>
<td align="center" width="33%">
  <img width="120" height="120" src="https://img.icons8.com/fluency/240/music.png"/>
  <br/>
  <img src="https://img.shields.io/badge/Rive-a855f7?style=for-the-badge&logo=discord&logoColor=white" /><br />
  <a href="https://discord.com/oauth2/authorize?client_id=1384158871207280651">Add to Discord</a>
</td>
</tr>
</table>
</div>

[View All Projects →](https://github.com/ToddyTheNoobDud/AquaLink#used-by)

## 📖 Documentation

For detailed usage, API references, and examples, check out the official documentation:

[![Docs](https://img.shields.io/badge/Documentation-0099FF?style=for-the-badge&logo=readthedocs&logoColor=white)](https://aqualink-6006388d.mintlify.app)

📌 **Get Started Quickly**
- Installation guide
- API methods
- Events and filters
- Troubleshooting

🔗 Visit: **[Aqualink Docs](https://aqualink-6006388d.mintlify.app)**

## 👑 Bots Using Aqualink

| Bot | Invite Link | Notes |
|-----|-------------|-------|
| Kenium | [Add to Discord](https://discord.com/oauth2/authorize?client_id=1202232935311495209) | Music playback, playlist support |
| Soya Music | [Add to Discord](https://discord.com/oauth2/authorize?client_id=997906613082013868&permissions=281357446481&integration_type=0&scope=bot+applications.commands) | Music playback, Discord integration |
| Rive | [Add to Discord](https://discord.com/oauth2/authorize?client_id=1384158871207280651) | Audio streaming bot |

## 🛠️ Advanced Features

<div align="center">
  <table>
    <tr>
      <td>
        <h4>🎛️ Audio Filters</h4>
        <ul>
          <li>Equalizer</li>
          <li>Bassboost preset</li>
          <li>Nightcore & Vaporwave presets</li>
          <li>8D rotation</li>
          <li>Karaoke, ChannelMix, LowPass, Distortion</li>
        </ul>
      </td>
      <td>
        <h4>🔄 Queue & Player Control</h4>
        <ul>
          <li>Shuffle & loop modes</li>
          <li>Seek, replay, skip</li>
          <li>Queue move/swap/remove</li>
          <li>Autoplay support</li>
          <li>Save/load player sessions</li>
        </ul>
      </td>
      <td>
        <h4>📡 Reliability</h4>
        <ul>
          <li>Auto reconnects</li>
          <li>Node failover migration</li>
          <li>Region-aware node migration</li>
          <li>Debug trace buffer</li>
          <li>Lyrics and live lyrics support</li>
        </ul>
      </td>
    </tr>
  </table>
</div>

## 👥 Contributors

<div align="center">

<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="33%">
        <a href="https://github.com/southctrl">
          <img src="https://avatars.githubusercontent.com/u/134554554?v=4?s=100" width="100px;" alt="southctrl"/>
          <br />
          <sub><b>southctrl</b></sub>
        </a>
        <br />
        <a href="#code-pomicee" title="Code">💻</a>
        <a href="#doc-pomicee" title="Documentation">📖</a>
      </td>
      <td align="center" valign="top" width="33%">
        <a href="https://github.com/ToddyTheNoobDud">
          <img src="https://avatars.githubusercontent.com/u/86982643?v=4?s=100" width="100px;" alt="ToddyTheNoobDud"/>
          <br />
          <sub><b>ToddyTheNoobDud</b></sub>
        </a>
        <br />
        <a href="#code-ToddyTheNoobDud" title="Code">💻</a>
        <a href="#doc-ToddyTheNoobDud" title="Documentation">📖</a>
      </td>
      <td align="center" valign="top" width="33%">
        <a href="https://github.com/SoulDevs">
          <img src="https://avatars.githubusercontent.com/u/114820381?v=4" width="100px;" alt="SoulDevs"/>
          <br />
          <sub><b>SoulDevs</b></sub>
        </a>
        <br />
        <a href="#code-SoulDevs" title="Code">💻</a>
      </td>
    </tr>
  </tbody>
</table>

<br />

[Become a contributor →](CONTRIBUTING.md)

</div>

## 🤝 Contributing

<div align="center">

We welcome contributions of all sizes: fixes, features, and docs improvements.

[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-0061ff.svg?style=for-the-badge)](CONTRIBUTING.md)

</div>

## 💬 Community & Support

<div align="center">

Join the community and get help quickly:

[![Discord Server](https://img.shields.io/badge/Discord_Server-7289da?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/K4CVv84VBC)
[![GitHub Discussions](https://img.shields.io/badge/GitHub_Discussions-0061ff?style=for-the-badge&logo=github&logoColor=white)](https://github.com/ToddyTheNoobDud/AquaLink/discussions)

</div>

<div align="center">

<br />

<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=wave&color=0099FF&height=100&section=footer" />
</p>

<sub>Built with 💙 by the Aqualink Team</sub>

</div>
