// index.js
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const http = require('http')
const {
  Client,
  GatewayIntentBits,
  Partials,
  Routes,
  REST,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js')

// ─────────────────────────── Client (ograniczony cache) ───────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel, Partials.Message],
  sweepers: {
    messages: { interval: 300, lifetime: 900 }
  }
})

// ─────────────────────────── Stan ───────────────────────────
const raids = new Map() // Map<panelId, State>
const genPanelId = () => crypto.randomUUID()

// muteks per panel (prosty kolejkujący lock)
const locks = new Map()
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve()
  let unlock
  const p = new Promise(res => (unlock = res))
  locks.set(key, prev.then(() => p))
  try { return await fn() }
  finally { unlock(); if (locks.get(key) === p) locks.delete(key) }
}

// ─────────────────────────── Trwałość ───────────────────────────
const DATA_PATH = process.env.RAIDS_PATH || path.join(__dirname, 'raids.json')
if (!fs.existsSync(DATA_PATH)) fs.writeFileSync(DATA_PATH, JSON.stringify({}), 'utf8')

function parsePolishDate(dateText, timeText) {
  if (!dateText || !timeText) return null
  const norm = s => s.toLowerCase().replaceAll(',', ' ').replaceAll('.', ' ').replaceAll('-', ' ').replace(/\s+/g, ' ').trim()
  const MONTHS = {
    'stycznia': 1, 'styczen': 1, 'styczeń': 1,
    'lutego': 2, 'luty': 2,
    'marca': 3, 'marzec': 3,
    'kwietnia': 4, 'kwiecien': 4, 'kwiecień': 4,
    'maja': 5, 'maj': 5,
    'czerwca': 6, 'czerwiec': 6,
    'lipca': 7, 'lipiec': 7,
    'sierpnia': 8, 'sierpien': 8, 'sierpień': 8,
    'września': 9, 'wrzesnia': 9, 'wrzesien': 9, 'wrzesień': 9,
    'października': 10, 'pazdziernika': 10, 'pazdziernik': 10, 'październik': 10,
    'listopada': 11, 'listopad': 11,
    'grudnia': 12, 'grudzien': 12, 'grudzień': 12
  }
  const d = norm(dateText), t = norm(timeText)

  let day, month, year
  const num = d.match(/(\d{1,2})\s+(\d{1,2})\s+(\d{4})/)
  if (num) {
    day = parseInt(num[1], 10); month = parseInt(num[2], 10); year = parseInt(num[3], 10)
  } else {
    const parts = d.split(' ')
    let i = 0
    if (isNaN(parseInt(parts[0], 10))) i = 1
    day = parseInt(parts[i], 10)
    const mname = parts[i + 1]
    year = parseInt(parts[i + 2], 10)
    month = MONTHS[mname]
  }
  if (!day || !month || !year) return null

  const tm = t.match(/(\d{1,2})\s*:\s*(\d{2})/)
  if (!tm) return null
  const hh = parseInt(tm[1], 10), mm = parseInt(tm[2], 10)
  if (isNaN(hh) || isNaN(mm)) return null

  return new Date(year, month - 1, day, hh, mm, 0, 0)
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_PATH)) return
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))
    for (const [panelId, s] of Object.entries(raw)) {
      const state = {
        panelId,
        capacity: s.capacity,
        main: s.main || [],
        reserve: s.reserve || [],
        meta: s.meta || {},
        channelId: s.channelId || null,
        messageId: s.messageId || null,
        guildId: s.guildId || null,
      }
      // zapewnij tablicę oczekujących promocji
      if (!state.meta.pendingPromotions) state.meta.pendingPromotions = []
      if (!state.meta.startAt) {
        const d = parsePolishDate(state.meta.dateText, state.meta.timeText)
        if (d) state.meta.startAt = d.getTime()
      }
      raids.set(panelId, state)
    }
    console.log(`🔁 Wczytano stan ${raids.size} raid(ów) z raids.json`)
  } catch (e) {
    console.error('Błąd wczytywania raids.json:', e)
  }
}

let saveTimer = null
function saveState() {
  const obj = {}
  for (const [k, v] of raids.entries()) obj[k] = v
  try { fs.writeFileSync(DATA_PATH, JSON.stringify(obj, null, 2), 'utf8') }
  catch (e) { console.error('Błąd zapisu raids.json:', e) }
}
function saveStateDebounced() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 500) }

// ─────────────────────────── Emoji helpers ───────────────────────────
function _findEmoji(guild, nameWithColons) {
  if (!guild) return null
  const clean = String(nameWithColons).replace(/:/g, '')
  return guild.emojis?.cache?.find(e => e.name === clean) || null
}
function emStr(guild, nameWithColons) {
  const e = _findEmoji(guild, nameWithColons)
  return e ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : `:${nameWithColons}:`
}
function emObj(guild, nameWithColons) {
  const e = _findEmoji(guild, nameWithColons)
  return e ? { id: e.id } : undefined
}
const CLASS_OPTIONS = ['Łucznik', 'Wojownik', 'Mag', 'MSW']
const CLASS_TO_TOKEN = { 'Łucznik': 'lucznik', 'Wojownik': 'woj', 'Mag': 'mag', 'MSW': 'msw' }
function classEmojiName(cls) {
  if (cls === 'Łucznik') return 'Lucznik'
  if (cls === 'Wojownik') return 'Wojownik'
  if (cls === 'Mag') return 'Mag'
  if (cls === 'MSW') return 'Msw'
  return null
}
function spEmojiName(cls, sp) { return `sp${sp}${CLASS_TO_TOKEN[cls] || 'lucznik'}` }

