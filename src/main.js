// Copyright 2026 eris/uaaw
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const { Client: DiscordClient, Collection, GatewayIntentBits, EmbedBuilder,
  SlashCommandBuilder, PermissionFlagsBits, TextChannel } = require("discord.js");
const { Client: FluxerClient, Events: FluxerEvents, GuildChannel: FluxerGuildChannel,
  Routes: FluxerRoutes, isChatInputCommandInteraction } = require("@fluxerjs/core");
const { REST } = require("@discordjs/rest");
const { DataTypes, Sequelize } = require("sequelize");
const dotenv = require("dotenv");
const npmlog = require("npmlog");
const { readFileSync } = require("fs");
const { join } = require("path");
dotenv.config();

class InsufficientPermissionsError extends Error {}
class ConnectionError extends Error {}
class EntityNotFoundError extends Error {}

const DiscordEmojiPattern = /<(:|a:)(?<name>.+?):(?<id>[0-9]{1,22})>/g;
const DiscordPingPattern = /<(@|@!)(?<id>[0-9]{1,22})>/g;
const DiscordChannelPattern = /<#(?<id>[0-9]{1,22})>/g;
const FluxerPingPattern = /<(@|@!)(?<id>[0-9]{1,22})>/g;
const FluxerChannelPattern = /<#(?<id>[0-9]{1,22})>/g;
const FluxerEmojiPattern = /<(:|a:)(?<name>.+?):(?<id>[0-9]{1,22})>/g;
const TrailingNewlines = /[\s\r\n]+$/;

function truncate(value, limit) {
  if (value.length > limit) {
    return value.slice(0, limit - 3) + "...";
  }
  return value;
}

function fitOrEmpty(value, limit) {
  if (value.length > limit) {
    return "";
  }
  return value;
}

async function getMappings() {
  try {
    const path = join(process.cwd(), "mappings.json");
    const file = readFileSync(path, "utf-8");
    const data = JSON.parse(file);
    npmlog.warn("mappings", "mappings.json found");
    npmlog.warn("mappings", "Using mappings.json is not recommended as it's not the supported method. Please use commands to configure the bot instead, otherwise you may encounter more bugs.");
    return data;
  } catch (err) {
    throw "No mappings";
  }
}

async function checkWebhookPermissions(channel) {
  const selfMember = channel.guild.members.me;

  if (!selfMember.permissions.has(PermissionFlagsBits.ManageWebhooks) ||
      !selfMember.permissions.has(PermissionFlagsBits.SendMessages) ||
      !selfMember.permissions.has(PermissionFlagsBits.ViewChannel)) {
    throw new InsufficientPermissionsError(
      "Bot doesn't have sufficient permissions in server " + channel.guild.name +
      ". Please check if the bot has the following permissions: Manage Webhooks, Send Messages, View Channel"
    );
  }

  if (!selfMember.permissionsIn(channel).has(PermissionFlagsBits.ManageWebhooks)) {
    throw new InsufficientPermissionsError(
      "Bot doesn't have sufficient permission in the channel. " +
      "Please check if the `Manage Webhooks` permission isn't being overridden for the bot role in that specific channel."
    );
  }
}

class MappingModel extends require("sequelize").Model {}

class UniversalExecutor {
  constructor(discord, fluxer) {
    this.discord = discord;
    this.fluxer = fluxer;
  }

  async connect(discordTarget, fluxerTarget) {
    let discordChannelName;
    let fluxerChannelName;

    let fluxerChannel = this.fluxer.channels.get(fluxerTarget);

    if (!fluxerChannel) {
      try {
        fluxerChannel = await this.fluxer.channels.fetch(fluxerTarget);
        fluxerChannelName = fluxerChannel.name || fluxerTarget;
        fluxerTarget = fluxerChannel.id;
      } catch (e) {
        let target;
        this.fluxer.channels.forEach(ch => {
          if (ch.name && ch.name.toLowerCase() === fluxerTarget.toLowerCase()) {
            target = ch;
          }
        });
        if (!target) throw new ConnectionError("Fluxer channel not found.");
        fluxerChannel = target;
        fluxerTarget = target.id;
        fluxerChannelName = target.name;
      }
    } else {
      fluxerChannelName = fluxerChannel.name || fluxerTarget;
    }

    let discordChannel;
    try {
      let chan = await this.discord.channels.fetch(discordTarget);
      if (chan instanceof TextChannel) {
        discordChannel = chan;
        discordChannelName = chan.name;
      } else {
        throw new ConnectionError("We're in a weird position.");
      }
    } catch (e) {
      let channel = this.discord.channels.cache.find(channel => {
        if (channel instanceof TextChannel) {
          return channel.name.toLowerCase() === discordTarget.toLowerCase();
        }
        return false;
      });

      if (!channel) {
        throw new ConnectionError("Discord channel not found.");
      } else {
        discordChannel = channel;
        discordTarget = discordChannel.id;
        discordChannelName = discordChannel.name;
      }
    }

    const existingMapping = Main.mappings.find(
      mapping => mapping.discord === discordTarget || mapping.fluxer === fluxerTarget
    );

    if (existingMapping) {
      throw new ConnectionError(
        "Either the Fluxer or Discord channel is already bridged. Use the `disconnect` command and then try again."
      );
    }

    const mapping = {
      discord: discordTarget,
      fluxer: fluxerTarget,
      allowBots: true
    };

    try {
      await initiateDiscordChannel(discordChannel, mapping);
      await initiateFluxerChannel(fluxerChannel, mapping);
      await MappingModel.create({
        discordChannel: discordTarget,
        fluxerChannel: fluxerTarget,
        discordChannelName: discordChannelName,
        fluxerChannelName: fluxerChannelName,
        allowBots: true
      });
      Main.mappings.push(mapping);
    } catch (e) {
      npmlog.error("connect", e);
      if (e instanceof InsufficientPermissionsError) {
        throw new ConnectionError(e.message);
      } else {
        throw new ConnectionError(
          "An unexpected error occurred while setting up the webhook. Check the console for details."
        );
      }
    }
  }

