// --- Importation des modules ---
const { 
  Client, Collection, Events, GatewayIntentBits, 
  REST, Routes, EmbedBuilder, SlashCommandBuilder 
} = require('discord.js');
const express = require('express');
const cron = require('node-cron');
const mongoose = require('mongoose');

// --- Configuration des Secrets ---
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const mongoUri = process.env.MONGO_URI; 
const GAME_CHANNEL_ID = '1430685218351878154'; // ❗❗ REMPLACEZ CECI ❗❗

if (!token || !clientId || !GAME_CHANNEL_ID || !mongoUri) {
  console.error("Erreur : Des variables d'environnement sont manquantes !");
  process.exit(1);
}

// =================================================================
// 0. DÉFINITION DU JEU (Équilibrage)
// =================================================================

const GAME_DATA = {
  items: {
    // Items de base (Boutique)
    'pioche_en_bois': { name: 'Pioche en Bois', price: 10 },
    'pioche_en_pierre': { name: 'Pioche en Pierre', price: 30 },
    'epee_en_pierre': { name: 'Épée en Pierre', price: 25 },
    'lit': { name: 'Lit', price: 15 },
    'oeil_ender': { name: 'Oeil de l\'Ender', price: 100 },
    // Ressources (Actions)
    'bois': { name: 'Bois', price: 0 }, // Ne peut pas être acheté
    'pierre': { name: 'Pierre', price: 0 },
    'fer': { name: 'Fer', price: 0 },
    'diamant': { name: 'Diamant', price: 0 },
    // Items craftés
    'four': { name: 'Four', price: 0 },
    'pioche_en_fer': { name: 'Pioche en Fer', price: 0 },
    'epee_en_diamant': { name: 'Épée en Diamant', price: 0 },
  },
  recipes: {
    // ID de l'item à crafter
    'four': {
      name: 'Four',
      materials: [{ id: 'pierre', qty: 8 }]
    },
    'pioche_en_pierre': {
      name: 'Pioche en Pierre',
      materials: [{ id: 'pierre', qty: 3 }, { id: 'bois', qty: 2 }]
    },
    'pioche_en_fer': {
      name: 'Pioche en Fer',
      materials: [{ id: 'fer', qty: 3 }, { id: 'bois', qty: 2 }]
    },
    'epee_en_diamant': {
      name: 'Épée en Diamant',
      materials: [{ id: 'diamant', qty: 2 }, { id: 'bois', qty: 1 }]
    }
    // Ajoutez plus de crafts ici
  },
  actions: {
    'miner_pierre': {
      cost: 1, // Coût en points
      requires: ['pioche_en_bois', 'pioche_en_pierre', 'pioche_en_fer'], // Nécessite n'importe laquelle
      rewards: [{ id: 'pierre', qty: 1, chance: 1.0 }] // 100%
    },
    'miner_fer': {
      cost: 2,
      requires: ['pioche_en_pierre', 'pioche_en_fer'], // Pioche en bois ne marche pas
      rewards: [{ id: 'fer', qty: 1, chance: 0.5 }, { id: 'pierre', qty: 1, chance: 1.0 }] // 50% fer, 100% pierre
    },
    'miner_diamant': {
      cost: 5,
      requires: ['pioche_en_fer'], // Seule la pioche en fer
      rewards: [{ id: 'diamant', qty: 1, chance: 0.1 }, { id: 'pierre', qty: 1, chance: 1.0 }] // 10% diamant
    },
    'tuer_le_dragon': {
      cost: 50, // Coût final
      requires: ['epee_en_diamant', 'oeil_ender'], // Le 'check' sera spécial (12 yeux)
      rewards: []
    }
  }
};


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

const playerSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  userName: { type: String, required: true },
  points: { type: Number, default: 0 },
  completionPercent: { type: Number, default: 0 },
  inventory: { type: Map, of: Number, default: {} } 
});
const Player = mongoose.model('Player', playerSchema);

const gameStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'global' },
  currentQuestion: { type: String, default: "Pas de question en cours." },
  currentAnswers: { type: [String], default: [] },
  responders: { type: [String], default: [] }
});
const GameState = mongoose.model('GameState', gameStateSchema);

