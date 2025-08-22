// ================= ตั้งค่า & import =================
import {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  Events, PermissionsBitField
} from "discord.js";
import fs from "fs";
import cron from "node-cron";
import "dotenv/config";

// ======== CONFIG (แทนค่าตามของคุณ) ========
const TOKEN = process.env.DISCORD_TOKEN;

const DEPARTMENT_CHANNELS = {  // ห้องแจ้งเตือนเข้า/ออกเวร
  "ตำรวจ": "1337754520335290431",
  "หมอ":   "1308459559047663636",
  "สภา":   "1337974934638690386"
};

const DEPARTMENTS = {          // ยศของหน่วยงาน (role id)
  "ตำรวจ": "1309903906171650111",
  "หมอ":   "1309905561378095225",
  "สภา":   "1329732963914747936"
};

const DEPARTMENT_IMAGES = {    // โลโก้หน่วยงาน (สำหรับ embed รายงาน/ปุ่ม)
  // 👉 เปลี่ยนลิงก์รูปให้ตรงของคุณ
  "ตำรวจ": "https://cdn.discordapp.com/attachments/1385580108739379360/1408306378191409242/1394955799368830996.jpg",
  "หมอ":   "https://cdn.discordapp.com/attachments/1385580108739379360/1408306378191409242/1394955799368830996.jpg",
  "สภา":   "https://cdn.discordapp.com/attachments/1385580108739379360/1408306378191409242/1394955799368830996.jpg"
};

const ADMIN_CHANNEL_ID = "1400060987834368042"; // ห้องแอดมินสำหรับแจ้งเตือน/รายงาน

const DATA_FILE   = "checkin_data.json";
const BACKUP_FILE = "checkin_data_backup.json";

const MIN_HOURS        = 3; // ชั่วโมงขั้นต่ำ/วัน
const MAX_ABSENT_DAYS  = 3; // ขาดเวรได้สูงสุดติดต่อกัน
const MAX_SHORT_HOURS  = 2; // เตือนได้ 2 ครั้ง ครั้งที่ 3 ปลดยศ

// ================= Client =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel] // ให้ DM ทำงานได้
});

// ================= จัดการไฟล์ (JSON) =================
function ensureDataShape(o) {
  return {
    daily_checkins:   o?.daily_checkins   ?? {},
    work_hours:       o?.work_hours       ?? {},
    checkin_times:    o?.checkin_times    ?? {},
    absent_count:     o?.absent_count     ?? {},
    short_hours_count:o?.short_hours_count?? {}
  };
}

function backupData() {
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);
}
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(ensureDataShape({}), null, 4));
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return ensureDataShape(raw);
  } catch {
    // ซ่อมไฟล์เสีย
    fs.writeFileSync(DATA_FILE, JSON.stringify(ensureDataShape({}), null, 4));
    return ensureDataShape({});
  }
}
function saveData(d) {
  backupData();
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 4));
}
let data = loadData();

function thaiTime() {
  return new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
}
function todayKey() {
  // ใช้คีย์ไทยเพื่อให้เห็นวันที่แบบไทยในรายงาน (เหมือนฝั่ง Python ที่แสดงไทย)
  return new Date().toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok" });
}

// ================= DM เตือน / ปลดยศ =================
async function sendWarning(member, msg) {
  try {
    await member.send(msg);
  } catch {
    const adminChannel = member.guild.channels.cache.get(ADMIN_CHANNEL_ID);
    if (adminChannel) adminChannel.send(`ไม่สามารถส่ง DM ถึง ${member} ได้: ${msg}`);
  }
}

async function removeRoleAndReset(member, roleId) {
  const role = member.guild.roles.cache.get(roleId);
  if (role && member.roles.cache.has(roleId)) {
    await member.roles.remove(role);
  }

  const uid = member.id.toString();
  delete data.work_hours[uid];
  delete data.absent_count[uid];
  delete data.short_hours_count[uid];
  saveData(data);

  // DM ผู้ถูกปลดยศ
  try {
    await member.send(`❌ คุณถูกปลดยศ **${role?.name ?? "ไม่ทราบยศ"}** เนื่องจากเข้าเวรไม่ครบตามกำหนด หรือขาดเวรเกิน ${MAX_ABSENT_DAYS} วัน ข้อมูลถูกรีเซ็ตแล้ว`);
  } catch {}

  // แจ้งแอดมิน
  const adminChannel = member.guild.channels.cache.get(ADMIN_CHANNEL_ID);
  if (adminChannel) {
    const embed = new EmbedBuilder()
      .setTitle("ปลดยศ")
      .setDescription(`${member} ถูกปลดยศ ${role?.name ?? ""} เนื่องจากเข้าเวรไม่ครบหรือขาดเวร`)
      .setColor("Red");
    adminChannel.send({ embeds: [embed] });
  }
}

// ================= Logic โมดอล (เช็คอิน/เอาท์) =================
function validateRPName(name) {
  // เหมือน Python: ต้องมี "_" และ First/Last ตัวแรกพิมพ์ใหญ่ ตัวอักษรอังกฤษล้วน
  if (!name || !name.includes("_")) return false;
  const [first, last] = name.split("_", 2);
  const re = /^[A-Z][a-zA-Z]*$/;
  return re.test(first) && re.test(last);
}