  async disconnect(platform, channelId) {
    if (platform === "discord") {
      const mapping = Main.mappings.find(mapping => mapping.discord === channelId);
      const match = Main.mappings.map(mapping => mapping.discord).indexOf(channelId);
      if (match > -1) {
        Main.mappings.splice(match, 1);
        await MappingModel.destroy({ where: { discordChannel: channelId } });
        const channel = await this.discord.channels.fetch(mapping.discord);
        await unregisterDiscordChannel(channel, mapping);
        const fluxerChannel = this.fluxer.channels.get(mapping.fluxer);
        if (fluxerChannel) await unregisterFluxerChannel(fluxerChannel, mapping);
      } else {
        throw new ConnectionError("This channel isn't connected to anything.");
      }
    } else if (platform === "fluxer") {
      const mapping = Main.mappings.find(mapping => mapping.fluxer === channelId);
      const match = Main.mappings.map(mapping => mapping.fluxer).indexOf(channelId);

      if (match > -1) {
        Main.mappings.splice(match, 1);
        await MappingModel.destroy({ where: { fluxerChannel: channelId } });
        const channel = await this.discord.channels.fetch(mapping.discord);
        await unregisterDiscordChannel(channel, mapping);
        const fluxerChannel = this.fluxer.channels.get(mapping.fluxer);
        if (fluxerChannel) await unregisterFluxerChannel(fluxerChannel, mapping);
      } else {
        throw new ConnectionError("This channel isn't connected to anything.");
      }
    }
  }

  async connections() {
    const mappings = await MappingModel.findAll();
    return mappings.map(mapping => ({
      discord: mapping.discordChannelName,
      fluxer: mapping.fluxerChannelName,
      allowBots: mapping.allowBots
    }));
  }

  async toggleAllowBots(target) {
    const index = Main.mappings.indexOf(target);
    if (index > -1) {
      Main.mappings[index].allowBots = !Main.mappings[index].allowBots;
      const allowBots = Main.mappings[index].allowBots;
      const affectedRows = await MappingModel.update(
        { allowBots },
        {
          where: {
            discordChannel: target.discord,
            fluxerChannel: target.fluxer
          }
        }
      );

      if (affectedRows[0] === 0) {
        npmlog.error("db", "No affected rows?");
        throw new ConnectionError("No connection found.");
      }
      return allowBots;
    } else {
      throw new ConnectionError("This channel is not connected.");
    }
  }

  async pingDiscordUser(fluxerMessage, username) {
    const target = Main.mappings.find(mapping => mapping.fluxer === fluxerMessage.channelId);
    if (target) {
      const channel = await this.discord.channels.fetch(target.discord);
      if (channel instanceof TextChannel) {
        const query = username.toLowerCase();
        const user = this.discord.users.cache.find(user =>
          user.username.toLowerCase() === query ||
          user.username.toLowerCase() + "#" + user.discriminator === query
        );

        if (user) {
          const webhook = Main.webhooks.find(wh => wh.name === "revcord-" + target.fluxer);
          if (!webhook) throw new Error("No webhook");

          const avatarURL = fluxerMessage.author.displayAvatarURL();
          await sendDiscordMessage(
            webhook,
            {
              messageId: fluxerMessage.id,
              authorId: fluxerMessage.author.id,
              channelId: fluxerMessage.channelId
            },
            `<@${user.id}>`,
            fluxerMessage.author.username,
            avatarURL,
            null,
            true
          );
          return user.username + "#" + user.discriminator;
        } else {
          throw new EntityNotFoundError("User not found.");
        }
      }
    } else {
      throw new EntityNotFoundError("This channel is not connected.");
    }
  }
}

