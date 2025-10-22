// --- Importation des modules ---
const { Client, Collection, Events, GatewayIntentBits, REST, Routes, EmbedBuilder } = require('discord.js');
const express = require('express');
const cron = require('node-cron');
const mongoose = require('mongoose');

// --- Configuration des Secrets ---
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const mongoUri = process.env.MONGO_URI; // La nouvelle variable d'environnement
const GAME_CHANNEL_ID = '1430685218351878154'; // Mettez l'ID de votre salon

if (!token || !clientId || !GAME_CHANNEL_ID || !mongoUri) {
  console.error("Erreur : Des variables d'environnement sont manquantes ! (TOKEN, CLIENT_ID, GAME_CHANNEL_ID, MONGO_URI)");
  process.exit(1);
}

// =================================================================
// 1. PARTIE EXPRESS (Pour Uptime Robot)
// =================================================================
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Le bot est en ligne ! 🤖'));
app.listen(port, () => console.log(`[Express] Serveur web démarré sur le port ${port}`));

// =================================================================
// 2. PARTIE BASE DE DONNÉES (MongoDB Atlas avec Mongoose)
// =================================================================

// --- Définition des "Schémas" (la structure de vos données) ---

// Schéma pour les joueurs
const playerSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  userName: { type: String, required: true },
  points: { type: Number, default: 0 },
  completionPercent: { type: Number, default: 0 },
  inventory: { type: Map, of: Number, default: {} } // Ex: { "pioche_bois": 1, "pierre": 8 }
});
// Crée le "Modèle" pour interagir avec la collection "players"
const Player = mongoose.model('Player', playerSchema);

// Schéma pour l'état du jeu (la question actuelle)
const gameStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'global' },
  currentQuestion: { type: String, default: "Pas de question en cours." },
  currentAnswers: { type: [String], default: [] }, // Stocke les réponses possibles
  responders: { type: [String], default: [] } // Stocke les IDs de ceux qui ont répondu
});
const GameState = mongoose.model('GameState', gameStateSchema);

// --- Connexion à MongoDB ---
mongoose.connect(mongoUri)
  .then(async () => {
    console.log('[DB] Connecté à MongoDB Atlas !');
    // Initialiser l'état du jeu s'il n'existe pas
    const state = await GameState.findOne({ key: 'global' });
    if (!state) {
      console.log("[DB] Initialisation de l'état du jeu...");
      await new GameState().save();
    }
  })
  .catch(err => {
    console.error("[DB] Erreur de connexion à MongoDB :", err);
    process.exit(1);
  });

// --- Fonctions de gestion (maintenant asynchrones) ---
async function getPlayer(userId, userName) {
  let player = await Player.findOne({ userId: userId });
  if (!player) {
    // Crée le joueur s'il n'existe pas
    player = new Player({ userId: userId, userName: userName });
    await player.save();
  } else if (player.userName !== userName) {
    // Met à jour le pseudo si la personne a changé de nom
    player.userName = userName;
    await player.save();
  }
  return player;
}

async function addPoints(userId, userName, amount) {
  // findOneAndUpdate avec 'upsert: true' trouve le joueur OU le crée s'il n'existe pas,
  // et ajoute les points en une seule opération.
  await Player.findOneAndUpdate(
    { userId: userId },
    { 
      $inc: { points: amount }, // $inc = incrémenter
      $set: { userName: userName } // $set = définir la valeur (met à jour le pseudo)
    },
    { upsert: true } // upsert = update or insert
  );
}

// =================================================================
// 3. PARTIE BOT DISCORD (Commandes + Logique de jeu)
// =================================================================

// --- Banque de Questions (Identique) ---
const questions = [
  { q: "Quel bloc faut-il miner pour obtenir du diamant ?", a: ["diamant", "minerai de diamant"] },
  { q: "Combien de planches de bois faut-il pour faire un établi ?", a: ["4", "quatre"] },
  { q: "Quel mob hostile explose quand il s'approche de vous ?", a: ["creeper"] },
  { q: "Quel outil est nécessaire pour miner de la pierre ?", a: ["pioche", "pioche en bois"] }
];

// --- Client Discord ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
client.commands = new Collection();
const commands = [];

// --- Commande /ping (Identique) ---
const pingCommand = {
  data: { name: 'ping', description: 'Vérifie la latence du bot.' },
  async execute(interaction) {
    const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
    interaction.editReply(`Pong! 🏓 Latence : ${sent.createdTimestamp - interaction.createdTimestamp}ms`);
  },
};
commands.push(pingCommand.data);
client.commands.set(pingCommand.data.name, pingCommand);

// --- Commande /classement (Modifiée pour Mongoose) ---
const leaderboardCommand = {
  data: { name: 'classement', description: 'Affiche les 10 meilleurs joueurs.' },
  async execute(interaction) {
    // .find() trouve, .sort() trie, .limit() limite
    const top10 = await Player.find().sort({ points: -1 }).limit(10);
    
    if (top10.length === 0) {
      return interaction.reply("Personne n'a encore de points !");
    }

    const embed = new EmbedBuilder()
      .setTitle("🏆 Classement du Serveur 🏆")
      .setColor(0x00AE86);
      
    let description = "";
    top10.forEach((player, index) => {
      description += `**${index + 1}.** ${player.userName} - ${player.points} points\n`;
    });
    embed.setDescription(description);
    
    await interaction.reply({ embeds: [embed] });
  },
};
commands.push(leaderboardCommand.data);
client.commands.set(leaderboardCommand.data.name, leaderboardCommand);

