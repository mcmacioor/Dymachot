// index.js
require('dotenv').config()
const fs = require('fs')
const path = require('path')
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
} = require('discord.js')

const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
})

/**
 * Map<messageId, {
 *   capacity: number,
 *   main: Array<{ userId: string, cls: string, sp: number, isAlt: boolean }>,
 *   reserve: Array<{ userId: string, cls: string, sp: number, isAlt: boolean }>,
 *   meta: {
 *     leaderId: string,
 *     leaderMention: string,
 *     raidName: string,
 *     dateText: string,
 *     timeText: string,
 *     duration: string,
 *     requirements: string,
 *     startAt?: number // ms epoch (Europe/Warsaw local)
 *   },
 *   channelId: string
 * }>
 */
const raids = new Map()

// ─────────────────────────── Trwałość (JSON) ───────────────────────────
const DATA_PATH = process.env.RAIDS_PATH || path.join(__dirname, 'raids.json')

function parsePolishDate(dateText, timeText) {
    if (!dateText || !timeText) return null
    const norm = s => s.toLowerCase()
        .replaceAll(',', ' ')
        .replaceAll('.', ' ')
        .replaceAll('-', ' ')
        .replace(/\s+/g, ' ')
        .trim()

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

    const d = norm(dateText)
    const t = norm(timeText)
    let day, month, year

    // wariant liczbowy: dd mm yyyy
    const num = d.match(/(\d{1,2})\s+(\d{1,2})\s+(\d{4})/)
    if (num) {
        day = parseInt(num[1], 10); month = parseInt(num[2], 10); year = parseInt(num[3], 10)
    } else {
        // wariant z nazwą miesiąca; opcjonalny dzień tygodnia na początku
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
        for (const [msgId, s] of Object.entries(raw)) {
            const state = {
                capacity: s.capacity,
                main: s.main || [],
                reserve: s.reserve || [],
                meta: s.meta,
                channelId: s.channelId || null
            }
            // Migracja: jeśli brak startAt, spróbuj policzyć z tekstu
            if (!state.meta.startAt) {
                const d = parsePolishDate(state.meta.dateText, state.meta.timeText)
                if (d) state.meta.startAt = d.getTime()
            }
            raids.set(msgId, state)
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
    try {
        fs.writeFileSync(DATA_PATH, JSON.stringify(obj, null, 2), 'utf8')
    } catch (e) {
        console.error('Błąd zapisu raids.json:', e)
    }
}
function saveStateDebounced() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveState, 500)
}

// ─────────────────────────── Utils ───────────────────────────
const CLASS_OPTIONS = ['Łucznik', 'Wojownik', 'Mag', 'MSW']
const CLASS_TO_TOKEN = { 'Łucznik': 'lucznik', 'Wojownik': 'woj', 'Mag': 'mag', 'MSW': 'msw' }

function fmtNowPL() {
    return new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })
}
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
function classEmoji(cls) {
    if (cls === 'Łucznik') return ':Lucznik:'
    if (cls === 'Wojownik') return ':Wojownik:'
    if (cls === 'Mag') return ':Mag:'
    if (cls === 'MSW') return ':Msw:'
    return ''
}
function spEmoji(cls, sp) {
    const token = CLASS_TO_TOKEN[cls] || 'lucznik'
    return `:sp${sp}${token}:`
}
function equipmentBlock() {
    return (
        '**Wyposażenie:**\n' +
        ':Ancelloan: Ancek dla peta\n' +
        ':Wzmacniacz: Wzmacniacz wrózki\n' +
        ':Tarot: Demon/słońce 250\n' +
        ':Eliksirataku: Potki ataku\n' +
        ':Fulka: Fulki\n'
    )
}
function userLine(entry, index) {
    const tag = `<@${entry.userId}>`
    const clsEm = classEmoji(entry.cls)
    const spEm = spEmoji(entry.cls, entry.sp)
    const alt = entry.isAlt ? ' (Alt)' : ''
    return `${index}. ${tag} ${clsEm} [${entry.cls}] ${spEm} [SP ${entry.sp}]${alt}`
}