function formatDiscordMessage(attachments, content, mentions, stickerUrl) {
  let messageString = "";

  const emojis = content.match(DiscordEmojiPattern);
  if (emojis) {
    emojis.forEach((emoji, i) => {
      const dissected = DiscordEmojiPattern.exec(emoji);
      DiscordEmojiPattern.lastIndex = 0;

      if (dissected !== null) {
        const emojiName = dissected.groups["name"];
        const emojiId = dissected.groups["id"];

        if (emojiName && emojiId) {
          let emojiUrl;
          if (i < 5) {
            emojiUrl = "https://cdn.discordapp.com/emojis/" + emojiId + ".webp?size=32&quality=lossless";
          }
          content = content.replace(emoji, `[:${emojiName}:](${emojiUrl})`);
        }
      }
    });
  }

  const pings = content.match(DiscordPingPattern);
  if (pings) {
    for (const ping of pings) {
      const matched = DiscordPingPattern.exec(ping);
      DiscordPingPattern.lastIndex = 0;

      if (matched !== null) {
        const id = matched.groups["id"];
        if (id) {
          const match = mentions.members.find(member => member.id === id);
          if (match) {
            content = content.replace(ping, `[@${match.user.username}#${match.user.discriminator}]()`);
          }
        }
      }
    }
  }

  const channelMentions = content.match(DiscordChannelPattern);
  if (channelMentions) {
    for (const [index, mention] of channelMentions.entries()) {
      const match = mentions.channels.at(index);
      if (match && match instanceof TextChannel) {
        content = content.replace(mention, "#" + match.name);
      }
    }
  }

  messageString += content + "\n";
  attachments.forEach(attachment => {
    messageString += attachment.url + "\n";
  });
  if (stickerUrl) messageString += stickerUrl + "\n";
  messageString = messageString.replace(TrailingNewlines, "");
  return messageString;
}

async function handleDiscordMessage(fluxer, discord, message) {
  try {
    const target = Main.mappings.find(mapping => mapping.discord === message.channelId);

    if (target && message.applicationId !== discord.user.id && (!message.author.bot || target.allowBots)) {
      const webhook = Main.fluxerWebhooks.find(wh => wh.name === "revcord-" + message.channelId);
      if (!webhook) throw new Error("No Fluxer webhook for channel " + message.channelId);

      const username = truncate(
        message.author.username + (message.author.discriminator.length === 1 ? "" : "#" + message.author.discriminator),
        32
      );

      const reference = message.reference;
      let replyEmbed;

      if (reference && message.messageSnapshots.size === 0) {
        const crossPlatformReference = Main.fluxerCache.find(cached => cached.createdMessage === reference.messageId);
        if (crossPlatformReference) {
          // referenced message was from Fluxer side, look up original Fluxer message context
        } else {
          const samePlatformReference = Main.discordCache.find(cached => cached.parentMessage === reference.messageId);
          if (!samePlatformReference) {
            try {
              const sourceChannel = await discord.channels.fetch(message.reference.channelId);
              if (sourceChannel instanceof TextChannel) {
                const referenced = await sourceChannel.messages.fetch(message.reference.messageId);
                const formattedContent = formatDiscordMessage(referenced.attachments, referenced.content, referenced.mentions);

                replyEmbed = {
                  entity: referenced.author.username + "#" + referenced.author.discriminator,
                  entityImage: referenced.author.avatarURL(),
                  content: formattedContent,
                  embedType: "reply"
                };
              }
            } catch (e) {
              npmlog.warn("Discord", 'Bot lacks the "View message history" permission.');
              npmlog.warn("Discord", e);
            }
          }
        }
      }

      if (message.messageSnapshots.size > 0) {
        const referenced = message.messageSnapshots.at(0);
        const formattedContent = formatDiscordMessage(referenced.attachments, referenced.content, referenced.mentions);

        replyEmbed = {
          content: formattedContent,
          embedType: "forward"
        };
      }

      const sticker = message.stickers.first();
      let stickerUrl = sticker && sticker.url;

      const messageString = formatDiscordMessage(message.attachments, message.content, message.mentions, stickerUrl);

      const sendOptions = {
        content: truncate(messageString, 2000) || undefined,
        username,
        avatar_url: message.author.avatarURL() || undefined
      };

      if (replyEmbed) {
        const embedBuilder = new EmbedBuilder().setColor("#5875e8");
        if (replyEmbed.entity) embedBuilder.setAuthor({ name: replyEmbed.entity, iconURL: replyEmbed.entityImage });
        if (replyEmbed.content) {
          embedBuilder.setDescription(`**${replyEmbed.embedType === "reply" ? "Reply to" : "Forwarded message"}**: ${replyEmbed.content}`);
        }
        sendOptions.embeds = [embedBuilder.toJSON()];
      }

      if (message.embeds.length && message.author.bot) {
        if (!sendOptions.embeds) sendOptions.embeds = [];
        sendOptions.embeds.push(message.embeds[0].toJSON());
      }

      const sentMessage = await webhook.send(sendOptions, true);
      if (sentMessage) {
        Main.discordCache.push({
          parentMessage: message.id,
          parentAuthor: message.author.id,
          createdMessage: sentMessage.id,
          channelId: target.discord
        });
      }
    }
  } catch (e) {
    npmlog.warn("Fluxer", "Couldn't send a message to Fluxer");
    npmlog.warn("Fluxer", e);
  }
}