async function handleCheckin(interaction, action, department) {
  const name = interaction.fields.getTextInputValue("nameInput");

  if (!validateRPName(name)) {
    return interaction.reply({ content: "**รูปแบบชื่อไม่ถูกต้อง** ต้องเป็น Firstname_Lastname และเป็นอังกฤษ ตัวแรกพิมพ์ใหญ่", ephemeral: true });
  }

  const uid = interaction.user.id.toString();
  const today = todayKey();

  if (!data.daily_checkins[today]) {
    data.daily_checkins[today] = {};
    Object.keys(DEPARTMENTS).forEach(dep => (data.daily_checkins[today][dep] = []));
  }

  if (action === "ออก" && !data.checkin_times[uid]) {
    return interaction.reply({ content: "❌ คุณยังไม่ได้เข้าเวร ไม่สามารถออกเวรได้!", ephemeral: true });
  }

  await interaction.reply({ content: `กรุณาส่ง **รูปยืนยันการ${action}เวร** ในห้องนี้ ภายใน 1 นาที`, ephemeral: true });

  const filter = (m) => m.author.id === interaction.user.id && m.attachments.size > 0 && m.channelId === interaction.channelId;
  const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 60_000 }).catch(() => null);

  if (!collected || collected.size === 0) {
    return interaction.followUp({ content: `หมดเวลา! คุณไม่ได้ส่งรูปยืนยันการ${action}เวร`, ephemeral: true });
  }

  const img = collected.first().attachments.first(); // ใช้ URL ภาพจาก Discord

  if (action === "เข้า") {
    if (!data.daily_checkins[today][department].includes(uid)) {
      data.daily_checkins[today][department].push(uid);
    }
    data.checkin_times[uid] = new Date().toISOString();
  } else {
    const start = data.checkin_times[uid] ? new Date(data.checkin_times[uid]) : null;
    if (start) {
      const hours = (Date.now() - start.getTime()) / 3_600_000;
      data.work_hours[uid] = (data.work_hours[uid] || 0) + hours;
    }
    delete data.checkin_times[uid];

    const i = data.daily_checkins[today][department].indexOf(uid);
    if (i !== -1) data.daily_checkins[today][department].splice(i, 1);
  }

  saveData(data);

  // ส่งแจ้งในห้องของหน่วย
  const depChannelId = DEPARTMENT_CHANNELS[department];
  const depChannel = interaction.guild.channels.cache.get(depChannelId);
  if (depChannel) {
    const embed = new EmbedBuilder()
      .setTitle(`${action}เวรเรียบร้อย (${department})`)
      .setDescription(`โดย: ${interaction.user}\nชื่อในเกม: \`${name}\`\nเวลา: ${thaiTime()}`)
      .setColor(action === "เข้า" ? 0x57F287 : 0xED4245) // Green / Red
      .setImage(img.url);
    depChannel.send({ embeds: [embed] });
  }

  await interaction.followUp({ content: `บันทึกการ${action}เวรเรียบร้อยแล้ว!`, ephemeral: true });
}

// ================= รายงานเวร (ข้อความคำสั่ง) =================
async function sendDepartmentReport(target, guild, dep, roleId, dateLabel) {
  const role = guild.roles.cache.get(roleId);
  const members = role ? role.members : new Map();
  const checkedIn = (data.daily_checkins[dateLabel] || {})[dep] || [];

  let desc = "";
  for (const m of members.values()) {
    const uid = m.id.toString();
    const status = checkedIn.includes(uid) ? "เข้าเวร" : "ไม่ได้เข้าเวร";
    const shortCount = data.short_hours_count[uid] || 0;
    const absentCount = data.absent_count[uid] || 0;
    const extra = [];
    if (shortCount > 0) extra.push(`เตือนเข้าเวรไม่ครบ ${shortCount} ครั้ง`);
    if (absentCount > 0) extra.push(`ขาดเวร ${absentCount} วัน`);
    desc += `${m.displayName} (${status}${extra.length ? " / " + extra.join(" , ") : ""})\n`;
  }
  if (!desc) desc = "ไม่มีสมาชิกในหน่วยงาน";

  const embed = new EmbedBuilder()
    .setTitle(`รายงานเวร ${dep} (${dateLabel})`)
    .setDescription(desc)
    .setColor(0x5865F2) // Blue
    .setImage(DEPARTMENT_IMAGES[dep] || null);

  await target.send({ embeds: [embed] });
}

// ================= รายงานอัตโนมัติส่งห้องแอดมิน =================
async function sendDailyReport(guild) {
  const adminChannel = guild.channels.cache.get(ADMIN_CHANNEL_ID);
  if (!adminChannel) return;
  const dateLabel = todayKey();
  for (const [dep, roleId] of Object.entries(DEPARTMENTS)) {
    await sendDepartmentReport(adminChannel, guild, dep, roleId, dateLabel);
  }
}