mongoose.connect(mongoUri)
  .then(async () => {
    console.log('[DB] Connecté à MongoDB Atlas !');
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

// --- Fonctions de gestion (asynchrones) ---
async function getPlayer(userId, userName) {
  let player = await Player.findOne({ userId: userId });
  if (!player) {
    player = new Player({ userId: userId, userName: userName });
    await player.save();
  } else if (player.userName !== userName) {
    player.userName = userName;
    await player.save();
  }
  return player;
}

async function addPoints(userId, userName, amount) {
  await Player.findOneAndUpdate(
    { userId: userId },
    { $inc: { points: amount }, $set: { userName: userName } },
    { upsert: true }
  );
}

// =================================================================
// 3. PARTIE BOT DISCORD (Commandes + Logique de jeu)
// =================================================================

// --- Banque de Questions ---
const questions = [
  { q: "Quel bloc faut-il miner pour obtenir du diamant ?", a: ["diamant", "minerai de diamant"] },
  { q: "Combien de planches de bois faut-il pour faire un établi ?", a: ["4", "quatre"] },
  { q: "Quel mob hostile explose quand il s'approche de vous ?", a: ["creeper"] },
  { q: "Quel outil est nécessaire pour miner de la pierre ?", a: ["pioche", "pioche en bois"] }
];

// --- Client Discord ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
client.commands = new Collection();
const commands = []; // Array pour stocker les définitions de commandes

// --- Commande /ping ---
commands.push(new SlashCommandBuilder().setName('ping').setDescription('Vérifie la latence du bot.').toJSON());
client.commands.set('ping', {
  async execute(interaction) {
    const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
    interaction.editReply(`Pong! 🏓 Latence : ${sent.createdTimestamp - interaction.createdTimestamp}ms`);
  }
});

// --- Commande /classement ---
commands.push(new SlashCommandBuilder().setName('classement').setDescription('Affiche les 10 meilleurs joueurs.').toJSON());
client.commands.set('classement', {
  async execute(interaction) {
    const top10 = await Player.find().sort({ points: -1 }).limit(10);
    if (top10.length === 0) return interaction.reply("Personne n'a encore de points !");
    const embed = new EmbedBuilder().setTitle("🏆 Classement du Serveur 🏆").setColor(0x00AE86);
    let description = "";
    top10.forEach((player, index) => {
      description += `**${index + 1}.** ${player.userName} - ${player.points} points (${player.completionPercent}%)\n`;
    });
    embed.setDescription(description);
    await interaction.reply({ embeds: [embed] });
  }
});

// --- Commande /question ---
commands.push(new SlashCommandBuilder().setName('question').setDescription('Affiche la question active.').toJSON());
client.commands.set('question', {
  async execute(interaction) {
    const state = await GameState.findOne({ key: 'global' });
    await interaction.reply(`**Question actuelle :**\n${state.currentQuestion}`);
  }
});

// --- Commande /inventaire ---
commands.push(new SlashCommandBuilder().setName('inventaire').setDescription('Affiche vos points et votre inventaire.').toJSON());
client.commands.set('inventaire', {
  async execute(interaction) {
    const player = await getPlayer(interaction.user.id, interaction.user.username);
    const embed = new EmbedBuilder()
      .setTitle(`🎒 Inventaire de ${player.userName}`)
      .setColor(0x55AADD)
      .addFields(
        { name: 'Points', value: `${player.points} points`, inline: true },
        { name: 'Progression', value: `${player.completionPercent}%`, inline: true }
      );

    if (player.inventory.size === 0) {
      embed.setDescription("Votre inventaire est vide.");
    } else {
      let invString = "";
      for (const [itemId, quantity] of player.inventory.entries()) {
        const item = GAME_DATA.items[itemId];
        if (item && quantity > 0) { // N'affiche pas les items à 0
          invString += `**${item.name}** : ${quantity}\n`;
        }
      }
      embed.setDescription(invString || "Votre inventaire est vide.");
    }
    await interaction.reply({ embeds: [embed] });
  }
});

// --- Commande /boutique ---
commands.push(new SlashCommandBuilder().setName('boutique').setDescription('Affiche les items achetables avec des points.').toJSON());
client.commands.set('boutique', {
  async execute(interaction) {
    const embed = new EmbedBuilder().setTitle("🛒 Boutique du Serveur").setColor(0x9B59B6);
    let description = "Utilisez `/acheter [id_item]` pour acheter.\n\n";
    for (const itemId in GAME_DATA.items) {
      const item = GAME_DATA.items[itemId];
      if (item.price > 0) { // N'affiche que les items avec un prix
        description += `**${item.name}** (ID: \`${itemId}\`) - ${item.price} points\n`;
      }
    }
    embed.setDescription(description);
    await interaction.reply({ embeds: [embed] });
  }
});

// --- Commande /acheter ---
commands.push(new SlashCommandBuilder().setName('acheter')
  .setDescription('Acheter un item de la boutique.')
  .addStringOption(option => 
    option.setName('item_id')
    .setDescription("L'ID de l'item à acheter (voir /boutique)")
    .setRequired(true)
  ).toJSON()
);
client.commands.set('acheter', {
  async execute(interaction) {
    const itemId = interaction.options.getString('item_id').toLowerCase();
    const item = GAME_DATA.items[itemId];

    if (!item || item.price === 0) {
      return interaction.reply({ content: "Cet item n'existe pas ou ne peut pas être acheté.", ephemeral: true });
    }

    const player = await getPlayer(interaction.user.id, interaction.user.username);

    if (player.points < item.price) {
      return interaction.reply({ content: `Il vous manque ${item.price - player.points} points pour acheter ça.`, ephemeral: true });
    }

    // Transaction
    player.points -= item.price;
    const currentQty = player.inventory.get(itemId) || 0;
    player.inventory.set(itemId, currentQty + 1);
    await player.save();

    await interaction.reply(`Vous avez acheté **1x ${item.name}** pour ${item.price} points !`);
  }
});

// --- Commande /craft ---
commands.push(new SlashCommandBuilder().setName('craft')
  .setDescription('Crafter un item à partir de ressources.')
  .addStringOption(option => 
    option.setName('item_id')
    .setDescription("L'ID de l'item à crafter (ex: four)")
    .setRequired(true)
  ).toJSON()
);
client.commands.set('craft', {
  async execute(interaction) {
    const itemId = interaction.options.getString('item_id').toLowerCase();
    const recipe = GAME_DATA.recipes[itemId];

    if (!recipe) {
      return interaction.reply({ content: "Cet item ne peut pas être crafté ou n'existe pas.", ephemeral: true });
    }

    const player = await getPlayer(interaction.user.id, interaction.user.username);
    const missingMaterials = [];

    // 1. Vérifier les matériaux
    for (const material of recipe.materials) {
      const hasQty = player.inventory.get(material.id) || 0;
      if (hasQty < material.qty) {
        missingMaterials.push(`${material.qty - hasQty}x ${GAME_DATA.items[material.id].name}`);
      }
    }

    if (missingMaterials.length > 0) {
      return interaction.reply({ content: `Craft impossible. Il vous manque : ${missingMaterials.join(', ')}.`, ephemeral: true });
    }

    // 2. Transaction (retirer matériaux, ajouter item)
    for (const material of recipe.materials) {
      const hasQty = player.inventory.get(material.id);
      player.inventory.set(material.id, hasQty - material.qty);
    }
    const craftedQty = player.inventory.get(itemId) || 0;
    player.inventory.set(itemId, craftedQty + 1);
    
    await player.save();

    await interaction.reply(`🎉 Vous avez crafté **1x ${recipe.name}** !`);
  }
});

// --- Commande /action ---
commands.push(new SlashCommandBuilder().setName('action')
  .setDescription('Effectuer une action (miner, combattre...).')
  .addStringOption(option => 
    option.setName('nom')
    .setDescription("L'action à effectuer (ex: miner_pierre)")
    .setRequired(true)
  ).toJSON()
);
client.commands.set('action', {
  async execute(interaction) {
    const actionId = interaction.options.getString('nom').toLowerCase();
    const action = GAME_DATA.actions[actionId];

    if (!action) {
      return interaction.reply({ content: "Cette action n'existe pas.", ephemeral: true });
    }

    const player = await getPlayer(interaction.user.id, interaction.user.username);

    // 1. Vérifier les points
    if (player.points < action.cost) {
      return interaction.reply({ content: `Il vous faut ${action.cost} points pour faire ça. Il vous en manque ${action.cost - player.points}.`, ephemeral: true });
    }

    // 2. Vérifier les outils requis
    let hasRequiredTool = false;
    if (action.requires && action.requires.length > 0) {
      for (const toolId of action.requires) {
        if ((player.inventory.get(toolId) || 0) > 0) {
          hasRequiredTool = true;
          break; // Il a au moins un des outils
        }
      }
      if (!hasRequiredTool) {
        const toolNames = action.requires.map(id => GAME_DATA.items[id].name).join(' ou ');
        return interaction.reply({ content: `Il vous faut un outil pour faire ça (ex: ${toolNames}).`, ephemeral: true });
      }
    }
    
    // --- Cas spécial : Tuer le dragon ---
    if (actionId === 'tuer_le_dragon') {
      const eyes = player.inventory.get('oeil_ender') || 0;
      if (eyes < 12) {
        return interaction.reply({ content: `Il vous faut 12 Yeux de l'Ender pour activer le portail. Il vous en manque ${12 - eyes} !`, ephemeral: true });
      }
      
      player.points -= action.cost;
      player.inventory.set('oeil_ender', eyes - 12); // Consomme les yeux
      player.completionPercent = 100; // Victoire !
      await player.save();
      
      const embed = new EmbedBuilder()
        .setTitle("🎉 VICTOIRE ! 🎉")
        .setDescription(`Félicitations ${player.userName} ! Vous avez vaincu l'Ender Dragon !\nVotre progression est maintenant à 100% !`)
        .setColor(0x00FF00);
      return interaction.reply({ embeds: [embed] });
    }
    // --- Fin cas spécial ---

    // 3. Transaction (coût + récompenses)
    player.points -= action.cost;
    let rewardsString = `Action \`${actionId}\` effectuée (-${action.cost} points) !\nRécompenses :`;
    let hasRewards = false;

    for (const reward of action.rewards) {
      if (Math.random() <= reward.chance) { // Test de chance
        const currentQty = player.inventory.get(reward.id) || 0;
        player.inventory.set(reward.id, currentQty + reward.qty);
        rewardsString += `\n+ ${reward.qty}x ${GAME_DATA.items[reward.id].name}`;
        hasRewards = true;
      }
    }

    if (!hasRewards) {
      rewardsString += "\n(Rien obtenu cette fois...)";
    }

    await player.save();
    await interaction.reply(rewardsString);
  }
});


// =================================================================
// 4. PARTIE GESTIONNAIRES & CRON
// =================================================================

// --- Enregistrement des commandes (/) ---
const rest = new REST({ version: '10' }).setToken(token);
(async () => {
  try {
    console.log(`[Discord] Rafraîchissement de ${commands.length} commande(s) (/).`);
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }, // 'commands' est maintenant l'array de définitions JSON
    );
    console.log(`[Discord] ${commands.length} commande(s) (/) rechargée(s).`);
  } catch (error) {
    console.error(error);
  }
})();