async function handleDiscordMessageUpdate(fluxer, message) {
  try {
    const target = Main.mappings.find(mapping => mapping.discord === message.channelId);
    if (target && (target.allowBots || !message.author.bot)) {
      const cachedMessage = Main.discordCache.find(cached => cached.parentMessage === message.id);
      if (cachedMessage) {
        const webhook = Main.fluxerWebhooks.find(wh => wh.name === "revcord-" + message.channelId);
        if (webhook) {
          const messageString = formatDiscordMessage(message.attachments, message.content, message.mentions);
          await webhook.editMessage(cachedMessage.createdMessage, { content: messageString });
        }
      }
    }
  } catch (e) {
    npmlog.error("Fluxer", "Failed to edit message");
    npmlog.error("Fluxer", e);
  }
}

async function handleDiscordMessageDelete(fluxer, messageId) {
  const cachedMessage = Main.discordCache.find(cached => cached.parentMessage === messageId);
  if (cachedMessage) {
    try {
      const target = Main.mappings.find(mapping => mapping.discord === cachedMessage.channelId);
      if (target) {
        const webhook = Main.fluxerWebhooks.find(wh => wh.name === "revcord-" + cachedMessage.channelId);
        if (webhook) {
          await webhook.deleteMessage(cachedMessage.createdMessage);
        }
      }
    } catch (e) {
      npmlog.error("Fluxer", "Failed to delete message");
      npmlog.error("Fluxer", e);
    }
  }
}

async function initiateDiscordChannel(channel, mapping) {
  if (channel instanceof TextChannel) {
    await checkWebhookPermissions(channel);
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.name === "revcord-" + mapping.fluxer);

    if (!webhook) {
      npmlog.info("Discord", "Creating webhook for Discord#" + channel.name);
      webhook = await channel.createWebhook({ name: `revcord-${mapping.fluxer}` });
    }
    Main.webhooks.push(webhook);
  }
}

async function unregisterDiscordChannel(channel, mapping) {
  if (channel instanceof TextChannel) {
    await checkWebhookPermissions(channel);
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.name === "revcord-" + mapping.fluxer);

    npmlog.info("Discord", "Removing webhook for Discord#" + channel.name);
    if (webhook) {
      await webhook.delete();
      const i = Main.webhooks.indexOf(webhook);
      Main.webhooks.splice(i, 1);
    }
  }
}

async function initiateFluxerChannel(channel, mapping) {
  if (channel instanceof FluxerGuildChannel) {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.name === "revcord-" + mapping.discord);

    if (!webhook) {
      npmlog.info("Fluxer", "Creating webhook for Fluxer#" + channel.name);
      webhook = await channel.createWebhook({ name: `revcord-${mapping.discord}` });
    }
    Main.fluxerWebhooks.push(webhook);
  }
}

async function unregisterFluxerChannel(channel, mapping) {
  if (channel instanceof FluxerGuildChannel) {
    const webhooks = await channel.fetchWebhooks();
    const webhook = webhooks.find(wh => wh.name === "revcord-" + mapping.discord);

    npmlog.info("Fluxer", "Removing webhook for Fluxer#" + (channel.name || channel.id));
    if (webhook) {
      await webhook.delete();
      const i = Main.fluxerWebhooks.findIndex(wh => wh.id === webhook.id);
      if (i > -1) Main.fluxerWebhooks.splice(i, 1);
    }
  }
}

async function formatFluxerMessage(fluxer, message) {
  let messageString = "";
  let content = (message.content || "").toString();

  const pings = content.match(FluxerPingPattern);
  if (pings && message.mentions.length > 0) {
    for (const ping of pings) {
      const matched = FluxerPingPattern.exec(ping);
      FluxerPingPattern.lastIndex = 0;

      if (matched !== null) {
        const id = matched.groups["id"];
        if (id) {
          const match = message.mentions.find(user => user.id === id);
          if (match) {
            content = content.replace(ping, `@${match.username}`);
          }
        }
      }
    }
  }

  const channelMentions = content.match(FluxerChannelPattern);
  if (channelMentions) {
    for (const mention of channelMentions) {
      const ch = FluxerChannelPattern.exec(mention);
      FluxerChannelPattern.lastIndex = 0;

      if (ch !== null) {
        const channelId = ch.groups["id"];
        if (channelId) {
          try {
            const channelData = fluxer.channels.get(channelId) || await fluxer.channels.fetch(channelId);
            if (channelData?.name) {
              content = content.replace(mention, "#" + channelData.name);
            }
          } catch {}
        }
      }
    }
  }

  const emojis = content.match(FluxerEmojiPattern);
  if (emojis) {
    emojis.forEach((emoji, i) => {
      const dissected = FluxerEmojiPattern.exec(emoji);
      FluxerEmojiPattern.lastIndex = 0;

      if (dissected != null) {
        const emojiName = dissected.groups["name"];
        if (emojiName && i < 3) {
          content = content.replace(emoji, `:${emojiName}:`);
        }
      }
    });
  }

  messageString += content + "\n";

  message.attachments.forEach(attachment => {
    messageString += attachment.url + "\n";
  });

  return messageString.replace(TrailingNewlines, "");
}

