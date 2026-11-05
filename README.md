# claude-chat-bridge — answer your Claude Code sessions from WhatsApp, Gmail or Google Chat

## Quick start

All commands run in the project folder. `node bin/bridge.js …` works everywhere; after `npm link` you can type `bridge …` instead.

### 1. Install (once)

```bash
node -v                            # needs v22.13 or newer
cd "claude-chat-bridge"
npm install
node bin/bridge.js doctor          # checks Node, Claude Code and the terminal (PTY)
```

### 2. Pick where questions go

```bash
node bin/bridge.js channels whatsapp         # WhatsApp only
node bin/bridge.js channels gmail            # email only (needs the Apps Script setup below)
node bin/bridge.js channels gmail,whatsapp   # both: the first answer wins
node bin/bridge.js channels                  # show the current setting
```

Switching saves `BRIDGE_CHANNELS` in your `.env` and restarts the bridge. Turning email off also pauses Apps Script, so it stops sending emails. That needs Apps Script 1.6.0: paste `apps-script/Code.gs` into the editor once, then Deploy → Manage deployments → Edit → New version.

### 3. WhatsApp setup

**Recommended: give the bridge its own WhatsApp number** (a second SIM, or WhatsApp Business with another number). Then Claude's messages show on the **left** as received messages from "Claude", and your phone gets **notifications**. If you link your personal number instead, everything the bridge posts looks like you sent it: right side, and no notifications for you.

1. Set up WhatsApp (or WhatsApp Business) with the bot's number on a phone. Set its profile name to e.g. **Claude**.
2. Add to `.env` in the project folder:
   ```bash
   BRIDGE_CHANNELS=whatsapp
   # The people who get the questions and may answer (country code, comma-separated):
   BRIDGE_WHATSAPP_TO=919876543210,919812345678
   # One WhatsApp group per session, named "Claude - <session name>":
   BRIDGE_WHATSAPP_GROUPS=on
   ```
3. Link the bridge. Scan the QR code with the **bot number's** WhatsApp (Settings → Linked devices → Link a device):
   ```bash
   node bin/bridge.js whatsapp login     # also saves the QR as an image and opens it, if the terminal one won't scan
   node bin/bridge.js whatsapp status    # → connected — linked as +<bot number>
   ```
4. Everyone in `BRIDGE_WHATSAPP_TO` should save the bot's number as a contact. Otherwise messages can land in "message requests."

Switching from your personal number to a bot number:
```bash
node bin/bridge.js whatsapp logout     # unlink the current account
node bin/bridge.js whatsapp login      # scan with the bot number's WhatsApp
```

### 4. Run Claude sessions

```bash
node bin/bridge.js start "Session 1"                  # Claude in this folder → WhatsApp group "Claude - Session 1"
node bin/bridge.js start "API" --cwd ~/code/api       # Claude in another folder → group "Claude - API"
node bin/bridge.js start "Session 1" -- --model opus  # pass arguments to claude after --
```

Each command opens a normal Claude Code terminal. When Claude asks something, the question goes to that session's group (or to email, depending on your channels). **Reply to the question message** with e.g. `1`, `allow`, `deny use staging`, or any text. In a session group, a plain message answers that session's open question. Other commands you can send: `pending` · `sessions` · `status` · `help`.

- Every `start` creates a **new** group. Groups are kept after the session ends.
- Only you and the numbers in `BRIDGE_WHATSAPP_TO`/`BRIDGE_WHATSAPP_ALLOWED` can answer. Other people's messages are ignored.

### 5. Everyday commands

```bash
node bin/bridge.js sessions              # running sessions
node bin/bridge.js pending               # questions waiting for an answer
node bin/bridge.js answer q1a2b3 1       # answer from the PC instead
node bin/bridge.js whatsapp test         # test message to every running session's group (or to the numbers)
node bin/bridge.js logs --follow         # live log
node bin/bridge.js doctor                # health check
node bin/bridge.js stop                  # stop the background bridge (sessions keep running and re-attach)
```

**From WhatsApp** you can also start sessions and talk to Claude:

| Send | What happens |
|---|---|
| `/new My Project` | Starts a Claude session on the PC, in the background, in `BRIDGE_WHATSAPP_START_DIR` (default: your home folder). In group mode its group appears right away. |
| `/new Site in ~/work/site` | Same, in that folder (relative folders resolve against the start folder). |
| `/new Site in ~/work/site: fix the login bug` | Same, and the text after `:` is Claude's first message. |
| any message | If it answers no open question, it's typed into Claude as your next message: in a session group to that session; in a 1-to-1 chat to the only running session, or `#2 your text` for session_002. While Claude is working it's queued (🕐) and runs next. |
| `/exit` | Typed into Claude like any message: ends that session. |

Nothing is typed while that session has a permission request or question open: answer it first. Sessions started from WhatsApp open in a window of the tmux session `claude-bridge` (one window per session) when tmux is installed (`sudo apt install tmux`): watch them and type into them with `tmux attach -t claude-bridge`, switch windows with `Ctrl+b n` / `Ctrl+b w`, and leave without stopping anything with `Ctrl+b d`. Set `BRIDGE_TMUX_SESSION` to use another name, or `BRIDGE_TMUX_SESSION=off` to run them in the background with no terminal. Their screen output is also copied to `~/.claude-chat-bridge/logs/remote-session-*.log`. To turn remote starting off, set `BRIDGE_WHATSAPP_REMOTE_START=off`.

### 6. If something doesn't arrive