// ─────────────────────────── Render ───────────────────────────
function buildEmbed({ meta, main, reserve, capacity }) {
    const { leaderMention, raidName, dateText, timeText, duration, requirements } = meta

    const head =
        `**Lider:** ${leaderMention}\n` +
        `**Co:**\n${raidName}\n\n` +
        `**Kiedy:** ${dateText} ${timeText} [${duration}]\n` +
        '──────────────────────────────\n'

    const reqAndEquip =
        `**Wymogi:**\n${requirements}\n` +
        equipmentBlock() +
        '──────────────────────────────\n'

    const mainLines = []
    for (let i = 0; i < capacity; i++) {
        const entry = main[i]
        mainLines.push(entry ? userLine(entry, i + 1) : `${i + 1}. —`)
    }

    const reserveList = reserve.length
        ? reserve.map((e, i) => userLine(e, i + 1)).join('\n')
        : '—'

    return new EmbedBuilder()
        .setTitle('Dymacho Rajd') // tylko raz
        .setDescription(
            head +
            reqAndEquip +
            `**Skład ( ${main.length}/${capacity} ):**\n${mainLines.join('\n')}\n\n` +
            `**Rezerwa:**\n${reserveList}`
        )
    // brak footera i timestampu
}

function buttonsRow(messageId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`raid:${messageId}:signup`).setLabel('Zapisz się / Zmień SP').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`raid:${messageId}:signout`).setLabel('Wypisz się').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`raid:${messageId}:help`).setLabel('Pomoc').setStyle(ButtonStyle.Secondary),
    )
}
function altButtonsRow(messageId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`raid:${messageId}:signup_alt`).setLabel('Zapisz Alta').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`raid:${messageId}:leave_alts`).setLabel('Usuń Alty').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`raid:${messageId}:signout_all`).setLabel('Wypisz (Wszystko)').setStyle(ButtonStyle.Danger),
    )
}
function manageRow(messageId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`raid:${messageId}:manage`).setLabel('Zarządzaj').setStyle(ButtonStyle.Secondary),
    )
}
function managePanelRow(messageId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`raid:${messageId}:m_add`).setLabel('Dodaj osobę').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`raid:${messageId}:m_remove`).setLabel('Usuń osobę').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`raid:${messageId}:m_setdate`).setLabel('Zmień termin').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`raid:${messageId}:m_setleader`).setLabel('Zmień lidera').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`raid:${messageId}:m_ping`).setLabel('Oznacz zapisanych').setStyle(ButtonStyle.Primary),
    )
}

function classSelect(messageId, kind) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`raid:${messageId}:pickclass:${kind}`)
            .setPlaceholder('Wybierz klasę')
            .addOptions(CLASS_OPTIONS.map(c => ({ label: `${classEmoji(c)} ${c}`.trim(), value: c })))
    )
}
function spSelect(messageId, kind, cls) {
    const count = cls === 'MSW' ? 7 : 11
    const options = Array.from({ length: count }, (_, i) => {
        const n = i + 1
        return { label: `${spEmoji(cls, n)} SP ${n}`, value: String(n) }
    })
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`raid:${messageId}:picksp:${kind}:${cls}`)
            .setPlaceholder('Wybierz SP')
            .addOptions(options)
    )
}

// ─────────────────────────── /raid (tworzenie) ───────────────────────────
const raidCreateCmd = new SlashCommandBuilder()
    .setName('raid')
    .setDescription('Utwórz ogłoszenie rajdu z zapisami')
    .addUserOption(o => o.setName('lider').setDescription('Lider rajdu').setRequired(true))
    .addStringOption(o => o.setName('jaki_raid').setDescription('Jaki rajd').setRequired(true))
    .addStringOption(o => o.setName('wymogi').setDescription('Wymogi').setRequired(true))
    .addIntegerOption(o => o.setName('ilosc_slotow').setDescription('Ilość miejsc').setMinValue(1).setMaxValue(40).setRequired(true))
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
})