async function handleFluxerMessage(discord, fluxer, message, target) {
  try {
    const channel = await discord.channels.fetch(target.discord);

    if (channel instanceof TextChannel) {
      const webhook = Main.webhooks.find(wh => wh.name === "revcord-" + target.fluxer);
      if (!webhook) {
        throw new Error("No webhook in channel Discord#" + channel.name);
      }

      const referencedMsgId = message.messageReference?.message_id;
      let reply;

      if (referencedMsgId) {
        const crossPlatformReference = Main.discordCache.find(cached => cached.createdMessage === referencedMsgId);
        if (crossPlatformReference) {
          const referencedMessage = await channel.messages.fetch(crossPlatformReference.parentMessage);
          let attachments = [];

          if (referencedMessage.attachments.first()) attachments.push("file");
          if (referencedMessage.embeds.length > 0) attachments.push("embed");

          reply = {
            entity: referencedMessage.author.username + "#" + referencedMessage.author.discriminator,
            entityImage: referencedMessage.author.avatarURL(),
            content: referencedMessage.content,
            originalUrl: referencedMessage.url,
            attachments: attachments,
            embedType: "reply"
          };
        } else {
          try {
            const fluxerCh = fluxer.channels.get(target.fluxer);
            if (fluxerCh && fluxerCh.messages) {
              const refMsg = await fluxerCh.messages.fetch(referencedMsgId);
              let attachments = [];
              if (refMsg.attachments.size > 0) attachments.push("file");

              reply = {
                entity: refMsg.author.username,
                entityImage: refMsg.author.displayAvatarURL(),
                content: refMsg.content || "",
                attachments: attachments,
                embedType: "reply"
              };
            }
          } catch {}
        }
      }

      let messageString = await formatFluxerMessage(fluxer, message);

      let embed = reply && new EmbedBuilder()
        .setColor("#5875e8")
        .setAuthor({ name: reply.entity, iconURL: reply.entityImage });

      if (reply && reply.content) {
        if (reply.originalUrl) {
          embed?.setDescription(`[**Reply to:**](${reply.originalUrl}) ` + reply.content);
        } else {
          embed?.setDescription(`**Reply to**: ` + reply.content);
        }
      } else if (reply && reply.originalUrl) {
        embed?.setDescription(`[**Reply to**](${reply.originalUrl})`);
      }

      if (reply && reply.attachments.length > 0) {
        embed?.setFooter({ text: "contains " + reply.attachments.map(a => a + " ") });
      }

      const avatarURL = message.author.displayAvatarURL();

      await sendDiscordMessage(
        webhook,
        {
          messageId: message.id,
          authorId: message.author.id,
          channelId: message.channelId
        },
        messageString,
        message.author.username,
        avatarURL,
        embed,
        false
      );
    }
  } catch (e) {
    npmlog.error("Discord", "Couldn't send a message to Discord");
    npmlog.error("Discord", e);
  }
}

async function sendDiscordMessage(webhook, sourceParams, content, username, avatarURL, embed, allowUserPing) {
  const webhookMessage = await webhook.send({
    content,
    username,
    avatarURL,
    embeds: embed ? [embed] : [],
    allowedMentions: {
      parse: allowUserPing ? ["users"] : []
    }
  });

  Main.fluxerCache.push({
    parentMessage: sourceParams.messageId,
    parentAuthor: sourceParams.authorId,
    channelId: sourceParams.channelId,
    createdMessage: webhookMessage.id
  });
}

async function handleFluxerMessageUpdate(fluxer, message) {
  const target = Main.mappings.find(mapping => mapping.fluxer === message.channelId);
  if (target) {
    try {
      const cachedMessage = Main.fluxerCache.find(cached => cached.parentMessage === message.id);
      if (cachedMessage) {
        const webhook = Main.webhooks.find(wh => wh.name === "revcord-" + target.fluxer);
        if (webhook) {
          const messageString = await formatFluxerMessage(fluxer, message);
          await webhook.editMessage(cachedMessage.createdMessage, { content: messageString });
        }
      }
    } catch (e) {
      npmlog.error("Discord", "Failed to edit message");
      npmlog.error("Discord", e);
    }
  }
}

async function handleFluxerMessageDelete(fluxer, partialMessage) {
  const cachedMessage = Main.fluxerCache.find(cached => cached.parentMessage === partialMessage.id);
  if (cachedMessage) {
    try {
      const target = Main.mappings.find(mapping => mapping.fluxer === cachedMessage.channelId);
      if (target) {
        const webhook = Main.webhooks.find(wh => wh.name === "revcord-" + target.fluxer);
        if (webhook) {
          await webhook.deleteMessage(cachedMessage.createdMessage);
        }
      }
    } catch (e) {
      npmlog.error("Discord", "Failed to delete message");
      npmlog.error("Discord", e);
    }
  }
}