// ─────────────────────────── Utils ───────────────────────────
const fmtNowPL = () => new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })
function humanizeDelta(ms) {
  const sign = ms >= 0 ? 1 : -1
  const abs = Math.abs(ms)
  const d = Math.floor(abs / (24 * 60 * 60 * 1000))
  const h = Math.floor((abs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
  const m = Math.floor((abs % (60 * 60 * 1000)) / (60 * 1000))
  const parts = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m || (!d && !h)) parts.push(`${m}m`)
  return sign > 0 ? `za ${parts.join(' ')}` : `${parts.join(' ')} temu`
}
function classEmoji(guild, cls) {
  const name = classEmojiName(cls)
  return name ? emStr(guild, name) : ''
}
function spEmoji(guild, cls, sp) { return emStr(guild, spEmojiName(cls, sp)) }
function equipmentBlock(guild) {
  return (
    '**Wyposażenie:**\n' +
    `${emStr(guild, 'Ancelloan')} Ancek dla peta\n` +
    `${emStr(guild, 'Wzmacniacz')} Wzmacniacz wrózki\n` +
    `${emStr(guild, 'Tarot')} Demon/słońce 250\n` +
    `${emStr(guild, 'Eliksirataku')} Potki ataku\n` +
    `${emStr(guild, 'Fulka')} Fulki\n`
  )
}
function userLine(guild, entry, index) {
  const tag = `<@${entry.userId}>`
  const clsEm = classEmoji(guild, entry.cls)
  const spEm  = spEmoji(guild, entry.cls, entry.sp)
  const alt   = entry.isAlt ? ' (Alt)' : ''
  return `${index}. ${tag} ${clsEm} [${entry.cls}] ${spEm} [SP ${entry.sp}]${alt}`
}
function getStateByAnyId(anyId) {
  if (raids.has(anyId)) return raids.get(anyId)
  for (const [, st] of raids.entries()) if (st && st.messageId === anyId) return st
  return null
}

// ─────────────────────────── Permission / error helpers ───────────────────────────
function isMissingAccess(err) {
  return (
    (err && (err.code === 50001 || err.status === 403)) ||
    /Missing Access/i.test(String(err?.message || ''))
  )
}
function canPost(channel) {
  try {
    const me = channel?.guild?.members?.me
    if (!me) return true
    const perms = channel.permissionsFor(me)
    if (!perms) return true
    return (
      perms.has(PermissionFlagsBits.ViewChannel) &&
      perms.has(PermissionFlagsBits.SendMessages) &&
      perms.has(PermissionFlagsBits.EmbedLinks)
    )
  } catch { return true }
}

// ─────────────────────────── Soft recovery z wiadomości (z odtworzeniem rosteru) ───────────────────────────
async function recoverFromMessage(interaction, panelId) {
  try {
    const msg = interaction?.message
    if (!msg) return null

    const emb = msg.embeds?.[0]
    const desc = emb?.data?.description || emb?.description || ''
    if (!desc) return null

    // meta
    const leaderMatch = desc.match(/\*\*Lider:\*\*\s*<@!?(\d+)>/)
    const leaderId = leaderMatch?.[1] || interaction.user?.id

    const coMatch = desc.match(/\*\*Co:\*\*\s*([^\n]+)/)
    const raidName = coMatch ? coMatch[1].trim() : 'Raid'

    const kiedyMatch = desc.match(/\*\*Kiedy:\*\*\s*(.+?)\s*\[(.+?)\]/)
    let dateText = '', timeText = '', duration = ''
    if (kiedyMatch) {
      const kiedyRaw = (kiedyMatch[1] || '').trim()
      duration = (kiedyMatch[2] || '').trim()
      const partsDT = kiedyRaw.split(' ')
      timeText = partsDT[partsDT.length - 1] || ''
      dateText = kiedyRaw.replace(new RegExp(`\\s*${timeText}\\s*$`), '').trim()
    }

    let requirements = '—'
    {
      const m = desc.match(/\*\*Wymogi:\*\*([\s\S]*?)──────────────────────────────/)
      if (m) requirements = m[1].trim()
    }

    // capacity
    let capacity = 20
    {
      const m = desc.match(/\*\*Skład\s*\(\s*\d+\s*\/\s*(\d+)\s*\)\s*:\*\*/)
      if (m) {
        const capNum = parseInt(m[1], 10)
        if (!isNaN(capNum) && capNum > 0) capacity = capNum
      }
    }

    // parser rosteru
    function parseRosterBlock(blockText) {
      const out = []
      const lines = blockText.split('\n')
      for (const ln of lines) {
        if (!ln.trim() || /—$/.test(ln.trim())) continue
        const id = (ln.match(/<@!?(\d+)>/) || [])[1]
        if (!id) continue
        const cls = (ln.match(/\[(Łucznik|Wojownik|Mag|MSW)\]/i) || [])[1]
        let sp = parseInt((ln.match(/\[SP\s*(\d{1,2})\]/i) || [])[1], 10)
        if (isNaN(sp)) sp = undefined
        const isAlt = /\(Alt\)/i.test(ln)
        out.push({ userId: id, cls: cls || 'Łucznik', sp: sp || 1, isAlt: !!isAlt })
      }
      return out
    }

    let main = []
    let reserve = []
    {
      const mainMatch = desc.match(/\*\*Skład[^\n]*:\*\*([\s\S]*?)\n\s*\n/)
      const afterMain = mainMatch ? desc.slice(mainMatch.index + mainMatch[0].length - mainMatch[1].length) : ''
      const reserveMatch =
        desc.match(/\*\*Rezerwa:\*\*([\s\S]*)$/) ||
        (afterMain ? afterMain.match(/\*\*Rezerwa:\*\*([\s\S]*)$/) : null)

      if (mainMatch) main = parseRosterBlock(mainMatch[1].trim())
      if (reserveMatch) reserve = parseRosterBlock(reserveMatch[1].trim())
    }

    const startAtDate = parsePolishDate(dateText, timeText)
    const meta = {
      leaderId,
      leaderMention: `<@${leaderId}>`,
      raidName,
      requirements,
      dateText,
      timeText,
      duration,
      startAt: startAtDate ? startAtDate.getTime() : undefined,
      closed: false,
      pendingPromotions: [], // po adopcji brak zaplanowanych
    }

    const state = {
      panelId,
      capacity,
      main,
      reserve,
      meta,
      channelId: msg.channelId,
      messageId: msg.id,
      guildId: msg.guildId,
    }

    raids.set(panelId, state)
    saveStateDebounced()
    console.log(`♻️ Recovery: adoptowano panel ${panelId} z wiadomości (odtworzono ${main.length}+${reserve.length}).`)
    return state
  } catch (e) {
    console.error('recoverFromMessage error:', e)
    return null
  }
}

// ─────────────────────────── PROMOCJE Z REZERWY – opóźnienie 5 min ───────────────────────────
const PROMOTION_DELAY_MS = 5 * 60 * 1000

function cleanupPendingForUser(state, userId) {
  state.meta.pendingPromotions = (state.meta.pendingPromotions || []).filter(p => p.userId !== userId)
}

function schedulePromotions(state) {
  if (!state.meta.pendingPromotions) state.meta.pendingPromotions = []
  const pendingSet = new Set(state.meta.pendingPromotions.map(p => p.userId))
  let free = Math.max(0, state.capacity - state.main.length)
  if (free <= 0) return

  for (const entry of state.reserve) {
    if (free <= 0) break
    if (pendingSet.has(entry.userId)) continue
    // zaplanuj dla tej osoby
    state.meta.pendingPromotions.push({
      userId: entry.userId,
      scheduledAt: Date.now() + PROMOTION_DELAY_MS
    })
    pendingSet.add(entry.userId)
    free -= 1
  }
  saveStateDebounced()
}

// co 10s realizuj zaplanowane promocje (po upływie 5 min i gdy jest wolny slot)
setInterval(async () => {
  const now = Date.now()
  for (const [, state] of raids) {
    try {
      if (!state.meta?.pendingPromotions || state.meta.pendingPromotions.length === 0) continue
      // ile faktycznie wolnych gniazd?
      let free = Math.max(0, state.capacity - state.main.length)
      if (free <= 0) continue

      // promuj w kolejności zaplanowania
      const due = state.meta.pendingPromotions
        .filter(p => p.scheduledAt <= now)

      if (due.length === 0) continue

      const guild = client.guilds.cache.get(state.guildId)
      const channel = guild?.channels?.cache?.get(state.channelId) || (await client.channels.fetch(state.channelId).catch(() => null))

      for (const p of due) {
        if (free <= 0) break
        // osoba musi nadal być pierwsza (lub przynajmniej w rezerwie)
        const idx = state.reserve.findIndex(e => e.userId === p.userId)
        if (idx === -1) {
          // nie ma jej już w rezerwie -> usuń z pending
          state.meta.pendingPromotions = state.meta.pendingPromotions.filter(x => x !== p)
          continue
        }
        // jeśli nie ma wolnego miejsca, przerwij (bez usuwania p – spróbujemy w następnym tyku)
        if (state.main.length >= state.capacity) break

        // przeniesienie: z rezerwy do składu
        const entry = state.reserve.splice(idx, 1)[0]
        state.main.push(entry)
        free = Math.max(0, state.capacity - state.main.length)

        // usuń z pending (zrealizowane)
        state.meta.pendingPromotions = state.meta.pendingPromotions.filter(x => x !== p)

        // ogłoszenie z oznaczeniem
        if (channel && canPost(channel)) {
          try {
            await channel.send(`:fire: <@${entry.userId}> **został(a) przeniesion(y/a) do głównego składu** — ${fmtNowPL()}.`)
          } catch (e) { if (!isMissingAccess(e)) console.error(e) }
        }

        // odśwież embed
        try {
          const msg = await channel?.messages?.fetch(state.messageId)
          const newEmbed = buildEmbed(guild, state)
          await msg?.edit({
            embeds: [newEmbed],
            components: [buttonsRow(state.panelId, !!state.meta.closed), altButtonsRow(state.panelId, !!state.meta.closed), manageRow(state.panelId)]
          })
        } catch (e) { if (!isMissingAccess(e)) console.error(e) }
      }

      saveStateDebounced()
    } catch (e) {
      console.error('Promotion ticker error:', e)
    }
  }
}, 10 * 1000)

// ─────────────────────────── Render ───────────────────────────
function buildEmbed(guild, { meta, main, reserve, capacity }) {
  const { leaderMention, raidName, dateText, timeText, duration, requirements, closed } = meta
  const head =
    `**Lider:** ${leaderMention}\n` +
    `**Co:** ${raidName}\n\n` +
    `**Kiedy:** ${dateText} ${timeText} [${duration}]\n` +
    (closed ? '**[Zapisy zamknięte]**\n' : '') +
    '──────────────────────────────\n'
  const reqAndEquip =
    `**Wymogi:**\n${requirements}\n` +
    equipmentBlock(guild) +
    '──────────────────────────────\n'

  const mainLines = []
  for (let i = 0; i < capacity; i++) {
    const entry = main[i]
    mainLines.push(entry ? userLine(guild, entry, i + 1) : `${i + 1}. —`)
  }
  const reserveList = reserve.length ? reserve.map((e, i) => userLine(guild, e, i + 1)).join('\n') : '—'

  return new EmbedBuilder()
    .setTitle('Dymacho Rajd')
    .setDescription(
      head +
      reqAndEquip +
      `**Skład ( ${main.length}/${capacity} ):**\n${mainLines.join('\n')}\n\n` +
      `**Rezerwa:**\n${reserveList}`
    )
}

function buttonsRow(panelId, closed = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`raid:${panelId}:signup`).setLabel('Zapisz się / Zmień SP').setStyle(ButtonStyle.Success).setDisabled(closed),
    new ButtonBuilder().setCustomId(`raid:${panelId}:signout`).setLabel('Wypisz się').setStyle(ButtonStyle.Danger).setDisabled(closed),
    new ButtonBuilder().setCustomId(`raid:${panelId}:help`).setLabel('Pomoc').setStyle(ButtonStyle.Secondary),
  )
}
function altButtonsRow(panelId, closed = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`raid:${panelId}:signup_alt`).setLabel('Zapisz Alta').setStyle(ButtonStyle.Primary).setDisabled(closed),
    new ButtonBuilder().setCustomId(`raid:${panelId}:leave_alts`).setLabel('Usuń Alty').setStyle(ButtonStyle.Secondary).setDisabled(closed),
    new ButtonBuilder().setCustomId(`raid:${panelId}:signout_all`).setLabel('Wypisz (Wszystko)').setStyle(ButtonStyle.Danger).setDisabled(closed),
  )
}
function manageRow(panelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`raid:${panelId}:manage`).setLabel('Zarządzaj').setStyle(ButtonStyle.Secondary),
  )
}
function managePanelRow(panelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`raid:${panelId}:m_add`).setLabel('Dodaj osobę').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`raid:${panelId}:m_remove`).setLabel('Usuń osobę').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`raid:${panelId}:m_setdate`).setLabel('Zmień termin').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`raid:${panelId}:m_setleader`).setLabel('Zmień lidera').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`raid:${panelId}:m_promote`).setLabel('Do składu').setStyle(ButtonStyle.Primary),
  )
}
function managePanelRow2(panelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`raid:${panelId}:m_demote`).setLabel('Do rezerwy').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`raid:${panelId}:m_ping`).setLabel('Oznacz zapisanych').setStyle(ButtonStyle.Secondary),
  )
}