// ─────────────────────────── Helpery stanu ───────────────────────────
function removeAllUser(state, userId, { onlyAlts = false } = {}) {
    const filt = e => e.userId !== userId || (onlyAlts && !e.isAlt)
    state.main = state.main.filter(filt)
    state.reserve = state.reserve.filter(filt)
}
function pushEntry(state, entry) {
    if (state.main.length < state.capacity) state.main.push(entry)
    else state.reserve.push(entry)
}
function promoteFromReserve(state) {
    while (state.main.length < state.capacity && state.reserve.length > 0) {
        state.main.push(state.reserve.shift())
    }
}
async function rerender(interaction, messageId, state) {
    const message = await interaction.channel.messages.fetch(messageId)
    const newEmbed = buildEmbed({ meta: state.meta, main: state.main, reserve: state.reserve, capacity: state.capacity })
    await message.edit({ embeds: [newEmbed] })
}
async function rerenderById(channel, messageId, state) {
    const msg = await channel.messages.fetch(messageId)
    const newEmbed = buildEmbed({ meta: state.meta, main: state.main, reserve: state.reserve, capacity: state.capacity })
    await msg.edit({ embeds: [newEmbed] })
}

// ─────────────────────────── Tworzenie rajdu ───────────────────────────
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return
    if (interaction.commandName !== 'raid') return

    const leader = interaction.options.getUser('lider')
    const raidName = interaction.options.getString('jaki_raid')
    const requirements = interaction.options.getString('wymogi')
    const capacity = interaction.options.getInteger('ilosc_slotow')
    const dateText = interaction.options.getString('data')
    const timeText = interaction.options.getString('godzina')
    const duration = interaction.options.getString('czas_trwania')

    const startAtDate = parsePolishDate(dateText, timeText)
    const startAt = startAtDate ? startAtDate.getTime() : undefined

    const meta = {
        leaderId: leader.id,
        leaderMention: `<@${leader.id}>`,
        raidName,
        requirements,
        dateText,
        timeText,
        duration,
        startAt
    }

    const embed = buildEmbed({ meta, main: [], reserve: [], capacity })
    await interaction.reply({
        embeds: [embed],
        components: [buttonsRow('PENDING'), altButtonsRow('PENDING'), manageRow('PENDING')],
    })
    const sent = await interaction.fetchReply()
    await sent.edit({ components: [buttonsRow(sent.id), altButtonsRow(sent.id), manageRow(sent.id)] })

    raids.set(sent.id, {
        capacity,
        main: [],
        reserve: [],
        meta,
        channelId: sent.channelId
    })
    saveStateDebounced()
})

// ─────────────────────────── Sesje zarządzania ───────────────────────────
const manageSessions = new Map()
const sessionKey = (i, msgId) => `${i.user.id}_${msgId}`