async function replyFluxerInteraction(interaction, content, ephemeral = true) {
  await interaction.client.rest.post(
    FluxerRoutes.interactionCallback(interaction.id, interaction.token),
    {
      body: {
        type: 4,
        data: {
          content,
          flags: ephemeral ? 64 : 0
        }
      },
      auth: false
    }
  );
}

async function registerFluxerCommands(fluxer, commandsJson) {
  try {
    npmlog.info("Fluxer", `Registering ${commandsJson.length} slash commands globally.`);
    await fluxer.rest.put(
      FluxerRoutes.applicationCommands(fluxer.user.id),
      { body: commandsJson }
    );
    npmlog.info("Fluxer", "Slash commands registered.");
  } catch (error) {
    npmlog.error("Fluxer", error);
  }
}

async function registerSlashCommands(rest, discord, guildId, commandsJson) {
  try {
    npmlog.info("Discord", `Started refreshing ${commandsJson.length} application (/) commands.`);
    const data = await rest.put(
      require("discord-api-types/v10").Routes.applicationGuildCommands(discord.user.id, guildId),
      { body: commandsJson }
    );
    npmlog.info("Discord", `Successfully reloaded ${data.length} application (/) commands.`);
  } catch (error) {
    npmlog.error("Discord", error);
  }
}

class ConnectCommand {
  constructor() {
    this.data = new SlashCommandBuilder()
      .setName("connect")
      .setDescription("DiscordとFluxerのチャンネルを接続するよ！")
      .addStringOption(option =>
        option.setName("discord")
          .setDescription("Discordチャンネル（名前かID）")
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName("fluxer")
          .setDescription("Fluxerチャンネル（名前かID）")
          .setRequired(true)
      );
  }

  async execute(interaction, executor) {
    const discord = interaction.options.getString("discord");
    const fluxer = interaction.options.getString("fluxer");

    try {
      await executor.connect(discord, fluxer);
      await interaction.reply({ content: `Discord#${discord} と Fluxer#${fluxer} を接続したよ！`, ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: `エラー: ${error.message}`, ephemeral: true });
    }
  }
}

class DisconnectCommand {
  constructor() {
    this.data = new SlashCommandBuilder()
      .setName("disconnect")
      .setDescription("DiscordチャンネルとFluxer接続を切るよ！");
  }

  async execute(interaction, executor) {
    try {
      await executor.disconnect("discord", interaction.channelId);
      await interaction.reply({ content: "チャンネルの接続を切断したよ！", ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: `エラー: ${error.message}`, ephemeral: true });
    }
  }
}

class ListConnectionsCommand {
  constructor() {
    this.data = new SlashCommandBuilder()
      .setName("connections")
      .setDescription("接続中のアクティブなチャンネル一覧を表示するよ！");
  }

