
    missileDefenseEffectiveCosts() {
      const config = this.game?.config?.();
      const atomDisabled = config?.isUnitDisabled?.(UNIT.AtomBomb) === true;
      const hydrogenDisabled =
        config?.isUnitDisabled?.(UNIT.HydrogenBomb) === true;
      const rawAtomCost =
        typeof this.cost === "function" ? BigInt(this.cost(UNIT.AtomBomb)) : 0n;
      const rawHydrogenCost =
        typeof this.cost === "function"
          ? BigInt(this.cost(UNIT.HydrogenBomb))
          : 0n;
      return {
        atomDisabled,
        hydrogenDisabled,
        rawAtomCost,
        rawHydrogenCost,
        atomCost: atomDisabled ? 0n : rawAtomCost,
        hydrogenCost: hydrogenDisabled ? 0n : rawHydrogenCost,
      };
    }

    missileDefenseEnemyGoldState(enemy, costs) {
      const rawGold = enemy.gold?.() ?? 0n;
      const gold = BigInt(rawGold);
      if (costs.atomCost <= 0n && costs.hydrogenCost <= 0n) {
        return ["raw", rawGold];
      }
      const canHydrogen =
        costs.hydrogenCost > 0n && gold >= costs.hydrogenCost;
      const atomBudget = canHydrogen ? gold - costs.hydrogenCost : gold;
      const affordableAtoms =
        costs.atomCost > 0n ? atomBudget / costs.atomCost : 0n;
      return ["capacity", canHydrogen, affordableAtoms];
    }

    appendMissileDefenseStatePlayers(representation, players, mySid, costs) {
      if (!Array.isArray(players)) return;
      for (const other of players) {
        if (!other) continue;
        const sid = other.smallID?.();
        if (String(sid) === String(mySid)) continue;
        const friendly =
          this.player.isFriendly(other) || this.player.isOnSameTeam(other);
        this.addMissileDefenseStateRecord(representation, [
          "player",
          sid,
          friendly,
        ]);
        if (friendly) {
          this.appendMissileDefenseStateUnits(
            representation,
            ["friendly-sams", sid],
            other,
            [UNIT.SAMLauncher],
          );
          continue;
        }
        this.addMissileDefenseStateRecord(representation, [
          "enemy-gold",
          sid,
          this.missileDefenseEnemyGoldState(other, costs),
        ]);
        this.appendMissileDefenseStateUnits(
          representation,
          ["enemy-silos", sid],
          other,
          [UNIT.MissileSilo],
        );
      }
    }

    appendMissileDefenseStateMissiles(representation) {
      const activeMissiles =
        typeof this.game?.units === "function"
          ? this.missileFamilyUnitsSnapshot(
              UNIT.AtomBomb,
              UNIT.HydrogenBomb,
              UNIT.MIRV,
              UNIT.MIRVWarhead,
            )
          : null;
      this.addMissileDefenseStateRecord(representation, [
        "missile-collection",
        Array.isArray(activeMissiles),
        Array.isArray(activeMissiles) ? activeMissiles.length : null,
      ]);
      if (!Array.isArray(activeMissiles)) return;
      for (const missile of activeMissiles) {
        if (!missile) continue;
        this.addMissileDefenseStateRecord(representation, [
          "missile",
          missile.id?.(),
          missile.type?.(),
          missile.owner?.()?.smallID?.(),
          missile.tile?.(),
          missile.targetTile?.(),
          missile.isActive?.(),
        ]);
      }
    }

    missileDefenseStateRepresentation() {
      const representation = new Map();
      const costs = this.missileDefenseEffectiveCosts();
      this.addMissileDefenseStateRecord(representation, [
        "cost",
        UNIT.AtomBomb,
        costs.atomDisabled,
        costs.rawAtomCost,
        costs.atomCost,
      ]);
      this.addMissileDefenseStateRecord(representation, [
        "cost",
        UNIT.HydrogenBomb,
        costs.hydrogenDisabled,
        costs.rawHydrogenCost,
        costs.hydrogenCost,
      ]);
      this.appendMissileDefenseStateUnits(
        representation,
        "own-structures",
        this.player,
        [UNIT.City, UNIT.Factory, UNIT.Port, UNIT.MissileSilo],
      );
      this.appendMissileDefenseStateUnits(
        representation,
        "own-sams",
        this.player,
        [UNIT.SAMLauncher],
      );
      const mySid = this.player.smallID?.();
      this.addMissileDefenseStateRecord(representation, ["self", mySid]);
      const players = this.game?.players?.();
      this.appendMissileDefenseStatePlayers(
        representation,
        players,
        mySid,
        costs,
      );
      this.appendMissileDefenseStateMissiles(representation);
      return representation;
    }

    missileDefenseStateProbe() {
      return this.missileDefenseStateRepresentation();
    }

    missileDefenseStateRepresentationsEqual(left, right) {
      if (left === right) return true;
      if (!(left instanceof Map) || !(right instanceof Map)) return false;
      if (left.size !== right.size) return false;
      for (const [key, count] of left) {
        if (right.get(key) !== count) return false;
      }
      return true;
    }

    missileDefenseStateFingerprint(representation = null) {
      const state =