// --- Gestionnaire d'interactions (pour les slash commands) ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName); // Récupère l'objet { execute: ... }
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    await interaction.reply({ content: 'Il y a eu une erreur!', ephemeral: true });
  }
});

// --- Gestionnaire de Messages (pour les réponses aux questions) ---
client.on(Events.MessageCreate, async message => {
  if (message.author.bot || message.channel.id !== GAME_CHANNEL_ID) return;

  const reponse = message.content.toLowerCase().trim();
  const state = await GameState.findOne({ key: 'global' });
  if (!state || state.currentAnswers.length === 0) return;

  if (state.currentAnswers.includes(reponse)) {
    if (state.responders.includes(message.author.id)) {
      message.reply("Vous avez déjà répondu à cette question !");
      return;
    }

    let pointsGagnes = 0;
    let place = "";
    const respondersCount = state.responders.length;

    if (respondersCount === 0) { pointsGagnes = 3; place = "premier"; }
    else if (respondersCount === 1) { pointsGagnes = 2; place = "deuxième"; }
    else if (respondersCount === 2) { pointsGagnes = 1; place = "troisième"; }
    else { return; }
    
    await addPoints(message.author.id, message.author.username, pointsGagnes);
    state.responders.push(message.author.id);
    
    message.reply(`Bravo ${message.author.username} ! Vous êtes ${place} et gagnez **${pointsGagnes} points** !`);

    if (state.responders.length >= 3) {
      state.currentQuestion = "La question a été répondue. Prochaine question dans 2h.";
      state.currentAnswers = [];
      client.channels.cache.get(GAME_CHANNEL_ID).send("Les 3 places ont été prises ! La question est terminée.");
    }
    
    await state.save();
  }
});