function classSelect(panelId, kind, guild) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`raid:${panelId}:pickclass:${kind}`)
      .setPlaceholder('Wybierz klasę')
      .addOptions(
        CLASS_OPTIONS.map(c => ({
          label: c, value: c, emoji: emObj(guild, classEmojiName(c))
        }))
      )
  )
}
function spSelect(panelId, kind, cls, guild) {
  const count = cls === 'MSW' ? 7 : 11
  const options = Array.from({ length: count }, (_, i) => {
    const n = i + 1
    return { label: `SP ${n}`, value: String(n), emoji: emObj(guild, spEmojiName(cls, n)) }
  })
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`raid:${panelId}:picksp:${kind}:${cls}`)
      .setPlaceholder('Wybierz SP')
      .addOptions(options)
  )
}

// ─────────────────────────── /raid ───────────────────────────
const raidCreateCmd = new SlashCommandBuilder()
  .setName('raid')
  .setDescription('Utwórz ogłoszenie rajdu z zapisami')
  .addStringOption(o => o.setName('jaki_raid').setDescription('Jaki rajd').setRequired(true))
  .addStringOption(o => o.setName('wymogi').setDescription('Wymogi').setRequired(true))
  .addIntegerOption(o =>
    o.setName('ilosc_slotow')
     .setDescription('Ilość miejsc (max 20)')
     .setMinValue(1)
     .setMaxValue(20)
     .setRequired(true)
  )
  .addStringOption(o => o.setName('data').setDescription('Data (np. Wtorek, 11 listopada 2025 / 11.11.2025)').setRequired(true))
  .addStringOption(o => o.setName('godzina').setDescription('Godzina (np. 21:00)').setRequired(true))
  .addStringOption(o => o.setName('czas_trwania').setDescription('Czas trwania (np. 1h)').setRequired(true))

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN)
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.DEV_GUILD_ID),
    { body: [raidCreateCmd.toJSON()] }
  )
  console.log('✅ Zarejestrowano /raid (guild).')
}