// ================= Interaction (ปุ่ม/โมดอล) =================
client.on(Events.InteractionCreate, async (interaction) => {
  // ปุ่ม
  if (interaction.isButton()) {
    const [prefix, department, act] = interaction.customId.split("_");
    if (prefix !== "checkin") return;

    // ต้องมี Role หน่วยงานนั้น ๆ ถึงจะกดได้
    const roleId = DEPARTMENTS[department];
    if (!roleId || !interaction.member.roles.cache.has(roleId)) {
      return interaction.reply({ content: "คุณไม่มีสิทธิ์กดปุ่มนี้!", ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId(`modal_${department}_${act}`)
      .setTitle(`${act === "in" ? "เข้า" : "ออก"}เวร (${department})`);

    const nameInput = new TextInputBuilder()
      .setCustomId("nameInput")
      .setLabel("ชื่อในเกม (Firstname_Lastname)")
      .setPlaceholder("ตัวอย่าง: Firstname_Lastname")
      .setStyle(TextInputStyle.Short);

    const row = new ActionRowBuilder().addComponents(nameInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  // โมดอล
  if (interaction.isModalSubmit()) {
    const [prefix, department, act] = interaction.customId.split("_");
    if (prefix !== "modal") return;
    const action = act === "in" ? "เข้า" : "ออก";
    try {
      await handleCheckin(interaction, action, department);
    } catch (e) {
      console.error(e);
      if (!interaction.replied) {
        await interaction.reply({ content: "เกิดข้อผิดพลาดระหว่างบันทึกข้อมูล", ephemeral: true });
      }
    }
  }
});

// ================= คำสั่งข้อความ (!รายงานเวร / !ตำรวจ / !หมอ / !สภา) =================
client.on(Events.MessageCreate, async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  if (!msg.content.startsWith("!")) return;

  const args = msg.content.slice(1).trim().split(/\s+/);
  const command = args.shift();

  if (command === "รายงานเวร") {
    const dateLabel = todayKey();
    for (const [dep, roleId] of Object.entries(DEPARTMENTS)) {
      await sendDepartmentReport(msg.channel, msg.guild, dep, roleId, dateLabel);
    }
    return;
  }

  if (["ตำรวจ", "หมอ", "สภา"].includes(command)) {
    if (!msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

    const department = command;
    const embed = new EmbedBuilder()
      .setTitle(`ระบบบันทึกเวร - ${department}`)
      .setDescription("**กดปุ่มเพื่อเข้า/ออกเวร และแนบรูปยืนยันได้เลย!**")
      .setColor(0x5865F2)
      .setImage(DEPARTMENT_IMAGES[department] || null);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`checkin_${department}_in`).setLabel("📥 เข้าเวร").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`checkin_${department}_out`).setLabel("📤 ออกเวร").setStyle(ButtonStyle.Danger)
    );

    await msg.channel.send({ embeds: [embed], components: [row] });
  }
});

// ================= Reset เที่ยงคืน + รายงานอัตโนมัติ =================
// รันทุก 00:00 น. ตามโซนเวลาเอเชีย/กรุงเทพ
cron.schedule("0 0 * * *", async () => {
  for (const guild of client.guilds.cache.values()) {
    for (const [dep, roleId] of Object.entries(DEPARTMENTS)) {
      const role = guild.roles.cache.get(roleId);
      if (!role) continue;

      for (const member of role.members.values()) {
        const uid = member.id.toString();
        const hours = data.work_hours[uid] || 0;

        // เช็คชั่วโมง
        if (hours < MIN_HOURS) {
          data.short_hours_count[uid] = (data.short_hours_count[uid] || 0) + 1;
          if (data.short_hours_count[uid] >= (MAX_SHORT_HOURS + 1)) {
            await removeRoleAndReset(member, roleId);
            continue;
          } else {
            await sendWarning(member, `⚠️ คุณเข้าเวรไม่ครบ ${MIN_HOURS} ชั่วโมง! เตือนครั้งที่ ${data.short_hours_count[uid]}/3`);
          }
        } else {
          data.short_hours_count[uid] = 0;
        }

        // เช็คขาดเวร
        if (hours === 0) {
          data.absent_count[uid] = (data.absent_count[uid] || 0) + 1;
        } else {
          data.absent_count[uid] = 0;
        }

        if (data.absent_count[uid] >= MAX_ABSENT_DAYS) {
          await removeRoleAndReset(member, roleId);
          continue;
        }

        // รีเซตชั่วโมงของวันนั้น
        data.work_hours[uid] = 0;
      }
    }
    saveData(data);

    // ส่งรายงานประจำวันไปห้องแอดมิน (เหมือน Python)
    await sendDailyReport(guild);
  }
}, { timezone: "Asia/Bangkok" });

// ================= Ready =================
client.once(Events.ClientReady, () => {
  console.log(`✅ Bot ${client.user.tag} พร้อมใช้งานแล้ว!`);
});

if (!TOKEN) {
  console.error("❌ กรุณาตั้งค่า DISCORD_TOKEN ในไฟล์ .env");
  process.exit(1);
}
client.login(TOKEN);