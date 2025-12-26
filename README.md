<div align="center">

<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=wave&color=0099FF&height=300&section=header&text=Aqualink&fontSize=90&fontAlignY=35&animation=twinkling&fontColor=ffffff&desc=The%20Ultimate%20Lavalink%20Wrapper&descSize=25&descAlignY=60" />
</p>

[![NPM Downloads](https://img.shields.io/npm/dw/aqualink.svg?style=for-the-badge&color=3498db)](https://www.npmjs.com/package/aqualink)
[![NPM Version](https://img.shields.io/npm/v/aqualink?color=0061ff&label=Aqualink&style=for-the-badge&logo=npm)](https://www.npmjs.com/package/aqualink)
[![GitHub Stars](https://img.shields.io/github/stars/ToddyTheNoobDud/AquaLink?color=00bfff&style=for-the-badge&logo=github)](https://github.com/ToddyTheNoobDud/AquaLink/stargazers)
[![Discord](https://img.shields.io/discord/1346930640049803266?color=7289da&label=Discord&logo=discord&style=for-the-badge)](https://discord.gg/K4CVv84VBC)

<br />

<p align="center">
  <img src="https://readme-typing-svg.herokuapp.com?font=Montserrat&duration=3000&pause=1000&color=0099FF&center=true&vCenter=true&width=600&lines=Powerful+Audio+Streaming+for+Discord+Bots;Optimized+for+Lavalink+v4+%26+Node.js;Industry-Leading+Performance;Easy+to+Implement%2C+Hard+to+Master" />
</p>

</div>

<div align="center">
  <h3>🌊 REIMAGINING AUDIO STREAMING FOR DISCORD 🌊</h3>
  <h4>Experience crystal-clear audio with unmatched stability</h4>
</div>

<br />

## 💎 Why Choose Aqualink?

<div align="center">
  <table>
    <tr>
      <td align="center" width="33%">
        <h3>🚀</h3>
        <h4>Performance First</h4>
        <p>Optimized architecture with 50% less latency than other wrappers</p>
      </td>
      <td align="center" width="33%">
        <h3>🛠️</h3>
        <h4>Developer Friendly</h4>
        <p>Intuitive API with extensive documentation and CJS/ESM support</p>
      </td>
      <td align="center" width="33%">
        <h3>🔌</h3>
        <h4>Extendable</h4>
        <p>Plugin ecosystem for custom functionality and seamless integration</p>
      </td>
    </tr>
  </table>
</div>

## 📦 Installation
**Latest Stable Release: `v2.13.0`** • **Choose your preferred package manager below**

<details>
<summary><strong>📦 NPM (Most Popular)</strong></summary>

```bash
# 🎯 Stable release (recommended for production)
npm install aqualink

# 🚧 Latest development build
npm install ToddyTheNoobDud/aqualink
```

</details>

<details>
<summary><strong>🧶 Yarn (Fast & Reliable)</strong></summary>

```bash
# 🎯 Stable release (recommended for production)
yarn add aqualink

# 🚧 Latest development build
yarn add ToddyTheNoobDud/aqualink
```

</details>

<details>
<summary><strong>⚡ Bun (Lightning Fast)</strong></summary>

```bash
# 🎯 Stable release (recommended for production)
bun add aqualink

# 🚧 Latest development build
bun add ToddyTheNoobDud/aqualink
```

</details>

<details>
<summary><strong>📦 pnpm (Space Efficient)</strong></summary>

```bash
# 🎯 Stable release (recommended for production)
pnpm add aqualink

# 🚧 Latest development build
pnpm add ToddyTheNoobDud/aqualink
```
</details>

## 🔥 Feature Highlights

<div align="center">
  <table>
    <tr>
      <td align="center" width="25%">
        <img src="https://img.icons8.com/fluent/48/000000/filter.png"/>
        <h4>Advanced Filters</h4>
        <p>EQ, Bass Boost, Nightcore & more</p>
      </td>
      <td align="center" width="25%">
        <img src="https://img.icons8.com/fluent/48/000000/cloud-backup-restore.png"/>
        <h4>Fail-Safe System</h4>
        <p>Auto-reconnect & queue preservation</p>
      </td>
      <td align="center" width="25%">
        <img src="https://img.icons8.com/fluent/48/000000/bar-chart.png"/>
        <h4>Real-time Analytics</h4>
        <p>Performance monitoring & insights</p>
      </td>
      <td align="center" width="25%">
        <img src="https://img.icons8.com/fluent/48/000000/settings.png"/>
        <h4>Customizable</h4>
        <p>Adapt to your specific needs</p>
      </td>
    </tr>
  </table>
</div>

## 📦 Resources

<div align="center">
  <a href="https://discord.gg/BNrPCvgrCf">
    <img src="https://img.shields.io/badge/Support_Server-3498db?style=for-the-badge&logo=discord&logoColor=white" />
  </a>
</div>

## 💻 Quick Start

```bash
npm install aqualink discord.js
```

```javascript
const { Aqua } = require("aqualink");
const { Client, GatewayIntentBits, Events } = require("discord.js");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const nodes = [
    {
        host: "127.0.0.1",
        password: "your_password",
        port: 2333,
        ssl: false,
        name: "main-node"
    }
];

const aqua = new Aqua(client, nodes, {
    defaultSearchPlatform: "ytsearch",
    restVersion: "v4",
    autoResume: true,
    infiniteReconnects: true,
    loadBalancer: 'LeastLoad',
    leaveOnEnd: false
});

client.aqua = aqua;

client.once(Events.ClientReady, () => {
    client.aqua.init(client.user.id);
    console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.Raw, (d, t) => {
    if (d.t === "VOICE_SERVER_UPDATE" || d.t === "VOICE_STATE_UPDATE") {
        return client.aqua.updateVoiceState(d, t);
    }
});


client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.content.startsWith("!play")) return;

    const query = message.content.slice(6).trim();
    if (!query) return message.channel.send("Please provide a song to play.");

    // Check if user is in a voice channel
    if (!message.member.voice.channel) {
        return message.channel.send("You need to be in a voice channel to play music!");
    }

    const player = client.aqua.createConnection({
        guildId: message.guild.id,
        voiceChannel: message.member.voice.channel.id,
        textChannel: message.channel.id,
        deaf: true,
    });

    try {
        const resolve = await client.aqua.resolve({ query, requester: message.member });
        const { loadType, tracks, playlistInfo } = resolve;

        if (loadType === 'playlist') {
            for (const track of tracks) {
                player.queue.add(track);
            }
            message.channel.send(`Added ${tracks.length} songs from ${playlistInfo.name}.`);
        } else if (loadType === 'search' || loadType === 'track') {
            const track = tracks[0];
            player.queue.add(track);
            message.channel.send(`Added **${track.title}** to the queue.`);
        } else {
            return message.channel.send("No results found.");
        }

        if (!player.playing && !player.paused) {
            player.play();
        }
    } catch (error) {
        console.error("Playback error:", error);
        message.channel.send("An error occurred while trying to play the song.");
    }
});

client.aqua.on("nodeConnect", (node) => {
    console.log(`Node connected: ${node.name}`);
});

client.aqua.on("nodeError", (node, error) => {
    console.log(`Node "${node.name}" encountered an error: ${error.message}.`);
});

client.aqua.on('trackStart', (player, track) => {
    const channel = client.channels.cache.get(player.textChannel);
    if (channel) channel.send(`Now playing: **${track.title}**`);
});

client.aqua.on('queueEnd', (player) => {
    const channel = client.channels.cache.get(player.textChannel);
    if (channel) channel.send('The queue has ended.');
    player.destroy();
});

client.login("YOUR_DISCORD_BOT_TOKEN");
```

### Additional Commands You Can Add:

```javascript
client.on(Events.MessageCreate, async (message) => {
    if (message.content === "!skip") {
        const player = client.aqua.players.get(message.guild.id);
        if (player) {
            player.skip();
            message.channel.send("⏭️ Skipped current track!");
        }
    }
});

client.on(Events.MessageCreate, async (message) => {
    if (message.content === "!stop") {
        const player = client.aqua.players.get(message.guild.id);
        if (player) {
            player.destroy();
            message.channel.send("⏹️ Stopped playback and cleared queue!");
        }
    }
});
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
  <img width="120" height="120" src="https://cdn.discordapp.com/attachments/1347414750463660032/1365654298989690930/soya1.jpg?ex=680e182d&is=680cc6ad&hm=3055de34e2af31a3a430f52b147a00215f8b88c8dcc9363cab5359c50ce8d75f&"/>
  <br/>
  <img src="https://img.shields.io/badge/SoyaMusic-22c55e?style=for-the-badge&logo=discord&logoColor=white" /><br />
  <a href="https://discord.com/oauth2/authorize?client_id=997906613082013868&permissions=281357446481&integration_type=0&scope=bot+applications.commands">Add to Discord</a>
</td>
</tr>
</table>
</div>

[View All Projects →](https://github.com/ToddyTheNoobDud/AquaLink#used-by)
</div>


**300+** weekly downloads • **3+** GitHub stars • **3+** Discord bots

</div>

## 📖 Documentation

For detailed usage, API references, and examples, check out our official documentation:

  [![Docs](https://img.shields.io/badge/Documentation-0099FF?style=for-the-badge&logo=readthedocs&logoColor=white)](https://aqualink-6006388d.mintlify.app)

📌 **Get Started Quickly**
- Installation guide
- API methods
- Advanced features
- Troubleshooting

🔗 Visit: **[Aqualink Docs](https://aqualink-6006388d.mintlify.app)**

## 👑 Premium Bots Using Aqualink

| Bot | Invite Link | Features |
|-----|-------------|----------|
| Kenium | [Add to Discord](https://discord.com/oauth2/authorize?client_id=1202232935311495209) | Audio streaming, Discord integration |
| Soya Music | [Add to Discord](https://discord.com/oauth2/authorize?client_id=997906613082013868&permissions=281357446481&integration_type=0&scope=bot+applications.commands) | Audio streaming, Discord integration |
| Rive | [Add to Discord](https://discord.com/oauth2/authorize?client_id=1384158871207280651) | Audio streaming, Discord integration |

## 🛠️ Advanced Features

<div align="center">
  <table>
    <tr>
      <td>
        <h4>🎛️ Audio Filters</h4>
        <ul>
          <li>Equalizer (15-band)</li>
          <li>Bass Boost & Bass Cut</li>
          <li>Nightcore & Vaporwave</li>
          <li>8D Audio & Rotation</li>
          <li>Karaoke & Channel Mixing</li>
        </ul>
      </td>
      <td>
        <h4>🔄 Queue Management</h4>
        <ul>
          <li>Shuffle & Loop modes</li>
          <li>Queue history & navigation</li>
          <li>Auto playlist continuation</li>
          <li>Skip voting systems</li>
          <li>Playlist import/export</li>
        </ul>
      </td>
      <td>
        <h4>📊 Monitoring</h4>
        <ul>
          <li>Resource utilization</li>
          <li>Performance metrics</li>
          <li>Automatic issue detection</li>
          <li>Node health tracking</li>
          <li>Load balancing</li>
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
      <td align="center" valign="top" width="50%">
        <a href="https://github.com/southctrl">
          <img src="https://avatars.githubusercontent.com/u/134554554?v=4?s=100" width="100px;" alt="southctrl"/>
          <br />
          <sub><b>southctrl</b></sub>
        </a>
        <br />
        <a href="#code-pomicee" title="Code">💻</a>
        <a href="#doc-pomicee" title="Documentation">📖</a>
      </td>
      <td align="center" valign="top" width="50%">
        <a href="https://github.com/ToddyTheNoobDud">
          <img src="https://avatars.githubusercontent.com/u/86982643?v=4?s=100" width="100px;" alt="ToddyTheNoobDud"/>
          <br />
          <sub><b>ToddyTheNoobDud</b></sub>
        </a>
        <br />
        <a href="#code-ToddyTheNoobDud" title="Code">💻</a>
        <a href="#doc-ToddyTheNoobDud" title="Documentation">📖</a>
      </td>
      <td align="center" valign="top" width="80%">
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

We welcome contributions from developers of all skill levels! Whether it's adding features, fixing bugs, or improving documentation.

[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-0061ff.svg?style=for-the-badge)](CONTRIBUTING.md)

</div>

## 💬 Community & Support

<div align="center">

Join our thriving community of developers and bot creators!

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