// --- Commande /question (Modifiée pour Mongoose) ---
const questionCommand = {
  data: { name: 'question', description: 'Affiche la question active.' },
  async execute(interaction) {
    const state = await GameState.findOne({ key: 'global' });
    await interaction.reply(`**Question actuelle :**\n${state.currentQuestion}`);
  },
};
commands.push(questionCommand.data);
client.commands.set(questionCommand.data.name, questionCommand);


// --- Enregistrement des commandes (/) (Identique) ---
const rest = new REST({ version: '10' }).setToken(token);
(async () => {
  try {
    console.log(`[Discord] Rafraîchissement de ${commands.length} commande(s) (/).`);
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands },
    );
    console.log(`[Discord] ${commands.length} commande(s) (/) rechargée(s).`);
  } catch (error) {
    console.error(error);
  }
})();

// --- Gestionnaire d'interactions (Identique) ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    await interaction.reply({ content: 'Il y a eu une erreur!', ephemeral: true });
  }
});

// --- Gestionnaire de Messages (Modifié pour Mongoose) ---
client.on(Events.MessageCreate, async message => {
  if (message.author.bot || message.channel.id !== GAME_CHANNEL_ID) return;

  const reponse = message.content.toLowerCase().trim();
  
  // 1. Récupérer l'état actuel du jeu
  const state = await GameState.findOne({ key: 'global' });
  if (!state || state.currentAnswers.length === 0) return; // Pas de question active

  // 2. Vérifier si la réponse est correcte
  if (state.currentAnswers.includes(reponse)) {
    // 3. Vérifier si l'utilisateur a déjà répondu
    if (state.responders.includes(message.author.id)) {
      message.reply("Vous avez déjà répondu à cette question !");
      return;
    }

    // 4. Attribuer les points
    let pointsGagnes = 0;
    let place = "";
    const respondersCount = state.responders.length;

    if (respondersCount === 0) {
      pointsGagnes = 3;
      place = "premier";
    } else if (respondersCount === 1) {
      pointsGagnes = 2;
      place = "deuxième";
    } else if (respondersCount === 2) {
      pointsGagnes = 1;
      place = "troisième";
    } else {
      // Ce cas ne devrait pas arriver si on gère bien la fin de question
      return; 
    }
    
    // 5. Mettre à jour la DB (Joueur et État du jeu)
    // Ajoute les points au joueur
    await addPoints(message.author.id, message.author.username, pointsGagnes);
    
    // Ajoute le joueur à la liste des répondeurs
    state.responders.push(message.author.id);
    
    // Annonce
    message.reply(`Bravo ${message.author.username} ! C'était la bonne réponse. Vous êtes ${place} et gagnez **${pointsGagnes} points** !`);

    // 6. Si c'était le 3ème, clore la question
    if (state.responders.length >= 3) {
      state.currentQuestion = "La question a été répondue. Prochaine question dans 2h.";
      state.currentAnswers = [];
      client.channels.cache.get(GAME_CHANNEL_ID).send("Les 3 places ont été prises ! La question est terminée.");
    }
    
    // Sauvegarde les changements de l'état du jeu (responders, question)
    await state.save();
  }
});


// =================================================================
// 4. PARTIE TÂCHES PLANIFIÉES (Modifié pour Mongoose)
// =================================================================

// '0 */2 * * *' = toutes les 2 heures
cron.schedule('0 */2 * * *', async () => {
  console.log('[Cron] Lancement de la tâche de nouvelle question.');
  try {
    // 1. Choisir une nouvelle question
    const newQuestion = questions[Math.floor(Math.random() * questions.length)];

    // 2. Mettre à jour l'état du jeu dans la DB
    await GameState.updateOne(
      { key: 'global' },
      {
        currentQuestion: newQuestion.q,
        currentAnswers: newQuestion.a,
        responders: [] // Réinitialiser les répondeurs
      }
    );

    // 3. Envoyer la question dans le salon
    const channel = client.channels.cache.get(GAME_CHANNEL_ID);
    if (channel) {
      const embed = new EmbedBuilder()
        .setTitle("❓ Nouvelle Question Minecraft ! ❓")
        .setDescription(newQuestion.q)
        .setColor(0xFFAA00)
        .setFooter({ text: "Répondez directement dans ce salon. 3 points pour le 1er, 2 pour le 2e, 1 pour le 3e." });
      channel.send({ embeds: [embed] });
    } else {
      console.error(`[Cron] Erreur : Salon ${GAME_CHANNEL_ID} introuvable.`);
    }

  } catch (err) {
    console.error("[Cron] Erreur lors de l'exécution de la tâche :", err);
  }
}, {
  scheduled: true,
  timezone: "Europe/Paris"
});


// --- Connexion ---
client.once(Events.ClientReady, c => {
  console.log(`[Discord] Prêt ! Connecté en tant que ${c.user.tag}`);
});
client.login(token);