// ─────────────────────────── Handlery UI ───────────────────────────
client.on('interactionCreate', async interaction => {
    // Buttons
    if (interaction.isButton()) {
        const [prefix, messageId, action] = interaction.customId.split(':')
        if (prefix !== 'raid') return
        const state = raids.get(messageId)
        if (!state) return interaction.reply({ content: 'Ten panel zapisów nie jest już aktywny.', ephemeral: true })

        const userId = interaction.user.id
        const isLeader = userId === state.meta.leaderId

        if (action === 'help') {
            return interaction.reply({
                ephemeral: true,
                content:
                    '📌 **Jak to działa**\n' +
                    '• **Zapisz się / Zmień SP** – wybierz klasę i SP; jeśli brak miejsc, trafisz do rezerwy.\n' +
                    '• **Wypisz się** – usuwa Twoje główne konto (alty zostają).\n' +
                    '• **Zapisz Alta** – dodaje konto Alt z klasą i SP.\n' +
                    '• **Usuń Alty** – usuwa wszystkie Twoje alty.\n' +
                    '• **Wypisz (Wszystko)** – usuwa i główne konto, i alty.\n' +
                    '• **Zarządzaj** (lider): Dodaj/Usuń, Zmień termin, Zmień lidera, Oznacz zapisanych.'
            })
        }

        if (action === 'signout') {
            const before = JSON.stringify({ main: state.main, reserve: state.reserve })
            state.main = state.main.filter(e => !(e.userId === userId && !e.isAlt))
            state.reserve = state.reserve.filter(e => !(e.userId === userId && !e.isAlt))
            if (JSON.stringify({ main: state.main, reserve: state.reserve }) !== before) {
                await interaction.channel.send(`:x: <@${userId}> **wypisał(a) się** z rajdu — ${fmtNowPL()}.`)
            }
            promoteFromReserve(state)
            await rerender(interaction, messageId, state)
            saveStateDebounced()
            return interaction.deferUpdate()
        }

        if (action === 'signout_all') {
            const hadAny = state.main.some(e => e.userId === userId) || state.reserve.some(e => e.userId === userId)
            removeAllUser(state, userId, { onlyAlts: false })
            if (hadAny) await interaction.channel.send(`:x: <@${userId}> **wypisał(a) się (Wszystko)** — ${fmtNowPL()}.`)
            promoteFromReserve(state)
            await rerender(interaction, messageId, state)
            saveStateDebounced()
            return interaction.deferUpdate()
        }

        if (action === 'leave_alts') {
            const hadAlts = state.main.some(e => e.userId === userId && e.isAlt) || state.reserve.some(e => e.userId === userId && e.isAlt)
            removeAllUser(state, userId, { onlyAlts: true })
            if (hadAlts) await interaction.channel.send(`:x: <@${userId}> **usunął(ęła) alty** — ${fmtNowPL()}.`)
            promoteFromReserve(state)
            await rerender(interaction, messageId, state)
            saveStateDebounced()
            return interaction.deferUpdate()
        }

        if (action === 'signup' || action === 'signup_alt') {
            const kind = action === 'signup_alt' ? 'alt' : 'main'
            return interaction.reply({
                ephemeral: true,
                content: 'Wybierz klasę:',
                components: [classSelect(messageId, kind)],
            })
        }

        if (action === 'manage') {
            if (!isLeader) return interaction.reply({ content: 'Tylko lider może zarządzać tym rajdem.', ephemeral: true })
            return interaction.reply({ ephemeral: true, content: 'Panel zarządzania:', components: [managePanelRow(messageId)] })
        }

        // ——— Akcje panelu manage ———
        if (!isLeader && action.startsWith('m_')) {
            return interaction.reply({ content: 'Tylko lider może zarządzać.', ephemeral: true })
        }

        if (action === 'm_add') {
            const k = sessionKey(interaction, messageId)
            manageSessions.set(k, { mode: 'add' })
            return interaction.update({
                content: 'Wybierz użytkownika do dodania:',
                components: [new ActionRowBuilder().addComponents(
                    new UserSelectMenuBuilder().setCustomId(`raid:${messageId}:pickuser:add`).setPlaceholder('Wybierz użytkownika')
                )]
            })
        }

        if (action === 'm_remove') {
            const k = sessionKey(interaction, messageId)
            manageSessions.set(k, { mode: 'remove' })
            return interaction.update({
                content: 'Wybierz użytkownika do usunięcia:',
                components: [new ActionRowBuilder().addComponents(
                    new UserSelectMenuBuilder().setCustomId(`raid:${messageId}:pickuser:remove`).setPlaceholder('Wybierz użytkownika')
                )]
            })
        }

        if (action === 'm_setdate') {
            const modal = new ModalBuilder()
                .setCustomId(`raid:${messageId}:modal:setdate`)
                .setTitle('Zmień termin rajdu')
            const dateInput = new TextInputBuilder()
                .setCustomId('date_text').setLabel('Data (np. 11.11.2025)').setStyle(TextInputStyle.Short).setRequired(true)
            const timeInput = new TextInputBuilder()
                .setCustomId('time_text').setLabel('Godzina (np. 21:00)').setStyle(TextInputStyle.Short).setRequired(true)
            modal.addComponents(
                new ActionRowBuilder().addComponents(dateInput),
                new ActionRowBuilder().addComponents(timeInput)
            )
            return interaction.showModal(modal)
        }

        if (action === 'm_setleader') {
            return interaction.update({
                content: 'Wybierz nowego lidera:',
                components: [new ActionRowBuilder().addComponents(
                    new UserSelectMenuBuilder().setCustomId(`raid:${messageId}:pickuser:setleader`).setPlaceholder('Wybierz użytkownika')
                )]
            })
        }

        if (action === 'm_ping') {
            // Jeśli brak startAt — spróbuj policzyć „na żywo”
            if (!state.meta.startAt) {
                const d = parsePolishDate(state.meta.dateText, state.meta.timeText)
                if (d) {
                    state.meta.startAt = d.getTime()
                    saveStateDebounced()
                }
            }

            const hasStart = typeof state.meta.startAt === 'number'
            const now = Date.now()
            const delta = hasStart ? (state.meta.startAt - now) : null
            const whenTxt = hasStart
                ? (delta >= 0
                    ? `Start za ${humanizeDelta(delta)} (**${state.meta.dateText} ${state.meta.timeText}**)`
                    : `Start był ${humanizeDelta(delta)} (**${state.meta.dateText} ${state.meta.timeText}**)`)
                : `Termin: **${state.meta.dateText} ${state.meta.timeText}** (brak pewnego timestampu)`

            const mainIds = [...new Set(state.main.map(e => e.userId))]
            const resIds = [...new Set(state.reserve.map(e => e.userId))]
            const mainMentions = mainIds.length ? mainIds.map(id => `<@${id}>`).join(' ') : '—'
            const resMentions = resIds.length ? resIds.map(id => `<@${id}>`).join(' ') : '—'

            await interaction.channel.send(
                `📣 **Oznaczenie zapisanych**\n${whenTxt}\n\n` +
                `**Skład (${state.main.length}/${state.capacity})**: ${mainMentions}\n` +
                `**Rezerwa (${state.reserve.length})**: ${resMentions}`
            )
            return interaction.reply({ content: 'Wysłano oznaczenie ✅', ephemeral: true })
        }

        return
    }

    // String Select (klasa/SP + manage add SP)
    if (interaction.isStringSelectMenu()) {
        const parts = interaction.customId.split(':') // raid:<messageId>:pickclass|picksp:...
        if (parts[0] !== 'raid') return
        const messageId = parts[1]
        const state = raids.get(messageId)
        if (!state) return interaction.reply({ content: 'Ten panel zapisów nie jest już aktywny.', ephemeral: true })

        if (parts[2] === 'pickclass') {
            const kind = parts[3]
            const cls = interaction.values[0]
            return interaction.update({
                content: `Klasa: **${classEmoji(cls)} ${cls}** – teraz wybierz **SP**:`,
                components: [spSelect(messageId, kind, cls)]
            })
        }

        if (parts[2] === 'picksp') {
            const kind = parts[3] // main | alt | madd
            const cls = parts[4]
            const sp = Math.min(cls === 'MSW' ? 7 : 11, parseInt(interaction.values[0], 10))

            // manage-add (lider)
            if (kind === 'madd') {
                const k = sessionKey(interaction, messageId)
                const sess = manageSessions.get(k)
                if (!sess?.targetId) return interaction.update({ content: 'Sesja zarządzania wygasła.', components: [] })

                const entry = { userId: sess.targetId, cls, sp, isAlt: false }
                pushEntry(state, entry)
                promoteFromReserve(state)
                await rerender(interaction, messageId, state)
                saveStateDebounced()
                manageSessions.delete(k)
                return interaction.update({ content: `Dodano: <@${sess.targetId}> ${classEmoji(cls)} SP ${sp} ✅`, components: [] })
            }

            // user self (main/alt)
            const userId = interaction.user.id
            if (kind === 'main') {
                state.main = state.main.filter(e => !(e.userId === userId && !e.isAlt))
                state.reserve = state.reserve.filter(e => !(e.userId === userId && !e.isAlt))
            }
            const entry = { userId, cls, sp, isAlt: kind === 'alt' }
            pushEntry(state, entry)
            promoteFromReserve(state)
            await rerender(interaction, messageId, state)
            saveStateDebounced()
            return interaction.update({ content: 'Zapisano ✅', components: [] })
        }
    }

    // User Select (manage add/remove/setleader)
    if (interaction.isUserSelectMenu()) {
        const parts = interaction.customId.split(':') // raid:<messageId>:pickuser:add|remove|setleader
        if (parts[0] !== 'raid') return
        const messageId = parts[1]
        const mode = parts[2] === 'pickuser' ? parts[3] : null
        const state = raids.get(messageId)
        if (!state) return interaction.reply({ content: 'Ten panel zapisów nie jest już aktywny.', ephemeral: true })
        if (interaction.user.id !== state.meta.leaderId) return interaction.reply({ content: 'Tylko lider może zarządzać.', ephemeral: true })

        const targetId = interaction.values[0]

        if (mode === 'add') {
            const k = sessionKey(interaction, messageId)
            manageSessions.set(k, { mode: 'add', targetId })
            return interaction.update({
                content: `Dodawanie: <@${targetId}>\nWybierz klasę:`,
                components: [classSelect(messageId, 'madd')]
            })
        }

        if (mode === 'remove') {
            const before = JSON.stringify({ main: state.main, reserve: state.reserve })
            removeAllUser(state, targetId, { onlyAlts: false })
            promoteFromReserve(state)
            await rerender(interaction, messageId, state)
            saveStateDebounced()
            const changed = JSON.stringify({ main: state.main, reserve: state.reserve }) !== before
            if (changed) await interaction.channel.send(`🗑️ <@${targetId}> usunięty przez lidera — ${fmtNowPL()}.`)
            return interaction.update({ content: changed ? 'Usunięto ✅' : 'Użytkownik nie był zapisany.', components: [] })
        }

        if (mode === 'setleader') {
            state.meta.leaderId = targetId
            state.meta.leaderMention = `<@${targetId}>`
            await rerenderById(interaction.channel, messageId, state)
            saveStateDebounced()
            await interaction.channel.send(`👑 Nowy lider rajdu: <@${targetId}> — ${fmtNowPL()}.`)
            return interaction.update({ content: 'Zmieniono lidera ✅', components: [] })
        }
    }

    // Modal submit: zmiana terminu
    if (interaction.isModalSubmit()) {
        const parts = interaction.customId.split(':') // raid:<messageId>:modal:setdate
        if (parts[0] !== 'raid' || parts[2] !== 'modal' || parts[3] !== 'setdate') return
        const messageId = parts[1]
        const state = raids.get(messageId)
        if (!state) return interaction.reply({ content: 'Ten panel zapisów nie jest już aktywny.', ephemeral: true })
        if (interaction.user.id !== state.meta.leaderId) return interaction.reply({ content: 'Tylko lider może zmieniać termin.', ephemeral: true })

        const dateText = interaction.fields.getTextInputValue('date_text')
        const timeText = interaction.fields.getTextInputValue('time_text')
        const startAtDate = parsePolishDate(dateText, timeText)

        state.meta.dateText = dateText
        state.meta.timeText = timeText
        state.meta.startAt = startAtDate ? startAtDate.getTime() : undefined

        await rerenderById(interaction.channel, messageId, state)
        saveStateDebounced()
        await interaction.channel.send(`🗓️ Lider zaktualizował termin rajdu na **${dateText} ${timeText}** — ${fmtNowPL()}.`)
        return interaction.reply({ content: 'Zmieniono termin ✅', ephemeral: true })
    }
})

// ─────────────────────────── Start ───────────────────────────
client.login(process.env.BOT_TOKEN)
