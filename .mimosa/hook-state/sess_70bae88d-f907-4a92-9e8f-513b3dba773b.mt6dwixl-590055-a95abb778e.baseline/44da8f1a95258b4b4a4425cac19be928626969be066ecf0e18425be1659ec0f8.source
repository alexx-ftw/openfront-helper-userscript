// Companion Bot — commands: the emoji → action table, and turning the boss's
// outgoing emoji feed into a list of commands to run.
//
// Reading is all this file does; it never sends anything. Classic-script shared
// scope, no load-time side effects (see companion/core.js header).

"use strict";

  const COMPANION_ACTION_IDS = [
    "donateAllGold",
    "donateAllTroops",
    "breakAlliance",
    "requestAlliance",
    "attackBossTarget",
    "buildFactory",
    "pause",
    "resume",
  ];

  // Defaults must be pairwise distinct — the lookup is emoji → action, so two
  // actions sharing an emoji would make one of them unreachable.
  const COMPANION_DEFAULT_BINDINGS = {
    donateAllGold: "🆘",
    donateAllTroops: "💰",
    breakAlliance: "💔",
    requestAlliance: "🤝",
    attackBossTarget: "🎯",
    buildFactory: "🏭",
    pause: "🥱",
    resume: "💪",
  };

  // Bound so a long match cannot grow the dedupe list without limit.
  const COMPANION_SEEN_LIMIT = 256;

  // `emojiBindings[id] === null` means that action id is DISABLED: it is left out
  // of the returned object entirely, so companionCollectCommands' byEmoji lookup
  // (built from `bindings[id]`) never sees it and no emoji can trigger it.
  function companionBindings() {
    const saved = companionSettings().emojiBindings;
    const out = Object.assign({}, COMPANION_DEFAULT_BINDINGS);
    if (!saved || typeof saved !== "object") {
      return out;
    }
    for (const id of COMPANION_ACTION_IDS) {
      if (saved[id] === null) {
        delete out[id];
        continue;
      }
      if (typeof saved[id] === "string" && saved[id] !== "") out[id] = saved[id];
    }
    return out;
  }

  // Identity of one emoji message. createdAt is the game tick the message was
  // produced on, so the same emoji sent twice yields two distinct keys while the
  // SAME message lingering in the array across ticks yields one.
  //
  // The multitab original had no dedupe at all: it re-ran the command on every
  // 2s tick for as long as the emoji stayed in the feed, and only avoided a
  // donate storm because an unrelated cooldown happened to swallow the repeats.
  function companionEmojiKey(msg) {
    return `${msg.senderID}:${msg.recipientID}:${msg.message}:${msg.createdAt}`;
  }

  function companionEmojiActionLookup(bindings) {
    const byEmoji = {};
    for (const id of COMPANION_ACTION_IDS) {
      const emoji = bindings && bindings[id];
      if (typeof emoji === "string" && emoji !== "") byEmoji[emoji] = id;
    }
    return byEmoji;
  }

  function companionMessageTargetsBot(message, mySmallID) {
    return message.recipientID === "AllPlayers"
      || Number(message.recipientID) === Number(mySmallID);
  }

  function companionRecordEmojiMessage(message, seen) {
    const key = companionEmojiKey(message);
    if (seen.indexOf(key) !== -1) return false;
    seen.push(key);
    if (seen.length > COMPANION_SEEN_LIMIT) {
      seen.splice(0, seen.length - COMPANION_SEEN_LIMIT);
    }
    return true;
  }

  // Commands the boss has issued to THIS bot since the last call.
  // Mutates `seen` (the caller owns it, normally companionState.seenEmoji).
  function companionCollectCommands(boss, mySmallID, bindings, seen) {
    const out = [];
    // Our own smallID must be known. Without this guard Number(null) === 0, which
    // is TerraNullius's sentinel smallID — an unresolved caller would start
    // matching messages addressed to nobody. Keep the null path explicit for
    // callers that have not resolved their own player identity yet.
    if (mySmallID == null) return out;
    if (!boss || !boss.state) return out;
    const feed = boss.state.outgoingEmojis;
    if (!Array.isArray(feed) || feed.length === 0) return out;

    const byEmoji = companionEmojiActionLookup(bindings);

    for (const msg of feed) {
      if (!msg || typeof msg !== "object") continue;
      if (typeof msg.message !== "string") continue;
      if (!companionMessageTargetsBot(msg, mySmallID)) continue;
      const actionId = byEmoji[msg.message];
      if (!actionId) continue;
      if (!companionRecordEmojiMessage(msg, seen)) continue;
      out.push(actionId);
    }
    return out;
  }