client.once('ready', async () => {
  console.log(`Zalogowano jako ${client.user.tag}`)
  try { await registerCommands() } catch (e) { console.error('Rejestracja komend nie powiodła się:', e) }
  loadState()

  // watchdog auto-close co 60s
  setInterval(async () => {
    const now = Date.now()
    for (const [, state] of raids) {
      const start = state.meta?.startAt
      if (!state.meta?.closed && typeof start === 'number' && now >= (start + 10 * 60 * 1000)) {
        state.meta.closed = true
        try {
          const guild = client.guilds.cache.get(state.guildId)
          const channel = guild?.channels?.cache?.get(state.channelId) || (await client.channels.fetch(state.channelId))
          const msg = await channel.messages.fetch(state.messageId)
          const newEmbed = buildEmbed(guild, state)
          await msg.edit({
            embeds: [newEmbed],
            components: [buttonsRow(state.panelId, true), altButtonsRow(state.panelId, true), manageRow(state.panelId)]
          })
          saveStateDebounced()
        } catch { /* ignore w tle */ }
      }
    }
  }, 60 * 1000)
})

// ─────────────────────────── Tworzenie rajdu ───────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return
  if (interaction.commandName !== 'raid') return

  const leader = interaction.user

  const raidName    = interaction.options.getString('jaki_raid')
  const requirements= interaction.options.getString('wymogi')
  const requested   = interaction.options.getInteger('ilosc_slotow')
  const capacity    = Math.min(20, Math.max(1, requested))

  const dateText    = interaction.options.getString('data')
  const timeText    = interaction.options.getString('godzina')
  const duration    = interaction.options.getString('czas_trwania')

  const startAtDate = parsePolishDate(dateText, timeText)
  const startAt     = startAtDate ? startAtDate.getTime() : undefined

  const meta = {
    leaderId: leader.id,
    leaderMention: `<@${leader.id}>`,
    raidName,
    requirements,
    dateText,
    timeText,
    duration,
    startAt,
    pendingPromotions: [],
  }

  const panelId = genPanelId()
  const embed = buildEmbed(interaction.guild, { meta, main: [], reserve: [], capacity })

  const ephemeralNote = requested > 20
    ? { content: '⚠️ Maksymalna liczba miejsc to 20 — przycięto do 20.', ephemeral: true }
    : null

  await interaction.reply({
    embeds: [embed],
    components: [buttonsRow(panelId), altButtonsRow(panelId), manageRow(panelId)],
  })
  if (ephemeralNote) {
    try { await interaction.followUp(ephemeralNote) } catch {}
  }

  const sent = await interaction.fetchReply()

  raids.set(panelId, {
    panelId,
    capacity,
    main: [],
    reserve: [],
    meta,
    channelId: sent.channelId,
    messageId: sent.id,
    guildId: sent.guildId
  })
  saveStateDebounced()
})

