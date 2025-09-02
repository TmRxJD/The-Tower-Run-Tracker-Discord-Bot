const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL; // Replace with your Discord webhook URL

app.post('/github', async (req, res) => {
  const payload = req.body;

  // Example: Handle push events
  if (payload.commits && payload.repository) {
    // Only use the project name (repo name)
    const repo = payload.repository.name;
    const pusher = payload.pusher.name;
    const commitCount = payload.commits.length;
    // Remove author name from the end of each commit message
    const commitMsg = payload.commits.map(c => `[\`${c.id.substring(0,7)}\`](${c.url}): ${c.message}`).join('\n');

    const discordPayload = {
      embeds: [{
        title: `${repo}`,
        description: `${commitMsg}`,
        color: 0x7289DA,
        author: {
          name: `${pusher} pushed ${commitCount} commit${commitCount > 1 ? 's' : ''}`,
          icon_url: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png'
        },
        timestamp: new Date().toISOString(),
        setURL: 'https://the-tower-run-tracker.com/'
      }]
    };

    try {
      await axios.post(DISCORD_WEBHOOK_URL, discordPayload);
      res.status(200).send('OK');
    } catch (err) {
      res.status(500).send('Failed to send to Discord');
    }
  } else {
    res.status(200).send('Event ignored');
  }
});

function startGithubRelay() {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Relay listening on port ${PORT}`));
}

module.exports = { startGithubRelay };