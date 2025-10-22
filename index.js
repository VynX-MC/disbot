// --- Importation des modules ---
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits, REST, Routes } = require('discord.js');
const express = require('express');

// --- Récupération des secrets (Variables d'environnement Render) ---
// Assurez-vous d'avoir défini DISCORD_TOKEN et CLIENT_ID dans l'onglet "Environment" de Render.
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId) {
  console.error("Erreur : DISCORD_TOKEN ou CLIENT_ID n'est pas défini dans les variables d'environnement.");
  process.exit(1); // Arrête le processus si les secrets sont manquants
}

// =================================================================
// 1. PARTIE EXPRESS (Pour garder le bot en vie sur Render)
// =================================================================

const app = express();
// Render utilise la variable PORT, sinon nous utilisons 3000 par défaut
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  // Cette page sera "pinguée" par Uptime Robot
  res.send('Le bot est en ligne et fonctionne ! 🤖');
});

app.listen(port, () => {
  console.log(`[Express] Serveur web démarré et à l'écoute sur le port ${port}`);
});

// =================================================================
// 2. PARTIE BOT DISCORD (Votre code /ping)
// =================================================================

// --- Création du client Discord ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- Gestion des commandes ---
client.commands = new Collection();
const commands = [];

// Définition de la commande /ping
const pingCommand = {
  data: {
    name: 'ping',
    description: 'Vérifie la latence du bot et répond Pong!',
  },
  async execute(interaction) {
    const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
    interaction.editReply(`Pong! 🏓 Latence : ${sent.createdTimestamp - interaction.createdTimestamp}ms`);
  },
};

// Ajout de la commande à la collection
client.commands.set(pingCommand.data.name, pingCommand);
commands.push(pingCommand.data);

// --- Enregistrement des commandes (/) auprès de Discord ---
const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log(`[Discord] Début du rafraîchissement de ${commands.length} commande(s) (/).`);

    // Enregistre les commandes pour toutes les guildes (global)
    // Pour les tests, vous pouvez utiliser Routes.applicationGuildCommands(clientId, 'VOTRE_GUILD_ID')
    const data = await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands },
    );

    console.log(`[Discord] ${data.length} commande(s) (/) rechargée(s) avec succès.`);
  } catch (error) {
    console.error(error);
  }
})();

// --- Gestionnaire d'interactions ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return; // Ne traite que les slash commands

  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    console.error(`[Discord] Aucune commande ${interaction.commandName} n'a été trouvée.`);
    return;
  }

  try {
    // Exécute la commande
    await command.execute(interaction); 
  } catch (error) {
    console.error(error);
    await interaction.reply({ content: 'Il y a eu une erreur durant l\'exécution de cette commande!', ephemeral: true });
  }
});

// --- Événement "Ready" (Quand le bot est connecté) ---
client.once(Events.ClientReady, c => {
  console.log(`[Discord] Prêt ! Connecté en tant que ${c.user.tag}`);
  client.user.setActivity('vous observer', { type: 'WATCHING' });
});

// --- Connexion du bot à Discord ---
client.login(token);