// ─────────────────────────── Helpery stanu ───────────────────────────
function removeAllUser(state, userId, { onlyAlts = false } = {}) {
  const filt = e => e.userId !== userId || (onlyAlts && !e.isAlt)
  state.main = state.main.filter(filt)
  state.reserve = state.reserve.filter(filt)
  cleanupPendingForUser(state, userId)
}

// ─────────────────────────── Rerender ───────────────────────────
async function rerender(interaction, state) {
  const guild = interaction.guild ?? client.guilds.cache.get(state.guildId)
  const newEmbed = buildEmbed(guild, state)

  try {
    if (interaction.message && interaction.message.id === state.messageId) {
      await interaction.message.edit({
        embeds: [newEmbed],
        components: [buttonsRow(state.panelId, !!state.meta.closed), altButtonsRow(state.panelId, !!state.meta.closed), manageRow(state.panelId)]
      })
      return
    }
    const msg = await interaction.channel.messages.fetch(state.messageId)
    await msg.edit({
      embeds: [newEmbed],
      components: [buttonsRow(state.panelId, !!state.meta.closed), altButtonsRow(state.panelId, !!state.meta.closed), manageRow(state.panelId)]
    })
  } catch (e) {
    if (isMissingAccess(e)) {
      console.warn('⚠️ Brak dostępu przy rerender (pomijam edycję).')
      return
    }
    throw e
  }
}
async function rerenderById(channel, state) {
  const guild = channel.guild ?? client.guilds.cache.get(state.guildId)
  const newEmbed = buildEmbed(guild, state)
  try {
    const msg = await channel.messages.fetch(state.messageId)
    await msg.edit({
      embeds: [newEmbed],
      components: [buttonsRow(state.panelId, !!state.meta.closed), altButtonsRow(state.panelId, !!state.meta.closed), manageRow(state.panelId)]
    })
  } catch (e) {
    if (isMissingAccess(e)) {
      console.warn('⚠️ Brak dostępu przy rerenderById (pomijam edycję).')
      return
    }
    throw e
  }
}

// ─────────────────────────── Handlery UI ───────────────────────────
const manageSessions = new Map()
const sessionKey = (i, panelId) => `${i.user.id}_${panelId}`
const MAX_ALTS = 3

