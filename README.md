# discord for fluxer bot

DiscordとFluxerのチャンネルを繋ぐことのできるbotです。

.env を作成:

```
DISCORD_TKN=discord_bottoken
FLUXER_TKN=fluxer_bottoken
```

## コマンド

**DiscordとFluxerスラッシュコマンド**

コマンドと説明
- /connect <discord> <fluxer> : チャンネルを接続 
- /disconnect : 現在のチャンネルの接続を切断
- /connections : 接続一覧を表示 
- /allowbots : botメッセージ転送を切り替え 