// Optional strategy coordination. Native behavior remains the sole actuator.
// DIVERGENCE: proposals add scoped economic vetoes and receipt-backed support.
"use strict";

{
  const root = window;
  const VERSION = "ofh-hybrid-strategy-v1";
  const economicTypes = new Set(["City", "Factory", "Port"]);
  const sessions = new WeakMap();
  let sequence = 0;
  let enabled = false;
  let scope = null;
  let latestTick = -1;
  let requestBarrierTick = -1;
  const attacks = new Map();
  const exchanges = new Map();
  const naval = new Map();
  const issuedProposals = new Map();
  const structures = new WeakMap();
  const counts = { proposals: 0, economicChecked: 0, economicBlocked: 0, inheritedCalls: 0 };

  function read(object, key) {
    const receiver = object?.[key] === undefined ? object?.__src : object;
    const value = receiver?.[key];
    return typeof value === "function" ? value.call(receiver) : value;
  }

  function tickOf(context) {
    return Number(read(context.game, "ticks"));
  }

  function identity(context) {
    const game = context.game?.__src ?? context.game;
    if (!sessions.has(game)) sessions.set(game, `game-${++sequence}`);
    return { sessionId: context.sessionId ?? sessions.get(game), generation: context.generation ?? 0,
      actorSid: read(context.player, "smallID") };
  }

  function active() {
    return enabled && (typeof state === "undefined" || state.settings.winFixes !== false);
  }

  function reset(sessionId = null) {
    scope = sessionId;
    latestTick = -1;
    requestBarrierTick = -1;
    attacks.clear();
    exchanges.clear();
    naval.clear();
    issuedProposals.clear();
  }

  function observe(context) {
    const id = identity(context);
    const key = `${id.sessionId}:${id.generation}:${id.actorSid}`;
    if (scope !== key) reset(key);
    const tick = tickOf(context);
    return { ...id, tick, enabled: observeTick(tick) && active() };
  }

  function observeTick(tick) {
    if (tick < latestTick) {
      requestBarrierTick = latestTick;
      for (const exchange of exchanges.values()) exchange.status = "expired";
      issuedProposals.clear();
      naval.clear();
    }
    const forward = Number.isSafeInteger(tick) && tick >= latestTick;
    if (forward) latestTick = tick;
    return forward;
  }

  function propose(context, channel, candidates) {
    const current = observe(context);
    if (!current.enabled || !Number.isSafeInteger(current.tick) || current.tick < 0) return [];
    for (const [id, proposal] of issuedProposals) {
      if (current.tick >= proposal.expiresTick) issuedProposals.delete(id);
    }
    return candidates.filter(candidate => validCandidateTiming(candidate, current.tick)).map(candidate => {
      counts.proposals++;
      const proposal = { version: VERSION, proposalId: `${scope}:${++sequence}`, channel, ...current,
        target: candidate.target, createdTick: current.tick, sourceTick: current.tick,
        expiresTick: candidate.expiresTick, notBeforeTick: current.tick + (candidate.relativeNotBefore ?? 0),
        evidence: candidate.evidence ?? { status: "unknown" }, pendingNativeKeys: candidate.pendingNativeKeys ?? [] };
      issuedProposals.set(proposal.proposalId, copySemanticValue(proposal));
      return proposal;
    });
  }

  function validate(context, proposal) {
    const current = identity(context);
    const same = issuedMatches(proposal) && proposal?.version === VERSION && proposal.sessionId === current.sessionId
      && proposal.generation === current.generation && proposal.actorSid === current.actorSid;
    const now = tickOf(context);
    return { valid: active() && same && observeTick(now)
      && proposal.createdTick <= now && now < proposal.expiresTick,
      checkedTick: now };
  }

  function validCandidateTiming(candidate, tick) {
    const delay = candidate.relativeNotBefore ?? 0;
    return Number.isSafeInteger(candidate.expiresTick) && candidate.expiresTick > tick
      && Number.isSafeInteger(delay) && delay >= 0 && Number.isSafeInteger(tick + delay);
  }

  function copySemanticValue(value) {
    if (Array.isArray(value)) return value.map(copySemanticValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copySemanticValue(item)]));
    }
    return value;
  }

  function sameSemanticValue(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
      && keys.every(key => Object.hasOwn(right, key) && sameSemanticValue(left[key], right[key]));
  }

  function issuedMatches(proposal) {
    const issued = issuedProposals.get(proposal?.proposalId);
    return Boolean(issued && sameSemanticValue(issued, proposal));
  }

  function rebase(context, proposal, delta) {
    if (!validate(context, proposal).valid || !Number.isSafeInteger(delta) || delta < 0) return null;
    const notBeforeTick = proposal.notBeforeTick + delta;
    if (!Number.isSafeInteger(notBeforeTick)) return null;
    const delayed = { ...proposal, notBeforeTick };
    issuedProposals.set(delayed.proposalId, copySemanticValue(delayed));
    return delayed;
  }

  function vetoResult(context, reason, managed) {
    const now = tickOf(context);
    if (reason !== null) counts.economicBlocked++;
    return { blocked: reason !== null, reason, notBeforeTick: reason === null ? null : now + 1,
      proposalId: context.proposalId ?? null, scope: managed ? "economic" : "unmanaged",
      checkedTick: now, evidence: { source: "native-quote-and-existing-reservations" } };
  }

  function purchaseReason(context) {
    const { game, player, buildable, tile } = context;
    if (!read(player, "isAlive")) return "actor-unavailable";
    if (typeof buildable.cost !== "bigint" || typeof context.reservedGold !== "bigint") return "quote-unavailable";
    if (read(player, "gold") - context.reservedGold < buildable.cost) return "reserved-budget";
    const behavior = registeredStructure(context);
    // availableGoldAfterReserve has ONE meaningful argument in the stable port.
    if (behavior && behavior.availableGoldAfterReserve(buildable.type) < buildable.cost) return "defense-budget";
    if (behavior?.tileInsideActiveHostileMissileImpact(tile)) return "incoming-impact";
    if (urgentQuoteBlocks(context, behavior)) return "urgent-defense-quote";
    const proposalReason = purchaseProposalReason(context);
    if (proposalReason) return proposalReason;
    if (buildable.canUpgrade != null && buildable.canUpgrade !== false) return upgradeReason(game, player, buildable, tile);
    return null;
  }

  function purchaseProposalReason(context) {
    if (!context.proposalId && !context.proposal) return null;
    const proposal = context.proposal ?? issuedProposals.get(context.proposalId);
    if (!validate(context, proposal).valid) return "stale-proposal";
    if (proposal.channel === "economic" && proposal.target !== context.tile) return "proposal-site";
    return tickOf(context) < proposal.notBeforeTick ? "proposal-not-before" : null;
  }

  function urgentQuoteBlocks(context, behavior) {
    const quote = behavior?.hybridDefensiveQuote;
    return quote?.sourceTick === tickOf(context) && read(context.player, "gold") - context.reservedGold
      < context.buildable.cost + quote.cost;
  }

  function upgradeReason(game, player, buildable, tile) {
    const unit = typedUpgradeUnit(game, buildable);
    if (!unit || read(read(unit, "owner"), "smallID") !== read(player, "smallID")) return "upgrade-owner";
    if (read(unit, "type") !== buildable.type) return "upgrade-type";
    return read(unit, "tile") === tile ? null : "upgrade-site";
  }

  function typedUpgradeUnit(game, buildable) {
    return game?.units?.(buildable.type)?.find(item => read(item, "id") === buildable.canUpgrade);
  }

  function economicUpgradeTile({ game, player, buildable }) {
    const unit = typedUpgradeUnit(game, buildable);
    if (!unit || read(read(unit, "owner"), "smallID") !== read(player, "smallID")
      || read(unit, "type") !== buildable.type) return null;
    const tile = read(unit, "tile");
    return Number.isSafeInteger(tile) && tile >= 0 ? tile : null;
  }

  function structureKey(context) {
    // The raw game WeakMap owns the native session. Proposal generations and
    // optional caller metadata cannot replace the one live Structure instance.
    return read(context.player, "smallID");
  }

  function registeredStructure(context) {
    return structures.get(context.game?.__src ?? context.game)?.get(structureKey(context));
  }

  function admitEconomicPurchase(context) {
    counts.economicChecked++;
    const managed = active() && economicTypes.has(context.buildable?.type);
    return vetoResult(context, managed ? purchaseReason(context) : null, managed);
  }

  class HybridStructureBehavior extends StructureBehavior {
    async handleStructures(profile = null) {
      counts.inheritedCalls++;
      observe({ game: this.game, player: this.player });
      // A false result includes mandatory defensive holds; never fallback-buy.
      const outcome = await super.handleStructures(profile);
      if (outcome) this.hybridDefensiveQuote = null;
      return outcome;
    }

    async buildableFor(type, tile, timeoutMs = null) {
      const sourceTick = read(this.game, "ticks");
      const quote = await super.buildableFor(type, tile, timeoutMs);
      if (sourceTick === read(this.game, "ticks") && this.urgentDefenseQuote(type, quote)) {
        this.hybridDefensiveQuote = { sourceTick, cost: quote.cost, type, tile };
      }
      return quote;
    }

    urgentDefenseQuote(type, quote) {
      if (typeof quote?.cost !== "bigint" || quote.cost < 0n) return false;
      if (quote.canBuild === false && quote.canUpgrade === false) return false;
      if (type === "Defense Post") return (read(this.player, "incomingAttacks") ?? []).length > 0;
      if (type !== "SAM Launcher") return false;
      return ["Atom Bomb", "Hydrogen Bomb", "MIRV Warhead"].some(unitType =>
        this.game.units(unitType).some(unit => read(unit, "isActive")
          && !this.player.isFriendly(read(unit, "owner"))));
    }

    legendaryConstructionActionGroups(candidates, economyGrowthPriority) {
      const groups = super.legendaryConstructionActionGroups(candidates, economyGrowthPriority);
      if (!active()) return groups;
      this.hybridEconomy = { sourceTick: read(this.game, "ticks"), gold: String(read(this.player, "gold")),
        legalEconomicCandidates: candidates.filter(c => economicTypes.has(c.type) && c.legal !== false).length };
      const stalled = this.hybridLastProbe?.outcome === "skip"
        && this.hybridPreviousGold === this.hybridEconomy.gold;
      this.hybridPreviousGold = this.hybridEconomy.gold;
      if (!stalled) return groups;
      return groups.map(group => this.recoveryGroup(group));
    }

    recoveryGroup(group) {
      const productive = group.filter(c => economicTypes.has(c.type) && c.action !== "wait"
        && c.legal !== false && c.affordable !== false && typeof c.cost === "bigint" && !c.mandatory && !c.safety);
      // Keep native safety positions and speculative WAIT order intact. Only equally
      // admitted productive candidates are reordered after a failed, stagnant probe.
      productive.sort((a, b) => {
        if (a.cost === b.cost) return 0;
        return a.cost < b.cost ? -1 : 1;
      });
      let next = 0;
      return group.map(candidate => productive.includes(candidate) ? productive[next++] : candidate);
    }

    async legendaryConstructionActionGroupResult(actions, groups, index) {
      const outcome = await super.legendaryConstructionActionGroupResult(actions, groups, index);
      this.hybridLastProbe = { tick: read(this.game, "ticks"), outcome };
      return outcome;
    }
  }

  function createStructureBehavior(random, game, player) {
    const Behavior = active() ? HybridStructureBehavior : StructureBehavior;
    const behavior = new Behavior(random, game, player);
    const rawGame = game?.__src ?? game;
    if (!structures.has(rawGame)) structures.set(rawGame, new Map());
    structures.get(rawGame).set(structureKey({ game, player }), behavior);
    return behavior;
  }

  function attackFields(attack) {
    const owner = read(attack, "attacker") ?? read(attack, "attackerID");
    const target = read(attack, "target") ?? read(attack, "targetID");
    return { attackId: read(attack, "id"), ownerSid: read(owner, "smallID") ?? owner,
      targetSid: read(target, "smallID") ?? target, retreating: read(attack, "retreating") };
  }

  function eligiblePeer(context, peer) {
    const type = String(read(peer, "type")).toUpperCase();
    return read(peer, "isAlive") && type === "HUMAN"
      && read(peer, "smallID") !== read(context.player, "smallID")
      && context.player.isFriendly(peer);
  }

  function eligibleAttack(context, peer, facts) {
    const target = read(context.game, "players").find(p => read(p, "smallID") === facts.targetSid);
    return Boolean(target && read(target, "isAlive") && !context.player.isFriendly(target)
      && !facts.retreating && facts.ownerSid === read(peer, "smallID"));
  }

  function observeAttacks(context, peers) {
    const now = tickOf(context);
    const live = new Set();
    for (const peer of peers) {
      for (const attack of read(peer, "outgoingAttacks") ?? []) {
        const facts = attackFields(attack);
        if (!eligibleAttack(context, peer, facts)) continue;
        if (!recordAttack(facts, now)) continue;
        live.add(facts.attackId);
      }
    }
    for (const id of attacks.keys()) if (!live.has(id)) attacks.delete(id);
  }

  function recordAttack(facts, now) {
    const prior = attacks.get(facts.attackId);
    if (prior && (prior.ownerSid !== facts.ownerSid || prior.targetSid !== facts.targetSid)) {
      attacks.delete(facts.attackId);
      return false;
    }
    if (!prior) attacks.set(facts.attackId, { ...facts, firstObservedTick: now });
    return true;
  }

  function directedFeed(context, sender, recipientSid, emoji) {
    const now = tickOf(context);
    const duration = context.game.config().emojiMessageDuration();
    const senderSid = read(sender, "smallID");
    return (read(sender, "outgoingEmojis") ?? []).filter(message => message.senderID === senderSid
      && message.recipientID === recipientSid && message.message === emoji
      && Number.isInteger(message.createdAt) && message.createdAt <= now && now < message.createdAt + duration);
  }

  function observeRequest(context, peer) {
    const peerSid = read(peer, "smallID");
    const previous = exchanges.get(peerSid);
    if (previous && previous.status !== "expired" && previous.status !== "consumed") return;
    const requests = directedFeed(context, peer, read(context.player, "smallID"), "✋");
    const latest = requests.reduce((best, message) => !best || message.createdAt > best.createdAt ? message : best, null);
    if (!latest || latest.createdAt <= requestBarrierTick
      || (previous && latest.createdAt <= previous.requestTick)) return;
    const anchors = Array.from(attacks.values()).filter(a => a.ownerSid === peerSid
      && a.firstObservedTick <= latest.createdAt);
    if (anchors.length !== 1) return;
    exchanges.set(peerSid, { ...anchors[0], requestTick: latest.createdAt,
      expiresTick: latest.createdAt + context.game.config().emojiMessageDuration(), status: "ack-pending" });
  }

  function refreshExchange(context, peer) {
    const sid = read(peer, "smallID");
    const exchange = exchanges.get(sid);
    if (!exchange || exchange.status === "expired" || exchange.status === "consumed") return;
    const now = tickOf(context);
    const requestVisible = directedFeed(context, peer, read(context.player, "smallID"), "✋")
      .some(message => message.createdAt === exchange.requestTick);
    if (!requestVisible || !attacks.has(exchange.attackId) || now >= exchange.expiresTick) {
      exchange.status = "expired";
      return;
    }
    const ack = directedFeed(context, context.player, sid, "⏳").find(m => m.createdAt >= exchange.requestTick);
    if (!ack) { exchange.status = "ack-pending"; return; }
    exchange.ackTick = ack.createdAt;
    exchange.notBeforeTick = Math.max(exchange.requestTick, ack.createdAt);
    exchange.expiresTick = Math.min(exchange.expiresTick, ack.createdAt + context.game.config().emojiMessageDuration());
    exchange.status = "confirmed";
  }

  function observeDuo(context) {
    const current = observe(context);
    if (!current.enabled || !read(context.player, "isAlive") || String(read(context.player, "type")).toUpperCase() !== "HUMAN") return [];
    const peers = (read(context.game, "players") ?? []).filter(p => eligiblePeer(context, p));
    observeAttacks(context, peers);
    for (const peer of peers) { observeRequest(context, peer); refreshExchange(context, peer); }
    const alive = new Set(peers.map(p => read(p, "smallID")));
    for (const sid of exchanges.keys()) if (!alive.has(sid)) exchanges.delete(sid);
    return Array.from(exchanges, ([peerSid, exchange]) => ({ ...exchange, ...current, peerSid }));
  }

  function getJointPlan(context, peerSid) {
    const plans = observeDuo(context);
    if (context.crisis === true) return null;
    return plans.find(p => p.peerSid === peerSid && p.status === "confirmed"
      && tickOf(context) >= p.notBeforeTick && tickOf(context) < p.expiresTick) ?? null;
  }

  function consumeJointPlan(context, plan) {
    const current = getJointPlan(context, plan.peerSid);
    const keys = ["sessionId", "generation", "actorSid", "peerSid", "ownerSid", "targetSid", "attackId", "requestTick", "ackTick"];
    if (!current || !keys.every(key => current[key] === plan[key])) return false;
    const exchange = exchanges.get(plan.peerSid);
    exchange.status = "consumed";
    exchange.consumedTick = tickOf(context);
    return true;
  }

  function transportFacts(context, unit, plans) {
    const id = read(unit, "id");
    const target = read(unit, "targetTile");
    const plan = plans?.get(id) ?? plans?.get(String(id));
    const previous = naval.get(id);
    const ownerSid = read(read(unit, "owner"), "smallID");
    const changed = previous && previous.target !== target;
    const facts = { id, ownerSid, tile: read(unit, "tile"), target,
      sourceTick: tickOf(context), status: changed ? "redirected" : "observed", arrivalTick: null };
    if (read(unit, "transportShipState")?.isRetreating) return { ...facts, status: "recalled" };
    if (previous && previous.ownerSid !== ownerSid) return { ...facts, status: "ownership-changed" };
    if (!validMotionPlan(plan, id, target)) return facts;
    const arrivalTick = plan.startTick + (plan.path.length - 1) * plan.ticksPerStep;
    if (arrivalTick < facts.sourceTick) return facts;
    return { ...facts, arrivalTick, confidence: "native-motion-plan", planId: plan.planId, expiresTick: arrivalTick + plan.ticksPerStep };
  }

  function validMotionPlan(plan, id, target) {
    return Boolean(plan?.path?.length && plan.path.at(-1) === target && plan.unitId === id
      && Number.isFinite(plan.startTick) && plan.ticksPerStep > 0);
  }

  function observeNaval(context, transports, motionPlans) {
    observe(context);
    const live = new Set();
    for (const unit of transports) {
      if (!read(unit, "isActive")) continue;
      const facts = transportFacts(context, unit, motionPlans);
      live.add(facts.id);
      naval.set(facts.id, facts);
    }
    for (const [id, facts] of naval) if (!live.has(id)) naval.set(id,
      { ...facts, status: "unconfirmed", arrivalTick: null, sourceTick: tickOf(context) });
  }

  function transportCommitment(context, id) {
    observe(context);
    const facts = naval.get(id);
    if (!facts) return null;
    if (facts.expiresTick != null && tickOf(context) >= facts.expiresTick) return { ...facts, status: "unconfirmed", arrivalTick: null };
    return { ...facts };
  }

  function describeStrikeWindow(context, targetSid) {
    const commitments = Array.from(attacks.values()).filter(a => a.targetSid === targetSid);
    return { version: VERSION, sourceTick: tickOf(context), targetSid,
      status: commitments.length ? "observed" : "unknown", commitments,
      boundary: "Visible commitments only; no Human PRNG or synchronized first-strike prediction." };
  }

  root.__OFH_hybridStrategy = { version: VERSION, configure: options => { enabled = options.enabled === true; },
    createStructureBehavior, observe, propose, validate, rebase, admitEconomicPurchase, economicUpgradeTile,
    observeNaval, transportCommitment, observeDuo, getJointPlan, consumeJointPlan, describeStrikeWindow, reset,
    diagnostics: () => ({ version: VERSION, enabled: active(), ...counts, exchanges: exchanges.size, transports: naval.size }) };
}