client.on('interactionCreate', async interaction => {
  try {
    // Buttons
    if (interaction.isButton()) {
      const [prefix, anyId, action] = interaction.customId.split(':')
      if (prefix !== 'raid') return
      let state = getStateByAnyId(anyId)
      if (!state) {
        state = await recoverFromMessage(interaction, anyId)
        if (!state) {
          return interaction.reply({ content: 'Ten panel zapisów nie jest już aktywny (brak danych do odzyskania).', ephemeral: true })
        }
      }
      const panelId = state.panelId
      const userId = interaction.user.id
      const isLeader = userId === state.meta.leaderId

      // Blokada zapisów po zamknięciu
      const isClosed = !!state.meta.closed
      if (isClosed && ['signup', 'signup_alt', 'signout', 'signout_all', 'leave_alts'].includes(action)) {
        return interaction.reply({ ephemeral: true, content: '🔒 Zapisy są zamknięte.' })
      }

      if (action === 'help') {
        return interaction.reply({
          ephemeral: true,
          content:
            '📌 **Jak to działa**\n' +
            '• **Zapisz się / Zmień SP** – wybierz klasę i SP; jeśli brak miejsc, trafisz do rezerwy.\n' +
            '• **Wypisz się** – usuwa Twoje główne konto (alty zostają).\n' +
            '• **Zapisz Alta** – dodaje konto Alt z klasą i SP (limit 3).\n' +
            '• **Usuń Alty** – usuwa wszystkie Twoje alty.\n' +
            '• **Wypisz (Wszystko)** – usuwa i główne konto, i alty.\n' +
            '• **Zarządzaj** (lider): Dodaj/Usuń, Zmień termin/lidera, Do składu/Do rezerwy, Oznacz zapisanych.'
        })
      }

      if (action === 'signout') {
        await withLock(panelId, async () => {
          const before = JSON.stringify({ main: state.main, reserve: state.reserve })
          state.main = state.main.filter(e => !(e.userId === userId && !e.isAlt))
          state.reserve = state.reserve.filter(e => !(e.userId === userId && !e.isAlt))
          cleanupPendingForUser(state, userId)
          if (JSON.stringify({ main: state.main, reserve: state.reserve }) !== before) {
            if (canPost(interaction.channel)) {
              try { await interaction.channel.send(`:x: <@${userId}> **wypisał(a) się** z rajdu — ${fmtNowPL()}.`) } catch (e) { if (!isMissingAccess(e)) throw e }
            }
          }
          // zaplanuj ewentualne awanse (zamiast natychmiastowych)
          schedulePromotions(state)
          await rerender(interaction, state); saveStateDebounced()
        })
        return interaction.deferUpdate()
      }

      if (action === 'signout_all') {
        await withLock(panelId, async () => {
          const hadAny = state.main.some(e => e.userId === userId) || state.reserve.some(e => e.userId === userId)
          removeAllUser(state, userId, { onlyAlts: false })
          if (hadAny && canPost(interaction.channel)) {
            try { await interaction.channel.send(`:x: <@${userId}> **wypisał(a) się (Wszystko)** — ${fmtNowPL()}.`) } catch (e) { if (!isMissingAccess(e)) throw e }
          }
          schedulePromotions(state)
          await rerender(interaction, state); saveStateDebounced()
        })
        return interaction.deferUpdate()
      }

      if (action === 'leave_alts') {
        await withLock(panelId, async () => {
          const hadAlts = state.main.concat(state.reserve).some(e => e.userId === userId && e.isAlt)
          // usuń tylko alty
          state.main = state.main.filter(e => !(e.userId === userId && e.isAlt))
          state.reserve = state.reserve.filter(e => !(e.userId === userId && e.isAlt))
          cleanupPendingForUser(state, userId)
          if (hadAlts && canPost(interaction.channel)) {
            try { await interaction.channel.send(`:x: <@${userId}> **usunął(ęła) alty** — ${fmtNowPL()}.`) } catch (e) { if (!isMissingAccess(e)) throw e }
          }
          schedulePromotions(state)
          await rerender(interaction, state); saveStateDebounced()
        })
        return interaction.deferUpdate()
      }

      if (action === 'signup' || action === 'signup_alt') {
        if (action === 'signup_alt') {
          const altsCount = state.main.concat(state.reserve).filter(e => e.userId === userId && e.isAlt).length
          if (altsCount >= MAX_ALTS) {
            return interaction.reply({ ephemeral: true, content: `❌ Osiągnięto limit ALT-ów (${MAX_ALTS}).` })
          }
        }
        const kind = action === 'signup_alt' ? 'alt' : 'main'
        return interaction.reply({
          ephemeral: true,
          content: 'Wybierz klasę:',
          components: [classSelect(panelId, kind, interaction.guild)]
        })
      }

      if (action === 'manage') {
        if (!isLeader) return interaction.reply({ content: 'Tylko lider może zarządzać tym rajdem.', ephemeral: true })
        return interaction.reply({
          ephemeral: true,
          content: 'Panel zarządzania:',
          components: [managePanelRow(panelId), managePanelRow2(panelId)]
        })
      }

      if (!isLeader && action.startsWith('m_')) {
        return interaction.reply({ content: 'Tylko lider może zarządzać.', ephemeral: true })
      }

      if (action === 'm_add') {
        const k = sessionKey(interaction, panelId)
        manageSessions.set(k, { mode: 'add' })
        return interaction.update({
          content: 'Wybierz użytkownika do dodania:',
          components: [new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder().setCustomId(`raid:${panelId}:pickuser:add`).setPlaceholder('Wybierz użytkownika')
          )]
        })
      }

      if (action === 'm_remove') {
        const k = sessionKey(interaction, panelId)
        manageSessions.set(k, { mode: 'remove' })
        return interaction.update({
          content: 'Wybierz użytkownika do usunięcia:',
          components: [new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder().setCustomId(`raid:${panelId}:pickuser:remove`).setPlaceholder('Wybierz użytkownika')
          )]
        })
      }

      if (action === 'm_setdate') {
        const modal = new ModalBuilder()
          .setCustomId(`raid:${panelId}:modal:setdate`).setTitle('Zmień termin rajdu')
        const dateInput = new TextInputBuilder().setCustomId('date_text').setLabel('Data (np. 11.11.2025)').setStyle(TextInputStyle.Short).setRequired(true)
        const timeInput = new TextInputBuilder().setCustomId('time_text').setLabel('Godzina (np. 21:00)').setStyle(TextInputStyle.Short).setRequired(true)
        modal.addComponents(new ActionRowBuilder().addComponents(dateInput), new ActionRowBuilder().addComponents(timeInput))
        return interaction.showModal(modal)
      }

      if (action === 'm_setleader') {
        return interaction.update({
          content: 'Wybierz nowego lidera:',
          components: [new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder().setCustomId(`raid:${panelId}:pickuser:setleader`).setPlaceholder('Wybierz użytkownika')
          )]
        })
      }

      if (action === 'm_promote') {
        const k = sessionKey(interaction, panelId)
        manageSessions.set(k, { mode: 'promote' })
        return interaction.update({
          content: 'Wybierz użytkownika do przeniesienia **do składu**:',
          components: [new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder().setCustomId(`raid:${panelId}:pickuser:promote`).setPlaceholder('Wybierz użytkownika z rezerwy')
          )]
        })
      }

      if (action === 'm_demote') {
        const k = sessionKey(interaction, panelId)
        manageSessions.set(k, { mode: 'demote' })
        return interaction.update({
          content: 'Wybierz użytkownika do przeniesienia **do rezerwy**:',
          components: [new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder().setCustomId(`raid:${panelId}:pickuser:demote`).setPlaceholder('Wybierz użytkownika ze składu')
          )]
        })
      }

      if (action === 'm_ping') {
        if (!state.meta.startAt) {
          const d = parsePolishDate(state.meta.dateText, state.meta.timeText)
          if (d) { state.meta.startAt = d.getTime(); saveStateDebounced() }
        }
        const hasStart = typeof state.meta.startAt === 'number'
        const now = Date.now()
        const delta = hasStart ? (state.meta.startAt - now) : null
        const whenTxt = hasStart
          ? (delta >= 0 ? `Start za ${humanizeDelta(delta)} (**${state.meta.dateText} ${state.meta.timeText}**)`
                        : `Start był ${humanizeDelta(delta)} (**${state.meta.dateText} ${state.meta.timeText}**)`)
          : `Termin: **${state.meta.dateText} ${state.meta.timeText}** (brak pewnego timestampu)`

        const mainIds = [...new Set(state.main.map(e => e.userId))]
        const resIds  = [...new Set(state.reserve.map(e => e.userId))]
        const mainMentions = mainIds.length ? mainIds.map(id => `<@${id}>`).join(' ') : '—'
        const resMentions  = resIds.length ? resIds.map(id => `<@${id}>`).join(' ')  : '—'

        if (canPost(interaction.channel)) {
          try {
            await interaction.channel.send(
              `📣 **Oznaczenie zapisanych**\n${whenTxt}\n\n` +
              `**Skład (${state.main.length}/${state.capacity})**: ${mainMentions}\n` +
              `**Rezerwa (${state.reserve.length})**: ${resMentions}`
            )
          } catch (e) { if (!isMissingAccess(e)) throw e }
        }
        return interaction.reply({ content: 'Wysłano oznaczenie ✅', ephemeral: true })
      }

      return
    }

    // String Select (klasa/SP + manage add SP)
    if (interaction.isStringSelectMenu()) {
      const parts = interaction.customId.split(':') // raid:<anyId>:pickclass|picksp:...
      if (parts[0] !== 'raid') return
      const anyId = parts[1]
      let state = getStateByAnyId(anyId)
      if (!state) {
        state = await recoverFromMessage(interaction, anyId)
        if (!state) {
          return interaction.reply({ content: 'Ten panel zapisów nie jest już aktywny (brak danych do odzyskania).', ephemeral: true })
        }
      }

      if (parts[2] === 'pickclass') {
        const kind = parts[3]
        const cls = interaction.values[0]
        return interaction.update({
          content: `Klasa: **${classEmoji(interaction.guild, cls)} ${cls}** – teraz wybierz **SP**:`,
          components: [spSelect(anyId, kind, cls, interaction.guild)]
        })
      }

      if (parts[2] === 'picksp') {
        const kind = parts[3] // main | alt | madd
        const cls = parts[4]
        const sp = Math.min(cls === 'MSW' ? 7 : 11, parseInt(interaction.values[0], 10))

        await withLock(state.panelId, async () => {
          if (kind === 'madd') {
            const k = sessionKey(interaction, anyId)
            const sess = manageSessions.get(k)
            if (!sess?.targetId) return interaction.update({ content: 'Sesja zarządzania wygasła.', components: [] })

            state.main = state.main.filter(e => !(e.userId === sess.targetId && !e.isAlt))
            state.reserve = state.reserve.filter(e => !(e.userId === sess.targetId && !e.isAlt))
            cleanupPendingForUser(state, sess.targetId)

            const entry = { userId: sess.targetId, cls, sp, isAlt: false }
            const goesToMainBeforePush = state.main.length < state.capacity
            state.main.length < state.capacity ? state.main.push(entry) : state.reserve.push(entry)

            // po potencjalnym zwolnieniu miejsca zaplanuj awanse
            schedulePromotions(state)

            await rerender(interaction, state); saveStateDebounced()
            manageSessions.delete(k)
            const whereTxt = goesToMainBeforePush ? 'do **głównego składu**' : 'do **rezerwy**'
            return interaction.update({ content: `Dodano: <@${sess.targetId}> ${classEmoji(interaction.guild, cls)} SP ${sp} — ${whereTxt} ✅`, components: [] })
          }

          const userId = interaction.user.id
          let goesToMainBeforePush

          if (kind === 'main') {
            state.main = state.main.filter(e => !(e.userId === userId && !e.isAlt))
            state.reserve = state.reserve.filter(e => !(e.userId === userId && !e.isAlt))
            cleanupPendingForUser(state, userId)
            goesToMainBeforePush = state.main.length < state.capacity
            if (goesToMainBeforePush) state.main.push({ userId, cls, sp, isAlt: false })
            else state.reserve.push({ userId, cls, sp, isAlt: false })
          } else {
            const altsList = state.main.concat(state.reserve).filter(e => e.userId === userId && e.isAlt)
            if (altsList.length >= MAX_ALTS) {
              return interaction.update({ content: `❌ Osiągnięto limit ALT-ów (${MAX_ALTS}).`, components: [] })
            }
            goesToMainBeforePush = state.main.length < state.capacity
            if (goesToMainBeforePush) state.main.push({ userId, cls, sp, isAlt: true })
            else state.reserve.push({ userId, cls, sp, isAlt: true })
          }

          // zamiast natychmiastowego promote — planujemy
          schedulePromotions(state)
          await rerender(interaction, state); saveStateDebounced()

          const whereTxt = goesToMainBeforePush ? 'do **głównego składu**' : 'do **rezerwy**'
          return interaction.update({ content: `Zapisano ${whereTxt} ✅`, components: [] })
        })
      }
    }

    // User Select (manage add/remove/setleader/promote/demote)
    if (interaction.isUserSelectMenu()) {
      const parts = interaction.customId.split(':') // raid:<anyId>:pickuser:add|remove|setleader|promote|demote
      if (parts[0] !== 'raid') return
      const anyId = parts[1]
      const mode = parts[2] === 'pickuser' ? parts[3] : null
      let state = getStateByAnyId(anyId)
      if (!state) {
        state = await recoverFromMessage(interaction, anyId)
        if (!state) {
          return interaction.reply({ content: 'Ten panel zapisów nie jest już aktywny (brak danych do odzyskania).', ephemeral: true })
        }
      }
      if (interaction.user.id !== state.meta.leaderId) return interaction.reply({ content: 'Tylko lider może zarządzać.', ephemeral: true })

      const targetId = interaction.values[0]

      await withLock(state.panelId, async () => {
        if (mode === 'add') {
          const k = sessionKey(interaction, anyId)
          manageSessions.set(k, { mode: 'add', targetId })
          return interaction.update({ content: `Dodawanie: <@${targetId}>\nWybierz klasę:`, components: [classSelect(anyId, 'madd', interaction.guild)] })
        }

        if (mode === 'remove') {
          const before = JSON.stringify({ main: state.main, reserve: state.reserve })
          removeAllUser(state, targetId, { onlyAlts: false })
          const changed = JSON.stringify({ main: state.main, reserve: state.reserve }) !== before
          if (changed && canPost(interaction.channel)) {
            try { await interaction.channel.send(`🗑️ <@${targetId}> usunięty przez lidera — ${fmtNowPL()}.`) } catch (e) { if (!isMissingAccess(e)) throw e }
          }
          schedulePromotions(state)
          await rerender(interaction, state); saveStateDebounced()
          return interaction.update({ content: changed ? 'Usunięto ✅' : 'Użytkownik nie był zapisany.', components: [] })
        }

        if (mode === 'setleader') {
          state.meta.leaderId = targetId
          state.meta.leaderMention = `<@${targetId}>`
          await rerenderById(interaction.channel, state); saveStateDebounced()
          if (canPost(interaction.channel)) {
            try { await interaction.channel.send(`👑 Nowy lider rajdu: <@${targetId}> — ${fmtNowPL()}.`) } catch (e) { if (!isMissingAccess(e)) throw e }
          }
          return interaction.update({ content: 'Zmieniono lidera ✅', components: [] })
        }

        if (mode === 'promote') {
          // manualny awans — NATYCHMIAST (lider świadomie przenosi)
          const idxRes = state.reserve.findIndex(e => e.userId === targetId)
          if (idxRes === -1) return interaction.update({ content: 'Użytkownik nie jest w rezerwie.', components: [] })
          const entry = state.reserve.splice(idxRes, 1)[0]
          if (state.main.length >= state.capacity) {
            const bumped = state.main.pop()
            state.reserve.unshift(bumped)
          }
          cleanupPendingForUser(state, targetId)
          state.main.push(entry)
          await rerender(interaction, state); saveStateDebounced()
          if (canPost(interaction.channel)) {
            try { await interaction.channel.send(`⬆️ <@${targetId}> przeniesion(y/a) przez lidera **do składu** — ${fmtNowPL()}.`) } catch (e) { if (!isMissingAccess(e)) throw e }
          }
          // po zmianach przelicz planowane
          schedulePromotions(state)
          return interaction.update({ content: `Przeniesiono <@${targetId}> do **składu** ✅`, components: [] })
        }

        if (mode === 'demote') {
          const idxMain = state.main.findIndex(e => e.userId === targetId)
          if (idxMain === -1) return interaction.update({ content: 'Użytkownik nie jest w składzie.', components: [] })
          const entry = state.main.splice(idxMain, 1)[0]
          state.reserve.unshift(entry)
          cleanupPendingForUser(state, targetId)
          schedulePromotions(state)
          await rerender(interaction, state); saveStateDebounced()
          return interaction.update({ content: `Przeniesiono <@${targetId}> do **rezerwy** ✅`, components: [] })
        }
      })
    }

    // Modal submit: zmiana terminu
    if (interaction.isModalSubmit()) {
      const parts = interaction.customId.split(':') // raid:<anyId>:modal:setdate
      if (parts[0] !== 'raid' || parts[2] !== 'modal' || parts[3] !== 'setdate') return
      const anyId = parts[1]
      const state = getStateByAnyId(anyId)
      if (!state) return interaction.reply({ content: 'Ten panel zapisów nie jest już aktywny.', ephemeral: true })
      if (interaction.user.id !== state.meta.leaderId) return interaction.reply({ content: 'Tylko lider może zmieniać termin.', ephemeral: true })

      const dateText = interaction.fields.getTextInputValue('date_text')
      const timeText = interaction.fields.getTextInputValue('time_text')
      const startAtDate = parsePolishDate(dateText, timeText)

      await withLock(state.panelId, async () => {
        state.meta.dateText = dateText
        state.meta.timeText = timeText
        state.meta.startAt = startAtDate ? startAtDate.getTime() : undefined
        state.meta.closed = false
        await rerenderById(interaction.channel, state); saveStateDebounced()
        if (canPost(interaction.channel)) {
          try { await interaction.channel.send(`🗓️ Lider zaktualizował termin rajdu na **${dateText} ${timeText}** — ${fmtNowPL()}.`) } catch (e) { if (!isMissingAccess(e)) throw e }
        }
      })
      return interaction.reply({ content: 'Zmieniono termin ✅', ephemeral: true })
    }
  } catch (err) {
    console.error('Interaction error:', err)
    if (interaction.deferred || interaction.replied) {
      try { await interaction.followUp({ ephemeral: true, content: '❌ Wystąpił błąd. Spróbuj ponownie.' }) } catch {}
    } else {
      try { await interaction.reply({ ephemeral: true, content: '❌ Wystąpił błąd. Spróbuj ponownie.' }) } catch {}
    }
  }
})

// ─────────────────────────── Healthcheck (opcjonalny) ───────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    const ok = client && client.isReady()
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: ok ? 'ok' : 'starting',
      ready: !!ok,
      guilds: ok ? client.guilds.cache.size : 0,
      latency_ms: ok ? client.ws.ping : null,
      timestamp: new Date().toISOString(),
    }))
  } else { res.writeHead(404); res.end('not found') }
})
const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`Healthcheck on :${PORT}`))

// ─────────────────────────── Start ───────────────────────────
client.login(process.env.BOT_TOKEN)