// --- Tâches Planifiées (node-cron) ---
// '0 */2 * * *' = toutes les 2 heures
cron.schedule('0 */2 * * *', async () => {
  console.log('[Cron] Lancement de la tâche de nouvelle question.');
  try {
    const newQuestion = questions[Math.floor(Math.random() * questions.length)];
    await GameState.updateOne(
      { key: 'global' },
      { currentQuestion: newQuestion.q, currentAnswers: newQuestion.a, responders: [] }
    );
    const channel = client.channels.cache.get(GAME_CHANNEL_ID);
    if (channel) {
      const embed = new EmbedBuilder()
        .setTitle("❓ Nouvelle Question Minecraft ! ❓")
        .setDescription(newQuestion.q)
        .setColor(0xFFAA00)
        .setFooter({ text: "Répondez directement dans ce salon. 3 points pour le 1er, 2 pour le 2e, 1 pour le 3e." });
      channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("[Cron] Erreur lors de l'exécution de la tâche :", err);
  }
}, {
  scheduled: true,
  timezone: "Europe/Paris" // Assurez-vous que c'est votre fuseau horaire
});


// --- Connexion ---
client.once(Events.ClientReady, c => {
  console.log(`[Discord] Prêt ! Connecté en tant que ${c.user.tag}`);
});
client.login(token);