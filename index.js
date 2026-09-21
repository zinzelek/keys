// index.js - InstaLing Key Gen Bot (discord.js v14 + Firebase Admin)
// Działa na Railway BEZ dotenv (zmienne wstrzykiwane automatycznie)

import { 
  Client, GatewayIntentBits, REST, Routes, 
  SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} from 'discord.js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

// ===== KONFIGURACJA Z ENV (RAILWAY VARIABLES) =====
// index.js - TYLKO ODCZYT Z ENV
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;      // ← Pusty tutaj, wypełniany na Railway
const CLIENT_ID = process.env.CLIENT_ID;
const FIREBASE_CREDS = process.env.FIREBASE_CREDENTIALS;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;

if (!DISCORD_TOKEN || !CLIENT_ID || !FIREBASE_CREDS || !FIREBASE_DB_URL) {
  console.error('❌ Brakuje zmiennych środowiskowych! Sprawdź Railway Variables.');
  process.exit(1);
}

// ===== INICJALIZACJA FIREBASE ADMIN =====
let serviceAccount;
try { serviceAccount = JSON.parse(FIREBASE_CREDS); } 
catch (e) { console.error('❌ Błąd parsowania FIREBASE_CREDENTIALS:', e); process.exit(1); }

if (!getApps().length) {
  initializeApp({ credential: cert(serviceAccount), databaseURL: FIREBASE_DB_URL });
}
const db = getDatabase();
const licensesRef = db.ref('licenses');

// ===== DISCORD CLIENT =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ===== KOMENDA /gen =====
const genCommand = new SlashCommandBuilder()
  .setName('gen')
  .setDescription('🔐 Generuj klucze licencyjne InstaLing')
  .addStringOption(opt => opt
    .setName('type')
    .setDescription('Typ licencji')
    .setRequired(true)
    .addChoices(
      { name: '💎 LIFETIME (na zawsze)', value: 'LIFETIME' },
      { name: '📅 MONTH (30 dni)', value: 'MONTH' },
      { name: '📆 WEEK (7 dni)', value: 'WEEK' },
      { name: '📅 DAY (24h)', value: 'DAY' }
    ))
  .addIntegerOption(opt => opt
    .setName('count')
    .setDescription('Ile kluczy (1-50)')
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(50))
  .setDefaultMemberPermissions('0'); // Tylko Owner

// ===== REJESTRACJA KOMEND =====
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
async function registerCommands() {
  try {
    console.log('🔄 Rejestruję komendy...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [genCommand.toJSON()] });
    console.log('✅ Komendy zarejestrowane globalnie.');
  } catch (e) { console.error('❌ Błąd rejestracji:', e); }
}

// ===== GENERATOR KLUCZY =====
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeKey() {
  let k = 'VIP-';
  for (let i = 0; i < 4; i++) k += CHARS[Math.random() * CHARS.length | 0];
  k += '-';
  for (let i = 0; i < 4; i++) k += CHARS[Math.random() * CHARS.length | 0];
  return k;
}

function getExpiryMs(type) {
  switch (type) {
    case 'DAY': return 24 * 60 * 60 * 1000;
    case 'WEEK': return 7 * 24 * 60 * 60 * 1000;
    case 'MONTH': return 30 * 24 * 60 * 60 * 1000;
    case 'LIFETIME': return -1;
    default: return 0;
  }
}

// ===== OBSŁUGA INTERAKCJI =====
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'gen') return;

  // Tylko Owner bota
  const app = await client.application.fetch();
  if (interaction.user.id !== app.owner.id) {
    return interaction.reply({ content: '❌ Tylko właściciel bota może generować klucze.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const type = interaction.options.getString('type');
  const count = interaction.options.getInteger('count');
  const now = Date.now();
  const expiresAt = getExpiryMs(type) === -1 ? -1 : now + getExpiryMs(type);

  const generated = [];
  const updates = {};
  for (let i = 0; i < count; i++) {
    const key = makeKey();
    updates[`/licenses/${key}`] = {
      type, status: 'unused', createdAt: now, expiresAt,
      createdBy: interaction.user.tag
    };
    generated.push(key);
  }

  try {
    await db.ref().update(updates);
  } catch (e) {
    console.error('Firebase update error:', e);
  }

  // ===== ODPOWIEDŹ =====
  const embed = new EmbedBuilder()
    .setTitle(`✅ Wygenerowano ${generated.length}/${count} kluczy (${type})`)
    .setColor(type === 'LIFETIME' ? '#FFD700' : '#00FF00')
    .setTimestamp()
    .setFooter({ text: `Wygenerowane przez ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() });

  const chunks = [];
  for (let i = 0; i < generated.length; i += 20) {
    chunks.push(generated.slice(i, i + 20).join('\n'));
  }

  embed.setDescription(chunks[0] || 'Brak kluczy');
  if (chunks.length > 1) {
    embed.addFields({ name: '...i więcej', value: `+${generated.length - 20} kluczy (pełna lista w przycisku)`, inline: false });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`copy_keys_${interaction.id}_${Buffer.from(generated.join(',')).toString('base64').slice(0, 50)}`)
      .setLabel('📋 Skopiuj wszystkie do DM')
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
});

// ===== PRZYCISK KOPIUJ =====
client.on('interactionCreate', async (i) => {
  if (!i.isButton()) return;
  if (!i.customId.startsWith('copy_keys_')) return;

  const keysB64 = i.customId.split('_')[3];
  if (!keysB64) return i.reply({ content: 'Błąd danych.', ephemeral: true });
  
  const keys = Buffer.from(keysB64, 'base64').toString().split(',');
  
  try {
    await i.user.send({
      content: `🔑 **Twoje wygenerowane klucze (${keys.length}):**\n\`\`\`\n${keys.join('\n')}\n\`\`\`\n*Prześlij je użytkownikom. Każdy klucz działa na **1 urządzenie**.*`
    });
    await i.reply({ content: '✅ Wysłałem listę kluczy na PW!', ephemeral: true });
  } catch (e) {
    await i.reply({ content: '❌ Nie mogę wysłać PW (zablokowane?). Włącz "Wiadomości prywatne" w ustawieniach serwera.', ephemeral: true });
  }
});

// ===== START =====
client.once('ready', async () => {
  console.log(`🤖 Zalogowano jako ${client.user.tag}`);
  await registerCommands();
});

client.login(DISCORD_TOKEN).catch(e => { console.error('❌ Login failed:', e); process.exit(1); });