| Symptom | Check |
|---|---|
| `whatsapp status` says `connecting` | Wait a few seconds after a restart. If it stays, run `node bin/bridge.js logs`. |
| `not_linked` / `logged_out` | `node bin/bridge.js whatsapp login` |
| QR code won't scan | Scan the image that opens (also saved as `~/.claude-chat-bridge/whatsapp-qr.png`). |
| No group appears | `node bin/bridge.js logs` and look for `session group`. You need at least one number in `BRIDGE_WHATSAPP_TO` besides the bot's own. |
| A member wasn't added | Their privacy settings block it; they get an invite link instead. |
| Still getting emails with `channels whatsapp` | Update Apps Script to 1.6.0 (see step 2), then run `node bin/bridge.js channels whatsapp` again. |
| Company network / firewall | `node bin/bridge.js doctor`. See [WhatsApp setup](#whatsapp-setup-linked-device). |

The full documentation follows: Gmail and Google Chat setup, configuration, security, troubleshooting.

---

## Overview

Run several Claude Code CLI sessions on your PC, walk away, and answer their questions from Google Chat on your phone. Claude Code can stop for several kinds of input, and each one is forwarded to a **Claude Assistant** Chat app with buttons:
- multiple-choice questions,
- permission prompts,
- "should I continue?" style questions,
- terminal menus.

When you tap a button, the answer is routed back to the right terminal and Claude continues.

Two ways to receive questions:
- **Gmail (default, no admin rights needed):** each question is an email to yourself. Answer with a one-tap link or by replying to the email. See [Gmail setup](#gmail-setup-no-admin-rights-needed).
- **Google Chat app:** interactive cards in a Chat DM. This needs a Chat app configured in Cloud Console, and possibly admin settings. See §5–§9.

**Zero cost.** It uses only:
- Node.js
- Claude Code's official hooks
- a free Google Apps Script project
- the Google Chat API (free with Workspace)
- a Google Sheet for history

There is no server to host, no inbound port, and no paid service.

```
 Your PC                                                    Google (free)
┌────────────────────────────────────────────┐            ┌──────────────────────────────────┐
│ terminal 1: bridge start "SPM Backend"     │            │ Apps Script project              │
│   └─ claude (PTY) ──hooks──┐               │  HTTPS     │  • web app relay  (doPost)       │
│ terminal 2: bridge start "Mobile App"      │  outbound  │  • Chat app "Claude Assistant"   │
│   └─ claude (PTY) ──hooks──┤               │  only,     │  • Script Properties = queue     │
│                            ▼               │  HMAC-     │  • Sheet = history / audit       │
│ bridge daemon (127.0.0.1 only)             │  signed    │                                  │
│   SQLite queue · router · sync ────────────┼───────────►│  pushes cards ──► Google Chat ──►📱│
│                            ▲               │  long-poll │  ◄── button clicks / commands     │
│                            └── answers ◄───┼────────────┤                                  │
└────────────────────────────────────────────┘            └──────────────────────────────────┘
```

---

## Contents

- [Quick start](#quick-start)

0. [Gmail setup (no admin rights needed)](#gmail-setup-no-admin-rights-needed)
0a. [Choosing platforms: BRIDGE_CHANNELS](#choosing-platforms-bridge_channels)
0b. [WhatsApp setup (linked device)](#whatsapp-setup-linked-device)

1. [What gets forwarded, and how answers return](#1-what-gets-forwarded-and-how-answers-return)
2. [Prerequisites](#2-prerequisites)
3. [Install Node.js and the bridge](#3-install-nodejs-and-the-bridge)
4. [Claude Code configuration](#4-claude-code-configuration-nothing-to-change)
5. [Google Cloud project & Chat API](#5-google-cloud-project--google-chat-api)
6. [Apps Script deployment](#6-apps-script-deployment)
7. [Create the Google Chat app](#7-create-the-google-chat-app-claude-assistant)
8. [Pushing messages: service account (recommended) or webhook](#8-pushing-messages-service-account-recommended-or-webhook)
9. [Workspace administrator permissions](#9-workspace-administrator-permissions)
10. [Environment variables & local setup](#10-environment-variables--local-setup)
11. [Starting the bridge and launching sessions](#11-starting-the-bridge-and-launching-sessions)
12. [Using Google Chat](#12-using-google-chat)
13. [Configuration reference](#13-configuration-reference)
14. [Running in the background](#14-running-in-the-background)
15. [Testing](#15-testing)
15a. [Logs & monitoring](#logs--monitoring)
16. [Troubleshooting](#16-troubleshooting)
17. [Security considerations](#17-security-considerations)
18. [Known limitations](#18-known-limitations)

---

## Gmail setup (no admin rights needed)

This path uses only your own Google account: no Chat app, no service account, no Cloud Console configuration.

**1. Apps Script**
1. Go to <https://script.google.com> → **New project** → name it `Claude Assistant`.
2. ⚙ **Project Settings** → tick **Show "appsscript.json" manifest file**.
3. Paste [`apps-script/Code.gs`](apps-script/Code.gs) into `Code.gs` (replace everything) and [`apps-script/appsscript.json`](apps-script/appsscript.json) into `appsscript.json`. **Save**.

**2. Script Properties** (⚙ Project Settings → Script properties)

| Property | Value |
|---|---|
| `SHARED_SECRET` | the value of `BRIDGE_SHARED_SECRET` on your PC (≥ 32 chars) |
| `ALLOWED_EMAILS` | your address, e.g. `you@company.com` |
| `PUSH_MODE` | `gmail` (also the default when no service account or webhook is set) |
| `ANSWER_URL` | filled in at step 5 (optional but recommended) |

**3. Run `setup` once:** pick `setup` in the toolbar → **Run** → allow the permissions it asks for (Gmail, Sheets, triggers, external requests). It creates the history sheet and two triggers: reminders every 5 min, and reading your email replies every 1 min.

**4. Relay deployment** (the PC talks to this one)
1. **Deploy → New deployment → Web app**: *Execute as* **Me**, *Who has access* **Anyone**.
2. Copy the `/exec` URL into `BRIDGE_APPS_SCRIPT_URL` on your PC.

**5. Answer-link deployment** (optional; enables one-tap buttons in the emails)
1. **Deploy → New deployment → Web app** again: *Execute as* **Me**, *Who has access* **Anyone within <your domain>**.
2. Copy its `/exec` URL into the Script Property `ANSWER_URL`.

This second deployment is how the answer page knows it's really you. Google makes you sign in, and the script checks your email against `ALLOWED_EMAILS`. Without `ANSWER_URL`, you answer by replying to the email.

**6. After every change to `Code.gs`:** Deploy → **Manage deployments** → edit **each** deployment → *Version*: **New version** → Deploy. A deployment keeps running its old version otherwise, which shows up as *"Script function not found: doPost"*.

**7. On the PC**
```bash
node bin/bridge.js doctor --send-test   # ✔ everywhere + a test email arrives
node bin/bridge.js start "SPM Backend" --cwd ~/code/spm-backend
```

**What the emails contain**
- **Every question email** shows:
  - **📝 You asked**: your last instruction to that session;
  - **🔧 What Claude did** since then: files edited, commands run, files read, and so on;
  - for questions, **💬 what Claude said right before asking**.

  This is read from the session's own Claude transcript on your PC, so you can answer without opening the terminal.
- **When Claude completes a task** (its turn ends without asking you anything), you get a green **"✅ Finished: <your request>"** email with the same context plus Claude's summary. Reply with your next instruction and it is typed into Claude, or ignore it.
- **The subject always starts with the session name**: `[Claude · <session name>] …`.

**Gmail limits**
- Emails are **sent** with Apps Script's `MailApp`; `bridge doctor` shows how many you have left today.
- **Replies are read** by a once-a-minute trigger that does a single Gmail search, so polling never touches Gmail.
- The manifest needs the scope `https://www.googleapis.com/auth/script.send_mail`, already in `apps-script/appsscript.json`. After adding it, run `setup` once more to approve it.

**Answering by email**
- **Tap a button** in a question email. A page opens showing your answer → **Confirm**. Email scanners that open links can't answer, because only the Confirm button does.
- **Reply** to the question email:

  | Question type | What to reply |
  |---|---|
  | Option question | `1`, `2`, … or your own text |
  | Permission | `allow` · `session` · `deny <reason>` (`allow confirm` for sensitive operations) |
  | Turn finished | any text, which is typed into Claude's prompt |
  | Any question | `dismiss` |

  Only replies **sent from your own account** count: the script checks that the reply is in your Sent mail. You get a short "📨 Got it" reply in the thread. Replies are read within about 1 minute.
- **Commands:** email yourself with subject `claude sessions`, `claude status`, `claude pending` or `claude help`. The answer arrives in the same thread.
- **When a question is resolved**, its thread is labelled `Claude Assistant/Answered`, `…/Answered in terminal`, `…/Expired`, or `…/Dismissed`, and marked read. Problems (e.g. "Not delivered: you already answered in the terminal") are replied in the thread.
- **Signatures and quoted text are removed** before your reply reaches Claude. That covers a `-- ` separator, link-only lines (logos, social icons), your name or email address alone on a line, "Regards"/"Thanks" sign-offs, "Sent from my iPhone", and the quoted original email. If your signature starts differently, set the Script Property `SIGNATURE_MARKER` to its first words (e.g. `Software Engineer`); everything from that line on is cut.
- **Replying too late** (the question was already answered in the terminal, expired, or dismissed) gets a reply in the thread: *"This question was already handled — … Your reply was NOT sent to Claude."* Replies are never silently dropped.
- **Timing:**
  - A question email goes out about 5 s after Claude asks (20 s for "turn finished").
  - It is held back while you are typing in that terminal (`localPresenceSec`, 20 s).
  - Email replies are checked about once a minute, so allow up to 60 s before Claude continues.

**Phone notifications:** some Gmail apps don't notify for mail you send to yourself. If yours doesn't, set `NOTIFY_EMAIL` to another address you read on the phone. Answer links still work from there, as long as you open them signed in to the allowed account. Replies, however, must be sent from the script owner's account.

---

## Choosing platforms: `BRIDGE_CHANNELS`

Set in `.env` (project folder or `~/.claude-chat-bridge/.env`) which platforms receive questions:

```bash
BRIDGE_CHANNELS=gmail             # email only (default when an Apps Script URL is set)
BRIDGE_CHANNELS=whatsapp          # WhatsApp only (no Apps Script needed)
BRIDGE_CHANNELS=gmail,whatsapp    # both
```

- **Every listed platform gets every question.** The first answer from any of them wins, and the others show it:
  - WhatsApp edits its message to e.g. *"✅ Answered: Postgres (via email)"*;
  - a late email reply gets *"already handled"*.
- **Switch with one command:** `node bin/bridge.js channels whatsapp` (or `gmail`, or `gmail,whatsapp`). It updates `BRIDGE_CHANNELS` in the `.env` that sets it, restarts the bridge, and, when email/Chat is turned off, tells Apps Script to pause. A paused Apps Script sends nothing: no reminders and no "bridge disconnected" notices. It turns back on by itself when you switch email back on. Run `node bin/bridge.js channels` to see the current setting.
- **If you edit `.env` by hand instead**, restart the bridge with `node bin/bridge.js stop`; it starts again with the next command. It pauses Apps Script on start whenever email/Chat isn't in the list. Check with `node bin/bridge.js doctor`.
- **Pausing needs Apps Script 1.6.0 or later.** With an older `Code.gs`, copy the new one into the editor and deploy a new version (Deploy → Manage deployments → Edit → New version).
- Telegram is planned next and will be added the same way (`BRIDGE_CHANNELS=…,telegram`).

## WhatsApp setup (linked device)

The bridge links to your WhatsApp the same way WhatsApp Web does: free, running on your PC, no Meta account or server.

1. Add `whatsapp` to `BRIDGE_CHANNELS` in `.env`, e.g. `BRIDGE_CHANNELS=gmail,whatsapp`, then run `node bin/bridge.js stop`.
2. Link it:
   ```bash
   node bin/bridge.js whatsapp login
   ```
   A QR code appears in the terminal. On your phone: **WhatsApp → Settings → Linked devices → Link a device**, and scan it. You'll see `✅ Linked as +91…`, and a welcome message arrives in your **"Message yourself"** chat (your own number at the top of the chat list).
3. Check: `node bin/bridge.js whatsapp status` and `node bin/bridge.js doctor`.

**Answering on WhatsApp**
- Each question arrives in your "Message yourself" chat with the same context as the email: what you asked, what Claude did, and what it said.
- **Swipe right on a question message (Reply)** and type:
  - `1` / `2` … to pick an option, or your own text;
  - `allow` · `session` · `deny <reason>` for permissions (`allow confirm` for sensitive operations);
  - for questions with several parts, one line per part (`1,3` picks several options);
  - `dismiss` to skip.
- If only one question is open, you can just type the answer without swiping. With several open, either swipe-reply, or start with the question id, e.g. `qk3u5f 2`.
- **Accepted answers get a ✅ reaction.** Problems are replied in the chat, e.g. *"Not delivered: you already answered in the terminal"*.
- **Commands:** `sessions`, `pending`, `status`, `help`.
- **Notifications** (session finished or failed) arrive in the same chat.

**Good to know**
- **Unofficial client:** linking uses the open-source Baileys library, not an official WhatsApp API. WhatsApp doesn't approve automated clients, so there is a small risk that WhatsApp restricts the number. The bridge only messages your own chat, at low volume, which keeps that risk low. If that's not acceptable, use email only.
- **Notifications:** your phone may not show a notification for messages a linked device posts in your own "Message yourself" chat. If you miss them, link the bridge to a **second WhatsApp number** (e.g. WhatsApp Business on another SIM) and set `BRIDGE_WHATSAPP_TO=<your main number>`. The bridge account then messages your main number like a normal contact, and only that number may answer.
- **Several people:** list several numbers, separated by commas: `BRIDGE_WHATSAPP_TO=919876543210,919812345678`. Every number gets each question and notification, and any of them can answer by replying to their copy. The first answer wins, every copy is updated to show who answered, and later replies are refused. Each number must be able to receive messages from the linked account. A number the recipient hasn't saved or messaged before may land in "message requests" or be held back by WhatsApp's spam filters.
- **One group per session:** set `BRIDGE_WHATSAPP_GROUPS=on`. Every new session (`node bin/bridge.js start "Session 1"`) gets its own group **"Claude - Session 1"**. The members are the `BRIDGE_WHATSAPP_TO` numbers, and the linked account creates the group. All of that session's questions and notices go there, and nothing goes to 1-to-1 chats. Anyone in the group who is listed in `BRIDGE_WHATSAPP_TO`/`BRIDGE_WHATSAPP_ALLOWED` can answer, as can you from the linked phone. A plain reply answers that session's open question.
  - Every new session makes a new group. Groups are kept after the session ends.
  - If someone's privacy settings block adding them, they get an invite link in a 1-to-1 chat instead.
  - If a group can't be created (for example, `BRIDGE_WHATSAPP_TO` has no number besides the linked one), that session's messages go to the normal chats, and the bridge tries again after 5 minutes.
  - The linked account posts as you, so **your own phone gets no notifications** for these groups. The other members do.
  - Creating many groups quickly from an unofficial client can get a number flagged by WhatsApp. Keep it to a normal pace.
- **Login storage:** the linked-device login is stored in `~/.claude-chat-bridge/whatsapp-auth` (mode 700). It keeps working while your phone is offline for up to about 14 days.
- **Company firewalls:** some office networks inspect HTTPS (e.g. **Sophos**) and block the WhatsApp connection with *"unable to verify the first certificate"*. `bridge doctor` detects this and names the firewall. Your WhatsApp messages stay end-to-end encrypted either way. Fixes:
  1. ask IT to exclude `*.whatsapp.net` / `*.whatsapp.com` from SSL inspection;
  2. or get the firewall's CA certificate (`.pem`) from IT and set `BRIDGE_WHATSAPP_CA_FILE=/path/to/ca.pem`;
  3. or run on another network (phone hotspot / home Wi-Fi).
- **Unlinking:** `node bin/bridge.js whatsapp logout`, or remove **Claude Bridge** under Linked devices on the phone.
- **Security:** only messages from your own account in your own chat (or the configured numbers) are accepted. Answers pass the same validation as email answers: open question, matching session, not expired, valid option. Messages from other chats and old chat history are ignored.

## 1. What gets forwarded, and how answers return

| Situation in the terminal | How it is captured | How your answer is applied |
|---|---|---|
| Claude asks a multiple-choice question (`AskUserQuestion`, 1–4 questions, single/multi-select) | `PreToolUse` hook (official) | Hook returns `permissionDecision: "allow"` + `updatedInput.answers` (official contract), so this is not keystroke emulation |
| Claude asks for permission (Bash, Edit, Write, WebFetch, MCP tools, plan approval…) | `PermissionRequest` hook (official) | Hook returns `allow`, `deny` (+ reason) or **allow for this session only** (`addRules` with `destination: "session"`) |
| Claude finishes a turn and waits ("Should I fix the failures or only report?") | `Stop` hook (official) | Your reply is typed into Claude's input box via the PTY, but only if Claude is still idle at the prompt (no `UserPromptSubmit` since) |
| Terminal menus that no hook covers (e.g. Claude's *"Do you trust this folder?"*, inquirer-style lists, `[y/N]` prompts from any CLI) | PTY screen detector on a virtual terminal (`@xterm/headless`) | Arrow keys + Enter / `y`/`n` are injected after re-checking that the same prompt is still on screen |
| MCP elicitation dialogs | `Notification` hook | A notification tells you input is needed in the terminal |
| Session ends / fails / window closed, bridge offline / back online, unanswered reminders | runner + daemon + Apps Script trigger | Notifications in Chat |

**At the keyboard?** Nothing changes, and every prompt still works in the terminal:
- Native permission dialogs stay visible while the bridge waits. Answering one in the terminal withdraws the Chat question.
- For `AskUserQuestion`, which is held while waiting for a remote answer, press any key in that terminal (or `Ctrl+\`). Claude shows its normal dialog, and **the email/Chat question stays open**: whichever answer comes first wins. If you answer in the terminal, the remote question closes automatically.
- Questions are pushed only after a short delay (5 s, or 20 s for "turn finished"). Nothing is pushed while you are typing in that session (`localPresenceSec`), so Chat isn't spammed while you work.

**If anything fails** (daemon down, network gone, question expired), the hook **fails open to the terminal prompt**. It never auto-approves.

---

## 2. Prerequisites

- **Node.js ≥ 22.13** (built-in `node:sqlite` is used, so there is no database to install). Checked with 22.22.2.
- **Claude Code CLI** installed and logged in. Checked with 2.1.280.
- macOS (tested) or Windows 10/11 (uses ConPTY via `node-pty`; written for it but **not tested** here). Linux works the same as macOS.
- A **Google Workspace** account (Business/Enterprise/Education) with Google Chat enabled. Interactive Chat apps are a Workspace feature, and personal `@gmail.com` accounts can't create them.
- Permission to create a Google Cloud project, or an existing one you can use. See [§9](#9-workspace-administrator-permissions) for what an administrator may need to allow.

## 3. Install Node.js and the bridge

macOS (Homebrew) or Windows (winget), if you don't have Node 22 yet:

```bash
brew install node@22            # macOS
winget install OpenJS.NodeJS.LTS  # Windows
node -v                          # must print v22.13 or newer
```

Install the bridge:

```bash
cd "claude-chat-bridge"
npm install          # pinned deps: node-pty 1.1.0, @xterm/headless 6.0.0
npm link             # puts the `bridge` command on your PATH (or use: node bin/bridge.js …)
bridge doctor        # checks Node, Claude Code and the PTY
```

> npm ≥ 11 may skip dependency install scripts. `npm install` runs `scripts/fix-pty-perms.js`, which restores the executable bit on node-pty's `spawn-helper`. The bridge also does this at runtime. Without it every spawn fails with `posix_spawnp failed`.

## 4. Claude Code configuration (nothing to change)

The bridge **does not modify** `~/.claude/settings.json` or any project settings. Sessions started through the bridge get an extra settings layer, `claude --settings ~/.claude-chat-bridge/claude-hooks.json`. Claude Code merges hooks from all settings sources, so your existing hooks keep running. This was verified: with the bridge active, Claude reported 2 hooks running for `PreToolUse`, yours and the bridge's.

The generated hooks file contains:

| Event | Matcher | Purpose | Timeout |
|---|---|---|---|
| `PreToolUse` | `AskUserQuestion` | forward + answer multiple-choice questions | `questionTimeoutSec + 60` |
| `PermissionRequest` | `*` | forward + answer permission prompts | `questionTimeoutSec + 60` |
| `Stop` | – | "turn finished" question | 10 s |
| `UserPromptSubmit` | – | detects that you typed locally | 10 s |
| `Notification`, `SessionStart`, `SessionEnd` | – | status/lifecycle | 5–10 s |

Hook commands use absolute, quoted paths (`"…/node" "…/hook.js"`), so directories with spaces work. The hook only acts when the env var `BRIDGE_SESSION_ID` is set, which happens only for bridge-launched sessions. Claude sessions you start yourself are unaffected.

## 5. Google Cloud project & Google Chat API

1. Open <https://console.cloud.google.com/projectcreate> and create a project, e.g. `claude-assistant`. Note the **project number** (Dashboard → Project info).
2. Enable the Chat API: <https://console.cloud.google.com/apis/library/chat.googleapis.com> → **Enable**.
3. Configure the OAuth consent screen: **APIs & Services → OAuth consent screen**.
   - User type: **Internal**.
   - App name: `Claude Assistant`.
   - Add your email as the support and developer contact.
   - Internal apps need no Google verification.

## 6. Apps Script deployment

1. Go to <https://script.google.com> → **New project** and rename it `Claude Assistant`.
2. **Project Settings** (⚙) → tick **Show "appsscript.json" manifest file in editor**.
3. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs), and `appsscript.json` with [`apps-script/appsscript.json`](apps-script/appsscript.json). Save.
4. **Project Settings → Google Cloud Platform (GCP) Project → Change project**, then enter the **project number** from step 5.1.
   The Chat app has to live in a standard Cloud project; the default hidden project can't be configured for Chat.
5. Select the function `setup` in the editor toolbar → **Run** → authorise. It does three things:
   - creates the history spreadsheet *"Claude Assistant — bridge history"*,
   - generates `SHARED_SECRET` (shown in the execution log),
   - installs a 5-minute `housekeeping` trigger, which drives reminders, expiry, and offline detection.
6. **Project Settings → Script properties** → add:

   | Property | Value |
   |---|---|
   | `SHARED_SECRET` | already created by `setup`, or paste the one from `bridge setup` (the same value must be on both sides) |
   | `ALLOWED_EMAILS` | your Workspace email, e.g. `you@company.com` (comma-separate several) |
   | `SERVICE_ACCOUNT_JSON` *or* `WEBHOOK_URL` | see [§8](#8-pushing-messages-service-account-recommended-or-webhook) |
   | `OFFLINE_AFTER_MIN` / `REMIND_AFTER_MIN` | optional (defaults 5 / 15) |

7. **Deploy → New deployment** → type **Web app**:
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**. The bridge has no Google login; every request is authenticated with the HMAC shared secret instead. Without the secret, requests are rejected.

   Click **Deploy** and copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).
8. **Deploy → Test deployments** → copy the **Head deployment ID**. The Chat app uses it in the next step.

After editing `Code.gs` later: the Chat app (head deployment) picks up changes immediately. For the web app, use **Deploy → Manage deployments → Edit → Version: New version**, which keeps the same URL.

## 7. Create the Google Chat app "Claude Assistant"

1. Open <https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat> (Chat API → **Configuration**).
2. Fill in the app details:
   - **App name**: `Claude Assistant`
   - **Avatar URL**: `https://developers.google.com/workspace/chat/images/quickstart-app-avatar.png` (or your own)
   - **Description**: `Claude Code questions from my PC`
3. **Interactive features**: **On**. Under *Functionality*, select **Join spaces and group conversations** (optional; a DM is enough).
4. **Connection settings**: **Apps Script** → paste the **Head deployment ID**. Leave the default trigger function names. `Code.gs` implements `onMessage`, `onAddedToSpace`, `onRemovedFromSpace` and `onAppCommand`, and also the legacy `onCardClick` and `onAddToSpace` in case your project uses the older event format.
5. **Commands** → add these **slash commands**. The IDs must match:

   | ID | Name | Description |
   |---|---|---|
   | 1 | `/sessions` | List Claude sessions |
   | 2 | `/status` | Bridge status |
   | 3 | `/pending` | Unanswered questions |
   | 4 | `/help` | Help |
   | 5 | `/cancel` | Dismiss a question: `/cancel <id>` |
   | 6 | `/reply` | Answer by text: `/reply <id> <answer>` |

   You can skip this step: typing `sessions`, `pending`, `reply q7k2m 1` etc. in the DM works without slash commands.
6. **Visibility**: add your own email (or a group) → **Save**.
7. In Google Chat: **New chat** → search **Claude Assistant** → open the DM → send `help`. This records the DM as the space where questions are pushed (`CHAT_SPACE`). The first time, Chat asks you to **Configure** or authorise the app; accept.

## 8. Pushing messages: service account (recommended) or webhook

Replying to *your* clicks and commands needs no credentials. To **push** a question the moment Claude asks it, the Chat app must send a message on its own ("app authentication"). Pick one option.

### Option A — service account (interactive cards pushed to your DM) ✅ recommended

1. **IAM & Admin → Service accounts → Create service account** in the same Cloud project, named `claude-assistant`. No roles are needed.
2. Open it → **Keys → Add key → Create new key → JSON** → download.
3. Paste the **entire JSON** into the Script Property `SERVICE_ACCOUNT_JSON`.
4. On your PC: `bridge doctor --send-test`. The line *service-account app authentication* should show ✔ and a test message should arrive.

This uses the `chat.bot` scope, which needs **no administrator approval** (scopes starting with `chat.app.*` would). If **key creation is blocked**, see [§9](#9-workspace-administrator-permissions).

### Option B — incoming webhook (text notifications, no service account)

1. Create a Chat **space** (webhooks can't be added to DMs) → space name → **Apps & integrations → Webhooks → Add webhook** → copy the URL.
2. Set the Script Property `WEBHOOK_URL` to that URL (and optionally `PUSH_MODE=webhook`).
3. Questions arrive in that space as text that includes the question id. Answer from your DM with Claude Assistant using the buttons in `/pending`, or with `/reply <id> <answer>`.

### Option C — nothing pushed

Set `PUSH_MODE=none`. Open the DM and send `/pending` whenever you want to check; everything else works the same.

## 9. Workspace administrator permissions

Everything above can be done by a normal user **if** your Workspace allows it. These are the settings that can block you, and what to do about each:

| Needed for | Admin setting | If it's blocked |
|---|---|---|
| Using any Chat app | Admin console → Apps → Google Workspace → Google Chat → **Chat apps** → *Allow users to install Chat apps* (and allow apps from your own org) | Ask the admin to allow internal Chat apps; nothing else replaces this |
| Creating a Cloud project | Resource Manager *Project Creator* role on the org | Ask for a project to be created for you, or use an existing one |
| Option A service account key | Org policy **`iam.disableServiceAccountKeyCreation`**, which is enforced by default on many newer organisations | Ask an admin to add an exception for this one project, or use **Option B/C** |
| Option B webhooks | Chat setting *Allow users to add and use incoming webhooks* | Use Option A or C |
| Web app "Anyone" access | Apps Script / Drive sharing policies may hide *Anyone*; then only *Only myself* / *Anyone within <domain>* can be chosen | First check you actually picked **Anyone** (a sign-in page / HTTP 401 in `bridge doctor` means you didn't). If the admin hides it: either ask for an exception for this script, or use a free OAuth-authenticated route. One option is calling the restricted web app with your own user access token (`Authorization: Bearer …`). Another is the Apps Script API (`scripts.run`). Both need a one-time local OAuth consent and are **not implemented yet**; this is the integration boundary |

`bridge doctor` reports each of these from the live system: whether the relay is reachable, whether the signature is accepted, the allowlist, whether the spreadsheet exists, push mode, Chat space, whether a service-account token was obtained, and whether a test message was sent.

## 10. Environment variables & local setup

```bash
# 1. create ~/.claude-chat-bridge/{.env,config.json} (secret is generated, file mode 600)
bridge setup --url "https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec" --emails you@company.com
#    → prints SHARED_SECRET / ALLOWED_EMAILS to copy into Script Properties (if you didn't use the one from setup())

# 2. verify the whole chain, including a real message in Google Chat
bridge doctor --send-test
```

| Variable | Meaning |
|---|---|
| `BRIDGE_APPS_SCRIPT_URL` | Web app `/exec` URL |
| `BRIDGE_SHARED_SECRET` | HMAC secret (≥ 32 chars). **Must equal** Script Property `SHARED_SECRET` |
| `BRIDGE_ALLOWED_EMAILS` | Comma-separated allowlist, checked again locally |
| `BRIDGE_HOME` | State directory (default `~/.claude-chat-bridge`) |
| `BRIDGE_QUESTION_TIMEOUT_SEC` | Question expiry (default 1800) |
| `BRIDGE_PUSH_DELAY_SEC` | Overrides every push delay |
| `BRIDGE_LOCAL_PRESENCE_SEC` | Hold pushes while you type in that terminal (default 20) |
| `BRIDGE_CLAUDE_COMMAND` | Claude executable (default `claude`) |
| `BRIDGE_LOG_LEVEL` | `debug` / `info` / `warn` |

Values are read from, lowest precedence first: `claude-chat-bridge/.env` (next to `.env.example`), then `~/.claude-chat-bridge/.env` (written by `bridge setup`), then real environment variables. `bridge doctor` lists the files it read and warns if one is readable by other users (`chmod 600 .env`). See [`.env.example`](.env.example).

## 11. Starting the bridge and launching sessions

Open one terminal (CMD / PowerShell / Terminal) per project, as you do today, and start Claude through the bridge:

```bash
bridge start "SPM Backend"        --cwd ~/code/spm-backend
bridge start "SPM Frontend"       --cwd ~/code/spm-frontend
bridge start "Mobile Application" --cwd ~/code/mobile
# pass Claude arguments after --
bridge start "SPM Backend" --cwd ~/code/spm-backend -- --model opus --permission-mode default
```

The first `bridge start` launches the background daemon automatically, or you can run `bridge daemon --detach` yourself. The terminal shows Claude exactly as usual.

```bash
$ bridge sessions
SESSION ID       PROJECT                  STATUS     PID      LAST ACTIVITY
session_001      SPM Backend              WAITING    7670     1s ago
session_002      Mobile App               RUNNING    7670     1s ago
session_003      Frontend                 WAITING    7670     1s ago

$ bridge pending
q28wab  session_003  free_text  PENDING  (1s ago)
  Claude is asking you something: I found 11 test-case files with approximately 1,000 rows.
    1. Verify and fix failures
    2. Verify only, report
qkewwy  session_001  permission  PENDING  (1s ago)
  Permission request: Bash: npm test -- --coverage

$ bridge answer qkewwy --deny "use npm run test:ci"     # answer from the PC (same validation as Chat)
Delivered: denied: use npm run test:ci
```

(That output was captured from this implementation.) Other commands: `bridge history`, `bridge audit`, `bridge logs`, `bridge stop`, `bridge help`.

**Statuses:**

| Status | Meaning |
|---|---|
| `STARTING` | session launched |
| `RUNNING` | Claude is working |
| `WAITING` | a question is open |
| `IDLE` | turn finished; nothing asked |
| `COMPLETED` | exit code 0 |
| `FAILED` | non-zero exit |
| `STOPPED` | terminal closed or killed |

**Restarts never duplicate sessions:**
- The `claude` processes belong to the terminal windows, not to the daemon. Restarting the daemon (`bridge stop`, a crash, a reboot of just the daemon) leaves them running. Each runner re-attaches with its session id.
- Hooks waiting on an answer reconnect with an idempotency key and still receive it.
- Starting the same project in the same directory twice is refused unless you pass `--new`.
- After a terminal was closed you can reuse its metadata: `bridge start "SPM Backend" --session session_001 -- --continue`.

**Sessions already running in a plain terminal** can't be taken over. There is no supported way to attach to another process's terminal or to inject hooks into a running Claude. To migrate one:
1. Note its conversation: `claude --resume` lists them, or use the id shown by `/status` inside Claude.
2. Exit it (`/exit`).
3. Relaunch through the bridge with the same conversation: `bridge start "Project" --cwd <dir> -- --resume <session-id>` (or `-- --continue` for the most recent one).

## 12. Using Google Chat

A question card looks like this (rendered from the real `Code.gs` card JSON):

```
🔔 Claude is asking you something — Frontend (q28wab)
┌───────────────────────────────────────────────┐
│ Claude is asking you something                │
│ Frontend · session_003 · q28wab               │
│                                               │
│ I found 11 test-case files with approximately │
│ 1,000 rows.  What should I do?                │
│ 1. Verify and fix failures                    │
│ 2. Verify only, report                        │
│ ⏳ Waiting for your answer — expires 14:55    │
│ [1. Verify and fix failures] [2. Verify only, report] │
│ [✏️ Reply] [Dismiss]                          │
└───────────────────────────────────────────────┘
```

- **Multiple choice:**
  - One question: one button per option, plus **✏️ Type something**, which opens a dialog for a custom answer.
  - Several questions or multi-select: **📝 Answer** opens a form with radio buttons or checkboxes and an "or type your own" field per question.
- **Permission requests:** **✅ Allow**, **✅ Allow for session** (session-scoped rule, never written to your settings), **❌ Deny**, **💬 Deny with reason** (Claude sees the reason).
  - Sensitive operations show **⚠️ Sensitive operation: …** and need a second **Yes, allow** tap. This covers deletions, force-push, deployments, publishing, credential and `.env` access, `sudo`, `curl | sh`, destructive SQL and similar. "Allow for session" is never offered for them.
- **Claude finished a turn:** Claude's last message, plus buttons for any numbered options or yes/no question detected in it, plus **✏️ Reply**. The text is typed into Claude's prompt.
- **Terminal menus:** one button per menu entry, or **Leave for terminal**.
- **After you answer**, the card updates:
  - *📨 Answer recorded — delivering…*
  - then *✅ Delivered*, or *❌ Not delivered: reason* (e.g. you already answered in the terminal).
  - If your PC is offline, the card says so; the answer is kept and delivered when the PC reconnects.
- **Commands:** `/sessions`, `/status`, `/pending`, `/help`, `/cancel <id>`, `/reply <id> <number | text | allow | session | deny [reason]>`. For a sensitive permission: `/reply <id> allow confirm`.

## 13. Configuration reference

`~/.claude-chat-bridge/config.json` (template: [`config/config.example.json`](config/config.example.json)):

| Key | Default | Description |
|---|---|---|
| `questionTimeoutSec` | 1800 | After this the question expires, the terminal shows its own prompt, and late answers are rejected |
| `pushDelaySec.{permission,ask_user_question,free_text,menu,yes_no,text_prompt}` | 5 / 5 / 20 / 5 / 5 / 5 | Grace period before pushing to Chat (answered locally meanwhile → never pushed) |
| `localPresenceSec` | 20 | Hold pushes while someone is typing in that session's terminal |
| `notifications.sessionStarted / sessionCompleted / sessionFailed / turnFinished / answerRejected` | false / true / true / true / true | Which events reach Chat. `turnFinished: false` disables the Stop-hook questions |
| `detector.enabled / idleMs / textPrompts` | true / 1200 / false | PTY prompt detection; `textPrompts` (generic `Name:` prompts) applies to non-Claude commands only |
| `allowFreeTextPrompts` | true | Allow typing replies into Claude's prompt from Chat |
| `autoApprove.rules` | `[]` | **Opt-in** auto-approval, e.g. `[{"tool":"Bash","pattern":"^npm (test|run lint)$"}]`. Never applies to sensitive operations; every use is audited |
| `extraDangerousPatterns` | `[]` | Extra regexes that force the two-step confirmation |
| `longPollSec` | 20 | Long-poll window per request to Apps Script |

## 14. Running in the background

The daemon starts automatically with the first `bridge start`. To keep it running across logins:

**macOS (launchd)** — `~/Library/LaunchAgents/com.claude-chat-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude-chat-bridge</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/ABSOLUTE/PATH/claude-chat-bridge/bin/bridge.js</string><string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.claude-chat-bridge.plist
caffeinate -i -w $(pgrep -f "bridge.js daemon")   # keep the Mac awake while the daemon runs
```

**Windows**: Task Scheduler → *Create Task* → trigger *At log on* → action `node.exe "C:\path\claude-chat-bridge\bin\bridge.js" daemon`. Set *Power Options → Sleep: Never* while you're away.

Logs: see [Logs & monitoring](#logs--monitoring).

## 15. Testing

```bash
npm test                     # 84 tests: unit, integration, reliability, PTY, Gmail and WhatsApp (no accounts needed)
npm run test:e2e-claude      # real Claude Code (Haiku): 2 concurrent sessions, every prompt answered from "Chat"
E2E_SESSIONS=1 E2E_PERMISSION_MODE=inherit E2E_MODEL=inherit npm run test:e2e-claude   # with YOUR model + permission mode
```

The second form was also run with a default permission mode of `auto`:
- the AskUserQuestion answer (`updatedInput.answers`) and the typed reply both worked;
- the auto-mode classifier approved the Bash call itself, so correctly no permission question reached Chat.

`npm test` runs the **real `apps-script/Code.gs`** inside a simulated Apps Script runtime (`test/helpers/gas-runtime.js`). The simulator reproduces Script Properties, Cache, Lock, Utilities (signed byte arrays, a blocking `sleep`), Sheets, UrlFetch and the web app's 302 redirect from `/exec`. The tests drive it with Chat add-on (and legacy) event objects. They cover:
- multiple-choice (single, custom text, multi-question / multi-select), permissions (allow, deny with reason, allow for session, two-step sensitive confirmation);
- duplicate clicks, unauthorized users, tampered session ids, forged responses for the wrong session or user;
- three concurrent sessions with answers routed to the right hook;
- network outage with answers given while offline, daemon restart while a hook waits, expiry, Chat API failure and retry;
- offline/reconnected notices, reminders, webhook mode, exit notifications, a wrong shared secret;
- PTY menus and `[y/N]` prompts answered from Chat, and stale answers refused after a local answer;
- Gmail mode:
  - question emails, and answers by reply (`allow`, numbers, free text);
  - forged replies (not sent from your account) ignored;
  - the answer page refusing other users and tampered links;
  - the sensitive-operation checkbox, multi-question forms;
  - rejection notes in the thread, email commands, notification emails.

`test:e2e-claude` was run against Claude Code 2.1.280 with two sessions in parallel. In each session:
1. The folder-trust dialog was detected and answered through the PTY.
2. `AskUserQuestion` was answered through the hook.
3. A Bash permission was answered through the hook.
4. Claude's plain-text follow-up was answered by typing into its prompt.
5. Claude created the chosen file with the expected content.

## Logs & monitoring

Every event is recorded, both on your PC and in Google. Run the commands from the `claude-chat-bridge` folder (or use `bridge …` after `npm link`).

### Watch events live

```bash
node bin/bridge.js logs --follow      # live feed; Ctrl+C to stop
```

Keep this open in a second terminal while you work. Typical lines:

```
5:05:52 pm INFO  daemon started pid=30879 port=60620 chat=configured
5:06:15 pm INFO  chat: connected to Apps Script
5:10:19 pm INFO  questions: question created id=qgnwjg session=session_004 kind=ask_user_question
5:10:27 pm INFO  local takeover session=session_004 released=["qgnwjg"]
5:11:31 pm INFO  chat: answer processed response=2eec… question=qgnwjg result=accepted
5:20:02 pm WARN  chat: lost connection to Apps Script error=network error calling poll: …
```

| Line | Meaning |
|---|---|
| `question created` | Claude asked something; an email or Chat card follows after the push delay |
| `answer processed … result=accepted` | your answer was validated and handed to Claude |
| `answer processed … result=rejected reason=…` | refused, with the reason (e.g. already answered in the terminal, expired, wrong user) |
| `local takeover` | a key was pressed in that terminal while a question waited; Claude shows its own dialog and the remote question stays open |
| `lost connection` / `connected` | network or Apps Script outage, and recovery. Nothing is lost; everything is retried |
| `notification queued kind=session_failed` | a status email or Chat message is on its way |

### Commands on your PC

| Command | Shows |
|---|---|
| `node bin/bridge.js logs --lines 200` | the last 200 events (add `--follow` to keep watching) |
| `node bin/bridge.js history [--limit 50]` | every question: time, id, session, final status, the answer and who gave it |
| `node bin/bridge.js audit [--limit 100]` | security trail: answers accepted/rejected and why, local answers, sessions started/ended, auto-approvals |
| `node bin/bridge.js pending` | questions still waiting for an answer |
| `node bin/bridge.js sessions [--all]` | sessions and their state (RUNNING, WAITING, IDLE, COMPLETED, FAILED, STOPPED) |
| `node bin/bridge.js doctor` | health check of Node, Claude, PTY, config and the Google connection |

### Files on your PC (`~/.claude-chat-bridge/`)

| File | Contents |
|---|---|
| `logs/daemon.log` | main event log, one JSON object per line (what `bridge logs` shows) |
| `logs/runner-<pid>.log` | per terminal window started with `bridge start` (screen-prompt detection, reconnects) |
| `logs/daemon.stdout.log` | output of the background daemon itself, useful if it crashed or won't start |
| `bridge.db` | SQLite database with tables `sessions`, `questions`, `responses`, `notifications`, `audit_log` |

Example of querying the database directly:
```bash
sqlite3 ~/.claude-chat-bridge/bridge.db "select id, session_id, kind, status, resolution_note from questions order by created_at desc limit 20;"
```

### On the Google side

| Where | Shows |
|---|---|
| **Google Sheet "Claude Assistant — bridge history"** (in your Drive; created by `setup`) | **Questions** tab: every question and its final status. **Responses**: every answer from email, links or Chat, and whether the bridge accepted it. **Audit**: refused requests (wrong secret, unlisted users), ignored or too-late email replies, notifications |
| **Apps Script editor → ⏱ Executions** (left sidebar) | each run of the script (relay calls from the PC, the 1-minute email check `gmailPoll`, `housekeeping`, button clicks) with duration and any error |
| **Gmail labels `Claude Assistant/…`** | resolved question threads sorted by outcome: Answered, Answered in terminal, Expired, Dismissed, Not delivered |

### Following one question end to end

When an answer doesn't seem to arrive, follow the question id (e.g. `qgnwjg`, shown in the email subject):

1. `node bin/bridge.js history`. What's its status?
   - `PENDING`: your answer hasn't reached the PC yet. Go to step 2.
   - `ANSWERED_LOCALLY`: it was answered or taken over in the terminal before your email arrived. You should also have received a "Your reply was NOT sent to Claude" reply.
   - `DELIVERED`: Claude received it.
   - `FAILED` / `EXPIRED`: the reason is shown in the same row.
2. **Apps Script → Executions:** did `gmailPoll` run in the last minute, and without errors?
3. **Google Sheet → Responses / Audit:** was your reply recorded, or listed as `gmail.reply_ignored` (not sent from the owner account) or `gmail.reply_too_late`?
4. `node bin/bridge.js logs --follow`: an `answer processed … question=<id>` line appears within a few seconds of step 3.

## 16. Troubleshooting

| Symptom | Fix |
|---|---|
| `posix_spawnp failed` | `node scripts/fix-pty-perms.js` (node-pty helper lost its executable bit) |
| `doctor`: *requires a Google sign-in (HTTP 401)* or *non-JSON … got an HTML page* | Web app access isn't **Anyone** (or you used the `/dev` URL). **Deploy → Manage deployments → ✏️ Edit → Who has access: Anyone → Deploy**. The URL stays the same |
| `doctor`: *bad signature* | `BRIDGE_SHARED_SECRET` ≠ Script Property `SHARED_SECRET` |
| `doctor`: *stale or future timestamp* | Fix the PC clock (±5 min tolerance) |
| `doctor`: *Chat space not captured yet* | Open the DM with Claude Assistant and send `help` |
| `doctor`: *service account token request failed* | Key JSON pasted incompletely, or key disabled. Re-create the key |
| Key creation fails with *disabled by organization policy* | See [§9](#9-workspace-administrator-permissions); use Option B/C meanwhile |
| Chat: *Claude Assistant not responding* | Wrong Head deployment ID in the Chat API config, or `Code.gs` not saved. Check **Apps Script → Executions** |
| Chat: *⛔ not on the allowlist* | Add the email to `ALLOWED_EMAILS` (Script Property) **and** `BRIDGE_ALLOWED_EMAILS` (PC) |
| Questions not pushed, but `/pending` shows them | Push mode `none`/misconfigured, so check `doctor`. Pushes are retried by `housekeeping` (5 min) |
| Answer says *Not delivered: no longer pending* | You (or the timeout) already resolved it in the terminal. Nothing was typed |
| Nothing arrives while you work in the terminal | Expected: `localPresenceSec` holds pushes while you type there |
| Too many "turn finished" messages | Raise `pushDelaySec.free_text` or set `notifications.turnFinished: false` |
| Email reply doesn't reach Claude | Wait up to 60 s (replies are checked every minute). Then follow the question id as described in [Logs & monitoring](#logs--monitoring). Common causes: a key was pressed in that terminal (status `ANSWERED_LOCALLY`), the `gmailPoll` trigger is missing (run `setup` again), or the reply was sent from a different account than the script owner |
| `bridge: command not found` | Run `npm link` once in the project folder, or use `node bin/bridge.js …` |
| `bridge start: project folder not found` | Pass a real folder: `--cwd "/full/path/to/project"` (quote paths with spaces), or `cd` into the project and omit `--cwd` |
| A terminal menu isn't detected | It must have a cursor marker (`❯`, `>`, `›`) and sit at the bottom of the screen. Answer it locally, and please report the screen layout |

## 17. Security considerations

- **No shell from Chat.** Chat can only answer a question that exists and is still pending. There is no command execution, no session creation, and no arbitrary input from Chat.
  - Free-text replies go only into Claude's own prompt, and only while Claude is idle there. Claude's permission system still applies to whatever it does next.
  - Control characters and escape sequences are stripped from every typed answer.
- **Who can answer:** the allowlist is checked in Apps Script and again on the PC. Every refused attempt is logged in the audit trails.
- **Every answer is validated before it is acted on**, so stale and replayed answers are refused. All of these must hold:
  - the response id was never processed before,
  - the question exists, belongs to the stated session, and is still `PENDING`,
  - it hasn't expired,
  - the option or answer fits the question,
  - a sensitive allow carries an explicit confirmation,
  - for terminal input, the same prompt is still on screen.
- **Relay authentication:** HMAC-SHA256 over timestamp + nonce + operation + payload in both directions, ±5 min clock window, nonce replay cache. Responses from Apps Script are verified too.
- **No inbound ports:** the daemon listens on `127.0.0.1` only, with a random bearer token in `daemon.json` (mode 600). All Google traffic is outbound HTTPS.
- **Secrets:** `bridge setup` writes `.env` and `config.json` to `~/.claude-chat-bridge` with mode 600. A `.env` placed next to `.env.example` in the project folder is also read: keep it `chmod 600` and out of git (it's in `.gitignore`). `bridge doctor` warns when a secrets file is readable by others. Logs redact secret-like fields. `SERVICE_ACCOUNT_JSON` lives only in Script Properties (owner-only). Its `chat.bot` scope can post messages as the app and nothing else.
- **Permissions:**
  - Nothing is approved automatically unless you add `autoApprove.rules`, which never cover sensitive operations.
  - "Allow for session" writes an in-memory, session-scoped rule only (`destination: "session"`), never your settings files.
  - Sensitive operations need two taps.
- **Fail-safe:** on any error, timeout or outage, the hook returns no decision and Claude shows its normal terminal prompt.
- **Audit:** locally `bridge audit` (SQLite `audit_log`), remotely the *Audit* sheet. Question and response history is in both places.
- **Data in Google:** question text, commands awaiting approval and Claude's last message are stored in your own Apps Script project and spreadsheet, inside your Workspace. Don't route sessions that handle data your organisation forbids from being stored there.

## 18. Known limitations

- **Live Google integration was not tested from this machine.** It needs your Workspace and Cloud console. The Apps Script code was tested by running the exact `Code.gs` in a faithful simulator, and the Chat event and response shapes follow the current official docs (add-on format, with the legacy format supported as a fallback). Run `bridge doctor --send-test` after setup to verify the live chain.
- **Gmail mode** was tested only against the simulator (`GmailApp`, HtmlService). The real checks are `bridge doctor --send-test` and one reply to a question email. Gmail search results can lag a few seconds, so a reply may take one extra polling cycle to be picked up.
- **Windows** support (ConPTY, `.cmd` shims, paths with spaces) is implemented but was not run.
- PTY detection is heuristic and limited to menus with a cursor marker, `[y/N]` prompts, and (opt-in) text prompts. Full-screen TUIs with unusual layouts may not be recognised; they still work locally.
- While a question waits for a remote answer, Claude's `AskUserQuestion` dialog isn't drawn. Press any key in that terminal to show it; the remote question stays answerable. Permission dialogs remain visible all the time.
- Script Properties hold ≤ ~9 KB per question. Very long texts are shortened in Chat; the full text stays in the terminal and the local DB.
- Apps Script quotas apply (executions, UrlFetch calls, trigger runtime). The bridge long-polls (≈ 3 requests/min when idle), which fits normal Workspace quotas. See <https://developers.google.com/apps-script/guides/services/quotas>.
