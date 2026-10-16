      return ports.some((port) => port?.isUnderConstruction?.() === false);
    }

    nuclearSlotPressureQueueEligible() {
      const pending = this.nukeBehavior?._pendingNukeLaunches;
      const queued = Array.isArray(pending) && pending.length > 0;
      const wantedSlots = state.nukeWantSlots?.need > 0;
      return queued && !wantedSlots;
    }

  }