  async execute(interaction, executor) {
    try {
      const connections = await executor.connections();
      if (connections.length === 0) {
        await interaction.reply({ content: "アクティブな接続がないよ...", ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("アクティブな接続")
        .setColor("#5875e8")
        .setDescription(
          connections.map(conn =>
            `Discord: **${conn.discord}** <-> Fluxer: **${conn.fluxer}**${conn.allowBots ? " (bot許可)" : ""}`
          ).join("\n")
        );

      await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
      await interaction.reply({ content: `エラー: ${error.message}`, ephemeral: true });
    }
  }
}

class AllowBotsCommand {
  constructor() {
    this.data = new SlashCommandBuilder()
      .setName("allowbots")
      .setDescription("チャンネルのbotメッセージ転送を切り替えるよ！");
  }

  async execute(interaction, executor) {
    try {
      const mapping = Main.mappings.find(mapping => mapping.discord === interaction.channelId);
      if (!mapping) {
        await interaction.reply({ content: "ここはFluxerに接続されてないよ...", ephemeral: true });
        return;
      }

      const newState = await executor.toggleAllowBots(mapping);
      await interaction.reply({
        content: `このチャンネルのbotメッセージ転送を${newState ? "有効" : "無効"}にしたよ`,
        ephemeral: true
      });
    } catch (error) {
      await interaction.reply({ content: `エラー: ${error.message}`, ephemeral: true });
    }
  }
}

class FluxerSlashConnectCommand {
  constructor() {
    this.data = {
      name: "connect",
      description: "DiscordとFluxerのチャンネルを接続するよ！",
      options: [
        { name: "discord", description: "Discordチャンネル（名前かID）", type: 3, required: true },
        { name: "fluxer", description: "Fluxerチャンネル（名前かID）", type: 3, required: true }
      ]
    };
  }

  async execute(interaction, executor) {
    const discord = interaction.getString("discord");
    const fluxer = interaction.getString("fluxer");

    try {
      await executor.connect(discord, fluxer);
      await replyFluxerInteraction(interaction, `Discord#${discord} と Fluxer#${fluxer} を接続したよ！`);
    } catch (error) {
      await replyFluxerInteraction(interaction, `エラー: ${error.message}`);
    }
  }
}

class FluxerSlashDisconnectCommand {
  constructor() {
    this.data = {
      name: "disconnect",
      description: "FluxerチャンネルとDiscordの接続を切断するよ"
    };
  }

  async execute(interaction, executor) {
    try {
      await executor.disconnect("fluxer", interaction.channelId);
      await replyFluxerInteraction(interaction, "チャンネルの接続を切断したよ");
    } catch (error) {
      await replyFluxerInteraction(interaction, `エラー: ${error.message}`);
    }
  }
}

class FluxerSlashListConnectionsCommand {
  constructor() {
    this.data = {
      name: "connections",
      description: "接続中のアクティブなチャンネル一覧を表示するよ！"
    };
  }

  async execute(interaction, executor) {
    try {
      const connections = await executor.connections();
      if (connections.length === 0) {
        await replyFluxerInteraction(interaction, "アクティブな接続がないよ...");
        return;
      }

      const list = connections.map(conn =>
        `Discord: **${conn.discord}** <-> Fluxer: **${conn.fluxer}**${conn.allowBots ? " (bot許可)" : ""}`
      ).join("\n");

      await replyFluxerInteraction(interaction, `**アクティブな接続:**\n${list}`);
    } catch (error) {
      await replyFluxerInteraction(interaction, `エラー: ${error.message}`);
    }
  }
}

class FluxerSlashAllowBotsCommand {
  constructor() {
    this.data = {
      name: "allowbots",
      description: "チャンネルのbotメッセージ転送を切り替えるよ！"
    };
  }

  async execute(interaction, executor) {
    try {
      const mapping = Main.mappings.find(mapping => mapping.fluxer === interaction.channelId);
      if (!mapping) {
        await replyFluxerInteraction(interaction, "このチャンネルはDiscordに接続されてないよ...");
        return;
      }

      const newState = await executor.toggleAllowBots(mapping);
      await replyFluxerInteraction(interaction, `このチャンネルのbotメッセージ転送を${newState ? "有効" : "無効"}にしたよ`);
    } catch (error) {
      await replyFluxerInteraction(interaction, `エラー: ${error.message}`);
    }
  }
}

class Main {
  static mappings = [];
  static webhooks = [];
  static fluxerWebhooks = [];
  static discordCache = [];
  static fluxerCache = [];

  constructor() {
    const discordToken = process.env.DISCORD_TKN;
    const fluxerToken = process.env.FLUXER_TKN;

    if (!discordToken || !fluxerToken) {
      throw "At least one token was not provided";
    }
  }

  async initDb() {
    const sequelize = new Sequelize({
      dialect: "sqlite",
      storage: "revcord.sqlite",
      logging: false
    });

    await sequelize.authenticate();
    npmlog.info("db", "Connection has been established successfully.");

    MappingModel.init({
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      discordChannel: {
        type: DataTypes.STRING
      },
      fluxerChannel: {
        type: DataTypes.STRING
      },
      discordChannelName: {
        type: DataTypes.STRING
      },
      fluxerChannelName: {
        type: DataTypes.STRING
      },
      allowBots: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
      }
    }, { sequelize, modelName: "mapping" });

    await sequelize.sync({ alter: true });

    const mappingsInDb = await MappingModel.findAll({});
    const mappings = mappingsInDb.map(mapping => ({
      discord: mapping.discordChannel,
      fluxer: mapping.fluxerChannel,
      allowBots: mapping.allowBots
    }));

    return mappings;
  }

  async start() {
    let usingJson = false;
    try {
      const mappings = await getMappings();
      Main.mappings = mappings;
      usingJson = true;
    } catch {
      try {
        Main.mappings = await this.initDb();
      } catch (e) {
        npmlog.error("db", "A database error occurred. If you don't know what to do, try removing the `revcord.sqlite` file (will reset all your settings).");
        npmlog.error("db", e);
      }
    } finally {
      this.bot = new Bot(usingJson);
      this.bot.start();
    }
  }
}

class Bot {
  constructor(usingJsonMappings) {
    this.usingJsonMappings = usingJsonMappings;
  }

  async start() {
    this.setupFluxerBot();
    this.setupDiscordBot();
  }

  setupDiscordBot() {
    this.discord = new DiscordClient({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages
      ],
      allowedMentions: { parse: [] }
    });

    this.discord.once("ready", () => {
      console.log("Discord ready");
      npmlog.info("Discord", `Logged in as ${this.discord.user.username}#${this.discord.user.discriminator}`);

      this.rest = new REST().setToken(process.env.DISCORD_TKN);
      this.executor = new UniversalExecutor(this.discord, this.fluxer);
      this.commands = new Collection();

      const slashCommands = [
        new ConnectCommand(),
        new DisconnectCommand(),
        new ListConnectionsCommand(),
        new AllowBotsCommand()
      ];

      slashCommands.forEach(command => {
        this.commands.set(command.data.name, command);
      });

      this.commandsJson = this.commands.map(command => command.data.toJSON());

      if (!this.usingJsonMappings) {
        this.discord.guilds.cache.forEach(guild => {
          registerSlashCommands(this.rest, this.discord, guild.id, this.commandsJson);
        });
        console.log("Discord commands registered");
      }

      Main.mappings.forEach(async mapping => {
        const channel = this.discord.channels.cache.get(mapping.discord);
        try {
          await initiateDiscordChannel(channel, mapping);
        } catch (e) {
          npmlog.error("Discord", "An error occurred while initializing webhooks");
          npmlog.error("Discord", e);
        }
      });
    });

    this.discord.on("interactionCreate", async interaction => {
      if (!interaction.isCommand() || this.usingJsonMappings) return;

      const command = this.commands.get(interaction.commandName);
      if (!command) {
        npmlog.info("Discord", "no command");
        return;
      }

      try {
        await command.execute(interaction, this.executor);
      } catch (e) {
        npmlog.error("Discord", "Error while executing slash command");
        npmlog.error("Discord", e);
      }
    });

    this.discord.on("guildCreate", guild => {
      if (!this.usingJsonMappings) {
        registerSlashCommands(this.rest, this.discord, guild.id, this.commandsJson);
      }
    });

    this.discord.on("messageCreate", message => {
      handleDiscordMessage(this.fluxer, this.discord, message);
    });

    if (process.env.DEBUG && !isNaN(Number(process.env.DEBUG))) {
      if (Number(process.env.DEBUG)) {
        this.discord.on("debug", info => {
          if (info.toLowerCase().includes("heartbeat")) return;
          npmlog.info("DEBUG", info);
        });
      }
    }

    this.discord.on("messageUpdate", (oldMessage, newMessage) => {
      if (oldMessage.applicationId === this.discord.user.id) return;

      const partialMessage = {
        author: oldMessage.author,
        attachments: oldMessage.attachments,
        channelId: oldMessage.channelId,
        content: newMessage.content,
        embeds: newMessage.embeds,
        id: newMessage.id,
        mentions: newMessage.mentions
      };

      handleDiscordMessageUpdate(this.fluxer, partialMessage);
    });

    this.discord.on("messageDelete", message => {
      if (message.applicationId === this.discord.user.id) return;
      handleDiscordMessageDelete(this.fluxer, message.id);
    });

    this.discord.login(process.env.DISCORD_TKN);
  }

  setupFluxerBot() {
    this.fluxer = new FluxerClient({ intents: 0, suppressIntentWarning: true });

    this.fluxer.on(FluxerEvents.Ready, () => {
      console.log("Fluxer ready");
      npmlog.info("Fluxer", `Logged in as ${this.fluxer.user.username}`);

      this.fluxerSlashCommands = new Collection();
      const fluxerSlashCommands = [
        new FluxerSlashConnectCommand(),
        new FluxerSlashDisconnectCommand(),
        new FluxerSlashListConnectionsCommand(),
        new FluxerSlashAllowBotsCommand()
      ];

      fluxerSlashCommands.forEach(command => {
        this.fluxerSlashCommands.set(command.data.name, command);
      });

      if (!this.usingJsonMappings) {
        registerFluxerCommands(this.fluxer, fluxerSlashCommands.map(c => c.data));
      }

      console.log("Fluxer commands registered");

      Main.mappings.forEach(async mapping => {
        const channel = this.fluxer.channels.get(mapping.fluxer);
        try {
          if (channel) {
            await initiateFluxerChannel(channel, mapping);
          }
        } catch (e) {
          npmlog.error("Fluxer", e);
        }
      });
    });

    this.fluxer.on(FluxerEvents.InteractionCreate, async interaction => {
      if (!isChatInputCommandInteraction(interaction) || this.usingJsonMappings) return;
      if (!this.fluxerSlashCommands) return;

      const command = this.fluxerSlashCommands.get(interaction.commandName);
      if (!command) return;

      try {
        await command.execute(interaction, this.executor);
      } catch (e) {
        npmlog.error("Fluxer", "Error while executing slash command");
        npmlog.error("Fluxer", e);
      }
    });

    this.fluxer.on(FluxerEvents.MessageCreate, async message => {
      if (!message.content && message.attachments.size === 0) return;

      const isOurWebhook = message.webhookId && Main.fluxerWebhooks.some(wh => wh.id === message.webhookId);
      if (isOurWebhook) return;

      const target = Main.mappings.find(mapping => mapping.fluxer === message.channelId);

      if (target && message.author.id !== this.fluxer.user?.id && (!message.author.bot || target.allowBots)) {
        handleFluxerMessage(this.discord, this.fluxer, message, target);
      }
    });

    this.fluxer.on(FluxerEvents.MessageUpdate, async (oldMessage, newMessage) => {
      if (!newMessage.content) return;
      const isOurWebhook = newMessage.webhookId && Main.fluxerWebhooks.some(wh => wh.id === newMessage.webhookId);
      if (isOurWebhook) return;
      handleFluxerMessageUpdate(this.fluxer, newMessage);
    });

    this.fluxer.on(FluxerEvents.MessageDelete, async partialMessage => {
      handleFluxerMessageDelete(this.fluxer, partialMessage);
    });

    this.fluxer.login(process.env.FLUXER_TKN);
  }
}

console.log("Bridge bot starting...");
const app = new Main();
app.start();
